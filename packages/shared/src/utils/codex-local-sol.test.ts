import { describe, expect, test } from 'bun:test'
import { isCodexFastModeSupportedModel } from '../types/agent'
import { resolveReasoningProfile } from '../types/reasoning-profile'
import { inferCodexAlignedGPT5ContextWindow, inferContextWindow } from './context-window'

describe('本机 GPT-6.1 Sol 兼容能力', () => {
  test('Given 已验证的精确模型 ID When 推断窗口 Then 前端与后端均使用 272K', () => {
    for (const id of ['gpt-6.1-sol', 'GPT-6.1-SOL', 'gpt-6.1-sol[1m]']) {
      expect(inferCodexAlignedGPT5ContextWindow(id)).toBe(272_000)
      expect(inferContextWindow(id)).toBe(272_000)
    }
    expect(inferCodexAlignedGPT5ContextWindow('gpt-6-sol')).toBe(372_000)
  })

  test('Given 本机 Sol 兼容模型 When 选择思考等级 Then 使用 Astra 规则且不能关闭思考', () => {
    const profile = resolveReasoningProfile({ modelId: 'gpt-6.1-sol', transport: 'openai-responses' })
    expect(profile?.id).toBe('openai-reasoning-astra')
    expect(profile?.normalize('off')).toBe('low')
    expect(profile?.normalize('minimal')).toBe('low')
    expect(profile?.normalize('max')).toBe('max')
    expect(profile?.levels).not.toContain('off')
    expect(profile?.encodings['openai-responses']?.effortMap.off).toBe('low')
    expect(resolveReasoningProfile({ modelId: 'gpt-6.1-sol', transport: 'anthropic-messages' })).toBeUndefined()
  })

  test('Given 本机兼容模型 When 检查 Fast Mode Then 可用且保留原有 Sol 行为', () => {
    expect(isCodexFastModeSupportedModel('gpt-6.1-sol')).toBe(true)
    expect(isCodexFastModeSupportedModel('GPT-6.1-SOL')).toBe(true)
    expect(isCodexFastModeSupportedModel('gpt-6-sol')).toBe(true)
    expect(resolveReasoningProfile({ modelId: 'gpt-6-sol', transport: 'openai-responses' })?.normalize('off')).toBe('off')
  })

  test('Given 未核验的近似 ID When 判断能力 Then 不套用本机兼容项', () => {
    for (const id of ['gpt-6.1-sol-mini', 'gpt-6.1-sol-codex', 'gpt-6.10-sol', 'gpt-6.1-luna']) {
      expect(inferCodexAlignedGPT5ContextWindow(id)).toBeUndefined()
      expect(isCodexFastModeSupportedModel(id)).toBe(false)
      expect(resolveReasoningProfile({ modelId: id, transport: 'openai-responses' })).toBeUndefined()
    }
  })
})
