import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CodexOAuthCredentials, GithubCopilotOAuthCredentials } from '@proma/shared'
import { serializeCodexCredentials, serializeGithubCopilotCredentials } from '@proma/shared'

const tempHome = mkdtempSync(join(tmpdir(), 'proma-model-refresh-'))
const originalHome = process.env.HOME
const originalDev = process.env.PROMA_DEV
let secureStorageAvailable = true
let calls = 0
let codexCalls = 0
let modelReadCalls = 0
let afterCopilotList: (credential: GithubCopilotOAuthCredentials) => Promise<void> = async () => undefined
const forceFlags: boolean[] = []
let codexPolicy: (refresh: string) => Promise<CodexOAuthCredentials> = async () => ({
  access: 'renewed-codex-access', refresh: 'renewed-codex-refresh', expires: Date.now() + 3600000,
})
let fetchPolicy: (credential: GithubCopilotOAuthCredentials) => Promise<GithubCopilotOAuthCredentials> = async (credential) => ({
  ...credential, access: 'renewed-test-access', expires: Date.now() + 3600000, availableModelIds: ['gpt-5.4'],
})

mock.module('node:os', () => ({ ...os, homedir: () => tempHome }))

mock.module('electron', () => ({
  app: { isPackaged: true, getPath: () => join(tempHome, 'Library', 'Application Support') },
  safeStorage: {
    isEncryptionAvailable: () => secureStorageAvailable,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''),
  },
  shell: { openExternal: async () => undefined },
}))
mock.module('./github-copilot-oauth-service', () => ({
  refreshGithubCopilotOAuth: async (credential: GithubCopilotOAuthCredentials, force: boolean) => {
    forceFlags.push(force)
    calls++
    return fetchPolicy(credential)
  },
}))

mock.module('./codex-oauth-service', () => ({
  refreshCodexOAuth: async (refresh: string) => {
    codexCalls++
    return codexPolicy(refresh)
  },
}))

let manager: typeof import('./channel-manager')
beforeAll(async () => {
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'
  const paths = await import('./config-paths')
  // 安全断言必须先于任何创建或读写，不能只依赖运行时可能缓存的 HOME。
  expect(paths.getChannelsPath()).toBe(join(tempHome, '.proma', 'channels.json'))
  const registry = await import('./adapters/pi-model-registry')
  const listCopilot = registry.listGithubCopilotModels
  const listCodex = registry.listCodexModels
  const sdk = await import('@earendil-works/pi-coding-agent')
  // 持久化 fixture 使用真实 SDK，但关闭在线目录，避免测试依赖网络或真实配置。
  const offlineSdk = {
    ModelRuntime: {
      create: async (input: Parameters<typeof sdk.ModelRuntime.create>[0]) => {
        const runtime = await sdk.ModelRuntime.create(input)
        const refresh = runtime.refresh.bind(runtime)
        runtime.refresh = (options) => refresh({ ...options, allowNetwork: false })
        return runtime
      },
    },
  } as unknown as typeof sdk
  mock.module('./oauth-proxy-scope', () => ({ runWithOAuthProxyScope: async (operation: () => Promise<unknown>) => operation() }))
  mock.module('./adapters/pi-model-registry', () => ({
    ...registry,
    listCodexModels: async (credential: CodexOAuthCredentials) => listCodex(credential, offlineSdk),
    listGithubCopilotModels: async (credential: GithubCopilotOAuthCredentials) => {
      modelReadCalls++
      const models = await listCopilot(credential, offlineSdk)
      await afterCopilotList(credential)
      return models
    },
  }))
  manager = await import('./channel-manager')
})
beforeEach(() => {
  afterCopilotList = async () => undefined
  fetchPolicy = async (credential) => ({ ...credential, access: 'renewed-test-access', expires: Date.now() + 3600000, availableModelIds: ['gpt-5.4'] })
  codexPolicy = async () => ({ access: 'renewed-codex-access', refresh: 'renewed-codex-refresh', expires: Date.now() + 3600000 })
})

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalDev === undefined) delete process.env.PROMA_DEV
  else process.env.PROMA_DEV = originalDev
  rmSync(tempHome, { recursive: true, force: true })
})

function credentials(access = 'test-access'): GithubCopilotOAuthCredentials {
  return { access, refresh: 'test-refresh', expires: Date.now() + 3600000, availableModelIds: ['gpt-5.4'] }
}
function createCopilot() {
  return manager.createChannel({ name: 'Copilot test', provider: 'github-copilot', baseUrl: '',
    apiKey: serializeGithubCopilotCredentials(credentials()), enabled: true,
    models: [{ id: 'gpt-5.4', name: '用户名称', enabled: false }, { id: 'manual-model', name: 'Manual', enabled: true, source: 'manual' }] })
}

describe('渠道模型刷新持久化', () => {
  test('Given Pi utility 的同账号续期先回写 When 主进程策略响应较晚 Then 使用最新策略而不静默丢目录', async () => {
    const channel = createCopilot()
    fetchPolicy = async (credential) => {
      const sdkRenewed = { ...credential, access: 'sdk-winner', expires: Date.now() + 3600000, availableModelIds: ['gpt-5.5'] }
      expect(manager.persistGithubCopilotOAuthCredentials(channel.id, sdkRenewed, credential)).toBe(true)
      return { ...credential, access: 'main-late', expires: Date.now() + 3600000, availableModelIds: ['gpt-5.4'] }
    }
    const result = await manager.refreshSubscriptionModels([channel.id])
    expect(result.issues).toEqual([])
    expect(manager.getChannelById(channel.id)?.models.find((model) => model.id === 'gpt-5.5')).toMatchObject({ enabled: true, source: 'fetched' })
    expect(await manager.decryptApiKey(channel.id)).toContain('sdk-winner')
    expect(await manager.decryptApiKey(channel.id)).not.toContain('main-late')
  })

  test('Given 目录读取期间 Pi utility 再续期 When 凭据代际变化 Then 有限重取最新策略再提交', async () => {
    const channel = createCopilot()
    let replace = true
    afterCopilotList = async (credential) => {
      if (!replace) return
      replace = false
      expect(manager.persistGithubCopilotOAuthCredentials(channel.id, {
        ...credential, access: 'sdk-after-list', availableModelIds: ['gpt-5.5'],
      }, credential)).toBe(true)
    }
    const before = modelReadCalls
    const result = await manager.refreshSubscriptionModels([channel.id])
    expect(result.issues).toEqual([])
    expect(modelReadCalls).toBe(before + 2)
    expect(manager.getChannelById(channel.id)?.models.find((model) => model.id === 'gpt-5.5')).toMatchObject({ enabled: true, source: 'fetched' })
    expect(await manager.decryptApiKey(channel.id)).toContain('sdk-after-list')
  })

  test('Given 凭据持续变化 When 目录尝试三次 Then 明确返回失败并保留原模型而不无限重取', async () => {
    const channel = createCopilot()
    let generation = 0
    afterCopilotList = async (credential) => {
      expect(manager.persistGithubCopilotOAuthCredentials(channel.id, { ...credential, access: `generation-${++generation}` }, credential)).toBe(true)
    }
    const before = modelReadCalls
    const result = await manager.refreshSubscriptionModels([channel.id])
    expect(modelReadCalls).toBe(before + 3)
    expect(result.issues[0]?.requiresAuthorization).toBe(false)
    expect(manager.getChannelById(channel.id)?.models).toEqual(channel.models)
  })

  test('Given token 剩两分钟 When 主进程交给 Pi 前解析 Then 按 SDK 五分钟余量提前续期', async () => {
    const copilot = createCopilot()
    manager.updateChannel(copilot.id, { apiKey: serializeGithubCopilotCredentials({ ...credentials(), expires: Date.now() + 120000 }) })
    const codex = manager.createChannel({ name: 'Codex near expiry', provider: 'openai-codex', baseUrl: '', enabled: true,
      apiKey: serializeCodexCredentials({ access: 'near-expiry', refresh: 'test-refresh', expires: Date.now() + 120000 }), models: [] })
    const beforeCopilot = calls
    const beforeCodex = codexCalls
    const [first, second] = await Promise.all([
      manager.resolveGithubCopilotOAuthCredentials(copilot.id), manager.resolveCodexOAuthCredentials(codex.id),
    ])
    expect(calls).toBe(beforeCopilot + 1)
    expect(codexCalls).toBe(beforeCodex + 1)
    expect(first.access).toBe('renewed-test-access')
    expect(second.access).toBe('renewed-codex-access')
  })

  test('Given 安全存储不可用 When 创建或手动更新订阅凭据 Then 不走通用明文回退', async () => {
    const channel = createCopilot()
    secureStorageAvailable = false
    try {
      for (const provider of ['github-copilot', 'openai-codex'] as const) {
        expect(() => manager.createChannel({ name: 'Must not save', provider, baseUrl: '', enabled: true,
          apiKey: 'must-not-save-secret', models: [] })).toThrow()
      }
      expect(() => manager.updateChannel(channel.id, { apiKey: 'must-not-save-secret' })).toThrow()
      expect(manager.getChannelById(channel.id)).toEqual(channel)
      expect(readFileSync(join(tempHome, '.proma', 'channels.json'), 'utf8')).not.toContain('must-not-save-secret')
    } finally {
      secureStorageAvailable = true
    }
  })

  test('Given Codex 会话与目录同时遇到过期凭据 When 续期 Then 共用一次请求且不丢目录', async () => {
    const channel = manager.createChannel({ name: 'Codex concurrent', provider: 'openai-codex', baseUrl: '', enabled: true,
      apiKey: serializeCodexCredentials({ access: 'expired', refresh: 'test-refresh', expires: 0 }), models: [] })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    codexPolicy = async () => {
      await gate
      return { access: 'concurrent-codex', refresh: 'next-refresh', expires: Date.now() + 3600000 }
    }
    const before = codexCalls
    const session = manager.resolveCodexOAuthCredentials(channel.id)
    const catalog = manager.refreshSubscriptionModels([channel.id])
    expect(codexCalls).toBe(before + 1)
    release()
    const [resolved, result] = await Promise.all([session, catalog])
    expect(codexCalls).toBe(before + 1)
    expect(resolved.access).toBe('concurrent-codex')
    expect(result.issues).toEqual([])
    expect(manager.getChannelById(channel.id)?.models.some((model) => model.id === 'gpt-6-sol')).toBe(true)
  })

  test('Given Codex 旧账号等待续期 When 新账号重新登录并请求 Then 不复用旧锁或覆盖新账号', async () => {
    const channel = manager.createChannel({ name: 'Codex lock switch', provider: 'openai-codex', baseUrl: '', enabled: true,
      apiKey: serializeCodexCredentials({ access: 'old', refresh: 'old-refresh', expires: 0, accountId: 'old-account' }), models: [] })
    let releaseOld!: () => void
    let releaseNew!: () => void
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve })
    const newGate = new Promise<void>((resolve) => { releaseNew = resolve })
    codexPolicy = async (refresh) => {
      await (refresh === 'old-refresh' ? oldGate : newGate)
      return { access: `${refresh}-renewed`, refresh: `${refresh}-next`, expires: Date.now() + 3600000 }
    }
    const before = codexCalls
    const oldRequest = manager.resolveCodexOAuthCredentials(channel.id)
    manager.updateChannel(channel.id, { apiKey: serializeCodexCredentials({ access: 'new', refresh: 'new-refresh', expires: 0, accountId: 'new-account' }) })
    const newRequest = manager.resolveCodexOAuthCredentials(channel.id)
    expect(codexCalls).toBe(before + 2)
    releaseOld()
    await oldRequest
    const joined = manager.resolveCodexOAuthCredentials(channel.id)
    expect(codexCalls).toBe(before + 2)
    releaseNew()
    const [fresh, joinedFresh] = await Promise.all([newRequest, joined])
    expect(fresh.accountId).toBe('new-account')
    expect(joinedFresh).toEqual(fresh)
    expect(await manager.decryptApiKey(channel.id)).toContain('new-refresh-renewed')
    expect(await manager.decryptApiKey(channel.id)).not.toContain('old-refresh-renewed')
  })

  test('Given Copilot 已开始网络续期 When 安全存储随后不可用 Then 停止回写并不保存明文', async () => {
    const channel = createCopilot()
    fetchPolicy = async (credential) => {
      secureStorageAvailable = false
      return { ...credential, access: 'must-not-persist-plaintext', expires: Date.now() + 3600000 }
    }
    try {
      const result = await manager.refreshSubscriptionModels([channel.id])
      expect(result.issues[0]?.message).toContain('安全存储不可用')
      expect(manager.getChannelById(channel.id)).toEqual(channel)
      expect(readFileSync(join(tempHome, '.proma', 'channels.json'), 'utf8')).not.toContain('must-not-persist-plaintext')
    } finally {
      secureStorageAvailable = true
    }
  })

  test('Given 带 Pi type 字段的 Codex 连续运行时回写 When 使用最新凭据快照 Then 保留 accountId 并拒绝旧快照', async () => {
    const initial = { access: 'initial', refresh: 'initial-refresh', expires: Date.now() + 3600000, accountId: 'account' }
    const channel = manager.createChannel({ name: 'Codex runtime CAS', provider: 'openai-codex', baseUrl: '', enabled: true,
      apiKey: serializeCodexCredentials(initial), models: [] })
    const next = { type: 'oauth' as const, access: 'next', refresh: 'next-refresh', expires: Date.now() + 3600000 }
    expect(manager.persistCodexOAuthCredentials(channel.id, next, initial)).toBe(true)
    const snapshot = { ...next, accountId: initial.accountId }
    const latest = { ...snapshot, access: 'latest' }
    expect(manager.persistCodexOAuthCredentials(channel.id, latest, snapshot)).toBe(true)
    expect(manager.persistCodexOAuthCredentials(channel.id, { ...initial, access: 'stale' }, initial)).toBe(false)
    expect(await manager.decryptApiKey(channel.id)).toBe(serializeCodexCredentials(latest))
  })

  test('Given 更高版本配置含已移除的火山套餐 When 读取 Then 清理历史套餐但保留火山 API 与其他渠道', async () => {
    const api = manager.createChannel({ name: 'Volcengine API test', provider: 'doubao-api', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: 'test-api-key', models: [], enabled: true })
    const path = join(tempHome, '.proma', 'channels.json')
    const config = JSON.parse(readFileSync(path, 'utf8')) as { version: number; channels: unknown[] }
    config.version = 99
    config.channels.push({ ...api, id: 'legacy-doubao', provider: 'doubao' }, { ...api, id: 'legacy-ark', provider: 'ark-coding-plan' })
    const { writeJsonFileAtomic } = await import('./safe-file')
    writeJsonFileAtomic(path, config)
    const channels = manager.listChannels()
    expect(channels.some((channel) => channel.id === 'legacy-doubao' || channel.id === 'legacy-ark')).toBe(false)
    expect(channels.find((channel) => channel.id === api.id)).toEqual(api)
  })

  test('Given Codex token 已过期 When 目录刷新 Then 先串行续期再使用新凭据拉取并保持成功缓存', async () => {
    codexPolicy = async () => ({ access: 'renewed-codex-access', refresh: 'renewed-codex-refresh', expires: Date.now() + 3600000 })
    const channel = manager.createChannel({ name: 'Codex expired', provider: 'openai-codex', baseUrl: '', enabled: true,
      apiKey: serializeCodexCredentials({ access: 'expired', refresh: 'test-refresh', expires: 0, accountId: 'test-account' }), models: [] })
    const before = codexCalls
    const result = await manager.refreshSubscriptionModels([channel.id])
    expect(result.issues).toEqual([])
    expect(codexCalls).toBe(before + 1)
    expect(result.channels.find((item) => item.id === channel.id)?.models.some((model) => model.id === 'gpt-6-sol')).toBe(true)
    expect(await manager.decryptApiKey(channel.id)).toContain('renewed-codex-access')
    expect(await manager.decryptApiKey(channel.id)).toContain('test-account')
    expect(readFileSync(join(tempHome, '.proma', 'channels.json'), 'utf8')).not.toContain('renewed-codex-access')
    await manager.refreshSubscriptionModels([channel.id])
    expect(codexCalls).toBe(before + 1)
  })

  test('Given 过期 Copilot 会话先续期 When 同时刷新目录 Then 共用请求且新模型不因旧快照丢失', async () => {
    const channel = createCopilot()
    manager.updateChannel(channel.id, { apiKey: serializeGithubCopilotCredentials({ ...credentials(), expires: 0 }) })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    fetchPolicy = async (credential) => {
      await gate
      return { ...credential, access: 'concurrent-renewed', expires: Date.now() + 3600000, availableModelIds: ['gpt-5.4', 'gpt-5.5'] }
    }
    const before = calls
    const session = manager.resolveGithubCopilotOAuthCredentials(channel.id)
    const catalog = manager.refreshSubscriptionModels([channel.id])
    expect(calls).toBe(before + 1)
    release()
    const [resolved, result] = await Promise.all([session, catalog])
    expect(calls).toBe(before + 1)
    expect(resolved.access).toBe('concurrent-renewed')
    expect(result.issues).toEqual([])
    expect(manager.getChannelById(channel.id)?.models.find((model) => model.id === 'gpt-5.5')).toMatchObject({ enabled: true, source: 'fetched' })
    await manager.refreshSubscriptionModels([channel.id])
    expect(calls).toBe(before + 1)
  })

  test('Given 未过期 Copilot 目录先强制刷新 When 会话同时取凭据 Then 会话等待同一请求并使用新策略', async () => {
    const channel = createCopilot()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    fetchPolicy = async (credential) => {
      await gate
      return { ...credential, access: 'forced-renewed', expires: Date.now() + 3600000, availableModelIds: ['gpt-5.5'] }
    }
    const before = calls
    const catalog = manager.refreshSubscriptionModels([channel.id])
    const session = manager.resolveGithubCopilotOAuthCredentials(channel.id)
    expect(calls).toBe(before + 1)
    release()
    const [result, resolved] = await Promise.all([catalog, session])
    expect(calls).toBe(before + 1)
    expect(forceFlags.at(-1)).toBe(true)
    expect(resolved.access).toBe('forced-renewed')
    expect(resolved.availableModelIds).toEqual(['gpt-5.5'])
    expect(result.issues).toEqual([])
    expect(manager.getChannelById(channel.id)?.models.find((model) => model.id === 'gpt-5.5')).toMatchObject({ enabled: true, source: 'fetched' })
  })

  test('Given 旧账号正在刷新 When 换账号再请求 Then 新账号不复用旧锁且旧响应不释放新锁', async () => {
    const channel = createCopilot()
    manager.updateChannel(channel.id, { apiKey: serializeGithubCopilotCredentials({ ...credentials('old'), expires: 0 }) })
    let releaseOld!: () => void
    let releaseNew!: () => void
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve })
    const newGate = new Promise<void>((resolve) => { releaseNew = resolve })
    fetchPolicy = async (credential) => {
      await (credential.access === 'old' ? oldGate : newGate)
      return { ...credential, access: `${credential.access}-renewed`, expires: Date.now() + 3600000 }
    }
    const before = calls
    const oldRequest = manager.resolveGithubCopilotOAuthCredentials(channel.id)
    manager.updateChannel(channel.id, { apiKey: serializeGithubCopilotCredentials({ ...credentials('new'), refresh: 'new-account-refresh', expires: 0 }) })
    const newRequest = manager.resolveGithubCopilotOAuthCredentials(channel.id)
    expect(calls).toBe(before + 2)
    releaseOld()
    await oldRequest
    const joined = manager.resolveGithubCopilotOAuthCredentials(channel.id)
    expect(calls).toBe(before + 2)
    releaseNew()
    const [fresh, joinedFresh] = await Promise.all([newRequest, joined])
    expect(fresh.access).toBe('new-renewed')
    expect(joinedFresh).toEqual(fresh)
    expect(await manager.decryptApiKey(channel.id)).toContain('new-renewed')
    expect(await manager.decryptApiKey(channel.id)).not.toContain('old-renewed')
  })

  test('Given Copilot 未过期 token When UI 检查 Then 刷新账号策略并加密保存且保留用户模型', async () => {
    fetchPolicy = async (credential) => ({ ...credential, access: 'renewed-test-access', expires: Date.now() + 3600000, availableModelIds: ['gpt-5.4'] })
    const channel = createCopilot()
    const before = calls
    const result = await manager.refreshSubscriptionModels([channel.id])
    expect(result.issues).toEqual([])
    expect(calls).toBe(before + 1)
    expect(forceFlags.at(-1)).toBe(true)
    expect(result.channels.find((item) => item.id === channel.id)?.models).toEqual(channel.models)
    expect(await manager.decryptApiKey(channel.id)).toContain('renewed-test-access')
    expect(readFileSync(join(tempHome, '.proma', 'channels.json'), 'utf8')).not.toContain('renewed-test-access')
    await manager.refreshSubscriptionModels([channel.id])
    expect(calls).toBe(before + 1)
  })

  test('Given Codex 渠道 When 刷新 Then 追加新版允许模型且不重新启用旧模型或恢复下线目录', async () => {
    const channel = manager.createChannel({ name: 'Codex test', provider: 'openai-codex', baseUrl: '', enabled: true,
      apiKey: serializeCodexCredentials({ access: 'test-access', refresh: 'test-refresh', expires: Date.now() + 3600000 }),
      models: [{ id: 'gpt-5.4', name: '我的 GPT', enabled: false }] })
    const result = await manager.refreshSubscriptionModels([channel.id])
    expect(result.issues).toEqual([])
    const saved = result.channels.find((item) => item.id === channel.id)!
    expect(saved.models.find((model) => model.id === 'gpt-5.4')).toEqual(channel.models[0])
    expect(saved.models.find((model) => model.id === 'gpt-6-sol')).toMatchObject({ enabled: true, source: 'fetched' })
    expect(saved.models.some((model) => model.id === 'gpt-5.5')).toBe(false)
  })

  test('Given 当前账号新增可用模型 When 刷新 Then 仅追加 runtime 支持的目录', async () => {
    const channel = createCopilot()
    fetchPolicy = async (credential) => ({ ...credential, availableModelIds: ['gpt-5.4', 'gpt-5.5', 'unknown-runtime-model'] })
    const result = await manager.refreshSubscriptionModels([channel.id])
    expect(result.issues).toEqual([])
    const models = manager.getChannelById(channel.id)!.models
    expect(models.find((model) => model.id === 'gpt-5.4')).toEqual(channel.models[0])
    expect(models.find((model) => model.id === 'gpt-5.5')).toMatchObject({ enabled: true, source: 'fetched' })
    expect(models.some((model) => model.id === 'unknown-runtime-model')).toBe(false)
  })

  test('Given 当前账号返回空目录 When 刷新 Then 视为成功且仍保留既有模型', async () => {
    const channel = createCopilot()
    fetchPolicy = async (credential) => ({ ...credential, availableModelIds: [] })
    const result = await manager.refreshSubscriptionModels([channel.id])
    expect(result.issues).toEqual([])
    expect(manager.getChannelById(channel.id)?.models).toEqual(channel.models)
  })

  test('Given 目录请求失败 When 更新 Then 不清空模型或修改凭据', async () => {
    const channel = createCopilot()
    fetchPolicy = async () => { throw new Error('network failure') }
    const result = await manager.refreshSubscriptionModels([channel.id])
    expect(result.issues[0]?.requiresAuthorization).toBe(false)
    expect(manager.getChannelById(channel.id)).toEqual(channel)
  })

  test('Given Pi 包装的 401 When 多次打开 Then 提示重新授权且不再次读取账号策略', async () => {
    const channel = createCopilot()
    fetchPolicy = async () => { throw new Error('OAuth refresh failed', { cause: new Error('401 Unauthorized') }) }
    const result = await manager.refreshSubscriptionModels([channel.id])
    const afterFailure = calls
    expect(result.issues[0]?.requiresAuthorization).toBe(true)
    await manager.refreshSubscriptionModels([channel.id])
    expect(calls).toBe(afterFailure)
    expect(manager.getChannelById(channel.id)).toEqual(channel)
  })

  test('Given 刷新期间修改 enabled When 响应到达 Then 保存最新用户状态', async () => {
    const channel = createCopilot()
    fetchPolicy = async (credential) => {
      manager.updateChannel(channel.id, { models: [{ id: 'gpt-5.4', name: '更新名称', enabled: true }] })
      return credential
    }
    await manager.refreshSubscriptionModels([channel.id])
    expect(manager.getChannelById(channel.id)?.models).toEqual([{ id: 'gpt-5.4', name: '更新名称', enabled: true }])
  })

  test('Given 刷新期间切换账号 When 旧响应到达 Then 不覆盖新账号凭据或模型', async () => {
    const channel = createCopilot()
    const next = { ...credentials('new-account-access'), refresh: 'new-account-refresh' }
    fetchPolicy = async (credential) => {
      manager.updateChannel(channel.id, { apiKey: serializeGithubCopilotCredentials(next), models: [] })
      return { ...credential, access: 'old-account-renewed' }
    }
    await manager.refreshSubscriptionModels([channel.id])
    expect(await manager.decryptApiKey(channel.id)).toBe(serializeGithubCopilotCredentials(next))
    expect(manager.getChannelById(channel.id)?.models).toEqual([])
  })

  test('Given Codex 刷新期间重新登录 When 旧凭据请求回写 Then 保留新账号', async () => {
    const original = { access: 'old', refresh: 'old-refresh', expires: 1 }
    const next = { access: 'new', refresh: 'new-refresh', expires: Date.now() + 3600000 }
    const channel = manager.createChannel({ name: 'Codex switch', provider: 'openai-codex', baseUrl: '', enabled: true,
      apiKey: serializeCodexCredentials(next), models: [] })
    expect(manager.persistCodexOAuthCredentials(channel.id, { ...original, access: 'renewed-old' }, original)).toBe(false)
    expect(await manager.decryptApiKey(channel.id)).toBe(serializeCodexCredentials(next))
  })

  test('Given 系统安全存储不可用 When 自动检查 Then 不读取供应商或明文保存凭据', async () => {
    const channel = createCopilot()
    const before = calls
    secureStorageAvailable = false
    try {
      const result = await manager.refreshSubscriptionModels([channel.id])
      expect(result.issues[0]?.message).toContain('安全存储不可用')
      expect(calls).toBe(before)
      expect(manager.getChannelById(channel.id)).toEqual(channel)
    } finally {
      secureStorageAvailable = true
    }
  })
})
