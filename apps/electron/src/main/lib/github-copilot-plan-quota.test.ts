import { describe, expect, test } from 'bun:test'
import { parseGithubCopilotPlanQuotaResponse, queryGithubCopilotPlanQuota } from './github-copilot-plan-quota'
import type { ManagedProxyFetch } from './proxy-fetch'

const secret = JSON.stringify({
  access: 'test-copilot-access-not-for-quota',
  refresh: 'test-github-oauth',
  expires: 1, // 短期 Copilot token 过期不影响 GitHub OAuth 额度查询。
  availableModelIds: [],
})
const fixture = {
  copilot_plan: 'business',
  quota_reset_date: '2026-10-01',
  quota_snapshots: {
    premium_interactions: { entitlement: 300, remaining: 240, percent_remaining: 80 },
    chat: { percent_remaining: 50 },
  },
}

function withSnapshot(snapshot: unknown): unknown {
  return { quota_snapshots: { premium_interactions: snapshot } }
}

function transport(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  let closed = 0
  let calls = 0
  let proxy: string | undefined
  return {
    create: (proxyUrl?: string): ManagedProxyFetch => {
      proxy = proxyUrl
      return {
        fetch: Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
          calls++
          return handler(input, init)
        }, { preconnect: () => undefined }) as typeof fetch,
        close: async () => { closed++ },
      }
    },
    get closed() { return closed },
    get calls() { return calls },
    get proxy() { return proxy },
  }
}

describe('Copilot 内部接口额度解析', () => {
  test('Given Premium 和 Chat When 解析 Then 返回套餐、剩余额度和 UTC 重置时间', () => {
    expect(parseGithubCopilotPlanQuotaResponse(fixture)).toMatchObject({
      supported: true,
      provider: 'github-copilot',
      planName: 'GitHub Copilot Business',
      windows: [
        { label: 'Premium', remainingPercent: 80, usedPercent: 20, remainingLabel: '240 / 300', resetAt: Date.parse('2026-10-01T00:00:00Z') },
        { label: 'Chat', remainingPercent: 50, usedPercent: 50 },
      ],
    })
  })

  test('Given 数值字符串和缺失百分比 When 解析 Then 由有效分子分母计算', () => {
    const result = parseGithubCopilotPlanQuotaResponse(withSnapshot({ entitlement: '300', remaining: '100' }))
    expect(result.windows[0]).toMatchObject({ remainingPercent: 33.33, usedPercent: 66.67, remainingLabel: '100 / 300' })
  })

  test('Given 用尽或超额 When 解析 Then 保留零额度且进度不越界', () => {
    for (const value of [0, -12]) {
      expect(parseGithubCopilotPlanQuotaResponse(withSnapshot({ percent_remaining: value })).windows[0])
        .toMatchObject({ remainingPercent: 0, usedPercent: 100 })
    }
    expect(parseGithubCopilotPlanQuotaResponse(withSnapshot({ percent_remaining: 125 })).windows[0]?.remainingPercent).toBe(100)
  })

  test('Given 无限额度 When 解析 Then 显示不限额而不是假进度', () => {
    expect(parseGithubCopilotPlanQuotaResponse(withSnapshot({ unlimited: true })).windows[0])
      .toMatchObject({ remainingLabel: '不限额', showProgress: false })
  })

  test('Given 按量计费占位 When 解析 Then 不显示假的剩余 100%', () => {
    const data = { token_based_billing: true, quota_snapshots: { premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 100 } } }
    expect(parseGithubCopilotPlanQuotaResponse(data)).toMatchObject({
      supported: true,
      windows: [{ label: '计费方式', remainingLabel: '按量计费', showProgress: false }],
    })
    expect(parseGithubCopilotPlanQuotaResponse({ ...data, token_based_billing: false }).supported).toBe(false)
  })

  test('Given 按量计费和其他不限额窗口并存 When 解析 Then 计费说明不被遮蔽', () => {
    const result = parseGithubCopilotPlanQuotaResponse({
      token_based_billing: true,
      quota_snapshots: {
        premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 100 },
        chat: { unlimited: true },
        completions: { unlimited: true },
      },
    })
    expect(result.windows).toMatchObject([
      { label: '计费方式', remainingLabel: '按量计费', showProgress: false },
      { label: 'Chat', remainingLabel: '不限额' },
      { label: '补全', remainingLabel: '不限额' },
    ])
  })

  test('Given Free 旧式配额 When 解析 Then completions 保留补全标签而非 Premium', () => {
    const result = parseGithubCopilotPlanQuotaResponse({
      copilot_plan: 'free',
      monthly_quotas: { chat: 50, completions: 2000 },
      limited_user_quotas: { chat: 25, completions: 1000 },
    })
    expect(result.windows).toMatchObject([
      { label: 'Chat', remainingPercent: 50 },
      { label: '补全', remainingPercent: 50 },
    ])
  })

  test('Given 未知键、缺失或错误类型 When 解析 Then 不伪造百分比', () => {
    for (const data of [null, [], {}, 'text', { quota_snapshots: [] }, { quota_snapshots: { mystery: { percent_remaining: 80 } } }]) {
      expect(parseGithubCopilotPlanQuotaResponse(data)).toMatchObject({ supported: false, windows: [] })
    }
    for (const value of [null, '', ' ', true, [], {}, 'Infinity', 'NaN']) {
      expect(parseGithubCopilotPlanQuotaResponse(withSnapshot({ percent_remaining: value })).supported).toBe(false)
    }
    expect(parseGithubCopilotPlanQuotaResponse(withSnapshot({ entitlement: 100 })).supported).toBe(false)
    expect(parseGithubCopilotPlanQuotaResponse(withSnapshot({ remaining: 50 })).supported).toBe(false)
  })

  test('Given 单个窗口损坏 When 另一窗口有效 Then 仍展示有效窗口', () => {
    expect(parseGithubCopilotPlanQuotaResponse({ quota_snapshots: { premium_interactions: null, chat: { percent_remaining: 20 } } }).windows)
      .toMatchObject([{ label: 'Chat', remainingPercent: 20 }])
  })

  test('Given 服务端任意套餐名或错误字段 When 解析 Then 不向 IPC 传递原文', () => {
    const result = parseGithubCopilotPlanQuotaResponse({ ...fixture, copilot_plan: 'test-github-oauth', error: 'test-copilot-access-not-for-quota' })
    expect(result.planName).toBe('GitHub Copilot')
    expect(JSON.stringify(result)).not.toContain('test-')
  })

  test('Given 各种合法重置日期 When 解析 Then 转为同一毫秒时刻', () => {
    for (const date of ['2026-10-01', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00.000Z', '2026-10-01T08:00:00+08:00']) {
      expect(parseGithubCopilotPlanQuotaResponse({ ...fixture, quota_reset_date: date }).windows[0]?.resetAt)
        .toBe(Date.parse('2026-10-01T00:00:00Z'))
    }
  })

  test('Given 缺失或无效日期 When 解析 Then 不自动推断或宽松纠正日期', () => {
    for (const date of [undefined, null, '', 'bad', '2026-02-30', '2026-13-01', '2026-10-01T00:00:00', '2026-10-01T24:00:00Z', 1788798060000]) {
      expect(parseGithubCopilotPlanQuotaResponse({ ...fixture, quota_reset_date: date }).windows[0]?.resetAt).toBeUndefined()
    }
  })
})

describe('Copilot 查询凭据与网络边界', () => {
  test('Given 已保存的登录 When 查询 Then 仅向固定接口发送 GitHub OAuth token 并释放代理', async () => {
    const mock = transport(async (input, init) => {
      expect(String(input)).toBe('https://api.github.com/copilot_internal/user')
      expect(init?.method).toBe('GET')
      expect(init?.redirect).toBe('error')
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      const headers = new Headers(init?.headers)
      expect(headers.get('Authorization')).toBe('token test-github-oauth')
      expect(headers.get('Editor-Version')).toBe('vscode/1.96.2')
      expect(headers.get('X-Github-Api-Version')).toBe('2025-04-01')
      expect(JSON.stringify(init)).not.toContain('test-copilot-access-not-for-quota')
      return Response.json(fixture)
    })
    const result = await queryGithubCopilotPlanQuota(secret, 'http://127.0.0.1:7890', mock.create)
    expect(result.supported).toBe(true)
    expect(mock.proxy).toBe('http://127.0.0.1:7890')
    expect(mock.closed).toBe(1)
    expect(JSON.stringify(result)).not.toContain('test-github-oauth')
  })

  test('Given 无效凭据 When 查询 Then 不发请求', async () => {
    const mock = transport(async () => { throw new Error('不应联网') })
    for (const value of ['', 'token', '{}', 'null', JSON.stringify({ ...JSON.parse(secret), refresh: 'bad\r\nheader' })]) {
      expect((await queryGithubCopilotPlanQuota(value, undefined, mock.create)).supported).toBe(false)
    }
    expect(mock.calls).toBe(0)
  })

  test('Given GitHub 托管企业域 When 查询 Then 使用该身份对应的 API 域', async () => {
    const mock = transport(async (input) => {
      expect(String(input)).toBe('https://api.acme.ghe.com/copilot_internal/user')
      return Response.json(fixture)
    })
    for (const enterpriseUrl of ['acme.ghe.com', 'https://acme.ghe.com/', 'api.acme.ghe.com']) {
      expect((await queryGithubCopilotPlanQuota(JSON.stringify({ ...JSON.parse(secret), enterpriseUrl }), undefined, mock.create)).supported).toBe(true)
    }
  })

  test('Given 非支持域、用户信息、端口或路径 When 查询 Then 不发送凭据也不回退 github.com', async () => {
    const mock = transport(async () => { throw new Error('不应联网') })
    for (const enterpriseUrl of ['http://acme.ghe.com', 'https://acme.ghe.com.evil.test', 'https://user@acme.ghe.com', 'https://acme.ghe.com:8443', 'https://acme.ghe.com/path', 'https://github.com?token=secret', 'localhost', 'https://192.168.1.1', 'https://github.example.com']) {
      const result = await queryGithubCopilotPlanQuota(JSON.stringify({ ...JSON.parse(secret), enterpriseUrl }), undefined, mock.create)
      expect(result.supported).toBe(false)
      expect(result.message).not.toContain(enterpriseUrl)
    }
    expect(mock.calls).toBe(0)
  })

  test('Given HTTP 认证、限流、服务器或重定向错误 When 查询 Then 固定错误不泄露响应', async () => {
    for (const status of [401, 403, 429, 500, 302]) {
      const mock = transport(async () => new Response('test-github-oauth private upstream body', { status }))
      const result = await queryGithubCopilotPlanQuota(secret, undefined, mock.create)
      expect(result.supported).toBe(false)
      expect(result.message).toContain(String(status))
      expect(JSON.stringify(result)).not.toContain('test-github-oauth')
      expect(mock.closed).toBe(1)
    }
  })

  test('Given 损坏 JSON When 查询 Then 返回格式错误并释放连接', async () => {
    const mock = transport(async () => new Response('test-github-oauth broken json'))
    const result = await queryGithubCopilotPlanQuota(secret, undefined, mock.create)
    expect(result.message).toContain('格式')
    expect(JSON.stringify(result)).not.toContain('test-github-oauth')
    expect(mock.closed).toBe(1)
  })

  test('Given 超时或代理网络异常 When 查询 Then 不回显底层敏感信息', async () => {
    for (const name of ['TimeoutError', 'AbortError', 'TypeError']) {
      const error = new Error('test-github-oauth proxy://private:password@host')
      error.name = name
      const mock = transport(async () => { throw error })
      const result = await queryGithubCopilotPlanQuota(secret, undefined, mock.create)
      expect(result.supported).toBe(false)
      expect(JSON.stringify(result)).not.toMatch(/test-github-oauth|password|proxy:\/\//)
      if (name !== 'TypeError') expect(result.message).toContain('超时')
      expect(mock.closed).toBe(1)
    }
  })

  test('Given 本地服务器实际返回重定向 When fetch执行 Then 不访问重定向目标', async () => {
    let redirected = false
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === '/target') {
          redirected = true
          return Response.json(fixture)
        }
        return new Response(null, { status: 302, headers: { Location: new URL('/target', request.url).href } })
      },
    })
    try {
      const mock = transport(async (_input, init) => fetch(server.url, init))
      const result = await queryGithubCopilotPlanQuota(secret, undefined, mock.create)
      expect(result.supported).toBe(false)
      expect(redirected).toBe(false)
      expect(mock.closed).toBe(1)
    } finally { server.stop(true) }
  })

  test('Given 正文一直未结束 When 达到真实超时 Then 中断正文并释放连接', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0, idleTimeout: 30,
      fetch: () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')) } })),
      // 服务端 idle timeout 必须晚于客户端15秒期限，才能验证客户端正文取消。
    })
    try {
      const mock = transport(async (_input, init) => fetch(server.url, init))
      const result = await queryGithubCopilotPlanQuota(secret, undefined, mock.create)
      expect(result.supported).toBe(false)
      expect(result.message).toContain('超时')
      expect(mock.closed).toBe(1)
    } finally { server.stop(true) }
  }, 20_000)

  test('Given 创建或释放代理失败 When 查询 Then 异常也不逃出安全边界', async () => {
    const error = new Error('test-github-oauth')
    const failed = await queryGithubCopilotPlanQuota(secret, undefined, () => { throw error })
    expect(failed.supported).toBe(false)
    const mock = transport(async () => Response.json(fixture))
    const result = await queryGithubCopilotPlanQuota(secret, undefined, () => ({
      ...mock.create(), close: async () => { throw error },
    }))
    expect(result.supported).toBe(true)
    expect(JSON.stringify([failed, result])).not.toContain('test-github-oauth')
  })
})
