import type { Channel, ChannelModel, SubscriptionModelRefreshIssue } from '@proma/shared'

export const SUBSCRIPTION_MODEL_CACHE_MS = 60 * 60 * 1000
export const SUBSCRIPTION_MODEL_RETRY_MS = 5 * 60 * 1000

export function isRefreshableSubscription(channel: Channel): boolean {
  return channel.provider === 'github-copilot' || channel.provider === 'openai-codex'
}

/** 只追加新模型；名称、手动条目和既有 enabled 均由用户掌控。 */
export function appendSubscriptionModels(existing: readonly ChannelModel[], fetched: readonly ChannelModel[]): ChannelModel[] {
  const result = [...existing]
  const known = new Set(existing.map((model) => model.id))
  for (const model of fetched) {
    if (!model.id.trim() || known.has(model.id)) continue
    known.add(model.id)
    result.push({ ...model, enabled: true, source: 'fetched' })
  }
  return result
}

export class SubscriptionAuthorizationError extends Error {}
export class SubscriptionSecureStorageError extends Error {}

/** Pi 的 ModelsError 会包装供应商 401 等原因，必须检查 cause 链而不是只看顶层消息。 */
export function isSubscriptionAuthorizationFailure(error: unknown): boolean {
  const visited = new Set<object>()
  let current = error
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current)
    if (current instanceof SubscriptionAuthorizationError) return true
    const details = current as { message?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown }
    if (details.status === 401 || details.status === 403 || details.statusCode === 401 || details.statusCode === 403) return true
    if (typeof details.message === 'string'
      && /\b(?:401|403|invalid_grant|invalid_token|refresh_token_reused|token_expired)\b|unauthorized|重新登录/i.test(details.message)) return true
    current = details.cause
  }
  return false
}

export interface LoadedSubscriptionModels {
  models: ChannelModel[]
  /** 仅在主进程内传递，提交时使用 safeStorage 加密，绝不经 IPC 返回。 */
  refreshedSecret?: string
  /** 使用已有串行续期流程时，其安全回写后的密文。 */
  expectedApiKey?: string
}

interface RefreshDependencies {
  load: (channel: Channel) => Promise<LoadedSubscriptionModels>
  /** 返回 undefined 表示渠道已删除或切换账号，应丢弃旧请求结果。 */
  commit: (channel: Channel, loaded: LoadedSubscriptionModels) => Channel | undefined
  now?: () => number
}

interface CacheEntry {
  credentialKey: string
  expiresAt: number
  issue?: SubscriptionModelRefreshIssue
}

interface InflightEntry {
  credentialKey: string
  promise: Promise<SubscriptionModelRefreshIssue | undefined>
}

/** 只响应 UI 的按需请求，没有定时器，也不会调用交互式登录。 */
export function createSubscriptionModelRefresher(dependencies: RefreshDependencies) {
  const cache = new Map<string, CacheEntry>()
  const inflight = new Map<string, InflightEntry>()
  const now = dependencies.now ?? Date.now
  const credentialKey = (channel: Channel): string => `${channel.provider}:${channel.apiKey}`

  async function refresh(channel: Channel): Promise<SubscriptionModelRefreshIssue | undefined> {
    if (!isRefreshableSubscription(channel)) return undefined
    const key = credentialKey(channel)
    const cached = cache.get(channel.id)
    if (cached?.credentialKey === key && now() < cached.expiresAt) return cached.issue
    const pending = inflight.get(channel.id)
    if (pending?.credentialKey === key) return pending.promise

    const promise = (async (): Promise<SubscriptionModelRefreshIssue | undefined> => {
      try {
        const loaded = await dependencies.load(channel)
        const saved = dependencies.commit(channel, loaded)
        if (!saved) return undefined
        cache.set(channel.id, { credentialKey: credentialKey(saved), expiresAt: now() + SUBSCRIPTION_MODEL_CACHE_MS })
        return undefined
      } catch (error) {
        if (inflight.get(channel.id)?.credentialKey !== key) return undefined
        const requiresAuthorization = error instanceof SubscriptionAuthorizationError
        const issue: SubscriptionModelRefreshIssue = {
          channelId: channel.id,
          channelName: channel.name,
          requiresAuthorization,
          message: requiresAuthorization
            ? '登录已失效，请到渠道设置重新授权；仍保留上次成功的模型列表。'
            : error instanceof SubscriptionSecureStorageError
              ? '系统安全存储不可用，已暂停刷新以避免明文保存凭据；仍使用上次成功的列表。'
              : '模型目录暂时无法更新，仍使用上次成功的列表；稍后打开时重试。',
        }
        cache.set(channel.id, {
          credentialKey: key,
          expiresAt: requiresAuthorization ? Infinity : now() + SUBSCRIPTION_MODEL_RETRY_MS,
          issue,
        })
        return issue
      } finally {
        if (inflight.get(channel.id)?.credentialKey === key) inflight.delete(channel.id)
      }
    })()
    inflight.set(channel.id, { credentialKey: key, promise })
    return promise
  }

  /** 保存账号变化后失效；只改模型 enabled 不会触发供应商请求。 */
  function invalidate(channelId: string): void {
    cache.delete(channelId)
  }

  return { refresh, invalidate }
}
