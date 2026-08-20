/**
 * Vertex and OpenAI-compatible HTTP transport for verifier completions.
 * @module @deepseek-ai/dsh-experimental-llm-turbo/transport
 */

import { TurboError, type VerifierCompletion } from './types.ts'

/** Verifier HTTP backend selected by config. */
export type VerifierProvider = 'vertex_ai' | 'openai_compatible'

/** Resolved transport settings for one verifier call. */
export interface VerifierTransportConfig {
  provider: VerifierProvider
  model: string
  apiKey: string
  baseUrl?: string
}

interface VertexCandidate {
  readonly content?: { readonly parts?: ReadonlyArray<{ readonly text?: string }> }
  readonly logprobs_result?: {
    readonly top_candidates?: ReadonlyArray<{
      readonly candidates?: ReadonlyArray<{ readonly token?: string; readonly log_probability?: number }>
    }>
    readonly chosen_candidates?: ReadonlyArray<{ readonly token?: string }>
  }
  readonly logprobsResult?: VertexCandidate['logprobs_result']
}

interface OpenAiChoice {
  readonly message?: { readonly content?: string | null }
  readonly logprobs?: {
    readonly content?: ReadonlyArray<{
      readonly token?: string
      readonly logprob?: number
      readonly top_logprobs?: ReadonlyArray<{ readonly token?: string; readonly logprob?: number }>
    }>
  }
}

/**
 * Strip a `gemini/` LiteLLM prefix so Vertex sees the raw model id.
 * @param model - configured model name.
 * @returns the Vertex/OpenAI model id.
 */
export function verifierModelId(model: string): string {
  return model.startsWith('gemini/') ? model.slice('gemini/'.length) : model
}

/**
 * Default Vertex generateContent URL for one model.
 * @param model - raw model id.
 * @param baseUrl - optional override; empty uses the public Vertex host.
 * @returns the POST URL.
 */
export function vertexGenerateUrl(model: string, baseUrl?: string): string {
  const root = baseUrl !== undefined && baseUrl.length > 0
    ? baseUrl.replace(/\/$/, '')
    : 'https://aiplatform.googleapis.com/v1'
  return `${root}/publishers/google/models/${encodeURIComponent(model)}:generateContent`
}

/**
 * Parse a Vertex `generateContent` JSON body into verifier completion fields.
 * @param body - parsed JSON.
 * @returns text plus optional token logprobs.
 */
export function parseVertexCompletion(body: unknown): VerifierCompletion {
  const record = body as { candidates?: VertexCandidate[] }
  const candidate = record.candidates?.[0]
  const text = candidate?.content?.parts?.map(part => part.text ?? '').join('') ?? ''
  const logprobs = candidate?.logprobs_result ?? candidate?.logprobsResult
  const tops = logprobs?.top_candidates
  if (tops === undefined) return { text }
  const positionLogprobs = tops.map(position =>
    (position.candidates ?? []).map(alt => [alt.token ?? '', alt.log_probability ?? 0] as const),
  )
  const tokens = logprobs?.chosen_candidates?.map(chosen => chosen.token ?? '')
  return { text, ...tokens === undefined ? {} : { tokens }, positionLogprobs }
}

/**
 * Parse an OpenAI-compatible chat completion JSON body.
 * @param body - parsed JSON.
 * @returns text plus optional token logprobs.
 */
export function parseOpenAiCompletion(body: unknown): VerifierCompletion {
  const choice = (body as { choices?: OpenAiChoice[] }).choices?.[0]
  const text = choice?.message?.content ?? ''
  const content = choice?.logprobs?.content
  if (content === undefined) return { text }
  const tokens: string[] = []
  const positionLogprobs: Array<Array<readonly [string, number]>> = []
  for (const position of content) {
    tokens.push(position.token ?? '')
    const alts = (position.top_logprobs ?? []).map(alt => [alt.token ?? '', alt.logprob ?? 0] as const)
    positionLogprobs.push(alts.length > 0 ? alts : [[position.token ?? '', position.logprob ?? 0] as const])
  }
  return { text, tokens, positionLogprobs }
}

/**
 * Fetch a verifier JSON body, mapping transport and HTTP failures to TurboError.
 * @param fetchImpl - injectable `fetch`.
 * @param url - request URL.
 * @param init - request init.
 * @returns parsed JSON.
 */
async function verifierJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetchImpl(url, init)
  } catch (error: unknown) {
    throw new TurboError(
      'VERIFIER_HTTP',
      error instanceof Error ? error.message : String(error),
    )
  }
  if (!response.ok) {
    throw new TurboError('VERIFIER_HTTP', `llm-turbo: verifier HTTP ${response.status}`)
  }
  try {
    return await response.json()
  } catch (error: unknown) {
    throw new TurboError(
      'VERIFIER_HTTP',
      error instanceof Error ? error.message : String(error),
    )
  }
}

/**
 * Call the configured verifier backend once.
 * Prefill / `continue_final_message` is deferred; scores then fall back to
 * tag text or `0.5`.
 * @param config - resolved model, key, and provider.
 * @param prompt - pairwise or progress prompt.
 * @param fetchImpl - injectable `fetch`.
 * @param signal - cancellation.
 * @returns parsed completion.
 */
export async function completeVerifier(
  config: VerifierTransportConfig,
  prompt: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<VerifierCompletion> {
  const model = verifierModelId(config.model)
  if (config.provider === 'openai_compatible') {
    const base = config.baseUrl !== undefined && config.baseUrl.length > 0
      ? config.baseUrl.replace(/\/$/, '')
      : ''
    if (base.length === 0) {
      throw new TurboError('CONFIG', 'llm-turbo: openai_compatible verifier requires baseUrl')
    }
    return parseOpenAiCompletion(await verifierJson(fetchImpl, `${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4096,
        temperature: 1,
        logprobs: true,
        top_logprobs: 20,
      }),
      signal,
    }))
  }

  return parseVertexCompletion(await verifierJson(fetchImpl, vertexGenerateUrl(model, config.baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': config.apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 4096,
        temperature: 1,
        responseLogprobs: true,
        logprobs: 20,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
    signal,
  }))
}
