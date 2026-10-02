import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 将 Electron/SDK module mock 限制在子进程，避免污染整个 bun test 的后续文件。 */
export function runIsolatedSubscriptionFixture(fixture: URL): void {
  const directory = mkdtempSync(join(tmpdir(), 'proma-isolated-subscription-test-'))
  try {
    const entry = join(directory, 'entry.test.ts')
    writeFileSync(entry, `import ${JSON.stringify(fileURLToPath(fixture))}\n`, 'utf8')
    const result = Bun.spawnSync({ cmd: [process.execPath, 'test', entry], stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) {
      throw new Error(`隔离测试失败：\n${result.stdout.toString()}\n${result.stderr.toString()}`)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
