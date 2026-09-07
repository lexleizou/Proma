import { afterEach, describe, expect, test } from 'bun:test'
import type { ChannelPlanQuotaResult } from '@proma/shared'
import { fetchChannelPlanQuota, getCachedPlanQuota, supportsChannelPlanQuota } from './channel-plan-quota'

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

function bridge(fn: (id: string) => Promise<ChannelPlanQuotaResult>): void {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { getChannelPlanQuota: fn } } })
}
function result(percent: number): ChannelPlanQuotaResult {
  return { supported: true, provider: 'github-copilot', windows: [{ type: 'custom', label: 'Premium', remainingPercent: percent, usedPercent: 100 - percent }], updatedAt: Date.now() }
}

describe('渠道额度支持与账号缓存隔离', () => {
  test('Given Copilot 订阅 When 检查展示能力 Then 支持且不影响原渠道', () => {
    expect(supportsChannelPlanQuota({ provider: 'github-copilot', baseUrl: '' })).toBe(true)
    expect(supportsChannelPlanQuota({ provider: 'openai-codex', baseUrl: '' })).toBe(true)
    expect(supportsChannelPlanQuota({ provider: 'custom', baseUrl: 'https://example.test' })).toBe(false)
    expect(supportsChannelPlanQuota(null)).toBe(false)
  })

  test('Given 同账号并发查询 When 请求未完成 Then 只调用一次 IPC 并缓存', async () => {
    let calls = 0
    bridge(async () => { calls++; return result(80) })
    const [a, b] = await Promise.all([fetchChannelPlanQuota('same-account', 1), fetchChannelPlanQuota('same-account', 1)])
    expect(a).toEqual(b)
    expect(calls).toBe(1)
    expect(await fetchChannelPlanQuota('same-account', 1)).toEqual(a)
    expect(calls).toBe(1)
    expect(getCachedPlanQuota('same-account', 2)).toBeNull()
  })

  test('Given 已换账号但旧请求更晚完成 When 缓存写回 Then 新账号结果不被旧结果覆盖', async () => {
    let finishOld: (value: ChannelPlanQuotaResult) => void = () => { throw new Error('未初始化') }
    let calls = 0
    bridge(async () => {
      calls++
      if (calls === 1) return new Promise((resolve) => { finishOld = resolve })
      return result(90)
    })
    const old = fetchChannelPlanQuota('switch-account', 1)
    const current = await fetchChannelPlanQuota('switch-account', 2)
    finishOld(result(10))
    await old
    expect(getCachedPlanQuota('switch-account', 2)).toEqual(current)
    expect(getCachedPlanQuota('switch-account', 1)).toBeNull()
  })

  test('Given IPC 拒绝并含敏感错误 When 查询 Then 安全失败且不出现未处理拒绝', async () => {
    bridge(async () => { throw new Error('private-token-from-ipc') })
    const value = await fetchChannelPlanQuota('failed-account', 1)
    expect(value.supported).toBe(false)
    expect(value.message).toBe('订阅额度查询失败，请稍后重试')
    expect(JSON.stringify(value)).not.toContain('private-token')
  })

  test('Given 过期缓存 When 再查询 Then 重新请求', async () => {
    let calls = 0
    bridge(async () => { calls++; return { ...result(80), updatedAt: Date.now() - 61_000 } })
    await fetchChannelPlanQuota('expired-account', 1)
    expect(getCachedPlanQuota('expired-account', 1)).toBeNull()
    await fetchChannelPlanQuota('expired-account', 1)
    expect(calls).toBe(2)
  })
})
