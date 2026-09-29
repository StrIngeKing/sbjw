/**
 * Pure no-op shell detection.
 *
 * A no-op command produces no durable state change and no information: it
 * echoes text back, exits, or prints the host name. One such call is a normal
 * way to probe a shell; a run of them is a model that has stopped working on
 * the task. The detector is deliberately conservative — it reports `true` only
 * when EVERY statement and every pipeline stage is effect-free, so a command
 * that also touches the filesystem, starts a process, or reads a file is never
 * classified as a no-op.
 *
 * @module sbjw/noop-shell
 */

/**
 * Effect-free commands, matched against a whole normalized statement.
 *
 * Each entry is a predicate over the trimmed statement.
 */
const NOOP_STATEMENTS = [
  // POSIX / generic
  (s) => /^echo(\s|$)/.test(s),
  (s) => /^printf(\s|$)/.test(s),
  (s) => /^true$/.test(s),
  (s) => /^:$/.test(s),
  (s) => /^exit(\s+0)?$/.test(s),
  (s) => /^hostname$/.test(s),
  (s) => /^uname(\s|$)/.test(s),
  (s) => /^pwd$/.test(s),
  (s) => /^whoami$/.test(s),
  (s) => /^date$/.test(s),
  // PowerShell
  (s) => /^write-host(\s|$)/i.test(s),
  (s) => /^write-output(\s|$)/i.test(s),
  (s) => /^write-verbose(\s|$)/i.test(s),
  (s) => /^write-information(\s|$)/i.test(s),
  (s) => /^write-debug(\s|$)/i.test(s),
  (s) => /^\[console\]::writeline/i.test(s),
  // A bare string literal is an expression statement with no effect.
  (s) => /^'[^']*'$/.test(s),
  (s) => /^"[^"]*"$/.test(s),
]

/**
 * Pipeline stages whose effect is limited to formatting or discarding already
 * produced output. These are effect-free ONLY when every stage of the pipeline
 * is in this set or in {@link NOOP_STATEMENTS}: `Get-Content x | Out-Null`
 * reads the filesystem, so it is not a no-op.
 */
const FORMAT_ONLY_STAGES = [
  'out-null',
  'out-host',
  'out-string',
  'out-default',
  'format-list',
  'format-table',
  'format-wide',
  'format-custom',
  'select-object',
  'measure-object',
  'convertto-json',
  'convertto-csv',
  'convertto-html',
  'tee-object',
]

/** Whether one pipeline stage is formatting-only. */
function isFormatOnlyStage(stage) {
  const lowered = stage.trim().toLowerCase()
  return FORMAT_ONLY_STAGES.some((name) => lowered === name || lowered.startsWith(`${name} `) || lowered.startsWith(`${name}(`))
}

/** Whether one statement is effect-free on its own. */
function isNoopStatement(statement) {
  const text = statement.replace(/[;&|]+$/, '').trim()
  if (text === '') return true
  for (const predicate of NOOP_STATEMENTS) {
    if (predicate(text)) return true
  }
  return false
}

/**
 * Split a shell command into statements, honoring quotes.
 *
 * `|` is deliberately NOT a separator here: a pipeline is one statement whose
 * stages are examined individually, which is what lets an all-effect-free
 * pipeline such as `Write-Host "x" | Out-Null` be recognized as a no-op.
 *
 * @param command - the raw command.
 * @returns the statements in order, empty statements removed.
 */
export function splitStatements(command) {
  return splitTopLevel(String(command ?? ''), [';', '\n', '&'])
}

/**
 * Split a pipeline into its stages, honoring quotes.
 *
 * @param statement - one statement.
 * @returns the stages in order, empty stages removed.
 */
export function splitPipeline(statement) {
  return splitTopLevel(String(statement ?? ''), ['|'])
}

/**
 * Split on a set of single-character operators that appear outside quotes.
 *
 * @param text - the text to split.
 * @param operators - the operator characters.
 * @returns the trimmed, non-empty parts.
 */
function splitTopLevel(text, operators) {
  const parts = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\' && !inSingle) {
      current += char
      index += 1
      if (index < text.length) current += text[index]
      continue
    }
    if (char === "'" && !inDouble && !inBacktick) inSingle = !inSingle
    else if (char === '"' && !inSingle && !inBacktick) inDouble = !inDouble
    else if (char === '`' && !inSingle && !inDouble) inBacktick = !inBacktick
    if (!inSingle && !inDouble && !inBacktick && operators.includes(char)) {
      // Consume a doubled operator (`&&`, `||`, `>>`).
      while (index + 1 < text.length && text[index + 1] === char) index += 1
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

/**
 * Whether a statement redirects output into a file or stream.
 *
 * A redirection is a durable side effect, so such a statement can never be
 * classified as a no-op — that is what keeps `echo hi > file.txt` out of the
 * no-op detector while still recognizing a bare `echo hi`.
 *
 * @param statement - one statement.
 * @returns whether an unquoted `>`, `>>`, `2>`, `*>`, `Out-File` or `Tee-Object` is present.
 */
export function writesViaRedirection(statement) {
  const stages = splitPipeline(statement)
  for (const stage of stages) {
    if (/(?:^|\s)(?:\d?|\*)>>?(?!&)/.test(stage)) return true
    if (/\b(Out-File|Set-Content|Add-Content|Tee-Object|Export-Csv|Start-Transcript)\b/i.test(stage)) return true
  }
  return false
}

/**
 * Strip leading comments and blank lines so a marker-only command is still
 * recognized.
 *
 * @param command - the raw command.
 * @returns the command with leading comment lines removed.
 */
export function stripLeadingComments(command) {
  const lines = String(command ?? '').replace(/\r\n?/g, '\n').split('\n')
  let index = 0
  while (index < lines.length) {
    const line = lines[index].trim()
    if (line === '' || line.startsWith('#')) {
      index += 1
      continue
    }
    break
  }
  return lines.slice(index).join('\n')
}

/**
 * Whether a shell command is a pure no-op.
 *
 * @param command - the raw command text.
 * @returns `true` only when every statement is effect-free and nothing is
 *   redirected into a file.
 */
export function isNoopShellCommand(command) {
  const body = stripLeadingComments(command).trim()
  if (body === '') return true
  // A redirection is a real write, so the command is never a no-op.
  if (writesViaRedirection(body)) return false
  // Input redirection (`< file`) is an effect-free read of a file.
  const statements = splitStatements(body)
  if (statements.length === 0) return true
  for (const statement of statements) {
    const stages = splitPipeline(statement.replace(/[;&|]+$/, ''))
    if (stages.length === 0) continue
    for (const stage of stages) {
      if (isNoopStatement(stage)) continue
      if (isFormatOnlyStage(stage)) continue
      return false
    }
  }
  return true
}

/**
 * Extract the shell command from a tool call, when the call is a shell call.
 *
 * @param toolName - the invoked tool name.
 * @param args - the parsed arguments.
 * @returns the command text, or `undefined` when this is not a shell call.
 */
export function shellCommandOf(toolName, args) {
  if (toolName !== 'bash' && toolName !== 'pwsh') return undefined
  if (args === null || typeof args !== 'object') return undefined
  const command = args.command
  return typeof command === 'string' ? command : undefined
}
