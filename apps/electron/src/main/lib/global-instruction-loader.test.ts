import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendPromaGlobalChatInstructions,
  loadPromaGlobalInstructionFile,
  PROMA_GLOBAL_INSTRUCTION_MAX_BYTES,
} from './global-instruction-loader'
import {
  combinePromaInstructionFiles,
  createPromaManagedResourceLoaderOptions,
  createPromaProjectInstructionFilesOverride,
} from './adapters/pi-resource-loader-overrides'

const directories: string[] = []
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'proma-global-instructions-'))
  directories.push(path)
  return path
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('明确的 Proma 全局规则读取', () => {
  test('Given 固定配置目录的 AGENTS.md When 读取 Then 保留内容并去除 UTF-8 BOM', () => {
    const root = directory()
    writeFileSync(join(root, 'AGENTS.md'), '\uFEFF# 全局规则\n使用简体中文。\n')
    expect(loadPromaGlobalInstructionFile(root)).toEqual({ path: join(root, 'AGENTS.md'), content: '# 全局规则\n使用简体中文。\n' })
  })
  test('Given 全局规则被修改或删除 When 下一请求读取 Then 生效且不使用缓存', () => {
    const root = directory()
    writeFileSync(join(root, 'AGENTS.md'), '旧规则')
    expect(loadPromaGlobalInstructionFile(root)?.content).toBe('旧规则')
    writeFileSync(join(root, 'AGENTS.md'), '新规则')
    expect(loadPromaGlobalInstructionFile(root)?.content).toBe('新规则')
    rmSync(join(root, 'AGENTS.md'))
    expect(loadPromaGlobalInstructionFile(root)).toBeUndefined()
  })
  test('Given 空白或不存在的规则 When 读取 Then 不注入空内容', () => {
    const root = directory()
    expect(loadPromaGlobalInstructionFile(root)).toBeUndefined()
    writeFileSync(join(root, 'AGENTS.md'), '\uFEFF \n\t')
    expect(loadPromaGlobalInstructionFile(root)).toBeUndefined()
  })
  test('Given 父目录存在 AGENTS.md 而配置目录无文件 When 读取 Then 不恢复祖先发现', () => {
    const root = directory()
    const config = join(root, 'config')
    mkdirSync(config)
    writeFileSync(join(root, 'AGENTS.md'), '不应从祖先读取')
    expect(loadPromaGlobalInstructionFile(config)).toBeUndefined()
  })
  test('Given 正式和开发配置目录 When 显式选择 Then 只读取选定目录', () => {
    const root = directory()
    for (const name of ['.proma', '.proma-dev']) {
      mkdirSync(join(root, name))
      writeFileSync(join(root, name, 'AGENTS.md'), name)
    }
    expect(loadPromaGlobalInstructionFile(join(root, '.proma'))?.content).toBe('.proma')
    expect(loadPromaGlobalInstructionFile(join(root, '.proma-dev'))?.content).toBe('.proma-dev')
  })
  test('Given 恰好 32 KiB 或超限 UTF-8 内容 When 读取 Then 按字节执行边界', () => {
    const root = directory()
    writeFileSync(join(root, 'AGENTS.md'), 'a'.repeat(PROMA_GLOBAL_INSTRUCTION_MAX_BYTES))
    expect(loadPromaGlobalInstructionFile(root)?.content).toHaveLength(PROMA_GLOBAL_INSTRUCTION_MAX_BYTES)
    writeFileSync(join(root, 'AGENTS.md'), '中'.repeat(Math.ceil(PROMA_GLOBAL_INSTRUCTION_MAX_BYTES / 3)))
    expect(() => loadPromaGlobalInstructionFile(root)).toThrow('超过 32 KiB')
  })
  test('Given 规则路径不可读而非不存在 When 读取 Then 提示错误而不是静默跳过', () => {
    const root = directory()
    mkdirSync(join(root, 'AGENTS.md'))
    expect(() => loadPromaGlobalInstructionFile(root)).toThrow('读取 Proma 全局规则失败')
  })
})

describe('Agent 与 Chat 全局规则注入', () => {
  test('Given 全局、工作区及项目规则 When Agent 合并 Then 保留顺序且路径重复只注入一次', () => {
    const root = directory()
    const global = { path: join(root, 'AGENTS.md'), content: '全局' }
    const workspace = { path: join(root, 'workspace', 'AGENTS.md'), content: '工作区' }
    const project = { path: join(root, 'project', 'AGENTS.md'), content: '项目' }
    const files = combinePromaInstructionFiles(workspace, [project, { path: join(root, '.', 'AGENTS.md'), content: '重复' }], global)
    expect(files).toEqual([global, workspace, project])
    expect(createPromaProjectInstructionFilesOverride(files)()).toEqual({ agentsFiles: files })
    expect(createPromaManagedResourceLoaderOptions()).toMatchObject({ noContextFiles: true, noExtensions: true, noSkills: true, appendSystemPrompt: [] })
  })
  test('Given 没有全局或工作区规则 When Agent 合并 Then 项目规则仍可正常注入', () => {
    const project = { path: join(directory(), 'AGENTS.md'), content: '项目' }
    expect(combinePromaInstructionFiles(undefined, [project])).toEqual([project])
  })
  test('Given 全局规则和用户系统提示 When Chat 请求 Then 全局在前并保留原提示', () => {
    const global = { path: join(directory(), 'AGENTS.md'), content: '全局规则' }
    expect(appendPromaGlobalChatInstructions('用户提示和工具提示', global)).toBe('Proma 全局用户指令（适用于所有项目和会话）：\n全局规则\n\n用户提示和工具提示')
    expect(appendPromaGlobalChatInstructions(undefined, global)).toContain('全局规则')
    expect(appendPromaGlobalChatInstructions('原提示', undefined)).toBe('原提示')
    expect(appendPromaGlobalChatInstructions(undefined, undefined)).toBeUndefined()
  })
})
