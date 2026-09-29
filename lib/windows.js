/**
 * Windows and PowerShell-first environment checks.
 *
 * These checks exist because a large share of agent failures on Windows are
 * environmental rather than logical: a UTF-8 literal read as GBK, a path with
 * a space silently split, a `\n` written into a file that must stay CRLF, a
 * substitution that only exists in a fresh PowerShell process, or a relative
 * path resolved against a different current directory than the model assumed.
 *
 * Every check is advisory and deterministic. None of them blocks work: the
 * cost of a wrong heuristic must never be a stalled task. On a non-Windows
 * host the evaluator returns no findings, so Linux and macOS behavior is
 * unchanged.
 *
 * @module sbjw/windows
 */

/** Matches any character outside printable ASCII. */
const NON_ASCII = /[^\x20-\x7E\r\n\t]/

/** Output-encoding controls that make PowerShell emit readable non-ASCII. */
const ENCODING_HINT =
  /(\[Console\]::OutputEncoding|\$OutputEncoding|chcp\s+\d+|Out-File[^;|&\n]*-Encoding|-Encoding\s+(utf8|utf8NoBOM|UTF8)|Set-Content[^;|&\n]*-Encoding|Get-Content[^;|&\n]*-Encoding|--encoding\b|PYTHONIOENCODING|LANG=|LC_ALL)/i

/** Any explicit encoding mention at all. */
const ANY_ENCODING_MENTION = /(encoding|utf-?8|utf8|gbk|gb2312|gb18030|big5|cp936|mbcs|ansi|chcp)/i

/** Characters needing quoting, or a literal that should have been quoted. */
const UNSAFE_UNQUOTED = /(^|\s)(-?[A-Za-z]:[\\/][^\s"'|;&]*\s+[^\s"'|;&]+|\/mnt\/[a-z]\/[^\s"'|;&]*\s+[^\s"'|;&]+)/

/** Statements whose effect does not survive their own process. */
const FRESH_PROCESS_ONLY = [
  { pattern: /\$env:(PATH|[A-Za-z_][A-Za-z0-9_]*)\s*=/, note: 'Setting `$env:NAME` only affects the current process; the parent shell and later commands in a different process do not inherit it. Use `setx` (user scope) or pass the value inline.' },
  { pattern: /(^|[\s;|&])cd\s+\S/i, note: '`cd` does not persist between separate PowerShell invocations. Pass an absolute path or the `workdir` argument instead.' },
  { pattern: /\bPush-Location\b/, note: '`Push-Location` is scoped to this process and is lost when the command returns.' },
  { pattern: /\b(Set-Alias|function\s+[A-Za-z-]+)\b/, note: 'An alias or function defined here does not exist in the next invocation; define it in the profile or inline it.' },
  { pattern: /\bImport-Module\b/, note: 'A module imported here is not loaded in the next invocation; import it in the same command that uses it.' },
]

/**
 * Evaluate the Windows-specific checks for one shell call.
 *
 * @param input - the call to evaluate.
 * @param input.toolName - the invoked tool; only `pwsh` and `bash` are examined.
 * @param input.args - the parsed arguments.
 * @param input.platform - `process.platform` value to model.
 * @param input.config - the `windows` configuration section.
 * @returns the findings, strongest first; empty on non-Windows hosts.
 */
export function evaluateWindowsShellCall({ toolName, args, platform = process.platform, config }) {
  if (platform !== 'win32') return []
  if (config?.enabled === false) return []
  if (toolName !== 'pwsh' && toolName !== 'bash') return []
  const command = typeof args?.command === 'string' ? args.command : ''
  if (command === '') return []
  const findings = []
  const push = (code, message) => findings.push({ code, severity: 'advisory', message })

  if (config?.warnOnNonAsciiCommandWithoutEncoding !== false && NON_ASCII.test(command)) {
    if (!ANY_ENCODING_MENTION.test(command)) {
      push(
        'non-ascii-without-encoding',
        'This command contains non-ASCII text but mentions no encoding. On Windows PowerShell 5.1 the console code page is often GBK/936, so a UTF-8 file or literal path can be decoded wrongly. Set the encoding explicitly (for example `[Console]::OutputEncoding = [Text.Encoding]::UTF8` or `-Encoding utf8`) or pass the value through a file.',
      )
    } else if (!ENCODING_HINT.test(command)) {
      push(
        'encoding-mentioned-not-set',
        'This command mentions encoding but does not set an output encoding. Verify the effective code page before trusting the text it prints.',
      )
    }
  }

  if (UNSAFE_UNQUOTED.test(command) && !/"[^"]*"/.test(command)) {
    push(
      'unquoted-path-with-space',
      'A path in this command appears unquoted and contains a space. Quote it (`"C:\\path with space"`) or the shell will split it into two arguments.',
    )
  }

  for (const rule of FRESH_PROCESS_ONLY) {
    if (rule.pattern.test(command)) {
      push('fresh-process-semantics', rule.note)
      break
    }
  }

  if (/\b(cmd\s+\/[cC]|cmd\.exe)\b/.test(command) && !/["']/.test(command)) {
    push(
      'cmd-quoting',
      'A `cmd /c` invocation is present without any quoting. `cmd.exe` re-parses the line, so its rules differ from PowerShell\'s; quote the inner command or use the native PowerShell form.',
    )
  }

  // A destructive command whose stated plan carries no undo path is the other
  // half of the Windows-first safety check: on Windows the destructive form is
  // usually `Remove-Item -Recurse -Force` or `rd /s`, which the POSIX-oriented
  // shell rules can miss. The finding is advisory; the blocking decision stays
  // with the risk classifier.
  const plan = typeof args?.justification === 'string' ? args.justification : typeof args?.description === 'string' ? args.description : ''
  if (isIrreversibleWithoutStatedUndo(command, plan)) {
    push(
      'destructive-without-undo',
      'This command destroys state and the stated plan names no way to undo it. State a backup, a stash or commit, a transaction, a dry run, or that it cannot be undone and why that is acceptable.',
    )
  }

  if (/&&|\|\|/.test(command) && !/pwsh|powershell/i.test(command)) {
    push(
      'posix-chaining',
      'This command uses `&&` or `||`. Windows PowerShell 5.1 does not support them (PowerShell 7 does); use `;` and an explicit `if ($?)` check when the target shell is unknown.',
    )
  }

  return findings
}

/**
 * Decide whether a file edit is at risk from a line-ending mismatch.
 *
 * @param input - the edit to evaluate.
 * @param input.toolName - the invoked tool; only `edit` is examined.
 * @param input.args - the parsed arguments (`old_string`, `new_string`).
 * @param input.fileText - the current file text, when it is already available.
 * @param input.platform - `process.platform` value to model.
 * @param input.config - the `windows` configuration section.
 * @returns the findings; empty when the current text is unknown.
 */
export function evaluateLineEndings({ toolName, args, fileText, platform = process.platform, config }) {
  if (platform !== 'win32') return []
  if (config?.enabled === false) return []
  if (config?.warnOnCrlfSensitivePatch === false) return []
  if (toolName !== 'edit') return []
  if (typeof fileText !== 'string' || fileText === '') return []
  const oldString = typeof args?.old_string === 'string' ? args.old_string : ''
  if (oldString === '') return []

  const crlf = (fileText.match(/\r\n/g) ?? []).length
  const loneLf = (fileText.match(/(?<!\r)\n/g) ?? []).length
  const dominantCrlf = crlf > 0 && crlf >= loneLf
  const oldHasLf = oldString.includes('\n')
  const oldHasCrlf = oldString.includes('\r\n')

  const findings = []
  if (dominantCrlf && oldHasLf && !oldHasCrlf) {
    findings.push({
      code: 'crlf-mismatch',
      severity: 'advisory',
      message: 'This file uses CRLF line endings, but `old_string` contains bare `\\n`. A literal match will fail or match the wrong span. Read the file and copy its exact line endings, or match on a CRLF-free anchor.',
    })
  }
  if (!dominantCrlf && oldHasCrlf) {
    findings.push({
      code: 'lf-mismatch',
      severity: 'advisory',
      message: 'This file uses LF line endings, but `old_string` contains CRLF. The literal match will fail. Normalize the anchor to LF.',
    })
  }
  return findings
}

/**
 * Detect a destructive command whose only reversal plan is "the test will tell
 * me afterwards".
 *
 * This is the Windows-first half of the risk gate: on Windows a destructive
 * command is usually written as `Remove-Item -Recurse -Force` or an `rd /s`,
 * whose phrases the POSIX-oriented shell rules can miss. The verdict is advisory
 * by design — the blocking decision belongs to the risk classifier, which uses
 * this as one more signal.
 *
 * @param command - the shell command text.
 * @param plan - the stated plan or justification.
 * @returns whether the command is destructive without a stated undo path.
 */
export function isIrreversibleWithoutStatedUndo(command, plan) {
  const destructive =
    /(\brm\s+(-[a-z]*\s+)*-?[a-z]*[rf]|Remove-Item|rd\s+\/s|rmdir\s+\/s|\bdel\s+\/[a-z]*[sf]|git\s+reset\s+--hard|git\s+clean|DROP\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM|format-volume|Clear-Disk)/i
  if (!destructive.test(String(command ?? ''))) return false
  return !/(backup|copy-?item|\bcp\b|stash|dry-?run|--whatif|-whatif|revert|restore|\.bak\b|checkpoint|snapshot|transaction|recycle)/i.test(
    String(plan ?? ''),
  )
}
