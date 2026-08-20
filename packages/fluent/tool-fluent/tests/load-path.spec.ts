/**
 * Loader export-shape guard for @deepseek-ai/dsh-tool-fluent. It is a NAMESPACE
 * plugin with `inject`, so a stray `export default apply` would make the
 * Loader's `unwrapExports` collapse the module to the bare `apply`, dropping
 * `inject` (postmortem 0001).
 */

import { describe, expect, it } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as toolFluent from '@deepseek-ai/dsh-tool-fluent'

describe('dsh-tool-fluent Loader export-shape guard', () => {
  it('has no default export and keeps name/inject/Config through unwrapExports', () => {
    expect('default' in toolFluent).toBe(false)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolFluent) as Record<string, unknown>
    expect(unwrapped).toBe(toolFluent)
    expect(unwrapped.name).toBe('tool-fluent')
    expect(unwrapped.inject).toEqual(['tools', 'fluent', 'systemPrompt'])
    expect(typeof unwrapped.apply).toBe('function')
    expect(unwrapped.Config).toBeDefined()
  })
})
