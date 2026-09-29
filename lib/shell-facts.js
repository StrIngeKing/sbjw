/** Bounded shell syntax inspection. Unknown syntax never proves read-only. */
import { posix, win32 } from 'node:path'

// DSH Desktop wraps every PowerShell command with these two encoding setup
// statements before handing it to Windows PowerShell 5.1. They are host
// transport scaffolding, not user code: treating them as opaque commands makes
// scopeUncertain leak into the real command and causes every shell read query to
// be discarded. Keep the allowlist deliberately exact so arbitrary expressions
// do not become trusted merely because they look assignment-like.
const POWERSHELL_HOST_PREAMBLE = [
  /^\s*\[Console\]::OutputEncoding\s*=\s*\[System\.Text\.UTF8Encoding\]::new\(\s*\$false\s*\)\s*$/i,
  /^\s*\$OutputEncoding\s*=\s*\[System\.Text\.UTF8Encoding\]::new\(\s*\$false\s*\)\s*$/i,
]

function isPowerShellHostPreamble(raw) {
  const text = String(raw ?? '')
  return POWERSHELL_HOST_PREAMBLE.some(pattern => pattern.test(text))
}

function looksLikePowerShell(command) {
  const text = String(command ?? '')
  return POWERSHELL_HOST_PREAMBLE.some(pattern => pattern.test(text.split(/[;\r\n]/, 1)[0] ?? ''))
    || /(?:^|[;\r\n])\s*\$[a-z_]\w*\s*=/i.test(text)
    || /(?:^|[;\r\n])\s*(?:Get|Set|Add|Remove|New|Test|Out|Select|Format|ConvertTo)-[A-Za-z][\w-]*/i.test(text)
}

export function pathKey(value, cwd = '') {
  const canonical = value => String(value ?? '').replaceAll('\\', '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '')
  const text = canonical(value?.displayPath ?? value)
  const root = canonical(cwd)
  if (!text) return ''
  if (/^[a-z]:\//i.test(text) || /^[a-z]:\//i.test(root) || text.startsWith('//')) {
    return win32.resolve(root || '.', text).replaceAll('\\', '/').toLowerCase()
  }
  return posix.resolve(root || '/', text)
}

/** Tokens retain quotes so command arguments are not mistaken for operators. */
export function shellStages(command) {
  const stages = []
  let tokens = [], token = '', raw = '', quote = '', quoted = false, complex = false
  let depth = 0, nested = false, stageStart = 0
  const flush = () => { if (token || quoted) tokens.push({ value: token, quoted, raw }); token = ''; raw = ''; quoted = false }
  const stage = (separator, end) => { flush(); if (tokens.length) stages.push({ tokens, separator, complex, nested, raw: text.slice(stageStart, end) }); tokens = []; complex = false; nested = depth > 0 }
  const text = String(command ?? '')
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      raw += ch
      if (ch === quote) {
        if (quote === "'" && text[i + 1] === "'") { token += "'"; raw += text[++i] }
        else quote = ''
      } else {
        if (quote === '"' && /[$`]/.test(ch)) complex = true
        token += ch
      }
    } else if (ch === "'" || ch === '"') { quote = ch; raw += ch; quoted = true }
    else if (ch === '#' && !token) { const end = i; while (i < text.length && text[i] !== '\n') i++; stage(';', end); stageStart = i + 1 }
    else if (';\n|&'.includes(ch)) {
      let sep = ch
      if (text[i + 1] === ch) { sep += ch; i++ }
      stage(sep, i - sep.length + 1)
      stageStart = i + 1
    } else if (ch === ',') {
      flush()
      tokens.push({ value: ',', arraySeparator: true, raw: ',' })
    } else if (ch === '>') {
      // A numeric stream prefix belongs to the operator, not to the path.
      if (/^[0-9*]$/.test(token)) token = ''
      flush()
      let op = '>'
      if (text[i + 1] === '>') { op += '>'; i++ }
      tokens.push({ value: op, operator: true })
    } else if (/\s/.test(ch)) flush()
    else {
      if (/[$`(){}<]/.test(ch)) complex = true
      if (/[({]/.test(ch)) { depth++; nested = true }
      if (/[)}]/.test(ch)) { depth = Math.max(0, depth - 1); nested = true }
      token += ch; raw += ch
    }
  }
  if (quote) complex = true
  stage('', text.length)
  return stages
}

/** Resolve only straight-line, command-local PowerShell string assignments.
 * Never execute user code, retain bindings across calls, or guess branch values.
 */
export function resolvedShellStages(command, options = {}) {
  const powershell = options.powershell ?? looksLikePowerShell(command)
  const stages = shellStages(command)
  if (!powershell) return stages
  const bindings = new Map()
  let chained = false
  let scopeUncertain = false
  return stages.map(stage => {
    if ([';', '\n'].includes(stage.separator) && isPowerShellHostPreamble(stage.raw)) {
      // Host-owned setup must be invisible to read/mutation extraction. Mark it
      // assignment-like so every downstream consumer skips it consistently,
      // and crucially do NOT taint the following user stage's scope.
      return { ...stage, assignment: true, hostPreamble: true, complex: false, scopeUncertain }
    }
    const assignment = /^\s*\$([a-z_]\w*)\s*=\s*('(?:[^']|'')*'|"[^"$`]*")\s*$/i.exec(stage.raw)
    const safe = !stage.nested && !chained && !['|', '&', '&&', '||'].includes(stage.separator)
    const safeReference = !stage.nested && !chained && !['&', '&&', '||'].includes(stage.separator)
    chained = ['|', '&', '&&', '||'].includes(stage.separator)
    if (assignment && safe) {
      const quoted = assignment[2]
      bindings.set(assignment[1].toLowerCase(), quoted[0] === "'" ? quoted.slice(1, -1).replaceAll("''", "'") : quoted.slice(1, -1))
      return { ...stage, assignment: true }
    }
    const tokens = stage.tokens.map(token => {
      const ref = /^(?:\$([a-z_]\w*)|"\$([a-z_]\w*)")$/i.exec(token.raw ?? '')
      const value = ref && safeReference ? bindings.get((ref[1] ?? ref[2]).toLowerCase()) : undefined
      return value === undefined ? token : { ...token, value, raw: JSON.stringify(value), quoted: true, resolved: true }
    })
    const complex = stage.nested || tokens.some(t => !t.resolved && (/[$`(){}<]/.test(t.raw ?? t.value)))
    // Unknown commands/expressions may assign variables, change cwd, or invoke code.
    const known = /^(Get-Content|Get-Item|Get-FileHash|Test-Path|Get-ChildItem|Remove-Item|Set-Content|Add-Content|Out-File|Write-Output|Write-Host|echo|cat|head|tail|stat|sha256sum|sha512sum|Select-Object|Format-List|Format-Table|Out-String|ConvertTo-Json)$/i.test(tokens[0]?.value ?? '')
    // Unknown/abbreviated parameters can include PowerShell common parameters
    // such as -OutVariable and -InformationVariable. Never retain bindings
    // through a flag whose variable side effects we do not understand.
    const indirectAssignment = tokens.some(t => !t.quoted && t.value.startsWith('-')
      && !PATH_FLAGS.test(t.value) && !VALUE_FLAGS.test(t.value) && !SWITCH_FLAGS.test(t.value))
    const result = { ...stage, tokens, complex, scopeUncertain }
    if (!safe || complex || !known || indirectAssignment) bindings.clear()
    // A preceding opaque command may change the PowerShell location/provider.
    // A later lexical path is not necessarily relative to the session cwd.
    if (!known) scopeUncertain = true
    return result
  })
}

const READ = /^(Get-Content|Get-Item|Get-FileHash|Test-Path|Get-ChildItem|cat|head|tail|stat|sha256sum|sha512sum)$/i
const FORMAT = /^(Select-Object|Format-List|Format-Table|Out-String|ConvertTo-Json)$/i
const PATH_FLAGS = /^(?:-LiteralPath|-Path|-FilePath)$/i
const VALUE_FLAGS = /^(?:-Algorithm|-Encoding|-TotalCount|-Tail|-ErrorAction|-PathType|-Filter|-Include|-Exclude|-Value|-Destination|-NewName|-n|-c|-s)$/i
const SWITCH_FLAGS = /^(?:-Raw|-Force|-Recurse|-r|-f|-rf|-fr|-WhatIf|--dry-run|-Confirm:\$false|--|-ErrorAction:Stop)$/i

function operands(tokens, { write = false } = {}) {
  const paths = []
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.arraySeparator) continue
    if (t.operator) { i++; continue }
    if (!t.quoted && PATH_FLAGS.test(t.value)) {
      // Path-bearing parameters consume exactly their following literal value.
      // Treating the flag and value as unrelated positional tokens is fragile:
      // later flags/wrappers can make an otherwise exact query lose its target.
      const value = tokens[++i]
      if (!value || value.arraySeparator || value.operator || (!value.quoted && value.value.startsWith('-'))) return []
      if (!value.value || /[$`*?\[\]{}()]/.test(value.value)) return []
      paths.push(value.value)
      if (write) break
      continue
    }
    if (!t.quoted && VALUE_FLAGS.test(t.value)) {
      if (tokens[i + 1] === undefined) return []
      i++
      continue
    }
    if (!t.quoted && SWITCH_FLAGS.test(t.value)) continue
    if (!t.quoted && t.value.startsWith('-')) return []
    if (!t.value || /[$`*?\[\]{}()]/.test(t.value)) return []
    // Unquoted comma lists are literal path arrays in PowerShell.
    paths.push(t.value)
    if (write) break
  }
  return paths
}

/** Exact query targets, with no filters that can confuse absence with type mismatch. */
export function shellReadQueries(command, options) {
  const effectiveOptions = options ?? { powershell: looksLikePowerShell(command) }
  // A bounded display wrapper, not arbitrary PowerShell evaluation. Bind each
  // Boolean line to its literal prefix and still confirm absence via fs.stat.
  const rawStages = shellStages(command)
  if (effectiveOptions.powershell && rawStages.length) {
    const meaningfulStages = rawStages.filter(stage => !([';', '\n'].includes(stage.separator) && isPowerShellHostPreamble(stage.raw)))
    const wrapped = meaningfulStages.map(stage => {
      const match = /^\s*('[^']*'|"[^"$`]*")\s*\+\s*\(\s*(Test-Path\s+[^()]+)\s*\)\s*$/i.exec(stage.raw)
      if (!match || !['', ';', '\n'].includes(stage.separator)) return undefined
      const queries = shellReadQueries(match[2], effectiveOptions)
      return queries.length === 1 && queries[0].kind === 'existence'
        ? { ...queries[0], outputPrefix: match[1].slice(1, -1) } : undefined
    })
    if (meaningfulStages.length && wrapped.every(Boolean)) return wrapped
  }
  const stages = resolvedShellStages(command, effectiveOptions).filter(s => !s.assignment)
  if (!stages.length || stages.some(s => s.complex || s.scopeUncertain || s.tokens.some(t => t.operator) || ['&', '&&', '||'].includes(s.separator))) return []
  const queries = []
  let inPipeline = false
  for (const s of stages) {
    const verb = s.tokens[0]?.value ?? ''
    if (inPipeline) {
      if (!FORMAT.test(verb)) return []
    } else {
      if (!READ.test(verb)) return []
      if (s.tokens.some(t => /^-(PathType|Filter|Include|Exclude|Name|Hidden|File|Directory)$/i.test(t.value))) return []
      const errorIndex = s.tokens.findIndex(t => /^-ErrorAction$/i.test(t.value))
      if (errorIndex >= 0 && !/^(Stop|Continue)$/i.test(s.tokens[errorIndex + 1]?.value ?? '')) return []
      const paths = operands(s.tokens)
      if (!paths.length && /^Get-ChildItem$/i.test(verb) && s.tokens.slice(1).every(t => SWITCH_FLAGS.test(t.value))) paths.push('.')
      if (!paths.length) return []
      const kind = /^Test-Path$/i.test(verb) ? 'existence' : /^Get-ChildItem$/i.test(verb) ? 'listing' : 'read-back'
      if (kind === 'existence' && s.separator === '|') return []
      for (const path of paths) queries.push({ path, kind, verb })
    }
    inPipeline = s.separator === '|'
  }
  return queries
}

/** Write targets only; read sources are never mutation candidates. */
export function shellMutationFacts(command, options) {
  const found = new Set()
  const unresolved = []
  for (const stage of resolvedShellStages(command, options)) {
    if (stage.assignment) continue
    const { tokens } = stage
    let recognized = false
    let incomplete = false
    const candidates = new Set()
    for (let i = 0; i < tokens.length - 1; i++) {
      if (!tokens[i].operator) continue
      const target = tokens[++i].value
      if (/^\$null$|^\/dev\/null$/i.test(target)) continue
      recognized = true
      if (target && !/[$`*?{}()]/.test(target)) candidates.add(target)
      else incomplete = true
    }
    const verb = tokens[0]?.value ?? ''
    if (/^(Remove-Item|ri|rm|del|erase|unlink|rmdir|rd)$/i.test(verb)) {
      recognized = true
      const paths = operands(tokens)
      if (!paths.length) incomplete = true
      for (const path of paths) candidates.add(path)
    } else if (/^(Set-Content|Add-Content|Out-File|New-Item|tee|Tee-Object)$/i.test(verb)) {
      recognized = true
      const paths = operands(tokens, { write: true })
      if (!paths.length) incomplete = true
      for (const path of paths) candidates.add(path)
    } else if (/^(Copy-Item|Move-Item|Rename-Item|cp|mv|copy|move)$/i.test(verb)) {
      recognized = true
      // Both explicit destinations and positional source/destination are candidates.
      for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i]
        if (!t.quoted && t.value.startsWith('-')) continue
        if (!/[$`*?{}()]/.test(t.value)) candidates.add(t.value)
      }
    }
    const nestedMutation = tokens.some(t => !t.quoted && /(?:^|[({])(Remove-Item|Set-Content|Add-Content|Out-File|rm|del)$/i.test(t.value))
    if ((recognized && (incomplete || !candidates.size || stage.complex || stage.scopeUncertain)) || (nestedMutation && stage.nested)) {
      unresolved.push('shell mutation target or execution scope could not be resolved')
    }
    // Resolved targets still help observe part of a command with unknown effects.
    for (const path of candidates) found.add(path)
  }
  return { targets: [...found], unresolved: [...new Set(unresolved)] }
}

export function shellMutationTargets(command, options) {
  return shellMutationFacts(command, options).targets
}
