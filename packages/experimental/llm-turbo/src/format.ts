/**
 * TurboAgent-aligned stringification of dsh messages and assembled actions.
 * @module @deepseek-ai/dsh-experimental-llm-turbo/format
 */

import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

const EMPTY_ACTION = '(empty response)'

/**
 * Format one content block the way TurboAgent stringifies OpenAI/Anthropic parts.
 * Reasoning is omitted; images become `[image]`.
 * @param block - one model-facing block.
 * @returns the TurboAgent line, or `undefined` when the block does not print.
 */
export function formatBlock(block: ContentBlock): string | undefined {
  switch (block.type) {
    case 'text':
      return block.text
    case 'image':
      return '[image]'
    case 'tool-call':
      return `[tool_call: ${block.name}(${block.arguments})]`
    case 'tool-result': {
      const inner = formatBlocks(block.content)
      return `[tool_result: ${inner}]`
    }
    case 'reasoning':
      return undefined
    default:
      // Merge-extensible fall-through (no assertNever): unknown blocks omit.
      return undefined
  }
}

/**
 * Join printable blocks with newlines, dropping empty and omitted blocks.
 * @param blocks - ordered content.
 * @returns the joined text, possibly empty.
 */
export function formatBlocks(blocks: readonly ContentBlock[]): string {
  return blocks.map(formatBlock).filter((part): part is string => part !== undefined && part.length > 0).join('\n')
}

/**
 * Format conversation history the way TurboAgent `Backend.format_history` does.
 * @param messages - provider-neutral messages, including this step's claimed input.
 * @param system - optional system slot printed as `SYSTEM:`.
 * @returns role-prefixed paragraphs joined by blank lines.
 */
export function formatHistory(messages: readonly Message[], system?: string): string {
  const parts: string[] = []
  if (system !== undefined && system.length > 0) parts.push(`SYSTEM: ${system}`)
  for (const message of messages) {
    const body = formatBlocks(message.content)
    if (body.length === 0) continue
    parts.push(`${message.role.toUpperCase()}: ${body}`)
  }
  return parts.join('\n\n')
}

/**
 * Format one assembled assistant action the way TurboAgent `format_action` does.
 * @param blocks - assembled candidate content.
 * @returns action text, or `(empty response)` when nothing printable remains.
 */
export function formatAction(blocks: readonly ContentBlock[]): string {
  const text = formatBlocks(blocks)
  return text.length > 0 ? text : EMPTY_ACTION
}

/**
 * Format the request the verifier sees as the task: system plus messages.
 * @param options - the loop request being wrapped.
 * @returns TurboAgent history text.
 */
export function formatRequestHistory(options: GenerateOptions): string {
  return formatHistory(options.messages, options.system)
}

/** Sentinel TurboAgent uses for an empty completion. */
export const EMPTY_CANDIDATE_ACTION = EMPTY_ACTION
