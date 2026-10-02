import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GithubCopilotOAuthCredentials } from '@proma/shared'
import { serializeCodexCredentials, serializeGithubCopilotCredentials } from '@proma/shared'

const tempHome = mkdtempSync(join(tmpdir(), 'proma-model-refresh-'))
const originalHome = process.env.HOME
const originalDev = process.env.PROMA_DEV
let secureStorageAvailable = true
let calls = 0
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
    expect(force).toBe(true)
    calls++
    return fetchPolicy(credential)
  },
}))

let manager: typeof import('./channel-manager')
beforeAll(async () => {
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'
  const paths = await import('./config-paths')
  // 安全断言必须先于任何创建或读写，不能只依赖运行时可能缓存的 HOME。
  expect(paths.getChannelsPath()).toBe(join(tempHome, '.proma', 'channels.json'))
  manager = await import('./channel-manager')
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
  test('Given Copilot 未过期 token When UI 检查 Then 刷新账号策略并加密保存且保留用户模型', async () => {
    const channel = createCopilot()
    const before = calls
    const result = await manager.refreshSubscriptionModels([channel.id])
    expect(result.issues).toEqual([])
    expect(calls).toBe(before + 1)
    expect(result.channels.find((item) => item.id === channel.id)?.models).toEqual(channel.models)
    expect(await manager.decryptApiKey(channel.id)).toContain('renewed-test-access')
    expect(readFileSync(join(tempHome, '.proma', 'channels.json'), 'utf8')).not.toContain('renewed-test-access')
    await manager.refreshSubscriptionModels([channel.id])
    expect(calls).toBe(before + 1)
  })

  test('Given Codex 渠道 When 刷新 Then 追加完整兼容的 gpt-5.5 且不重新启用旧模型', async () => {
    const channel = manager.createChannel({ name: 'Codex test', provider: 'openai-codex', baseUrl: '', enabled: true,
      apiKey: serializeCodexCredentials({ access: 'test-access', refresh: 'test-refresh', expires: Date.now() + 3600000 }),
      models: [{ id: 'gpt-5.4', name: '我的 GPT', enabled: false }] })
    const result = await manager.refreshSubscriptionModels([channel.id])
    expect(result.issues).toEqual([])
    const saved = result.channels.find((item) => item.id === channel.id)!
    expect(saved.models.find((model) => model.id === 'gpt-5.4')).toEqual(channel.models[0])
    expect(saved.models.find((model) => model.id === 'gpt-5.5')).toMatchObject({ enabled: true, source: 'fetched' })
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
    const next = credentials('new-account-access')
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
    manager.persistCodexOAuthCredentials(channel.id, { ...original, access: 'renewed-old' }, original)
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
