import { describe, expect, mock, test } from 'bun:test'
import type { GithubCopilotOAuthCredentials } from '@proma/shared'

interface Credential { type: 'oauth'; access: string; refresh: string; expires: number; availableModelIds?: string[] }
interface RuntimeInput {
  credentials: {
    read: (provider?: string) => Promise<Credential | undefined>
    modify: (provider: string, operation: (current: Credential | undefined) => Promise<Credential | undefined>) => Promise<Credential | undefined>
  }
  modelsPath?: string | null
  refreshOnCreate?: boolean
  allowModelNetwork?: boolean
}
let seen: Credential | undefined
let hasTimeout = false
let failure: Error | undefined
let authCalls = 0
let loginCalls = 0

mock.module('electron', () => ({ shell: { openExternal: async () => { loginCalls++ } } }))
mock.module('./oauth-proxy-scope', () => ({ runWithOAuthProxyScope: async (operation: () => Promise<unknown>) => operation() }))
mock.module('@earendil-works/pi-coding-agent', () => ({
  ModelRuntime: {
    create: async (input: RuntimeInput) => {
      expect(input.modelsPath).toBeNull()
      expect(input.refreshOnCreate).toBe(false)
      expect(input.allowModelNetwork).toBe(false)
      return {
        login: async () => { loginCalls++; throw new Error('不应调用交互式登录') },
        getAuth: async (provider: string, options?: { signal?: AbortSignal }) => {
          authCalls++
          hasTimeout = options?.signal instanceof AbortSignal
          seen = await input.credentials.read(provider)
          if (failure) throw failure
          if (seen && seen.expires === 0) {
            await input.credentials.modify(provider, async (current) => current ? {
              ...current, access: 'new-test-access', expires: Date.now() + 3600000,
              ...(provider === 'github-copilot' ? { availableModelIds: ['gpt-5.5'] } : {}),
            } : undefined)
          }
          return { auth: { apiKey: 'test' } }
        },
      }
    },
  },
}))

const { refreshGithubCopilotOAuth } = await import('./github-copilot-oauth-service')
const { refreshCodexOAuth } = await import('./codex-oauth-service')
const credential: GithubCopilotOAuthCredentials = {
  access: 'old-test-access', refresh: 'test-refresh', expires: Date.now() + 3600000,
  availableModelIds: ['gpt-5.4'],
}

describe('订阅目录续签不会启动登录', () => {
  test('Given 未过期 Copilot token When 强制刷新目录 Then 仅内存过期并重新获取策略', async () => {
    const originalExpiry = credential.expires
    const result = await refreshGithubCopilotOAuth(credential, true)
    expect(seen?.expires).toBe(0)
    expect(hasTimeout).toBe(true)
    expect(result.availableModelIds).toEqual(['gpt-5.5'])
    expect(credential.expires).toBe(originalExpiry)
    expect(result).not.toHaveProperty('type')
    expect(loginCalls).toBe(0)
  })
  test('Given 普通续签检查 When token 未过期 Then 不强制刷新或改变模型策略', async () => {
    const result = await refreshGithubCopilotOAuth(credential)
    expect(seen?.expires).toBe(credential.expires)
    expect(result).toEqual(credential)
    expect(loginCalls).toBe(0)
  })
  test('Given Codex refresh token When 续签 Then 不使用全局模型文件或调用登录', async () => {
    const result = await refreshCodexOAuth('test-refresh')
    expect(seen?.expires).toBe(0)
    expect(result.access).toBe('new-test-access')
    expect(loginCalls).toBe(0)
  })
  test('Given OAuth 失效 When 续签失败 Then 原样传播错误且不重试登录', async () => {
    failure = new Error('OAuth refresh failed', { cause: new Error('401') })
    const before = authCalls
    await expect(refreshGithubCopilotOAuth(credential, true)).rejects.toBe(failure)
    expect(authCalls).toBe(before + 1)
    expect(loginCalls).toBe(0)
    failure = undefined
  })
})
