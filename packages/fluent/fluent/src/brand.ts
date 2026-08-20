/**
 * dsh-fluent's owned branded id: {@link FluentProviderId}, the opaque identity a
 * provider reserves on `ctx.fluent`. The `Branded<B>` primitive lives in
 * `@deepseek-ai/dsh-brand`; keeping the type and its factory together here lets
 * `index.ts` re-export both under one name.
 * @module @deepseek-ai/dsh-fluent/brand
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque provider identity, reserved atomically at registration. */
export type FluentProviderId = Branded<'FluentProviderId'>

/**
 * Brand a string as a {@link FluentProviderId}. No validation — the registry
 * rejects an empty id at registration.
 * @param id - the provider's stable identifier.
 * @returns the same string, branded.
 */
export function FluentProviderId(id: string): FluentProviderId {
  return id as FluentProviderId
}
