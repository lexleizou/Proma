import { test } from 'bun:test'
import { runIsolatedSubscriptionFixture } from './subscription-refresh-test-runner'

test('Given 独立 Pi SDK mock When 检查订阅续签 Then 4 个授权边界通过且不污染其他测试', () => {
  runIsolatedSubscriptionFixture(new URL('./subscription-oauth-refresh.fixture.ts', import.meta.url))
})
