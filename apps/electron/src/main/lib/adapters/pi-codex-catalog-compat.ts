import type { Api, Model } from '@earendil-works/pi-ai/compat'

/** 目录更新不能把其他协议、缺失元数据的模型当作 Codex 可执行模型。 */
export function isCompatibleCodexCatalogModel(model: Model<Api>): boolean {
  return model.provider === 'openai-codex'
    && model.api === 'openai-codex-responses'
    && typeof model.id === 'string' && Boolean(model.id.trim())
    && typeof model.name === 'string' && Boolean(model.name.trim())
    && typeof model.baseUrl === 'string' && Boolean(model.baseUrl.trim())
    && Array.isArray(model.input) && model.input.includes('text')
    && Boolean(model.cost)
    && [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].every(Number.isFinite)
    && Number.isFinite(model.contextWindow) && model.contextWindow > 0
    && Number.isFinite(model.maxTokens) && model.maxTokens > 0
}
