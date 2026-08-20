import { describe, expect, it } from 'vitest'
import { CallId, createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  EMPTY_CANDIDATE_ACTION,
  formatAction,
  formatBlock,
  formatBlocks,
  formatHistory,
  formatRequestHistory,
} from '../src/format.ts'

describe('TurboAgent history and action formatting', () => {
  it('prints text, images, tool calls, and nested tool results', () => {
    expect(formatBlock({ type: 'text', text: 'hello' })).toBe('hello')
    expect(formatBlock({ type: 'image', attachment: {} as never })).toBe('[image]')
    expect(formatBlock({
      type: 'tool-call',
      id: CallId('c1'),
      name: 'bash',
      arguments: '{"cmd":"ls"}',
    })).toBe('[tool_call: bash({"cmd":"ls"})]')
    expect(formatBlock({
      type: 'tool-result',
      toolCallId: CallId('c1'),
      content: [{ type: 'text', text: 'ok' }],
    })).toBe('[tool_result: ok]')
    expect(formatBlock({ type: 'reasoning', text: 'secret' })).toBeUndefined()
    expect(formatBlock({ type: 'unknown' } as unknown as ContentBlock)).toBeUndefined()
  })

  it('drops empty and omitted blocks when joining', () => {
    expect(formatBlocks([
      { type: 'text', text: '' },
      { type: 'reasoning', text: 'skip' },
      { type: 'text', text: 'keep' },
    ])).toBe('keep')
  })

  it('prints SYSTEM and role prefixes, skipping empty messages', () => {
    expect(formatHistory([], '')).toBe('')
    expect(formatHistory([createUserMessage({
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    })], 'sys')).toBe('SYSTEM: sys\n\nUSER: hi')
    expect(formatHistory([createUserMessage({
      content: [{ type: 'reasoning', text: 'x' }],
      source: { kind: 'user' },
    })])).toBe('')
  })

  it('uses the empty-response sentinel for a blank action', () => {
    expect(formatAction([])).toBe(EMPTY_CANDIDATE_ACTION)
    expect(formatAction([{ type: 'text', text: 'done' }])).toBe('done')
  })

  it('formats the verifier task from the request system slot and messages', () => {
    expect(formatRequestHistory({
      provider: 'mock',
      model: 'mock',
      system: 'be brief',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } })],
    })).toBe('SYSTEM: be brief\n\nUSER: task')
  })
})
