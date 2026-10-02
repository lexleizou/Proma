import { test } from 'bun:test'
import { runIsolatedSubscriptionFixture } from './subscription-refresh-test-runner'

test('Given 独立配置目录 When 执行渠道刷新集成测试 Then 24 个持久化、迁移与并发边界通过且不接触真实配置', () => {
  runIsolatedSubscriptionFixture(new URL('./channel-subscription-refresh.fixture.ts', import.meta.url))
})
