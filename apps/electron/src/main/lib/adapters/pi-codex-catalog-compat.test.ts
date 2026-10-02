import { describe, expect, test } from 'bun:test'
import type { Api, Model } from '@earendil-works/pi-ai/compat'
import { isCompatibleCodexCatalogModel, withLocalCodexSolCompatibility } from './pi-codex-catalog-compat'
import { buildCodexModel, getCodexCatalogModels, listCodexModels } from './pi-model-registry'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')
const model: Model<Api> = {
  id: 'gpt-6-sol', name: 'GPT-6 Sol', api: 'openai-codex-responses', provider: 'openai-codex',
  baseUrl: 'https://chatgpt.com/backend-api', reasoning: true, input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 128000,
}
const credentials = { access: 'test', refresh: 'test', expires: Date.now() + 3600000 }

function runtimeSdk(models: Model<Api>[]): PiSdk {
  return { ModelRuntime: { create: async () => ({ getModels: () => models }) } } as unknown as PiSdk
}

describe('Codex 目录运行时兼容性', () => {
  test('Given 捆绑 Sol 目录 When 添加本机兼容项 Then 不修改原模型且完整复制工具元数据', () => {
    const snapshot = JSON.stringify(model)
    const catalog = withLocalCodexSolCompatibility([model])
    expect(catalog).toHaveLength(2)
    expect(JSON.stringify(model)).toBe(snapshot)
    expect(catalog[1]?.id).toBe('gpt-6.1-sol')
  })
  test('Given 原生目录已有本机模型 ID When 应用兼容项 Then 不覆盖原生新元数据', () => {
    const native = { ...model, id: 'gpt-6.1-sol', name: 'Native Sol', contextWindow: 512000 }
    const catalog = withLocalCodexSolCompatibility([model, native])
    expect(catalog).toHaveLength(2)
    expect(catalog[1]).toBe(native)
  })
  test('Given 无捆绑 Sol 或其协议无效 When 添加兼容项 Then 不捏造运行时模型', () => {
    expect(withLocalCodexSolCompatibility([])).toEqual([])
    const invalid = { ...model, api: 'openai-responses' as const }
    expect(withLocalCodexSolCompatibility([invalid])).toEqual([invalid])
  })
  test('Given 正确的 Codex 协议和元数据 When 校验 Then 接受模型', () => {
    expect(isCompatibleCodexCatalogModel(model)).toBe(true)
  })
  test('Given 其他协议或缺失元数据 When 校验 Then 不加入可用目录', () => {
    for (const candidate of [
      { ...model, api: 'openai-responses' as const }, { ...model, provider: 'openai' },
      { ...model, contextWindow: 0 }, { ...model, maxTokens: NaN },
      { ...model, input: ['image'] as ('text' | 'image')[] }, { ...model, baseUrl: '' },
      { ...model, input: undefined } as unknown as Model<Api>,
      { ...model, cost: undefined } as unknown as Model<Api>,
      { ...model, id: undefined } as unknown as Model<Api>,
      { ...model, cost: { ...model.cost, input: NaN } },
    ]) expect(isCompatibleCodexCatalogModel(candidate)).toBe(false)
  })
  test('Given 最新捆绑 Pi 目录 When 拉取 Codex Then 校验元数据并保留上游下线过滤', async () => {
    const catalog = await getCodexCatalogModels()
    expect(catalog.every(isCompatibleCodexCatalogModel)).toBe(true)
    expect(catalog.find((candidate) => candidate.id === 'gpt-6-sol')).toMatchObject({
      api: 'openai-codex-responses', provider: 'openai-codex', input: ['text', 'image'], reasoning: true,
    })
    expect(catalog.some((candidate) => /^gpt-5\.[45](?:-|$)/.test(candidate.id))).toBe(false)
    expect(catalog.some((candidate) => candidate.id === 'gpt-5.3-codex-spark')).toBe(false)
  })
  test('Given runtime 缺少允许模型 When 构建模型 Then 使用完整兼容的新版目录', async () => {
    const result = await buildCodexModel(runtimeSdk([]), { model: 'gpt-6-sol', codexOAuthCredentials: credentials })
    expect(result.model.id).toBe('gpt-6-sol')
    expect(isCompatibleCodexCatalogModel(result.model)).toBe(true)
  })
  test('Given 存量本机兼容模型不在 SDK runtime When 构建 Then 使用完整 Sol 元数据及原本机能力', async () => {
    const result = await buildCodexModel(runtimeSdk([]), { model: 'gpt-6.1-sol', codexOAuthCredentials: credentials })
    expect(result.model).toMatchObject({
      id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', contextWindow: 272000, maxTokens: 128000,
      api: 'openai-codex-responses', provider: 'openai-codex', input: ['text', 'image'],
      thinkingLevelMap: { off: 'low', minimal: 'low', low: 'low', high: 'high', max: 'max' },
      compat: { supportsOpenAIGrammarTools: true, supportsToolSearch: true },
      cost: { cacheRead: 0.1 },
    })
    expect(isCompatibleCodexCatalogModel(result.model)).toBe(true)
    expect(result.model.inputLimits?.images?.resize).toBeDefined()
    expect(result.model.cost.tiers?.[0]?.cacheRead).toBe(0.2)
  })
  test('Given 未核验的本机模型近似 ID When 构建 Then 拒绝推测其他型号', async () => {
    await expect(buildCodexModel(runtimeSdk([]), { model: 'gpt-6.1-sol-mini', codexOAuthCredentials: credentials }))
      .rejects.toThrow('未找到指定的 ChatGPT (Codex) 模型')
  })
  test('Given runtime 目录使用通用协议 When 选择模型 Then 保留目录优先及正确 Codex 协议', async () => {
    const result = await buildCodexModel(runtimeSdk([{ ...model, api: 'openai-responses' }]), {
      model: 'gpt-6-sol', codexOAuthCredentials: credentials,
    })
    expect(result.model.api).toBe('openai-codex-responses')
  })
  test('Given 上游已移除模型或未知 ID When 构建模型 Then 不借 runtime 条目绕过限制', async () => {
    for (const id of ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5', 'gpt-5.5-mini', 'gpt-5.3-codex-spark', 'unknown-model']) {
      const sdk = runtimeSdk(id === 'unknown-model' ? [] : [{ ...model, id }])
      await expect(buildCodexModel(sdk, { model: id, codexOAuthCredentials: credentials }))
        .rejects.toThrow('未找到指定的 ChatGPT (Codex) 模型')
    }
  })
  test('Given Astra SKU 不在 runtime 中 When 构建模型 Then 保留上游的精确家族回退', async () => {
    const result = await buildCodexModel(runtimeSdk([]), {
      model: 'gpt-6-astra-codex', codexOAuthCredentials: credentials,
    })
    expect(result.model.id).toBe('gpt-6-astra-codex')
    expect(isCompatibleCodexCatalogModel(result.model)).toBe(true)
  })
  test('Given 账号只允许目录子集 When 拉取模型 Then 传入完整凭据且不追加静态补丁模型', async () => {
    const sdk = { ModelRuntime: { create: async (input: {
      modelsPath: string | null
      credentials: { read: (provider: string) => Promise<unknown> }
    }) => {
      expect(input.modelsPath).toBeNull()
      expect(await input.credentials.read('openai-codex')).toEqual({ type: 'oauth', ...credentials })
      return { getAvailable: async (provider: string) => {
        expect(provider).toBe('openai-codex')
        return [model, { ...model, id: 'gpt-5.5' }, { ...model, id: 'invalid', api: 'openai-responses' }]
      } }
    } } } as unknown as PiSdk
    expect(await listCodexModels(credentials, sdk)).toEqual([{ id: 'gpt-6-sol', name: 'GPT-6 Sol' }])
  })
  test('Given 账号没有可用模型 When 拉取目录 Then 空目录是成功结果', async () => {
    const sdk = { ModelRuntime: { create: async () => ({ getAvailable: async () => [] }) } } as unknown as PiSdk
    expect(await listCodexModels(credentials, sdk)).toEqual([])
  })
})
