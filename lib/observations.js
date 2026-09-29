/** Targeted observations used for verification, separate from tool success text. */
import { posix } from 'node:path'
import { stat as nodeStat } from 'node:fs/promises'
import { pathKey } from './shell-facts.js'
import { parseVerificationSignals } from './verification.js'

/**
 * DSH renders shell results with presentation-only marker lines such as
 * `[stdout]` and `[exit code: 0]` when a structured `value.stdout` is not
 * exposed to the plugin.  Those markers are transport metadata, not command
 * output.  Strip only whole marker lines; never rewrite arbitrary command
 * output that merely contains bracketed text.
 */
function shellReceiptLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^\[(?:stdout|stderr)\]\s*$/i.test(line))
    .filter(line => !/^\[exit code:\s*[^\]]+\]\s*$/i.test(line))
}

/**
 * DSH 0.1.7+ exposes foreground shell streams as structured objects
 * `{ text, truncated, spillPath? }`; older/replayed results may still expose
 * strings. Normalize both shapes without stringifying an object to
 * `[object Object]`, which would incorrectly make an empty stderr look non-empty.
 */
function shellStreamText(stream) {
  if (typeof stream === 'string') return stream
  if (stream !== null && typeof stream === 'object' && typeof stream.text === 'string') return stream.text
  return ''
}

function shellExitCode(value) {
  const code = value?.exitCode
  if (typeof code === 'number' && Number.isFinite(code)) return code
  if (typeof code === 'string' && /^-?\d+$/.test(code.trim())) return Number(code)
  return code
}

/**
 * Last-resort local stat for the exact path already recorded in the mutation
 * ledger.  This is used only when the DSH fs service is unavailable.  It does
 * not infer absence from a directory listing and it does not accept paths that
 * are not native absolute paths for the current host.
 */
async function locallyAbsent(path) {
  const value = String(path ?? '')
  const nativeAbsolute = process.platform === 'win32'
    ? /^[a-z]:[\\/]/i.test(value)
    : value.startsWith('/')
  if (!nativeAbsolute) return false
  try {
    await nodeStat(value)
    return false
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
  }
}

export async function collectReadEvidence(ctx, exec, result, text, facts, state) {
  const queries = facts.queries ?? []
  const targets = []
  if (!queries.length || facts.guardDenied) return { targets }
  const shell = exec.name === 'pwsh' || exec.name === 'bash'
  const signals = parseVerificationSignals(text, result?.isError)
  const value = result?.value
  const structuredShell = shell && value !== null && typeof value === 'object' && 'exitCode' in value
  const structuredStdout = structuredShell ? shellStreamText(value.stdout) : ''
  const structuredStderr = structuredShell ? shellStreamText(value.stderr) : ''
  const structuredExitCode = structuredShell ? shellExitCode(value) : undefined
  const shellOK = !shell || (structuredShell
    ? structuredExitCode === 0 && !value.timedOut && !value.stopped && !value.aborted && !value.signal && !structuredStderr.trim()
    : !signals.shellReadFailed && !signals.interrupted && (signals.exitCode === undefined || signals.exitCode === 0))
  const code = result?.error?.info?.code ?? result?.error?.code
  const missing = code === 'FS_NOT_FOUND' || (shell && /ItemNotFoundException|PathNotFound|Cannot find path|找不到路径/i.test(text)
    && !/AccessDenied|UnauthorizedAccess|Permission denied|拒绝访问|timed out/i.test(text))
  let expectedNotFound = false
  // DSH shell results can carry a structured stdout alongside decorated display
  // text (for example `[stdout]` / `[exit code: 0]`). Existence receipts must be
  // parsed from the command's stdout when available; requiring the presentation
  // text itself to be exactly `True`/`False` can discard a valid target receipt.
  const stdout = structuredStdout
  const booleanText = stdout.trim() !== '' ? stdout : text
  const bools = shellReceiptLines(booleanText)
  const exactBools = queries.every(q => q.kind === 'existence') && bools.length === queries.length && bools.every(s => /^(true|false)$/i.test(s))
  const wrappedBools = queries.every(q => typeof q.outputPrefix === 'string') && bools.length === queries.length

  const absentNow = async (path) => {
    if (facts.observations?.get(path) === 'absent') return true
    const fs = ctx.get('fs')
    if (fs) {
      try {
        const target = await fs.resolve(path, { cwd: state.workspaceRoot })
        if (await fs.stat(target, exec.signal) === undefined) return true
      } catch {
        // A provider permission/transport failure is not itself absence.  A
        // native exact stat may still be available on Desktop, so continue.
      }
    }
    return locallyAbsent(path)
  }

  for (const [index, query] of queries.entries()) {
    const key = pathKey(query.path, state.workspaceRoot)
    const change = state.mutations.get(key)
    const pendingDeletion = change?.expected === 'absent' && facts.startSeq > change.at
    // The host can wrap FsError without preserving its code. Its scoped
    // fs/observed event is authoritative; prose errors alone are not.
    const observedMissing = !shell && facts.observations?.get(key) === 'absent'
    const wrappedFalse = wrappedBools && bools[index].startsWith(query.outputPrefix.trimStart())
      && /^false$/i.test(bools[index].slice(query.outputPrefix.trimStart().length).trim())
    if (pendingDeletion && query.kind === 'existence' && shellOK && !result.isError
      && ((exactBools && /^false$/i.test(bools[index])) || wrappedFalse)) {
      targets.push({ path: key, expected: 'absent', source: wrappedFalse ? 'shell-labeled-false' : 'shell-false' })
    } else if (pendingDeletion && query.kind === 'read-back' && (missing || observedMissing) && !signals.interrupted
      && ((shell && queries.length === 1 && missing) || observedMissing || await absentNow(key))) {
      targets.push({ path: key, expected: 'absent', source: shell && missing ? 'shell-not-found' : observedMissing ? 'fs-observation' : 'exact-stat' })
      expectedNotFound = true
    } else if (pendingDeletion && query.kind === 'glob' && change.type === 'file' && !result.isError
      && value && Array.isArray(value.paths) && value.paths.length === 0 && await absentNow(key)) {
      targets.push({ path: key, expected: 'absent', source: 'glob-empty+exact-stat' })
    } else if (query.kind === 'listing' && !result.isError && shellOK) {
      // A parent re-list only covers deletion, and only with an exact stat
      // confirmation. Hidden/truncated directory output alone proves nothing.
      for (const mutation of state.mutations.values()) {
        if (mutation.expected !== 'absent' || posix.dirname(mutation.key) !== key || facts.startSeq <= mutation.at) continue
        if (await absentNow(mutation.key)) targets.push({ path: mutation.key, expected: 'absent', source: 'listing+exact-stat' })
      }
    } else if (query.kind === 'read-back' && !result.isError && shellOK
      && (signals.hasReadOutput || stdout.trim() !== '' || facts.observations?.get(key) === 'present')) {
      targets.push({ path: key, expected: 'present', source: facts.observations?.get(key) === 'present' ? 'fs-observation' : 'read-output' })
    }
  }
  return { targets, expectedNotFound }
}
