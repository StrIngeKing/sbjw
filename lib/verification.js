/**
 * Verification detection and planning.
 *
 * A mutation is not verified because a command printed the word "success". The
 * detector requires an observable signal: a parsed test summary, an explicit
 * exit code, a filesystem version change for a named artifact, a re-read of an
 * effective configuration, or a successful read-back of the mutated path.
 *
 * `planFor` maps an intent to the checks that intent needs, so the guard can
 * tell the model exactly what is missing instead of restating the whole policy.
 *
 * @module dsh-reliability-guard/verification
 */

import { preview, redactSecrets } from './util.js'
import { shellCommandOf } from './noop-shell.js'
import { shellReadQueries, shellStages, pathKey } from './shell-facts.js'

/** Verification kinds in increasing evidence strength. */
export const VERIFICATION_KINDS = ['read-back', 'absence', 'existence', 'listing', 'diff', 'lint', 'typecheck', 'test', 'build', 'artifact', 'service', 'config-reread']

/** Kinds accepted by the baseline mutation gate; read-back is not a functional test. */
export const STRONG_KINDS = new Set(['read-back', 'absence', 'lint', 'typecheck', 'test', 'build', 'artifact', 'service', 'config-reread'])

/** Recognize a bounded, read-only shell grammar, not command names inside prose. */
function isShellReadBack(command, options) {
  const queries = shellReadQueries(command, options)
  return queries.length > 0 && queries.every(query => query.kind === 'read-back')
}

/** Tool names that read rather than change state, used for read-back detection. */
const READ_TOOLS = new Set(['read', 'read_image'])

/** Command fragments that identify a verification intent. */
const INTENT_RULES = [
  { kind: 'test', pattern: /(\bnode\s+--test\b|\bpytest\b|\bjest\b|\bvitest\b|\bmocha\b|\bgo\s+test\b|\bcargo\s+test\b|\bdotnet\s+test\b|\bnpm\s+(run\s+)?test\b|\bpnpm\s+(run\s+)?test\b|\byarn\s+test\b|\bbun\s+test\b|\brspec\b|\bphpunit\b|\bgradle\s+test\b|\bmvn\s+(-q\s+)?test\b|\bdsh\s+test\b)/i },
  { kind: 'typecheck', pattern: /(\btsc\b|\btypecheck\b|\btype-check\b|\bmypy\b|\bpyright\b|\bflow\b|\bdotnet\s+build\b.*-t:Build\b)/i },
  { kind: 'lint', pattern: /(\beslint\b|\bruff\b|\bflake8\b|\bpylint\b|\bgolangci-lint\b|\bprettier\s+--check\b|\bstandard\b|\bshellcheck\b)/i },
  { kind: 'build', pattern: /(\bnpm\s+run\s+build\b|\bpnpm\s+(run\s+)?build\b|\byarn\s+build\b|\bbun\s+run\s+build\b|\bcargo\s+build\b|\bgo\s+build\b|\bmsbuild\b|\bgradle\s+build\b|\bmvn\s+package\b|\bdocker\s+build\b|\btsc\s+-p\b)/i },
  { kind: 'diff', pattern: /(\bgit\s+diff\b|\bgit\s+status\b|\bgit\s+show\b|\bdiff\b|\bCompare-Object\b)/i },
  { kind: 'service', pattern: /(\bcurl\b|\bInvoke-WebRequest\b|\bInvoke-RestMethod\b|\bhealth\b|\blisten\b|\bnetstat\b|\bss\s+-)/i },
  { kind: 'config-reread', pattern: /(\bgit\s+config\s+--get\b|\bnpm\s+config\s+get\b|\bpnpm\s+config\s+get\b|\bdsh\b.*--dump-config\b)/i },
]

/**
 * Tool names whose mere invocation is a verification attempt, for profiles
 * that ship a dedicated verification tool rather than a shell.
 */
const VERIFICATION_TOOL_KINDS = new Map([
  ['run_tests', 'test'],
  ['run_test', 'test'],
  ['test', 'test'],
  ['typecheck', 'typecheck'],
  ['lint', 'lint'],
  ['build', 'build'],
  ['probe_test', 'test'],
  ['probe_build', 'build'],
  ['probe_typecheck', 'typecheck'],
])

/**
 * Infer the strongest verification kind a tool call intends.
 *
 * @param toolName - the invoked tool.
 * @param args - the parsed arguments.
 * @returns the intended kind, or `undefined` when the call is not a verification.
 */
export function verificationIntent(toolName, args) {
  if (READ_TOOLS.has(toolName)) {
    const path = args?.file_path ?? args?.path
    return typeof path === 'string' && path !== '' ? 'read-back' : undefined
  }
  if (['glob', 'grep', 'search', 'list'].includes(toolName)) return 'listing'
  const dedicated = VERIFICATION_TOOL_KINDS.get(toolName)
  if (dedicated !== undefined) return dedicated
  const command = typeof args?.command === 'string' ? args.command : ''
  if (command === '') return undefined
  const options = { powershell: toolName === 'pwsh' }
  if (shellCommandOf(toolName, args) !== undefined && isShellReadBack(command, options)) return 'read-back'
  const queries = shellReadQueries(command, options)
  if (queries.length) return queries.every(q => q.kind === 'existence') ? 'existence' : 'listing'
  // Do not find a test/build command inside quoted file contents or search terms.
  const stages = shellStages(command)
  const heads = stages.map(s => s.tokens.filter(t => !t.quoted && !t.operator).map(t => t.value).join(' ')).join('; ')
  if (stages.some(s => /^(echo|Write-Output|Write-Host|read|Get-Content|Get-Item|rg|grep)$/i.test(s.tokens[0]?.value ?? ''))) return undefined
  for (const rule of INTENT_RULES) {
    if (rule.pattern.test(heads)) return rule.kind
  }
  return undefined
}

/** Explicit read targets. Listings do not imply that a changed file was read. */
export function verificationQueries(toolName, args, cwd) {
  if (READ_TOOLS.has(toolName)) {
    const path = args?.file_path ?? args?.path
    return typeof path === 'string' ? [{ path: pathKey(path, cwd), kind: 'read-back', verb: toolName }] : []
  }
  if (toolName === 'glob') {
    if (typeof args?.pattern !== 'string' || /[*?\[\]{}]/.test(args.pattern)) return []
    return [{ path: pathKey(args.pattern, pathKey(args.path ?? '.', cwd)), kind: 'glob', verb: 'glob' }]
  }
  if (toolName === 'list' && typeof args?.path === 'string') return [{ path: pathKey(args.path, cwd), kind: 'listing', verb: 'list' }]
  const command = shellCommandOf(toolName, args)
  if (command === undefined) return []
  // Shell tools may execute relative paths from an explicit workdir that differs
  // from the session workspace root. Resolve verification targets from the same
  // directory the command actually used so they match mutation ledger keys.
  const commandCwd = typeof args?.workdir === 'string' && args.workdir.trim() !== ''
    ? pathKey(args.workdir, cwd)
    : cwd
  return shellReadQueries(command, { powershell: toolName === 'pwsh' }).map(query => ({ ...query, path: pathKey(query.path, commandCwd) }))
}

/**
 * Signals that prove a check actually ran and reported a result.
 *
 * Each entry extracts a concrete observation. An entry must NOT rely on the
 * mere presence of a success word; it must parse a number, a code, or a state.
 */
const OUTCOME_PATTERNS = [
  // Test summaries: "5 passed", "3 failed, 1 passed", "Tests: 2 failed, 7 passed"
  {
    kind: 'summary',
    pattern: /(\d+)\s+(passed|passing|failed|failing|skipped|pending|errored)\b/gi,
    read(match) {
      const count = Number(match[1])
      const word = match[2].toLowerCase()
      if (word.startsWith('fail') || word === 'errored') return { failed: count }
      if (word.startsWith('pass')) return { passed: count }
      return {}
    },
  },
  // Explicit exit codes.
  { kind: 'exit', pattern: /\[exit code:\s*(\d+)\]/gi, read: (match) => ({ exitCode: Number(match[1]) }) },
  { kind: 'exit', pattern: /^(?:exit\s+code|Exit\s*Code|exitcode)\s*[:=]\s*(-?\d+)\s*$/gim, read: (match) => ({ exitCode: Number(match[1]) }) },
  { kind: 'exit', pattern: /process exited with code\s+(\d+)/gi, read: (match) => ({ exitCode: Number(match[1]) }) },
  { kind: 'exit', pattern: /\$\?LASTEXITCODE\s*[:=]?\s*(\d+)/g, read: (match) => ({ exitCode: Number(match[1]) }) },
  // Build/tool-specific terminal lines that name a result, not an aspiration.
  { kind: 'build', pattern: /(\d+)\s+Error\(s\)/g, read: (match) => ({ buildErrors: Number(match[1]) }) },
  { kind: 'signal', pattern: /\b(FAIL|FAILED|ERROR|BUILD FAILED|COMPILATION ERROR)\b/g, read: () => ({ failureWord: true }) },
  { kind: 'signal', pattern: /\b(OK|SUCCESS|PASS|PASSED|BUILD SUCCEEDED|0 errors?)\b/g, read: () => ({ successWord: true }) },
  // Typecheck / lint clean markers
  { kind: 'signal', pattern: /\bno (issues|errors|problems|type errors) found\b/gi, read: () => ({ cleanMarker: true }) },
  { kind: 'signal', pattern: /\b(\d+)\s+(problems?|issues?|warnings?|errors?)\b/gi, read: (match) => ({ problemCount: Number(match[1]) }) },
  // Artifact version lines, for build/install verification.
  { kind: 'artifact', pattern: />\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\s*$/gm, read: (match) => ({ version: match[1] }) },
  // Test framework totals
  { kind: 'summary', pattern: /\bTests?:\s*(.*)$/gim, read: (match) => parseTotals(match[1]) },
  { kind: 'summary', pattern: /\b(\d+)\s+of\s+(\d+)\s+tests?\s+(passed|failed)/gi, read: (match) => (match[3].toLowerCase() === 'passed' ? { passed: Number(match[1]), total: Number(match[2]) } : { failed: Number(match[2]) - Number(match[1]), passed: Number(match[1]), total: Number(match[2]) }) },
]

/** Parse a `Tests: 2 failed, 7 passed, 1 skipped` tail into counters. */
function parseTotals(text) {
  const result = {}
  const matches = String(text).matchAll(/(\d+)\s+(passed|failed|skipped|pending|todo)/gi)
  for (const match of matches) {
    const count = Number(match[1])
    const word = match[2].toLowerCase()
    if (word === 'passed') result.passed = (result.passed ?? 0) + count
    else if (word === 'failed') result.failed = (result.failed ?? 0) + count
    else result.skipped = (result.skipped ?? 0) + count
  }
  return result
}

/**
 * Extract observable verification signals from a tool result.
 *
 * @param text - the result text content, already bounded by the caller.
 * @param isError - whether the pipeline marked the result as a failure.
 * @returns the parsed signals.
 */
export function parseVerificationSignals(text, isError) {
  const body = String(text ?? '')
  const displayBody = body
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => !/^\[(?:stdout|stderr)\]\s*$/i.test(line))
    .filter(line => !/^\[exit code:\s*[^\]]+\]\s*$/i.test(line))
    .join('\n')
    .trim()
  const signals = {
    isError: isError === true,
    passed: 0,
    failed: 0,
    skipped: 0,
    total: undefined,
    exitCode: undefined,
    buildErrors: undefined,
    problemCount: undefined,
    failureWord: false,
    successWord: false,
    cleanMarker: false,
    version: undefined,
    hasReadOutput: displayBody !== '' && displayBody !== '(no output)',
    // PowerShell can report non-terminating cmdlet errors despite exit code 0.
    shellReadFailed: /\[stderr\]|\[exit code:\s*(?:null|unknown)\]|(?:^|\n)\s*(?:Get-FileHash|Get-Item|Get-Content|Test-Path|Get-ChildItem)\s*:|\b(?:CategoryInfo|FullyQualifiedErrorId)\s*:/i.test(body),
    interrupted: /\[(?:timed out|stopped:|killed by signal:|still running)[^\]]*\]/i.test(body),
    evidence: [],
  }
  const seen = new Set()
  for (const { kind, pattern, read } of OUTCOME_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags)
    for (const match of body.matchAll(regex)) {
      const key = `${kind}:${match[0]}`
      if (seen.has(key)) continue
      seen.add(key)
      const parsed = read(match) ?? {}
      if (parsed.passed !== undefined) signals.passed += parsed.passed
      if (parsed.failed !== undefined) signals.failed += parsed.failed
      if (parsed.skipped !== undefined) signals.skipped += parsed.skipped
      if (parsed.total !== undefined) signals.total = parsed.total
      if (parsed.exitCode !== undefined) signals.exitCode = parsed.exitCode
      if (parsed.buildErrors !== undefined) signals.buildErrors = parsed.buildErrors
      if (parsed.problemCount !== undefined) signals.problemCount = parsed.problemCount
      if (parsed.failureWord === true) signals.failureWord = true
      if (parsed.successWord === true) signals.successWord = true
      if (parsed.cleanMarker === true) signals.cleanMarker = true
      if (parsed.version !== undefined) signals.version = parsed.version
      if (signals.evidence.length < 6) signals.evidence.push(preview(match[0].trim(), 120))
    }
  }
  return signals
}

/**
 * Decide whether a result constitutes a passed verification of a given kind.
 *
 * A failure word always wins: a summary that reports any failure is a failure,
 * even when it also reports passes. An error-marked result with no parsed
 * counters is never a pass.
 *
 * @param kind - the intended verification kind.
 * @param signals - the parsed signals.
 * @param options.shellRead - require observable output and shell completion for read-back.
 * @returns the verdict.
 */
export function judgeVerification(kind, signals, { shellRead = false } = {}) {
  if (['read-back', 'listing', 'existence', 'diff'].includes(kind)) {
    if (signals.isError || (shellRead && (signals.shellReadFailed || signals.interrupted || (signals.exitCode !== undefined && signals.exitCode !== 0)))) {
      return { passed: false, strong: false, reason: 'the read failed or did not finish' }
    }
    if (!signals.hasReadOutput && kind !== 'listing') return { passed: false, strong: false, reason: 'no observable read result' }
    return { passed: true, strong: STRONG_KINDS.has(kind), reason: 'the requested state was observed; coverage requires matching targets' }
  }
  if (shellRead && (signals.shellReadFailed || signals.interrupted)) {
    return { passed: false, strong: false, reason: 'the shell read reported an error or did not finish' }
  }
  if (shellRead && !signals.hasReadOutput) {
    return { passed: false, strong: false, reason: 'the shell read returned no observable file state' }
  }
  if (signals.failed > 0) {
    return { passed: false, reason: `${signals.failed} failing result(s) reported` }
  }
  if (signals.buildErrors !== undefined && signals.buildErrors > 0) {
    return { passed: false, reason: `${signals.buildErrors} build error(s) reported` }
  }
  if (signals.isError) {
    return { passed: false, reason: 'the tool reported the call as failed' }
  }
  if (signals.exitCode !== undefined && signals.exitCode !== 0) {
    return { passed: false, reason: `exit code ${signals.exitCode}` }
  }
  if (signals.failureWord) {
    return { passed: false, reason: `the output contains an explicit failure marker (${signals.evidence[0] ?? 'FAIL'})` }
  }
  switch (kind) {
    case 'test':
      if (signals.passed > 0 || signals.cleanMarker) {
        return { passed: true, reason: `${signals.passed} passing check(s) reported`, strong: true }
      }
      return { passed: false, reason: 'no test summary was found in the output' }
    case 'typecheck':
    case 'lint':
      if (signals.cleanMarker || (signals.problemCount !== undefined && signals.problemCount === 0)) {
        return { passed: true, reason: 'clean check reported', strong: true }
      }
      if (signals.problemCount !== undefined && signals.problemCount > 0) {
        return { passed: false, reason: `${signals.problemCount} problem(s) reported` }
      }
      if (signals.successWord && signals.exitCode === 0) {
        return { passed: true, reason: 'success marker with exit code 0', strong: true }
      }
      return { passed: false, reason: 'no clean-check marker or zero-problem count was found' }
    case 'build':
      if (signals.exitCode === 0 || signals.buildErrors === 0) {
        return { passed: true, reason: 'build reported success with an exit code or zero error count', strong: true }
      }
      return { passed: false, reason: 'no build exit code or zero-error count was found' }
    case 'service':
      if (signals.exitCode === 0) {
        return { passed: true, reason: 'service probe reported a response', strong: true }
      }
      return { passed: false, reason: 'no service response evidence was found' }
    case 'config-reread':
      if (!signals.hasReadOutput) return { passed: false, reason: 'no configuration state was observed' }
      return { passed: true, reason: 'the current state was read back', strong: STRONG_KINDS.has(kind) }
    case 'artifact':
      if (signals.version !== undefined) {
        return { passed: true, reason: `artifact version ${signals.version} reported`, strong: true }
      }
      return { passed: false, reason: 'no artifact identity (path or version) was observed' }
    default:
      return { passed: false, reason: `unknown verification kind "${kind}"` }
  }
}

/**
 * The checks an intent needs, in the order they should run.
 *
 * @param intent - one of `code`, `build`, `service`, `config`, `install`.
 * @returns the ordered list of required check kinds.
 */
export function planFor(intent) {
  switch (intent) {
    case 'code':
      return ['test', 'typecheck', 'diff']
    case 'build':
      return ['build', 'artifact']
    case 'service':
      return ['service']
    case 'config':
      return ['config-reread']
    case 'install':
      return ['artifact', 'service']
    default:
      return ['read-back']
  }
}

/**
 * Whether one tool call mutates state, using the risk classification.
 *
 * @param risk - the classification risk level.
 * @returns whether the call changes state.
 */
export function isMutationRisk(risk) {
  return risk !== 'LOW'
}

/**
 * Build the corrective text the completion gate injects.
 *
 * The text names only observable gaps, so the model knows what to do rather
 * than being reminded of the whole policy.
 *
 * @param gaps - the detected gaps.
 * @param options - rendering options.
 * @param options.digest - an evidence digest to append.
 * @returns the message text.
 */
export function renderGateMessage(gaps, { digest } = {}) {
  const lines = ['Reliability Guard: open completion gaps:']
  for (const gap of gaps) lines.push(`- ${gap}`)
  lines.push('Close with observable evidence or report the gap open; do not claim completion while blocking items remain.')
  if (typeof digest === 'string' && digest.trim() !== '') {
    lines.push('Evidence:', digest)
  }
  return lines.join('\n')
}

/**
 * Render the review request for a fresh-context reviewer.
 *
 * The reviewer receives the requirement, the current state, the diff, and the
 * verification results — never the executor's own explanation, which would
 * anchor the review.
 *
 * @param input - review inputs.
 * @param input.requirement - the original user request, bounded.
 * @param input.currentState - what the workspace now contains, bounded.
 * @param input.diff - the observed change, bounded.
 * @param input.verification - the verification results, bounded.
 * @param input.risk - the highest risk level involved.
 * @param input.round - the review round number.
 * @returns the review prompt.
 */
export function renderReviewPrompt({ requirement, currentState, diff, verification, risk, round }) {
  const section = (value, max = 1800) => preview(redactSecrets(String(value ?? '')), max)
  return [
    `Independent review r${round}; risk=${risk}. Review independently; do not rely on author reasoning.`,
    '',
    'Requirement:', section(requirement, 1200),
    '',
    'State:', section(currentState),
    '',
    'Change:', section(diff),
    '',
    'Checks:', section(verification),
    '',
    'Check requirement/scope, counterexamples (path/input/platform/order), whether checks exercise the changed behavior, and any unverified or unrelated edit.',
    'Output first line exactly `VERDICT: PASS` or `VERDICT: FAIL`. For FAIL, list concrete findings with evidence; insufficient evidence => FAIL and name what is missing.',
  ].join('\n')
}

/**
 * Parse a reviewer's verdict from its report.
 *
 * Unparseable output is treated as a failure, because an unreadable review is
 * not evidence of correctness.
 *
 * @param text - the reviewer's report.
 * @returns the parsed verdict.
 */
export function parseReviewVerdict(text) {
  const body = String(text ?? '')
  const match = /VERDICT\s*:\s*(PASS|FAIL)/i.exec(body)
  if (match === null) {
    return {
      verdict: 'FAIL',
      reason: 'the review did not state a parseable `VERDICT: PASS` or `VERDICT: FAIL` line',
      report: preview(redactSecrets(body), 1200),
    }
  }
  const verdict = match[1].toUpperCase()
  const remainder = body.slice(match.index + match[0].length).trim()
  return {
    verdict,
    reason: verdict === 'PASS' ? 'the reviewer found no counterexample' : preview(redactSecrets(remainder), 1200),
    report: preview(redactSecrets(body), 1600),
  }
}
