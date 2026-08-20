/** Deterministic provider adapter for the headless llm-turbo snapshot. */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'

class TurboSnapshotAdapter extends LlmAdapter {
  loopRequests = 0

  async * stream(options) {
    if (options.purpose !== undefined) {
      const text = 'TITLE_OK'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    this.loopRequests++
    const text = this.loopRequests % 3 === 0 ? 'TURBO_OTHER' : 'TURBO_OK'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Cordis plugin name. */
export const name = 'turbo-snapshot-backend'
/** Required LLM registry service. */
export const inject = ['llm']

/**
 * Register the deterministic provider adapter.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context carrying the LLM service.
 */
export function apply(ctx) {
  ctx.llm.registerAdapter(['deepseek-official'], new TurboSnapshotAdapter())
}
