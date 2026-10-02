import { describe, expect, test } from 'bun:test'
import type { Channel, ChannelModel } from '@proma/shared'
import {
  appendSubscriptionModels,
  createSubscriptionModelRefresher,
  isSubscriptionAuthorizationFailure,
  SubscriptionAuthorizationError,
  SUBSCRIPTION_MODEL_CACHE_MS,
  SUBSCRIPTION_MODEL_RETRY_MS,
} from './subscription-model-refresh'
import type { LoadedSubscriptionModels } from './subscription-model-refresh'

function channel(overrides: Partial<Channel> = {}): Channel {
  return { id: 'channel', name: 'Copilot', provider: 'github-copilot', baseUrl: '', apiKey: 'encrypted-a',
    models: [{ id: 'old', name: '我的名称', enabled: false }], enabled: true, createdAt: 0, updatedAt: 0, ...overrides }
}
const fetched: ChannelModel[] = [{ id: 'new', name: 'New', enabled: true }]

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('订阅模型按需刷新', () => {
  test('Given Pi 包装的 OAuth 错误 When 检查 cause Then 区分授权失效与网络故障', () => {
    expect(isSubscriptionAuthorizationFailure(new Error('OAuth refresh failed', { cause: new Error('401 Unauthorized') }))).toBe(true)
    expect(isSubscriptionAuthorizationFailure({ status: 403 })).toBe(true)
    expect(isSubscriptionAuthorizationFailure(new Error('invalid_grant'))).toBe(true)
    expect(isSubscriptionAuthorizationFailure(new Error('OAuth refresh failed', { cause: new Error('500 network') }))).toBe(false)
    const cyclic: { cause?: unknown } = {}
    cyclic.cause = cyclic
    expect(isSubscriptionAuthorizationFailure(cyclic)).toBe(false)
  })

  test('Given 已关闭模型和手动模型 When 追加目录 Then 只增加唯一新模型并保留旧配置', () => {
    const existing = [...channel().models, { id: 'manual', name: 'Manual', enabled: true, source: 'manual' as const }]
    expect(appendSubscriptionModels(existing, [{ id: 'old', name: 'Renamed', enabled: true }, ...fetched, ...fetched]))
      .toEqual([...existing, { ...fetched[0]!, source: 'fetched' }])
    expect(existing).toHaveLength(2)
    expect(appendSubscriptionModels(existing, [])).toEqual(existing)
  })

  test('Given 多个同时打开请求 When 缓存有效 Then 只读取一次并在 TTL 后刷新', async () => {
    let time = 0
    let calls = 0
    const wait = deferred<LoadedSubscriptionModels>()
    const refresher = createSubscriptionModelRefresher({ now: () => time,
      load: async () => { calls++; return wait.promise }, commit: (snapshot) => snapshot })
    const a = refresher.refresh(channel())
    const b = refresher.refresh(channel())
    expect(calls).toBe(1)
    wait.resolve({ models: fetched })
    await Promise.all([a, b])
    time = SUBSCRIPTION_MODEL_CACHE_MS - 1
    await refresher.refresh(channel())
    expect(calls).toBe(1)
    time++
    await refresher.refresh(channel())
    expect(calls).toBe(2)
  })

  test('Given 网络失败 When 再次打开 Then 保留列表且退避后才重试', async () => {
    let time = 0
    let calls = 0
    let commits = 0
    const refresher = createSubscriptionModelRefresher({ now: () => time,
      load: async () => { calls++; throw new Error('network') },
      commit: (snapshot) => { commits++; return snapshot } })
    expect((await refresher.refresh(channel()))?.requiresAuthorization).toBe(false)
    await refresher.refresh(channel())
    expect(calls).toBe(1)
    time = SUBSCRIPTION_MODEL_RETRY_MS
    await refresher.refresh(channel())
    expect(calls).toBe(2)
    expect(commits).toBe(0)
  })

  test('Given 授权失效 When 重开或很久之后再开 Then 不重试直到凭据改变', async () => {
    let time = 0
    let calls = 0
    const refresher = createSubscriptionModelRefresher({ now: () => time,
      load: async () => { calls++; throw new SubscriptionAuthorizationError() }, commit: (snapshot) => snapshot })
    expect((await refresher.refresh(channel()))?.requiresAuthorization).toBe(true)
    time = 100 * SUBSCRIPTION_MODEL_CACHE_MS
    await refresher.refresh(channel())
    expect(calls).toBe(1)
    await refresher.refresh(channel({ apiKey: 'encrypted-b' }))
    expect(calls).toBe(2)
  })

  test('Given 续期成功 When 提交新密文 Then 后续打开使用缓存', async () => {
    let calls = 0
    const saved = channel({ apiKey: 'renewed-encrypted' })
    const refresher = createSubscriptionModelRefresher({
      load: async () => { calls++; return { models: fetched } }, commit: () => saved })
    await refresher.refresh(channel())
    await refresher.refresh(saved)
    expect(calls).toBe(1)
  })

  test('Given 刷新期间账号切换 When 旧请求稍后失败 Then 不覆盖新账号缓存', async () => {
    const old = deferred<LoadedSubscriptionModels>()
    let calls = 0
    const next = channel({ apiKey: 'encrypted-b' })
    const refresher = createSubscriptionModelRefresher({
      load: async (snapshot) => { calls++; return snapshot.apiKey === 'encrypted-a' ? old.promise : { models: fetched } },
      commit: (snapshot) => snapshot.apiKey === next.apiKey ? snapshot : undefined })
    const pending = refresher.refresh(channel())
    await refresher.refresh(next)
    old.reject(new SubscriptionAuthorizationError())
    expect(await pending).toBeUndefined()
    await refresher.refresh(next)
    expect(calls).toBe(2)
  })

  test('Given 已删除或切换的渠道 When 旧请求完成 Then 丢弃结果且不缓存', async () => {
    let calls = 0
    const refresher = createSubscriptionModelRefresher({
      load: async () => { calls++; return { models: fetched } }, commit: () => undefined })
    await refresher.refresh(channel())
    await refresher.refresh(channel())
    expect(calls).toBe(2)
  })

  test('Given 普通 API 渠道 When 请求刷新 Then 不读取供应商', async () => {
    let calls = 0
    const refresher = createSubscriptionModelRefresher({ load: async () => { calls++; return { models: [] } }, commit: (snapshot) => snapshot })
    await refresher.refresh(channel({ provider: 'openai' }))
    expect(calls).toBe(0)
  })
})
