/**
 * Host-side ANSYS Fluent executable candidates from `AWP_ROOT<digits>` env
 * vars. Pure: no filesystem I/O and no spawn.
 * @module @deepseek-ai/dsh-fluent-local/discover
 */

import { join } from 'node:path'

/** Matches ANSYS `AWP_ROOT241`-style roots; the digits are the version key. */
const AWP_ROOT = /^AWP_ROOT(\d+)$/i

/**
 * Absolute Fluent launcher paths to try after a configured `fluent` PATH lookup
 * fails. Only `command === 'fluent'` participates; any other configured name
 * or path is left to `resolveExecutable` alone. The highest numeric
 * `AWP_ROOT<digits>` wins. Empty values are ignored.
 * @param command - the configured executable name or path.
 * @param env - merged host env (`process.env` plus provider `env` overrides).
 * @param platform - `win32` uses `fluent/ntbin/win64/fluent.exe`; others use `fluent/bin/fluent`.
 * @returns zero or one absolute candidate.
 */
export function fluentExecutableCandidates(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  if (command !== 'fluent') return []
  let best: { version: number; root: string } | undefined
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === '') continue
    const match = AWP_ROOT.exec(key)
    if (match === null) continue
    const version = Number(match[1])
    if (!Number.isFinite(version)) continue
    if (best === undefined || version > best.version) best = { version, root: value }
  }
  if (best === undefined) return []
  const relative = platform === 'win32'
    ? join('fluent', 'ntbin', 'win64', 'fluent.exe')
    : join('fluent', 'bin', 'fluent')
  return [join(best.root, relative)]
}
