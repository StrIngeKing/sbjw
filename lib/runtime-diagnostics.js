/**
 * Temporary, bounded runtime diagnostics for the shell verification seam.
 *
 * This module is deliberately observational only: it never mutates execution
 * facts, verdicts, evidence, or risk state.  The records are emitted only from
 * `sbjw(detail:true)` so a Desktop E2E run can show the exact
 * runtime shape that differs from isolated parser tests.
 *
 * @module sbjw/runtime-diagnostics
 */

import { shellReadQueries } from './shell-facts.js'
import { shellCommandOf } from './noop-shell.js'
import { verificationQueries } from './verification.js'
import { preview, redactSecrets } from './util.js'

function safeKeys(value) {
  try {
    return value !== null && typeof value === 'object' ? Object.keys(value).slice(0, 40) : []
  } catch {
    return ['<Object.keys threw>']
  }
}

function safePreview(value, limit = 200) {
  try {
    return preview(redactSecrets(String(value ?? '')), limit)
  } catch {
    return '<preview unavailable>'
  }
}

function safeJSON(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return []
  }
}

/**
 * Capture the runtime inputs and both query-extraction paths requested by the
 * 1.1.2 Desktop defect investigation.  Failures here are represented as
 * diagnostic strings rather than thrown: instrumentation must never change a
 * tool call's behavior.
 */
export function captureShellQueryDiagnostic({ toolName, args, workspaceRoot, startSeq }) {
  const execName = String(toolName)
  const commandType = typeof args?.command
  const rawCommand = commandType === 'string' ? args.command : ''
  let wrappedQueries = []
  let directQueries = []
  let shellCommand
  let error

  try {
    wrappedQueries = verificationQueries(execName, args, workspaceRoot)
  } catch (cause) {
    error = `verificationQueries: ${cause instanceof Error ? cause.message : String(cause)}`
  }
  try {
    directQueries = shellReadQueries(String(rawCommand), { powershell: execName === 'pwsh' })
  } catch (cause) {
    error = `${error ? `${error}; ` : ''}shellReadQueries: ${cause instanceof Error ? cause.message : String(cause)}`
  }
  try {
    shellCommand = shellCommandOf(execName, args)
  } catch (cause) {
    error = `${error ? `${error}; ` : ''}shellCommandOf: ${cause instanceof Error ? cause.message : String(cause)}`
  }

  return {
    at: startSeq,
    execName,
    argumentKeys: safeKeys(args),
    commandType,
    commandPreview: safePreview(rawCommand, 200),
    shellCommandDefined: shellCommand !== undefined,
    shellCommandPreview: shellCommand === undefined ? undefined : safePreview(shellCommand, 200),
    verificationQueries: safeJSON(wrappedQueries),
    directShellReadQueries: safeJSON(directQueries),
    error,
  }
}

/** Keep only a tiny rolling window so this temporary instrumentation stays bounded. */
export function noteShellQueryDiagnostic(state, record, max = 8) {
  if (!state || !record) return
  if (!Array.isArray(state.shellQueryDiagnostics)) state.shellQueryDiagnostics = []
  state.shellQueryDiagnostics.push(record)
  if (state.shellQueryDiagnostics.length > max) state.shellQueryDiagnostics.splice(0, state.shellQueryDiagnostics.length - max)
}
