/**
 * Zero-dependency value helpers shared by the guard modules.
 *
 * Everything here is deterministic and side-effect free. The canonicalization
 * functions are the guard's notion of "the same call": they are intentionally
 * conservative, because a false loop verdict blocks real work.
 *
 * @module sbjw/util
 */

/**
 * Deep-sort an already-parsed JSON value so two argument objects that differ
 * only in property order canonicalize identically.
 *
 * Arguments reach the tool pipeline as `JSON.parse` output (or its raw-string
 * fallback), so JSON's value domain is the whole input domain.
 *
 * @param value - any JSON value.
 * @returns the same value with object keys sorted.
 */
export function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const sorted = {}
    for (const key of Object.keys(value).sort()) sorted[key] = sortJsonValue(value[key])
    return sorted
  }
  return value
}

/**
 * Canonical string form of a tool call's arguments.
 *
 * @param args - the parsed tool arguments.
 * @returns a stable string; never throws for values that came from JSON.
 */
export function canonicalize(args) {
  try {
    return JSON.stringify(sortJsonValue(args)) ?? 'undefined'
  } catch {
    return String(args)
  }
}

/**
 * Normalize a shell command for semantic comparison: strip comments inside
 * double-quoted regions conservatively, collapse all whitespace runs, drop
 * redundant quotes around simple tokens, and trim trailing separators.
 *
 * The result is only used for equality between two commands from the same
 * session, so a normalization that is too eager can only over-group commands
 * that were already textually close.
 *
 * @param command - raw command text.
 * @returns the normalized command.
 */
export function normalizeCommand(command) {
  let text = String(command ?? '')
  text = text.replace(/\r\n?/g, '\n')
  // Drop whole-line comments; a `#` inside a quoted string is preserved by the
  // quote-aware strip below.
  text = text
    .split('\n')
    .map((line) => stripLineComment(line))
    .join('\n')
  // Collapse whitespace runs, including newlines used as statement separators.
  text = text.replace(/\s+/g, ' ').trim()
  // Remove quotes that wrap an entire simple token (`'foo'` -> `foo`).
  text = text.replace(/(^|[\s(=,;|&])'([A-Za-z0-9_./\\:@+-]+)'/g, '$1$2')
  text = text.replace(/(^|[\s(=,;|&])"([A-Za-z0-9_./\\:@+-]+)"/g, '$1$2')
  // A trailing separator changes nothing.
  text = text.replace(/[;&|]+\s*$/, '').trim()
  return text
}

/** Remove one `#` or PowerShell `#` comment that starts outside quotes. */
function stripLineComment(line) {
  let inSingle = false
  let inDouble = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === "'" && !inDouble) inSingle = !inSingle
    else if (char === '"' && !inSingle) inDouble = !inDouble
    else if (char === '#' && !inSingle && !inDouble) return line.slice(0, index)
  }
  return line
}

/**
 * Normalize a filesystem path for scope comparison: unify separators, drop a
 * Windows extended-length prefix, remove trailing separators, and lowercase
 * on case-insensitive platforms.
 *
 * @param target - a path or path-like string.
 * @param platform - `process.platform` value to model.
 * @returns the comparable form.
 */
export function normalizePath(target, platform = process.platform) {
  let text = String(target ?? '').replace(/\\/g, '/')
  text = text.replace(/^\/\/\?\/UNC\//i, '//')
  text = text.replace(/^\/\/\?\//, '')
  text = text.replace(/\/+$/, '')
  if (text === '') text = '/'
  const caseInsensitive = platform === 'win32' || platform === 'darwin'
  return caseInsensitive ? text.toLowerCase() : text
}

/**
 * Whether `child` is inside `root` (or equal to it). Both are normalized
 * first, so separator and case differences on Windows cannot hide an escape.
 *
 * @param child - candidate path.
 * @param root - the workspace root.
 * @param platform - `process.platform` value to model.
 * @returns whether the child is inside the root.
 */
export function isInside(child, root, platform = process.platform) {
  const normalizedChild = normalizePath(child, platform)
  const normalizedRoot = normalizePath(root, platform)
  if (normalizedRoot === '/' || normalizedRoot === '') return true
  if (normalizedChild === normalizedRoot) return true
  return normalizedChild.startsWith(`${normalizedRoot}/`)
}

/**
 * Stable, non-reversible fingerprint of a secret-bearing string.
 *
 * This is not a security primitive; it exists so diagnostics can group
 * identical secrets without printing them.
 *
 * @param text - the sensitive text.
 * @returns a short hex tag.
 */
export function weakFingerprint(text) {
  let hash = 0x811c9dc5
  const value = String(text ?? '')
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Patterns whose matched value must never be echoed into a diagnostic.
 *
 * The URL pattern is first because `scheme://user:password@host` defeats every
 * token-shaped rule: the secret is a URL component, not a token with a
 * recognizable prefix, and a connection string is one of the most likely
 * credentials to appear inside a command or an error message.
 */
const SECRET_PATTERNS = [
  // scheme://user:password@host  — the password is the whole credential and may
  // itself contain `@`, `:` or `/`. The password group is greedy so it can end
  // at the LAST plausible `@host`, which is what keeps `user:P@ssw0rd!@host`
  // from being truncated to `P`.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]{1,128}:)([^\s]{1,256})(@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)/gi, (_m, prefix, secret, suffix) => `${prefix}<redacted:${weakFingerprint(secret)}>${suffix}`],
  // A common connection form that omits the user: redis://:password@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/:)([^\s]*?)(@[A-Za-z0-9.[\]:_-]+)/gi, (_m, prefix, secret, suffix) => `${prefix}<redacted:${weakFingerprint(secret)}>${suffix}`],
  // scheme://token@host — a long token used as the user part. The token class
  // excludes `/` and `:#?`, so a public URL like `https://example.com/a@b/c` is
  // left alone while a real opaque token is redacted.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)([A-Za-z0-9._~+-]{8,})(@[A-Za-z0-9.[\]:_-]+)/g, (_m, prefix, secret, suffix) => `${prefix}<redacted:${weakFingerprint(secret)}>${suffix}`],
  // `curl -u user:password` and `-u :password` keep the credential out of the URL.
  [/(\s-(?:u|user)\s+)(?:[^\s:]{1,128}:)?([^\s]{3,128})/g, (_m, prefix, secret) => `${prefix}<redacted:${weakFingerprint(secret)}>`],
  // `//host/path/:_authToken=...` — the npm registry credential form.
  [/(:_authToken\s*=\s*)([^\s&"']+)/g, (_m, prefix, secret) => `${prefix}<redacted:${weakFingerprint(secret)}>`],
  /\b(sk-[A-Za-z0-9_-]{8,})/g,
  /\b(gh[pousr]_[A-Za-z0-9]{8,})/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{8,})/g,
  /\b(AKIA[0-9A-Z]{12,})/g,
  /\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,})/g,
  /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|authorization)\b\s*[:=]\s*("[^"]*"|'[^']*'|(?:Bearer|Basic|Token|Digest)\s+[^\s,;]+|[^\s,;]+)/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

/**
 * Replace credential-shaped substrings with a stable placeholder.
 *
 * Redaction is mandatory for every diagnostic path; it is applied even when
 * `includeSensitiveContent` is on, because that option controls verbosity, not
 * credential exposure.
 *
 * @param text - any candidate text.
 * @returns text with secrets replaced by `<redacted:tag>`.
 */
export function redactSecrets(text) {
  let result = String(text ?? '')
  for (const entry of SECRET_PATTERNS) {
    if (Array.isArray(entry)) {
      const [pattern, replace] = entry
      result = result.replace(pattern, replace)
      continue
    }
    result = result.replace(entry, (match, ...groups) => {
      const label = typeof groups[0] === 'string' && groups[0].length > 0 && match !== groups[0] ? groups[0] : ''
      const tag = weakFingerprint(match)
      return label === '' ? `<redacted:${tag}>` : `${label}=<redacted:${tag}>`
    })
  }
  return result
}

/**
 * Head- and tail-truncate a string, marking how much was omitted. Used for
 * every diagnostic and context payload so a tool result cannot blow up the
 * guard's own token cost.
 *
 * @param text - the text to bound.
 * @param cap - maximum characters to keep.
 * @returns the bounded text.
 */
export function preview(text, cap = 400) {
  const value = String(text ?? '')
  if (value.length <= cap) return value
  const head = Math.max(1, Math.floor(cap * 0.6))
  const tail = Math.max(1, cap - head)
  return `${value.slice(0, head)}… (+${value.length - cap} chars) …${value.slice(value.length - tail)}`
}

/**
 * Recursively freeze a JSON structure.
 *
 * @param value - the value to freeze.
 * @returns the same value.
 */
export function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}

/**
 * Extract a readable message from any thrown value without losing the cause
 * chain. Never returns an empty string.
 *
 * @param error - the thrown value.
 * @returns a one-line description.
 */
export function errorMessage(error) {
  if (error instanceof Error) {
    const cause = error.cause === undefined ? '' : ` <- ${errorMessage(error.cause)}`
    return `${error.name}: ${error.message}${cause}`
  }
  if (typeof error === 'string' && error.length > 0) return error
  try {
    const serialized = JSON.stringify(error)
    if (typeof serialized === 'string' && serialized.length > 0) return serialized
  } catch {
    /* fall through to String() */
  }
  return String(error)
}

/**
 * Collect every string leaf of a JSON value, depth-first, bounded by count.
 *
 * @param value - any JSON value.
 * @param limit - maximum strings to collect.
 * @returns the collected strings.
 */
export function collectStrings(value, limit = 200) {
  const found = []
  const walk = (node) => {
    if (found.length >= limit) return
    if (typeof node === 'string') {
      found.push(node)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node !== null && typeof node === 'object') {
      for (const key of Object.keys(node)) walk(node[key])
    }
  }
  walk(value)
  return found
}
