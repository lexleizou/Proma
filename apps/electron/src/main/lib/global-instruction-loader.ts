import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { PromaProjectInstructionFile } from './adapters/pi-resource-loader-overrides'

export const PROMA_GLOBAL_INSTRUCTION_MAX_BYTES = 32 * 1024

/** 仅读取明确的 Proma 配置目录，不搜索 cwd、祖先或附加目录。每次请求重新读取。 */
export function loadPromaGlobalInstructionFile(configDirectory: string): PromaProjectInstructionFile | undefined {
  const globalPath = resolve(configDirectory, 'AGENTS.md')
  let buffer: Buffer
  try {
    buffer = readFileSync(globalPath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw new Error(`读取 Proma 全局规则失败: ${globalPath}`, { cause: error })
  }
  if (buffer.byteLength > PROMA_GLOBAL_INSTRUCTION_MAX_BYTES) {
    throw new Error(`Proma 全局规则超过 32 KiB: ${globalPath}`)
  }
  const content = buffer.toString('utf8').replace(/^\uFEFF/, '')
  return content.trim() ? { path: globalPath, content } : undefined
}

/** Chat 与 Agent 复用同一全局规则文件，保留原系统提示及工具提示的内容。 */
export function appendPromaGlobalChatInstructions(
  systemMessage: string | undefined,
  globalFile: PromaProjectInstructionFile | undefined,
): string | undefined {
  if (!globalFile) return systemMessage
  const globalMessage = `Proma 全局用户指令（适用于所有项目和会话）：\n${globalFile.content}`
  return systemMessage ? `${globalMessage}\n\n${systemMessage}` : globalMessage
}
