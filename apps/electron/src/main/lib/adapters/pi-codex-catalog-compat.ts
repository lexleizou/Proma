import { CODEX_GPT_61_SOL_CONTEXT_WINDOW, isGpt61SolModel } from '@proma/shared'
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

/**
 * 保留原本机补丁的精确模型能力，完整继承捆绑 Sol 的协议、工具与输入限制。
 * 原生目录将来包含此 ID 时不覆盖其新元数据；此补丁不代表账号可用性授权。
 */
export function withLocalCodexSolCompatibility(models: readonly Model<Api>[]): Model<Api>[] {
  if (models.some((model) => isGpt61SolModel(model.id))) return [...models]
  const baseline = models.find((model) => model.id === 'gpt-6-sol')
  if (!baseline || !isCompatibleCodexCatalogModel(baseline)) return [...models]
  return [...models, {
    ...baseline,
    id: 'gpt-6.1-sol',
    name: 'GPT-6.1 Sol',
    contextWindow: CODEX_GPT_61_SOL_CONTEXT_WINDOW,
    thinkingLevelMap: {
      off: 'low', minimal: 'low', low: 'low', medium: 'medium',
      high: 'high', xhigh: 'xhigh', max: 'max',
    },
    // 沿用本机补丁的缓存费用估值，不表示供应商当前报价。
    cost: {
      ...baseline.cost,
      cacheRead: 0.1,
      ...(baseline.cost.tiers ? { tiers: baseline.cost.tiers.map((tier) => ({ ...tier, cacheRead: 0.2 })) } : {}),
    },
  }]
}
