import type { Api, Model } from '@earendil-works/pi-ai/compat'

/** 目录更新不能把其他协议、缺失元数据的模型当作 Codex 可执行模型。 */
export function isCompatibleCodexCatalogModel(model: Model<Api>): boolean {
  return model.provider === 'openai-codex'
    && model.api === 'openai-codex-responses'
    && Boolean(model.id.trim() && model.name.trim() && model.baseUrl)
    && model.input.includes('text')
    && Number.isFinite(model.contextWindow) && model.contextWindow > 0
    && Number.isFinite(model.maxTokens) && model.maxTokens > 0
}
