import { test } from 'bun:test'
import { runIsolatedSubscriptionFixture } from '../subscription-refresh-test-runner'

test('Given 隔离SDK与代理mock When 检查Copilot在线目录 Then 发现与运行保持账号权限边界', () => {
  runIsolatedSubscriptionFixture(new URL('./github-copilot-catalog.fixture.ts', import.meta.url))
})
