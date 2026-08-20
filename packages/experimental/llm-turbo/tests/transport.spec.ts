import { describe, expect, it } from 'vitest'
import { TurboError } from '../src/types.ts'
import {
  completeVerifier,
  parseOpenAiCompletion,
  parseVertexCompletion,
  verifierModelId,
  vertexGenerateUrl,
} from '../src/transport.ts'

describe('verifier transport', () => {
  it('strips a LiteLLM gemini prefix and builds the Vertex URL', () => {
    expect(verifierModelId('gemini/gemini-2.5-flash')).toBe('gemini-2.5-flash')
    expect(verifierModelId('gemini-2.5-flash')).toBe('gemini-2.5-flash')
    expect(vertexGenerateUrl('m')).toBe('https://aiplatform.googleapis.com/v1/publishers/google/models/m:generateContent')
    expect(vertexGenerateUrl('m', 'https://proxy.example/v1/')).toBe(
      'https://proxy.example/v1/publishers/google/models/m:generateContent',
    )
  })

  it('parses Vertex snake_case and camelCase logprobs', () => {
    expect(parseVertexCompletion({})).toEqual({ text: '' })
    expect(parseVertexCompletion({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
    })).toEqual({ text: 'ok' })
    const parsed = parseVertexCompletion({
      candidates: [{
        content: { parts: [{ text: 'A' }, { text: 'B' }] },
        logprobs_result: {
          chosen_candidates: [{ token: 'A' }],
          top_candidates: [{ candidates: [{ token: 'A', log_probability: -0.1 }] }],
        },
      }],
    })
    expect(parsed).toEqual({
      text: 'AB',
      tokens: ['A'],
      positionLogprobs: [[['A', -0.1]]],
    })
    expect(parseVertexCompletion({
      candidates: [{
        content: { parts: [{ text: '' }] },
        logprobsResult: { top_candidates: [{ candidates: [] }] },
      }],
    }).positionLogprobs).toEqual([[]])
    expect(parseVertexCompletion({
      candidates: [{
        content: { parts: [{}] },
        logprobs_result: {
          chosen_candidates: [{}],
          top_candidates: [{}, { candidates: [{}] }],
        },
      }],
    })).toEqual({
      text: '',
      tokens: [''],
      positionLogprobs: [[], [['', 0]]],
    })
  })

  it('parses OpenAI chat completions with top_logprobs fallbacks', () => {
    expect(parseOpenAiCompletion({ choices: [{ message: { content: 'hi' } }] })).toEqual({ text: 'hi' })
    expect(parseOpenAiCompletion({ choices: [{ message: { content: null } }] })).toEqual({ text: '' })
    expect(parseOpenAiCompletion({
      choices: [{
        message: { content: 'x' },
        logprobs: {
          content: [
            { token: 'A', logprob: -1, top_logprobs: [{ token: 'A', logprob: -1 }] },
            { token: 'B', logprob: -2 },
            { top_logprobs: [{}] },
            {},
          ],
        },
      }],
    })).toEqual({
      text: 'x',
      tokens: ['A', 'B', '', ''],
      positionLogprobs: [[['A', -1]], [['B', -2]], [['', 0]], [['', 0]]],
    })
  })

  it('POSTs Vertex generateContent and maps HTTP failures', async () => {
    const fetchImpl: typeof fetch = async (url, init) => {
      expect(String(url)).toContain('generateContent')
      expect(init?.headers).toMatchObject({ 'x-goog-api-key': 'k' })
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'v' }] } }],
      }), { status: 200 })
    }
    expect(await completeVerifier({
      provider: 'vertex_ai',
      model: 'gemini/gemini-2.5-flash',
      apiKey: 'k',
    }, 'prompt', fetchImpl)).toEqual({ text: 'v' })

    const failing: typeof fetch = async () => new Response('nope', { status: 503 })
    await expect(completeVerifier({
      provider: 'vertex_ai', model: 'm', apiKey: 'k',
    }, 'p', failing)).rejects.toMatchObject({ code: 'VERIFIER_HTTP' })
  })

  it('requires baseUrl for openai_compatible and sends Bearer auth', async () => {
    await expect(completeVerifier({
      provider: 'openai_compatible', model: 'm', apiKey: 'k',
    }, 'p', fetch)).rejects.toBeInstanceOf(TurboError)

    const fetchImpl: typeof fetch = async (url, init) => {
      expect(String(url)).toBe('https://api.example/v1/chat/completions')
      expect(init?.headers).toMatchObject({ authorization: 'Bearer secret' })
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'o' } }],
      }), { status: 200 })
    }
    expect(await completeVerifier({
      provider: 'openai_compatible',
      model: 'm',
      apiKey: 'secret',
      baseUrl: 'https://api.example/v1/',
    }, 'prompt', fetchImpl)).toEqual({ text: 'o' })

    const failing: typeof fetch = async () => new Response('', { status: 401 })
    await expect(completeVerifier({
      provider: 'openai_compatible', model: 'm', apiKey: 'k', baseUrl: 'https://x',
    }, 'p', failing)).rejects.toMatchObject({ code: 'VERIFIER_HTTP' })

    const throwing: typeof fetch = async () => {
      throw new Error('connect refused')
    }
    await expect(completeVerifier({
      provider: 'openai_compatible', model: 'm', apiKey: 'k', baseUrl: 'https://x',
    }, 'p', throwing)).rejects.toMatchObject({ code: 'VERIFIER_HTTP', message: 'connect refused' })

    const stringThrow: typeof fetch = async () => {
      throw 'offline'
    }
    await expect(completeVerifier({
      provider: 'vertex_ai', model: 'm', apiKey: 'k',
    }, 'p', stringThrow)).rejects.toMatchObject({ code: 'VERIFIER_HTTP', message: 'offline' })

    const badJson: typeof fetch = async () => new Response('not-json', { status: 200 })
    await expect(completeVerifier({
      provider: 'vertex_ai', model: 'm', apiKey: 'k',
    }, 'p', badJson)).rejects.toMatchObject({ code: 'VERIFIER_HTTP' })

    const stringJson: typeof fetch = async () => ({
      ok: true,
      json: async () => {
        throw 'bad-json'
      },
    }) as unknown as Response
    await expect(completeVerifier({
      provider: 'vertex_ai', model: 'm', apiKey: 'k',
    }, 'p', stringJson)).rejects.toMatchObject({ code: 'VERIFIER_HTTP', message: 'bad-json' })
  })
})
