/**
 * Optional `/visualizer` projection of ignorable turbo session events.
 * @module @deepseek-ai/dsh-experimental-llm-turbo/visualizer
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { LlmTurboCandidatesEventData, LlmTurboProgressEventData, LlmTurboVerdictEventData } from './types.ts'

/** One visualizer row projected from a session's turbo events. */
export interface TurboVisualizerEntry {
  /** Stable visualizer id `sessionId:turn:step`. */
  id: string
  /** Session that owns the turbo step. */
  sessionId: string
  /** Turn number copied from the candidates event. */
  turn: number
  /** Step number copied from the candidates event. */
  step: number
  /** Event timestamp in epoch milliseconds. */
  timestamp: number
  /** Gathered candidates for this step. */
  candidates: LlmTurboCandidatesEventData
  /** Verdict for this step, when present. */
  verdict?: LlmTurboVerdictEventData
  /** Progress monitor payload, when present. */
  progress?: LlmTurboProgressEventData
}

/** TurboAgent `RequestLogEntry` fields the DAG needs. */
export interface TurboRequestLogEntry {
  /** Visualizer row id. */
  id: string
  /** Owning session id. */
  sessionId: string
  /** ISO timestamp of the candidates event. */
  timestamp: string
  /** Constant API label for the DAG request node. */
  api: 'dsh'
  /** Minimal request stub; turbo events do not store original messages. */
  request: { model: string; messages: Array<{ role: string; content: string }> }
  /** Context-refinement node; v1 session events do not set this. */
  contextRefinement: { enabled: boolean }
  /** One node per gathered candidate action. */
  responses: Array<{
    model: string
    response: {
      choices: Array<{ message: { role: 'assistant'; content: string }; finish_reason: string }>
      model: string
      id: string
    }
  }>
  /** Reflection node; v1 does not record reflection. */
  reflection: { enabled: boolean }
  /** Verifier node and scores copied from the verdict. */
  verifier: {
    enabled: boolean
    scores?: Array<{ index: number; model: string; score: number }>
    comparisons?: Array<{
      i: number
      j: number
      rating_A: number
      rating_B: number
      winner: string
      request: Array<{ role: string; content: string }>
    }>
    bestIndex?: number
  }
  /** Progress-monitor node copied from `llm/turbo-progress`. */
  progressMonitor: { enabled: boolean; score?: number; error?: string }
  /** Winning action replayed to the client. */
  finalResponse: {
    choices: Array<{ message: { role: 'assistant'; content: string } }>
    model: string
  }
  /** Unused elapsed placeholder kept for TurboAgent log compatibility. */
  elapsedMs: number
}

/** One DAG node after rank layout. */
export interface TurboGraphNode {
  /** Graph node id. */
  id: string
  /** Display label. */
  label: string
  /** Pipeline role used by the HTML renderer. */
  nodeType: 'request' | 'context' | 'response' | 'reflection' | 'verifier' | 'progress' | 'final'
  /** Layout x in pixels. */
  x: number
  /** Layout y in pixels. */
  y: number
  /** True when this response is the verdict winner. */
  isBest?: boolean
  /** Optional verifier or progress score. */
  score?: number
}

/** One DAG edge. */
export interface TurboGraphEdge {
  /** Edge id. */
  id: string
  /** Source node id. */
  source: string
  /** Target node id. */
  target: string
}

const NODE_WIDTH = 220
const NODE_HEIGHT = 80
const NODE_SEP = 40
const RANK_SEP = 80

/**
 * Project live sessions into per-step visualizer rows.
 * @param sessions - live sessions from `ctx.sessions.list()`.
 * @returns one entry per `llm/turbo-candidates` event.
 */
export function projectVisualizerEntries(sessions: readonly Session[]): TurboVisualizerEntry[] {
  const entries: TurboVisualizerEntry[] = []
  for (const session of sessions) {
    const verdicts = new Map<string, LlmTurboVerdictEventData>()
    const progress = new Map<string, LlmTurboProgressEventData>()
    for (const event of session.events) {
      if (event.type === 'llm/turbo-verdict') {
        verdicts.set(`${event.data.turn}:${event.data.step}`, event.data)
      }
      if (event.type === 'llm/turbo-progress') {
        progress.set(`${event.data.turn}:${event.data.step}`, event.data)
      }
    }
    for (const event of session.events) {
      if (event.type !== 'llm/turbo-candidates') continue
      const key = `${event.data.turn}:${event.data.step}`
      const verdict = verdicts.get(key)
      const progressRow = progress.get(key)
      entries.push({
        id: `${session.id}:${event.data.turn}:${event.data.step}`,
        sessionId: session.id,
        turn: event.data.turn,
        step: event.data.step,
        timestamp: event.time,
        candidates: event.data,
        ...verdict === undefined ? {} : { verdict },
        ...progressRow === undefined ? {} : { progress: progressRow },
      })
    }
  }
  return entries
}

/**
 * Map one visualizer row onto TurboAgent's request-log JSON.
 * @param entry - candidates plus optional verdict/progress.
 * @returns a DAG-ready request log.
 */
export function toRequestLog(entry: TurboVisualizerEntry): TurboRequestLogEntry {
  const winner = entry.verdict === undefined
    ? entry.candidates.candidates[0]
    : entry.candidates.candidates[entry.verdict.bestIndex]
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    timestamp: new Date(entry.timestamp).toISOString(),
    api: 'dsh',
    request: { model: entry.candidates.model, messages: [] },
    contextRefinement: { enabled: false },
    responses: entry.candidates.candidates.map(candidate => ({
      model: candidate.model,
      response: {
        choices: [{
          message: { role: 'assistant', content: candidate.action },
          finish_reason: candidate.error === undefined ? 'stop' : 'error',
        }],
        model: candidate.model,
        id: String(candidate.index),
      },
    })),
    reflection: { enabled: false },
    verifier: {
      enabled: entry.verdict !== undefined,
      ...entry.verdict === undefined ? {} : {
        scores: entry.verdict.scores.map((score, index) => ({
          index,
          model: entry.candidates.candidates[index]?.model ?? entry.candidates.model,
          score,
        })),
        comparisons: entry.verdict.comparisons.map(comparison => ({
          i: comparison.i,
          j: comparison.j,
          rating_A: comparison.ratingA,
          rating_B: comparison.ratingB,
          winner: comparison.winner,
          request: [{ role: 'user', content: comparison.prompt }],
        })),
        bestIndex: entry.verdict.bestIndex,
      },
    },
    progressMonitor: {
      enabled: entry.progress !== undefined,
      ...entry.progress === undefined ? {} : {
        score: entry.progress.score,
        ...entry.progress.error === undefined ? {} : { error: entry.progress.error },
      },
    },
    finalResponse: {
      choices: [{ message: { role: 'assistant', content: winner?.action ?? '' } }],
      model: winner?.model ?? entry.candidates.model,
    },
    elapsedMs: 0,
  }
}

/**
 * Project live sessions into TurboAgent request-log rows.
 * @param sessions - live sessions from `ctx.sessions.list()`.
 * @returns one request log per candidates event.
 */
export function projectRequestLogEntries(sessions: readonly Session[]): TurboRequestLogEntry[] {
  return projectVisualizerEntries(sessions).map(toRequestLog)
}

function layoutRanks(ranks: string[][]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  for (const [rank, ids] of ranks.entries()) {
    const width = ids.length * NODE_WIDTH + (ids.length - 1) * NODE_SEP
    const origin = -width / 2
    for (const [index, id] of ids.entries()) {
      positions.set(id, {
        x: origin + index * (NODE_WIDTH + NODE_SEP),
        y: rank * (NODE_HEIGHT + RANK_SEP),
      })
    }
  }
  return positions
}

/**
 * Build the TurboAgent visualizer DAG from one request log.
 * @param entry - projected request log.
 * @returns laid-out nodes and edges.
 */
export function buildGraph(entry: TurboRequestLogEntry): { nodes: TurboGraphNode[]; edges: TurboGraphEdge[] } {
  const nodes: Omit<TurboGraphNode, 'x' | 'y'>[] = []
  const edges: TurboGraphEdge[] = []
  const ranks: string[][] = [['request']]
  nodes.push({ id: 'request', label: `Request (${entry.api})`, nodeType: 'request' })

  let prev = 'request'
  if (entry.contextRefinement.enabled) {
    nodes.push({ id: 'context', label: 'Context Refinement', nodeType: 'context' })
    edges.push({ id: 'e-req-ctx', source: 'request', target: 'context' })
    ranks.push(['context'])
    prev = 'context'
  }

  const responseIds: string[] = []
  for (const [index] of entry.responses.entries()) {
    const id = `response-${index}`
    responseIds.push(id)
    const score = entry.verifier.scores?.find(row => row.index === index)?.score
    nodes.push({
      id,
      label: `Response ${index}`,
      nodeType: 'response',
      isBest: entry.verifier.bestIndex === index,
      ...score === undefined ? {} : { score },
    })
    edges.push({ id: `e-${prev}-${id}`, source: prev, target: id })
  }
  if (responseIds.length > 0) ranks.push(responseIds)

  const reflectionIds: string[] = []
  if (entry.reflection.enabled) {
    for (const [index] of entry.responses.entries()) {
      const id = `reflection-${index}`
      reflectionIds.push(id)
      nodes.push({ id, label: `Reflection ${index}`, nodeType: 'reflection' })
      // oxlint-disable-next-line typescript/no-non-null-assertion -- response ids are pushed in the previous loop
      const source = responseIds[index]!
      edges.push({ id: `e-${source}-${id}`, source, target: id })
    }
    if (reflectionIds.length > 0) ranks.push(reflectionIds)
  }

  const sourceIds = reflectionIds.length > 0 ? reflectionIds : responseIds
  let preFinal = sourceIds[0] ?? 'request'
  if (entry.verifier.enabled) {
    nodes.push({ id: 'verifier', label: 'Verifier', nodeType: 'verifier' })
    ranks.push(['verifier'])
    for (const source of sourceIds) {
      edges.push({ id: `e-${source}-verifier`, source, target: 'verifier' })
    }
    preFinal = 'verifier'
  } else {
    preFinal = sourceIds[entry.verifier.bestIndex ?? 0] ?? sourceIds[0] ?? 'request'
  }

  if (entry.progressMonitor.enabled) {
    nodes.push({
      id: 'progress',
      label: 'Progress Monitor',
      nodeType: 'progress',
      ...entry.progressMonitor.score === undefined ? {} : { score: entry.progressMonitor.score },
    })
    ranks.push(['progress'])
    edges.push({ id: `e-${preFinal}-progress`, source: preFinal, target: 'progress' })
    edges.push({ id: 'e-progress-final', source: 'progress', target: 'final' })
  } else {
    edges.push({ id: `e-${preFinal}-final`, source: preFinal, target: 'final' })
  }

  nodes.push({ id: 'final', label: 'Final Response', nodeType: 'final' })
  ranks.push(['final'])

  const positions = layoutRanks(ranks)
  return {
    nodes: nodes.map((node) => {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- layoutRanks writes every node id
      const position = positions.get(node.id)!
      return { ...node, x: position.x, y: position.y }
    }),
    edges,
  }
}

/**
 * Self-contained HTML that fetches `/visualizer/api/entries` and draws a DAG.
 * @returns the document body.
 */
export function visualizerHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>llm-turbo visualizer</title>
<style>
body{font:14px/1.4 system-ui,sans-serif;margin:24px;background:#111;color:#eee}
h1{font-size:18px}
.entry{border:1px solid #444;border-radius:8px;padding:12px;margin:16px 0;overflow:auto}
.graph{position:relative;min-height:24rem}
.node{position:absolute;background:#1c1c1c;border:1px solid #555;border-radius:6px;padding:8px;width:12rem;box-sizing:border-box}
.win{border-color:#6c6}
svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
</style></head><body>
<h1>llm-turbo visualizer</h1>
<p>Projected from <code>llm/turbo-*</code> session events into a TurboAgent request-log DAG. Headless sessions without a web server still keep the full log.</p>
<div id="root">loading…</div>
<script>
const root = document.getElementById('root')
fetch('/visualizer/api/entries').then(r => r.json()).then(entries => {
  if (!entries.length) { root.textContent = 'No turbo events in live sessions.'; return }
  root.replaceChildren()
  for (const row of entries) {
    const wrap = document.createElement('div')
    wrap.className = 'entry'
    const title = document.createElement('h2')
    title.textContent = row.log.id + ' · ' + (row.log.verifier.enabled ? (row.log.verifier.bestIndex ?? '') : 'pending')
    wrap.append(title)
    const graph = document.createElement('div')
    graph.className = 'graph'
    let maxX = 0
    let maxY = 0
    for (const node of row.graph.nodes) {
      maxX = Math.max(maxX, node.x + 220)
      maxY = Math.max(maxY, node.y + 80)
    }
    graph.style.width = (maxX + 40) + 'px'
    graph.style.height = (maxY + 40) + 'px'
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    for (const edge of row.graph.edges) {
      const from = row.graph.nodes.find(n => n.id === edge.source)
      const to = row.graph.nodes.find(n => n.id === edge.target)
      if (!from || !to) continue
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      line.setAttribute('x1', String(from.x + 110))
      line.setAttribute('y1', String(from.y + 80))
      line.setAttribute('x2', String(to.x + 110))
      line.setAttribute('y2', String(to.y))
      line.setAttribute('stroke', '#666')
      svg.append(line)
    }
    graph.append(svg)
    for (const node of row.graph.nodes) {
      const el = document.createElement('div')
      el.className = 'node' + (node.isBest ? ' win' : '')
      el.style.left = (node.x + 20) + 'px'
      el.style.top = (node.y + 20) + 'px'
      el.textContent = node.label + (node.score == null ? '' : ' ' + Number(node.score).toFixed(2))
      graph.append(el)
    }
    wrap.append(graph)
    root.append(wrap)
  }
}).catch(error => { root.textContent = String(error) })
</script></body></html>
`
}

/**
 * Register `/visualizer` and `/visualizer/api/entries` on an existing web server.
 * @param ctx - plugin context that owns the session store.
 * @param server - live `webServer` service.
 * @returns a disposer that removes both routes.
 */
export function installVisualizerRoutes(ctx: Context, server: WebServer): () => void {
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    /* v8 ignore next -- node:http always supplies req.url for this prefix handler */
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/visualizer/api/entries') {
      const payload = projectRequestLogEntries(ctx.sessions.list()).map(log => ({
        log,
        graph: buildGraph(log),
      }))
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(payload))
      return
    }
    if (url.pathname === '/visualizer' || url.pathname === '/visualizer/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(visualizerHtml())
      return
    }
    res.writeHead(404)
    res.end()
  }
  return server.register({ kind: 'prefix', path: '/visualizer', handler })
}
