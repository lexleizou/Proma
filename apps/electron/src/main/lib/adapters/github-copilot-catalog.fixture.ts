import { describe, expect, mock, test } from 'bun:test'
import type { Api, Model } from '@earendil-works/pi-ai/compat'
import type { GithubCopilotOAuthCredentials } from '@proma/shared'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')
let scopeCalls = 0
mock.module('../oauth-proxy-scope', () => ({
  runWithOAuthProxyScope: async (operation: () => Promise<unknown>) => { scopeCalls++; return operation() },
}))
const { buildGithubCopilotModel, listGithubCopilotModels } = await import('./pi-model-registry')
const oldModel: Model<Api> = {
  id: 'claude-sonnet-5', name: 'Claude Sonnet 5', provider: 'github-copilot', api: 'anthropic-messages',
  baseUrl: 'https://api.individual.githubcopilot.com', reasoning: true, input: ['text', 'image'],
  contextWindow: 1000000, maxTokens: 128000, cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
}
const newModel: Model<Api> = {
  ...oldModel, id: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5',
  compat: { forceAdaptiveThinking: true, supportsTemperature: false },
}
function credentials(ids = [newModel.id]): GithubCopilotOAuthCredentials {
  return { access: 'synthetic-access', refresh: 'synthetic-refresh', expires: Date.now() + 3600000, availableModelIds: ids }
}
function fixture(options: { failure?: Error; aborted?: boolean; remote?: Model<Api>[]; renewedIds?: string[]; revoked?: boolean } = {}) {
  let refreshCalls = 0
  const sdk = { ModelRuntime: { create: async (input: Parameters<PiSdk['ModelRuntime']['create']>[0]) => {
    expect(input?.modelsPath).toBeNull()
    expect(input?.allowModelNetwork).toBe(false)
    if (!input?.credentials) throw new Error('必须使用内存凭据')
    const store = input.credentials
    let models = [oldModel]
    return {
      getAvailable: async (provider: string) => {
        expect(provider).toBe('github-copilot')
        if (options.renewedIds) {
          await store.modify(provider, async (current) => current ? { ...current, availableModelIds: options.renewedIds } : undefined)
        }
        const current = await store.read(provider)
        const ids = current && 'availableModelIds' in current ? current.availableModelIds : []
        return models.filter(model => Array.isArray(ids) && ids.includes(model.id))
      },
      refresh: async (request: { providers: string[]; allowNetwork: boolean; force: boolean; signal: AbortSignal }) => {
        refreshCalls++
        expect(request.providers).toEqual(['github-copilot'])
        expect(request.allowNetwork).toBe(true)
        expect(request.force).toBe(true)
        expect(request.signal).toBeInstanceOf(AbortSignal)
        if (options.revoked) await store.modify('github-copilot', async (current) => current ? { ...current, availableModelIds: [] } : undefined)
        if (!options.failure && !options.aborted) models = [oldModel, ...(options.remote ?? [newModel])]
        return { aborted: options.aborted ?? false, errors: new Map(options.failure ? [['github-copilot', options.failure]] : []) }
      },
    }
  } } } as unknown as PiSdk
  return { sdk, refreshCalls: () => refreshCalls }
}

describe('Copilot 按需在线目录与账号权限', () => {
  test('Given 账号允许SDK新型号 When 获取列表 Then 在线元数据补齐Sonnet5.5并使用代理scope', async () => {
    const f = fixture(); const before = scopeCalls
    expect(await listGithubCopilotModels(credentials(), f.sdk)).toEqual([{ id: newModel.id, name: newModel.name }])
    expect(f.refreshCalls()).toBe(1)
    expect(scopeCalls).toBe(before + 1)
  })
  test('Given 目录包含但账号不允许新型号 When 获取列表 Then 不突破账号名单', async () => {
    const f = fixture()
    expect(await listGithubCopilotModels(credentials([oldModel.id]), f.sdk)).toEqual([{ id: oldModel.id, name: oldModel.name }])
  })
  test('Given 账号允许的新型号 When 构建 Then 使用远程完整协议与thinking元数据', async () => {
    const f = fixture()
    const result = await buildGithubCopilotModel(f.sdk, { model: newModel.id, githubCopilotOAuthCredentials: credentials() })
    expect(result.model).toBe(newModel)
    expect(result.model.api).toBe('anthropic-messages')
    expect(result.model.compat).toMatchObject({ forceAdaptiveThinking: true, supportsTemperature: false })
    expect(f.refreshCalls()).toBe(1)
  })
  test('Given 已知型号 When 构建 Then 不依赖在线目录可用性', async () => {
    const f = fixture({ failure: new Error('offline') })
    expect((await buildGithubCopilotModel(f.sdk, { model: oldModel.id, githubCopilotOAuthCredentials: credentials([oldModel.id]) })).model).toBe(oldModel)
    expect(f.refreshCalls()).toBe(0)
  })
  test('Given 账号不允许 When 构建新型号 Then 不访问在线目录也不授权模型', async () => {
    const f = fixture()
    await expect(buildGithubCopilotModel(f.sdk, { model: newModel.id, githubCopilotOAuthCredentials: credentials([oldModel.id]) })).rejects.toThrow('当前订阅不支持')
    expect(f.refreshCalls()).toBe(0)
  })
  test('Given SDK续签改变账号名单 When 构建 Then 使用最新内存名单而非输入快照', async () => {
    const f = fixture({ renewedIds: [newModel.id] })
    expect((await buildGithubCopilotModel(f.sdk, { model: newModel.id, githubCopilotOAuthCredentials: credentials([oldModel.id]) })).model).toBe(newModel)
  })
  test('Given 目录刷新期间账号撤销权限 When 构建 Then 不运行模型也不误报仍已授权', async () => {
    const f = fixture({ revoked: true })
    await expect(buildGithubCopilotModel(f.sdk, { model: newModel.id, githubCopilotOAuthCredentials: credentials() })).rejects.toThrow('当前订阅不支持')
  })
  test('Given 账号允许但在线目录缺元数据 When 获取或构建 Then 不静默丢弃且不假称账号无权限', async () => {
    const f = fixture({ remote: [] })
    await expect(listGithubCopilotModels(credentials(), f.sdk)).rejects.toThrow('元数据')
    await expect(buildGithubCopilotModel(f.sdk, { model: newModel.id, githubCopilotOAuthCredentials: credentials() })).rejects.toThrow('账号已允许')
  })
  test('Given 不支持的协议或不完整元数据 When 获取 Then 不发布不可执行模型', async () => {
    for (const model of [
      { ...newModel, api: 'openai-codex-responses' as const }, { ...newModel, contextWindow: 0 },
      { ...newModel, cost: undefined } as unknown as Model<Api>,
    ]) {
      const f = fixture({ remote: [model] })
      await expect(listGithubCopilotModels(credentials(), f.sdk)).rejects.toThrow('元数据')
    }
  })
  test('Given 在线目录失败或超时 When 获取 Then 明确失败不假称刷新成功', async () => {
    for (const option of [{ failure: new Error('503') }, { aborted: true }]) {
      const f = fixture(option)
      await expect(listGithubCopilotModels(credentials(), f.sdk)).rejects.toThrow('模型目录')
    }
  })
})
