/**
 * GPT-6 model-family recognition shared by channel, runtime, and UI code.
 *
 * Astra can carry hyphenated SKU suffixes returned by Codex. Sol and Luna are
 * exact IDs so nearby names are never routed as an official model by mistake.
 */
const GPT_6_ASTRA_FAMILY_PATTERN = /^gpt-6-astra(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/
const GPT_6_SOL_MODEL_ID = 'gpt-6-sol'
const GPT_6_LUNA_MODEL_ID = 'gpt-6-luna'
/** 仅保留已验证的本机兼容项，不据此推断其他 6.1 型号。 */
const LOCAL_GPT_61_SOL_MODEL_ID = 'gpt-6.1-sol'

function normalizeModelId(modelId: string | undefined): string | undefined {
  return modelId?.trim().toLowerCase().replace(/\[1m\]$/i, '')
}

export function isGpt6AstraFamily(modelId: string | undefined): boolean {
  const normalized = normalizeModelId(modelId)
  return normalized !== undefined && GPT_6_ASTRA_FAMILY_PATTERN.test(normalized)
}

export function isGpt6SolFamily(modelId: string | undefined): boolean {
  return normalizeModelId(modelId) === GPT_6_SOL_MODEL_ID
}

export function isGpt6LunaFamily(modelId: string | undefined): boolean {
  return normalizeModelId(modelId) === GPT_6_LUNA_MODEL_ID
}

/** 本机 GPT-6.1 Sol 补丁使用独立能力，不属于旧 Sol/Luna 家族。 */
export function isGpt61SolModel(modelId: string | undefined): boolean {
  return normalizeModelId(modelId) === LOCAL_GPT_61_SOL_MODEL_ID
}
