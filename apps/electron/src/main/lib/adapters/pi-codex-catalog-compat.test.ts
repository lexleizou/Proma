import { describe, expect, test } from 'bun:test'
import type { Api, Model } from '@earendil-works/pi-ai/compat'
import { isCompatibleCodexCatalogModel } from './pi-codex-catalog-compat'
import { buildCodexModel, getCodexCatalogModels, listCodexModels } from './pi-model-registry'

const model: Model<Api> = {
  id: 'gpt-5.5', name: 'GPT-5.5', api: 'openai-codex-responses', provider: 'openai-codex',
  baseUrl: 'https://chatgpt.com/backend-api', reasoning: true, input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 128000,
}

describe('Codex 目录运行时兼容性', () => {
  test('Given 正确的 Codex 协议和元数据 When 校验 Then 接受模型', () => {
    expect(isCompatibleCodexCatalogModel(model)).toBe(true)
  })
  test('Given 其他协议或缺失元数据 When 校验 Then 不加入可用目录', () => {
    for (const candidate of [
      { ...model, api: 'openai-responses' as const }, { ...model, provider: 'openai' },
      { ...model, contextWindow: 0 }, { ...model, maxTokens: NaN },
      { ...model, input: ['image'] as ('text' | 'image')[] }, { ...model, baseUrl: '' },
    ]) expect(isCompatibleCodexCatalogModel(candidate)).toBe(false)
  })
  test('Given 捆绑 Pi 目录 When 拉取 Codex Then 包含完整兼容的 gpt-5.5', async () => {
    const catalog = await getCodexCatalogModels()
    expect(catalog.every(isCompatibleCodexCatalogModel)).toBe(true)
    expect(catalog.find((candidate) => candidate.id === 'gpt-5.5')).toMatchObject({
      api: 'openai-codex-responses', provider: 'openai-codex', input: ['text', 'image'], reasoning: true,
    })
    expect(await listCodexModels()).toContainEqual({ id: 'gpt-5.5', name: 'GPT-5.5' })
  })
  test('Given runtime 缺少 gpt-5.5 When 构建模型 Then 使用完整补丁而非通用 API 协议', async () => {
    const runtime = { getModels: () => [] }
    const sdk = { ModelRuntime: { create: async () => runtime } } as unknown as typeof import('@earendil-works/pi-coding-agent')
    const result = await buildCodexModel(sdk, {
      model: 'gpt-5.5', codexOAuthCredentials: { access: 'test', refresh: 'test', expires: Date.now() + 3600000 },
    })
    expect(result.model.id).toBe('gpt-5.5')
    expect(isCompatibleCodexCatalogModel(result.model)).toBe(true)
    expect(result.modelRuntime.getModels('openai-codex')).toEqual([])
  })
  test('Given runtime 目录错误地使用通用协议 When 选择 gpt-5.5 Then 忽略错误条目', async () => {
    const sdk = { ModelRuntime: { create: async () => ({ getModels: () => [{ ...model, api: 'openai-responses' }] }) } } as unknown as typeof import('@earendil-works/pi-coding-agent')
    const result = await buildCodexModel(sdk, {
      model: 'gpt-5.5', codexOAuthCredentials: { access: 'test', refresh: 'test', expires: Date.now() + 3600000 },
    })
    expect(result.model.api).toBe('openai-codex-responses')
  })
})
