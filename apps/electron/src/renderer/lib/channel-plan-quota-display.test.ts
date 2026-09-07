import { describe, expect, test } from 'bun:test'
import type { ChannelPlanQuotaResult } from '@proma/shared'
import { currentPlanQuota, getPlanQuotaDisplay, planQuotaAccountKey, planQuotaChannelKey } from './channel-plan-quota-display'

const quota: ChannelPlanQuotaResult = {
  supported: true, provider: 'github-copilot', planName: 'GitHub Copilot Pro', updatedAt: 1,
  windows: [{ type: 'custom', label: 'Premium', remainingPercent: 80, usedPercent: 20, resetAt: Date.parse('2026-10-01T00:00:00Z') }],
}

describe('额度展示模型', () => {
  test('Given Copilot 额度 When 展示 Then 显示剩余和重置时间详情', () => {
    const display = getPlanQuotaDisplay(quota, 'github-copilot')
    expect(display?.summary).toBe('Premium 80%')
    expect(display?.title).toContain('GitHub Copilot Pro')
    expect(display?.title).toContain('剩余 80%')
    expect(display?.title).toContain('重置')
    expect(display?.title).toContain('2026')
  })

  test('Given 重置时间缺失或异常 When 展示 Then 说明未提供且不崩溃', () => {
    for (const resetAt of [undefined, NaN, Infinity, 1e20]) {
      const windows = quota.windows.map((window) => ({ ...window, resetAt }))
      expect(getPlanQuotaDisplay({ ...quota, windows }, 'github-copilot')?.title).toContain('未提供重置时间')
    }
  })

  test('Given 不限额或按量计费 When 展示 Then 不显示假百分比或剩余按量计费', () => {
    for (const remainingLabel of ['不限额', '按量计费']) {
      const windows = quota.windows.map((window) => ({ ...window, showProgress: false, remainingLabel }))
      const display = getPlanQuotaDisplay({ ...quota, windows }, 'github-copilot')
      expect(display?.summary).toContain(remainingLabel)
      expect(display?.title).not.toContain('%')
      expect(display?.title).not.toContain(`剩余 ${remainingLabel}`)
    }
  })

  test('Given 加载或失败 When Copilot 展示 Then 不静默隐藏错误', () => {
    expect(getPlanQuotaDisplay(null, 'github-copilot')?.summary).toBe('额度加载中')
    const display = getPlanQuotaDisplay({ ...quota, supported: false, windows: [], message: '登录已失效，请重新登录' }, 'github-copilot')
    expect(display?.summary).toBe('额度不可用')
    expect(display?.title).toContain('重新登录')
    expect(display?.muted).toBe(true)
    expect(getPlanQuotaDisplay({ ...quota, windows: [] }, 'github-copilot')?.summary).toBe('额度未知')
  })

  test('Given 其他渠道 When 加载或失败 Then 保持既有隐藏行为', () => {
    expect(getPlanQuotaDisplay(null, 'openai-codex')).toBeNull()
    expect(getPlanQuotaDisplay({ ...quota, supported: false }, 'openai-codex')).toBeNull()
    const codex = { ...quota, windows: [{ type: '5h' as const, label: '每 5 小时', remainingPercent: 20, usedPercent: 80 }] }
    expect(getPlanQuotaDisplay(codex, 'openai-codex')?.summary).toBe('5H 20%')
  })

  test('Given Agent 已有旧额度 When 换号、切换或清空渠道 Then 立即排除旧结果', () => {
    const channelKey = planQuotaAccountKey('a', 1)!
    const loaded = { channelKey, result: quota }
    expect(currentPlanQuota(loaded, channelKey)).toBe(quota)
    expect(currentPlanQuota(loaded, planQuotaAccountKey('a', 2))).toBeNull()
    expect(currentPlanQuota(loaded, planQuotaAccountKey('b', 1))).toBeNull()
    expect(currentPlanQuota(loaded, planQuotaAccountKey(null))).toBeNull()
    expect(currentPlanQuota(loaded, planQuotaAccountKey(undefined))).toBeNull()
    expect(currentPlanQuota(null, channelKey)).toBeNull()
  })

  test('Given 同渠道换号或换 provider When 计算展示身份 Then 旧结果不属于新视图', () => {
    const channel = { id: 'channel', updatedAt: 1, provider: 'github-copilot' as const, baseUrl: '' }
    expect(planQuotaChannelKey(channel)).not.toBe(planQuotaChannelKey({ ...channel, updatedAt: 2 }))
    expect(planQuotaChannelKey(channel)).not.toBe(planQuotaChannelKey({ ...channel, provider: 'openai-codex' }))
  })
})
