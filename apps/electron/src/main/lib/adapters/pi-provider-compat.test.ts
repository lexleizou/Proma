import { describe, expect, test } from 'bun:test'
import { supportsPiDeveloperRole } from './pi-provider-compat'

describe('现行渠道的 Pi developer role', () => {
  test('Given 火山 API、通义或自定义渠道 When 选择角色 Then 保守使用 system', () => {
    expect(supportsPiDeveloperRole('doubao-api')).toBe(false)
    expect(supportsPiDeveloperRole('qwen')).toBe(false)
    expect(supportsPiDeveloperRole('custom')).toBe(false)
  })
  test('Given 原生 OpenAI 或 Codex 渠道 When 选择角色 Then 保留 developer 支持', () => {
    expect(supportsPiDeveloperRole('openai')).toBe(true)
    expect(supportsPiDeveloperRole('openai-codex')).toBe(true)
  })
})
