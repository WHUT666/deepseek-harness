/**
 * Service Definition for the Fluent capability seam (`ctx.fluent`): a solver
 * provider registry and per-call, order-independent selection over normalized
 * `probe`/`runJournal` requests.
 *
 * A provider reserves a branded id atomically: {@link Fluent.registerProvider}
 * validates and conflict-checks before mutating, so an invalid or conflicting
 * registration publishes nothing, and its disposer releases the reservation.
 * The seam exposes exactly the two operations and no solver CLI escape hatch.
 * @module @deepseek-ai/dsh-fluent
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { FluentProviderId } from './brand.ts'
import type {
  FluentJournalHandle,
  FluentProvider,
  FluentRequest,
  FluentResult,
  FluentService,
} from './types.ts'

export { FluentProviderId } from './brand.ts'
export type {
  FluentDimension,
  FluentJournalHandle,
  FluentJournalRead,
  FluentOperation,
  FluentProbeResult,
  FluentProvider,
  FluentRequest,
  FluentResult,
  FluentRunResult,
  FluentService,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fluent: FluentService
  }
}

/**
 * Structured Fluent failure. Extends {@link HarnessError} with a stable `code`
 * (`FLUENT_INVALID_PROVIDER`, `FLUENT_DUPLICATE_PROVIDER`,
 * `FLUENT_PROVIDER_UNAVAILABLE`, `FLUENT_PROVIDER_CONFIGURED_MISSING`,
 * `FLUENT_PROVIDER_CONFIGURED_UNAVAILABLE`, `FLUENT_PROVIDER_AMBIGUOUS`,
 * `FLUENT_INVALID_REQUEST`, `FLUENT_WORKSPACE_REQUIRED`,
 * `FLUENT_MALFORMED_RESPONSE`) that callers route on instead of parsing
 * `message`.
 */
export class FluentError extends HarnessError {}

/** Selection inputs for execution-time provider resolution. */
interface Selection {
  /** The configured provider id, if any. */
  readonly configuredId?: string
  /** Providers registered on this seam. */
  readonly providers: ReadonlyMap<FluentProviderId, FluentProvider>
}

/**
 * Config for the Fluent seam. `provider` pins which backend wins; it is
 * optional (a single registered usable provider auto-selects).
 */
export interface FluentConfig {
  /** Explicit provider id. Omitted = auto-select when exactly one usable. */
  readonly provider?: string
}

/**
 * `ctx.fluent`. Holds the id reservations; selection resolves a usable
 * provider at each `run()` / `startJournal()` call and never depends on
 * registration order.
 */
export class Fluent extends Service implements FluentService {
  /**
   * Provider selection config. Operational env overrides feed the SAME field:
   * `$DSH_FLUENT_PROVIDER` is equivalent to `provider` and is not a hidden
   * priority chain.
   */
  static Config: z<FluentConfig> = z.object({
    provider: z.string(),
  })

  private readonly providers = new Map<FluentProviderId, FluentProvider>()
  private readonly configuredId: string | undefined

  constructor(ctx: Context, config: FluentConfig = {}) {
    super(ctx, 'fluent')
    this.configuredId = config.provider ?? process.env.DSH_FLUENT_PROVIDER
  }

  registerProvider(provider: FluentProvider): () => void {
    const id = provider.id
    if (id.trim() === '') {
      throw new FluentError('a Fluent provider id must be a non-empty string', 'FLUENT_INVALID_PROVIDER')
    }
    if (this.providers.has(id)) {
      throw new FluentError(`a Fluent provider with id "${id}" is already registered`, 'FLUENT_DUPLICATE_PROVIDER')
    }
    const dispose = this.ctx.effect(function* (this: Fluent) {
      this.providers.set(id, provider)
      yield () => { this.providers.delete(id) }
    }.bind(this), 'fluent.registerProvider()')
    return () => void dispose()
  }

  async run(request: FluentRequest, signal?: AbortSignal): Promise<FluentResult> {
    validateRequest(request)
    const provider = this.selectProvider()
    if (request.operation === 'runJournal') {
      const handle = await provider.startJournal(request, signal)
      return handle.done
    }
    return provider.run(request, signal)
  }

  async startJournal(request: FluentRequest, signal?: AbortSignal): Promise<FluentJournalHandle> {
    validateJournalRequest(request)
    return this.selectProvider().startJournal(request, signal)
  }

  private selectProvider(): FluentProvider {
    return resolveProvider({
      providers: this.providers,
      ...this.configuredId !== undefined ? { configuredId: this.configuredId } : {},
    })
  }
}

/** Reject a journal run that names no journal, or an unknown operation. */
function validateRequest(request: FluentRequest): void {
  const operation: string = request.operation
  if (operation !== 'probe' && operation !== 'runJournal') {
    throw new FluentError(`unknown Fluent operation "${operation}"`, 'FLUENT_INVALID_REQUEST')
  }
  if (request.workspaceRoot.trim() === '') {
    throw new FluentError('workspaceRoot must be a non-empty string', 'FLUENT_INVALID_REQUEST')
  }
  if (request.operation === 'runJournal') validateJournalFields(request)
  else if (request.processors !== undefined) {
    throw new FluentError('processors applies only to runJournal', 'FLUENT_INVALID_REQUEST')
  }
}

/** Reject a `startJournal` call that is not a valid journal run. */
function validateJournalRequest(request: FluentRequest): void {
  if (request.operation !== 'runJournal') {
    throw new FluentError('startJournal requires operation runJournal', 'FLUENT_INVALID_REQUEST')
  }
  if (request.workspaceRoot.trim() === '') {
    throw new FluentError('workspaceRoot must be a non-empty string', 'FLUENT_INVALID_REQUEST')
  }
  validateJournalFields(request)
}

/** Shared journal-path and processors checks. */
function validateJournalFields(request: FluentRequest): void {
  if (request.journalPath === undefined || request.journalPath.trim() === '') {
    throw new FluentError('runJournal requires a non-empty journalPath', 'FLUENT_INVALID_REQUEST')
  }
  if (request.processors !== undefined && (!Number.isInteger(request.processors) || request.processors < 1)) {
    throw new FluentError('processors must be a positive integer', 'FLUENT_INVALID_REQUEST')
  }
}

/** Resolve the selected provider or throw the matching {@link FluentError}. */
function resolveProvider(selection: Selection): FluentProvider {
  const { configuredId, providers } = selection
  if (configuredId !== undefined) {
    const provider = [...providers.values()].find(candidate => candidate.id === configuredId)
    if (provider === undefined) {
      throw new FluentError(`configured Fluent provider "${configuredId}" is not registered`, 'FLUENT_PROVIDER_CONFIGURED_MISSING')
    }
    if (!provider.available()) {
      throw new FluentError(`configured Fluent provider "${configuredId}" is registered but unavailable`, 'FLUENT_PROVIDER_CONFIGURED_UNAVAILABLE')
    }
    return provider
  }
  const usable = [...providers.values()].filter(provider => provider.available())
  const [single] = usable
  if (single === undefined) {
    throw new FluentError('no usable Fluent provider is registered', 'FLUENT_PROVIDER_UNAVAILABLE')
  }
  if (usable.length > 1) {
    const ids = usable.map(provider => provider.id).join(', ')
    throw new FluentError(`multiple usable Fluent providers are registered (${ids}); configure one explicitly`, 'FLUENT_PROVIDER_AMBIGUOUS')
  }
  return single
}

export default Fluent
