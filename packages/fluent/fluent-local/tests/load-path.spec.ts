/**
 * Loader export-shape guard for @deepseek-ai/dsh-fluent-local. It is a NAMESPACE
 * plugin with `inject`, so a stray `export default apply` would make the
 * Loader's `unwrapExports` collapse the module to the bare `apply`, dropping
 * `inject` (postmortem 0001).
 */

import { describe, expect, it } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as fluentLocal from '@deepseek-ai/dsh-fluent-local'

describe('dsh-fluent-local Loader export-shape guard', () => {
  it('has no default export and keeps name/inject/Config through unwrapExports', () => {
    expect('default' in fluentLocal).toBe(false)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(fluentLocal) as Record<string, unknown>
    expect(unwrapped).toBe(fluentLocal)
    expect(unwrapped.name).toBe('fluent-local')
    expect(unwrapped.inject).toEqual(['fluent', 'subprocess'])
    expect(typeof unwrapped.apply).toBe('function')
    expect(unwrapped.Config).toBeDefined()
  })
})
