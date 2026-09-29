/**
 * Deterministic mutation risk classification.
 *
 * The classifier answers four questions about a state-changing tool call
 * without asking a model:
 *
 * 1. `action` — what kind of change is this (delete, overwrite, vcs-rewrite,
 *    migration, dependency, system-config, credential, publish, bulk-write)?
 * 2. `scope` — how wide is the blast radius (workspace / path / outside /
 *    repository / system / remote / unknown)?
 * 3. `risk` — LOW / MEDIUM / HIGH / CRITICAL.
 * 4. `reversible` — can it be undone from the information the call already
 *    carries (the previous content, a backup step, or version control)?
 *
 * Reliability Guard never implements its own permission system: the result is
 * used to fail closed on irreversible high-risk calls and to route the rest
 * through the official sandbox and approval seams.
 *
 * @module dsh-reliability-guard/risk
 */

import { collectStrings, isInside, normalizePath } from './util.js'
import { tmpdir } from 'node:os'
import { resolvedShellStages, shellMutationTargets } from './shell-facts.js'

/** Ordered risk levels, worst last. */
export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']

/** Numeric rank of a risk level, for threshold comparisons. */
export function riskRank(level) {
  const index = RISK_LEVELS.indexOf(level)
  return index < 0 ? 0 : index
}

/**
 * Shell command rules, evaluated in order. The first match wins, so the list
 * is ordered from most severe to least severe.
 */
const SHELL_RULES = [
  {
    id: 'destructive-sql',
    action: 'database',
    risk: 'CRITICAL',
    scope: 'unknown',
    reason: 'destructive SQL (DROP / TRUNCATE / DELETE without WHERE)',
    pattern: /(^|[\s'"(;])(drop\s+(table|database|schema|index)|truncate\s+table|delete\s+from\s+[^\s;]+(?![^;]*\bwhere\b))/i,
  },
  {
    id: 'migration',
    action: 'migration',
    risk: 'CRITICAL',
    scope: 'unknown',
    reason: 'database migration or schema change',
    pattern: /\b(alembic\s+(upgrade|downgrade)|prisma\s+migrate|flyway\s+migrate|knex\s+migrate|sequelize\s+db:migrate|rake\s+db:(migrate|rollback)|manage\.py\s+migrate|django-admin\s+migrate|typeorm\s+migration:(run|revert)|goose\s+(up|down)|liquibase\s+update)\b/i,
  },
  {
    id: 'git-history-rewrite',
    action: 'vcs-rewrite',
    risk: 'CRITICAL',
    scope: 'repository',
    reason: 'git history rewrite (filter-branch / filter-repo / reflog expire / gc --prune)',
    pattern: /\bgit\b[^;|&\n]*\b(filter-branch|filter-repo|reflog\s+expire|gc\b[^;|&\n]*--prune)/i,
  },
  {
    id: 'git-discard',
    action: 'vcs-discard',
    risk: 'HIGH',
    scope: 'repository',
    reason: 'git discards uncommitted work (reset --hard / clean -fdx / checkout -- .)',
    pattern: /\bgit\b[^;|&\n]*\b(reset\s+--hard|clean\s+-[a-z]*[fdx]|checkout\s+--\s+\.|restore\s+--source)/i,
  },
  {
    id: 'credential-write',
    action: 'credential',
    risk: 'CRITICAL',
    scope: 'outside',
    reason: 'credential or secret material is created, rotated, or moved',
    // A credential store on the left of a redirection, or named as the target of
    // a write flag. The verb context matters: `Get-Content -Path .env.example`
    // is a read, and `cat .env.example` is a read.
    pattern:
      /(?:>>?|\|\s*Out-File\s+)(?![^;|&\n]{0,40}(?:Get-Content|cat|type|rg|grep|findstr|Select-String|more|less)\b)\s*['"]?\.?(?:env(?:\.[a-z0-9]+)?|credentials\.ya?ml|npmrc|pypirc|netrc|aws\/credentials)\b/i,
  },
  {
    id: 'credential-write',
    action: 'credential',
    risk: 'CRITICAL',
    scope: 'outside',
    reason: 'credential or secret material is created, rotated, or moved',
    // A WRITE verb targeting a credential store. Read verbs are excluded by
    // construction rather than by a lookahead.
    pattern:
      /(?:^|[\s;|&(])(?:Set-Content|Add-Content|Out-File|New-Item|New-Object\s+-TypeName\s+System\.IO\.StreamWriter)\b[^;|&\n]{0,60}(?:-Path\s+|-FilePath\s+|-LiteralPath\s+)?['"]?\.?(?:env(?:\.[a-z0-9]+)?|credentials\.ya?ml|npmrc|pypirc|netrc)\b/i,
  },
  {
    id: 'credential-store-write',
    action: 'credential',
    risk: 'CRITICAL',
    scope: 'outside',
    reason: 'key material is written',
    // 2a. A key GENERATION command writes new key material. A generation is
    //     identified positively — a type (`-t`) or an output file (`-f`) — so
    //     the read-only forms (`-l` list, `-y` print public key, `-F` find,
    //     `-p` change passphrase) can never be caught by accident. A bare
    //     `ssh-keygen` with no flags still generates interactively.
    pattern: /\bssh-keygen\b(?:\s+(?:-[tfbCE])|$|(?=\s*[;|&\n]))/i,
  },
  {
    id: 'credential-store-write',
    action: 'credential',
    risk: 'CRITICAL',
    scope: 'outside',
    reason: 'key material is written',
    // 2b. `openssl` writes with genrsa/genpkey/pkcs12; `-noout` only reads.
    pattern: /\bopenssl\s+(?:genrsa|genpkey|pkcs12|req\b(?![^;|&\n]{0,60}-noout))/i,
  },
  {
    id: 'credential-store-write',
    action: 'credential',
    risk: 'CRITICAL',
    scope: 'outside',
    reason: 'key material is written',
    pattern: /\b(?:gpg\s+--gen-key|New-SelfSignedCertificate)\b/i,
  },
  {
    id: 'credential-target-write',
    action: 'credential',
    risk: 'CRITICAL',
    scope: 'outside',
    reason: 'key material or a credential store is written',
    // 2c. A write verb whose target is key material, a key file, or a secret.
    pattern:
      /\b(Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item)\b[^;|&\n]{0,80}(id_rsa|id_ed25519|\.pem\b|\.p12\b|\.pfx\b|\.credentials\.ya?ml|\.env(?:\.[a-z0-9]+)?\b|secret|credential|api[_-]?key|private[_-]?key)/i,
  },
  {
    id: 'credential-rotation',
    action: 'credential',
    risk: 'CRITICAL',
    scope: 'outside',
    reason: 'a credential is rotated, revoked or stored',
    // 3. The rotation verb must START a command, not appear as an argument to a
    //    read: `rg "how to rotate the password"` and
    //    `git log --grep "rotate the password"` are searches.
    pattern:
      /(?:^|[;|&]\s*|\b(?:then|do)\s+)(?:\.\/|\/usr\/bin\/)?(?:rotate|revoke|regenerate|reissue)\b[^;|&\n]{0,40}\b(credential|secret|api[_-]?key|access[_-]?token|password|certificate|ssh\s+key)\b/i,
  },
  {
    id: 'publish',
    action: 'publish',
    risk: 'HIGH',
    scope: 'remote',
    reason: 'publishes or deploys an artifact to a remote target',
    pattern: /\b(npm\s+publish|pnpm\s+publish|yarn\s+npm\s+publish|twine\s+upload|poetry\s+publish|cargo\s+publish|dotnet\s+nuget\s+push|docker\s+push|gh\s+release\s+create|kubectl\s+apply|kubectl\s+delete|terraform\s+(apply|destroy)|helm\s+(install|upgrade|uninstall)|aws\s+(s3\s+rm|cloudformation\s+delete)|gcloud\s+(deploy|delete)|vercel\s+(deploy|--prod)|netlify\s+deploy|flyctl\s+deploy|serverless\s+deploy)\b/i,
  },
  {
    id: 'dependency-upgrade',
    action: 'dependency',
    risk: 'HIGH',
    scope: 'repository',
    reason: 'installs, upgrades, or removes dependencies',
    pattern: /\b(npm\s+(install|i|uninstall|update|upgrade|ci)|pnpm\s+(add|install|remove|update|up)|yarn\s+(add|install|remove|up)|bun\s+(add|install|remove)|pip\s+(install|uninstall)\b|pip3\s+(install|uninstall)|python\s+-m\s+pip\s+(install|uninstall)|poetry\s+(add|remove|update)|uv\s+(add|sync|pip\s+install)|conda\s+(install|remove|update)|cargo\s+(install|add|remove|update)|go\s+get|go\s+install|dotnet\s+add\s+package|dotnet\s+remove\s+package|composer\s+(require|remove|update)|gem\s+(install|uninstall|update)|brew\s+(install|uninstall|upgrade)|choco\s+(install|uninstall|upgrade)|winget\s+(install|uninstall|upgrade)|scoop\s+(install|uninstall|update)|apt(-get)?\s+(install|remove|purge|upgrade|dist-upgrade)|dnf\s+(install|remove|upgrade)|yum\s+(install|remove|update)|pacman\s+-S)/i,
  },
  {
    id: 'system-config',
    action: 'system-config',
    risk: 'HIGH',
    scope: 'system',
    reason: 'changes machine or user-global configuration',
    pattern: /\b(git\s+config\s+--global|git\s+config\s+--system|npm\s+config\s+set|npm\s+config\s+delete|pnpm\s+config\s+set|setx\b|reg\s+add|reg\s+delete|netsh\s+(int|advfirewall|winsock)|sc\s+(config|delete|stop)|New-Service|Set-Service|Stop-Service|Remove-Service|Set-ItemProperty[^;|&\n]*HKLM|New-ItemProperty[^;|&\n]*HKLM|Remove-ItemProperty[^;|&\n]*HKLM|Set-ExecutionPolicy|New-LocalUser|Add-LocalGroupMember|Set-LocalUser|Remove-LocalUser|systemctl\s+(enable|disable|mask|unmask)|launchctl\s+(load|unload|bootstrap)|defaults\s+write|update-alternatives|usermod|visudo|chsh\b|Set-NetFirewallProfile|New-NetFirewallRule|Remove-NetFirewallRule)/i,
  },
  {
    id: 'permission-broadening',
    action: 'permission',
    risk: 'HIGH',
    scope: 'path',
    reason: 'broadens filesystem or process permissions',
    pattern: /\b(chmod\s+(-R\s+)?(777|a\+rwx)|chown\s+-R|chgrp\s+-R|takeown\b|icacls\b|Set-Acl\b|sudo\s+chmod|sudo\s+chown)\b/i,
  },
  {
    id: 'drive-format',
    action: 'system-config',
    risk: 'CRITICAL',
    scope: 'system',
    reason: 'disk or volume level destruction',
    pattern: /\b(format-volume|diskpart|clear-disk|initialize-disk|Remove-Partition|mkfs(\.\w+)?\s|dd\s+if=.{0,40}of=\/dev\/)/i,
  },
  {
    id: 'process-kill',
    action: 'process',
    risk: 'MEDIUM',
    scope: 'system',
    reason: 'terminates processes',
    pattern: /\b(taskkill|Stop-Process|kill\s+-9|pkill\s+-9|killall)\b/i,
  },
  {
    id: 'recursive-delete',
    action: 'delete',
    risk: 'HIGH',
    scope: 'path',
    reason: 'recursively deletes a directory tree',
    pattern: /(rm\s+(-[a-z]*\s+)*-?[a-z]*r[a-z]*f|rm\s+(-[a-z]*\s+)*-?[a-z]*f[a-z]*r|Remove-Item[^;|&\n]*-(Recurse|r)\b|rd\s+\/s|rmdir\s+\/s|del\s+\/[a-z]*s)/i,
  },
  {
    id: 'delete',
    action: 'delete',
    risk: 'HIGH',
    scope: 'path',
    reason: 'deletes files',
    pattern: /^\s*(rm|del|erase|Remove-Item|ri|unlink)\s+\S/i,
  },
  {
    id: 'move-or-overwrite',
    action: 'move',
    risk: 'HIGH',
    scope: 'path',
    reason: 'moves or overwrites a path',
    pattern: /(^|[\s;|&])(mv|move|Move-Item|mi|copy|cp|Copy-Item|ci|robocopy|xcopy)\s+\S/i,
  },
  {
    id: 'in-place-edit',
    action: 'bulk-write',
    risk: 'HIGH',
    scope: 'workspace',
    reason: 'rewrites files in place across a selection',
    pattern: /^\s*(Set-Content\b|Add-Content\b|Out-File\b|sed\s+-i|perl\s+-pi|truncate\s+-s|tee\s)/i,
  },
]

/** Read-only shell verbs: their presence alone never raises risk above LOW. */
const READ_ONLY_VERBS = /^(ls|dir|cat|type|Get-Content|gc|Get-ChildItem|gci|head|tail|wc|grep|rg|find|findstr|Select-String|sls|Get-Item|gi|Test-Path|Where-Object|where|Get-Process|gps|ps|Get-Service|netstat|ss|env|printenv|Get-Command|Get-Help|git\s+(status|log|diff|show|branch|remote|describe|rev-parse|ls-files|blame|shortlog)|node\s+--version|npm\s+(ls|list|view|info|outdated|why)|pnpm\s+(ls|list|why|outdated)|pip\s+(show|list|freeze)|git\s+--version|python\s+--version|echo|Write-Output|Write-Host|pwd|whoami|hostname|uname|date|which|Get-FileHash|jq|sort|uniq|cut|awk|comm|diff|Compare-Object)\b/i

/**
 * Tools that only read. A call to one of these never raises risk above LOW,
 * which is what keeps the guard from interfering with normal exploration.
 */
const READ_ONLY_TOOLS = new Set([
  'read',
  'reliability_guard',
  'reliability_guard_reconcile',
  'read_image',
  'glob',
  'grep',
  'search',
  'list',
  'web_search',
  'web_fetch',
  'todo_write',
  'ask_user_question',
  'skill',
  'present',
  'job_output',
  'job_list',
  'reliability_guard',
])

/** Tools that write one file, mapped to how their arguments express the path. */
const FILE_MUTATION_TOOLS = new Map([
  ['write', { action: 'write', pathKeys: ['file_path', 'path'] }],
  ['edit', { action: 'edit', pathKeys: ['file_path', 'path'] }],
  ['str_replace_editor', { action: 'edit', pathKeys: ['path', 'file_path'] }],
  ['create_file', { action: 'write', pathKeys: ['path', 'file_path'] }],
])

/**
 * Whether a path is absolute rather than relative to the session's working
 * directory. A relative path is by definition inside whatever root the call
 * runs in, so it is never an escape.
 *
 * @param path - the candidate path.
 * @returns whether the path is absolute.
 */
function isAbsolutePath(path) {
  const text = String(path ?? '')
  if (text === '') return false
  if (/^[A-Za-z]:[\\/]/.test(text)) return true
  if (text.startsWith('\\\\') || text.startsWith('//')) return true
  if (text.startsWith('/')) return true
  if (text.startsWith('~')) return true
  return false
}

/**
 * Whether a path leaves the reach of the session workspace or the platform's
 * own temporary roots.
 *
 * The official sandbox permits writes to the workspace and to a platform
 * temporary root, so a temporary path is NOT treated as an escape. Everything
 * else outside the workspace is, which is the classification that matters.
 *
 * @param path - the candidate path.
 * @param workspaceRoot - the session workspace root, when known.
 * @returns whether the path is outside both boundaries.
 */
function looksOutsideWorkspace(path, workspaceRoot) {
  if (typeof path !== 'string' || path.trim() === '') return false
  // A relative path belongs to the session's working directory whatever that
  // directory is, so it can never be an escape.
  if (!isAbsolutePath(path)) return false
  const normalized = normalizePath(path)
  if (workspaceRoot !== undefined && workspaceRoot !== '') {
    if (isInside(path, workspaceRoot)) return false
  }
  if (/^\/(tmp|var\/tmp|private\/var\/folders|private\/tmp)(\/|$)/.test(normalized)) return false
  if (isInside(path, tmpdir())) return false
  if (workspaceRoot !== undefined && workspaceRoot !== '') return true
  if (normalized.startsWith('c:/windows') || normalized.startsWith('c:/program files')) return true
  return /^\/(etc|usr|var|opt|bin|sbin|boot|root|sys|proc)(\/|$)/.test(normalized)
}

/**
 * Extract candidate paths mentioned by a shell command.
 *
 * This is intentionally shallow: it finds quoted strings and bare tokens that
 * look like paths. Missing a path only makes the scope estimate more
 * conservative (wider), never narrower.
 *
 * @param command - the shell command text.
 * @returns candidate path strings, deduplicated.
 */
export function extractShellPaths(command) {
  const found = new Set()
  const text = String(command ?? '')
  const quoted = text.matchAll(/"([^"\n]{1,260})"|'([^'\n]{1,260})'/g)
  for (const match of quoted) {
    const value = match[1] ?? match[2] ?? ''
    if (value === '' || value.startsWith('-')) continue
    if (/[\\/]/.test(value) || /\.([A-Za-z0-9]{1,8})$/.test(value)) found.add(value)
  }
  const bare = text.matchAll(/(?:^|[\s=])((?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/])[^\s"'|;&)]{1,240})/g)
  for (const match of bare) found.add(match[1])
  // A file-writing cmdlet or verb followed by a relative path is a real target,
  // which is what makes `Set-Content -Path out.txt` observable. Only the
  // argument that directly follows the verb or its path flag is taken, so a
  // read (`Get-Content -Path out.txt`) does not become a claimed mutation.
  const verbTargets = text.matchAll(
    /(?:^|[\s;|&(])(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item|tee|sed\s+-i|perl\s+-pi)\b(?:\s+-\w+)*\s+(?:-Path\s+|-FilePath\s+|-Destination\s+|-LiteralPath\s+)?("[^"]{1,240}"|'[^']{1,240}'|[^\s"'|;&)>]{1,240})/gi,
  )
  for (const match of verbTargets) {
    const value = String(match[1]).replace(/^["']|["']$/g, '')
    if (value === '' || value.startsWith('-')) continue
    found.add(value)
  }
  for (const path of shellMutationTargets(command)) found.add(path)
  return [...found]
}

/**
 * Decide whether a command carries its own undo path.
 *
 * The dry-run check comes first and returns immediately: a dry run is not a
 * reversal of anything, it means nothing was changed, so it must not be
 * outranked by an unrelated `backup`/`copy` word elsewhere in the line.
 *
 * @param command - the shell command text.
 * @returns the matched rollback signal, or `undefined`.
 */
export function detectRollbackSignal(command) {
  const text = String(command ?? '')
  // `\b` cannot match between a space and a leading `-`, so the flag
  // alternatives are bounded by whitespace/start instead of word boundaries.
  if (/(?:^|\s)(?:-whatif|--dry-run|--just-print)(?=\s|$)/i.test(text)
    || /^\s*git\s+clean\b[^;|&\n]*\s-[a-z]*n[a-z]*(?:\s|$)/i.test(text)) return 'dry-run'
  const signals = [
    ['backup-copy', /\b(Copy-Item|cp\s+-[a-z]*[ab]|robocopy|xcopy|\.bak\b|\.orig\b|\.backup\b|backup)/i],
    ['git-stash', /\bgit\s+stash\b/i],
    ['git-commit', /\bgit\s+(commit|tag)\b/i],
    ['git-revert', /\bgit\s+(revert|restore)\b/i],
    ['recycle-bin', /\b(Recycle|SendToRecycleBin|-ToRecycleBin)\b/i],
    ['transaction', /\b(transaction|rollback|BEGIN\s+TRANSACTION)\b/i],
  ]
  for (const [name, pattern] of signals) {
    if (pattern.test(text)) return name
  }
  return undefined
}

/**
 * Classify one tool call.
 *
 * @param input - classification input.
 * @param input.toolName - the invoked tool name.
 * @param input.args - the parsed arguments.
 * @param input.workspaceRoot - the session workspace root, when known.
 * @param input.platform - `process.platform` value to model.
 * @returns a frozen classification record.
 */
export function classifyRisk({ toolName, args, workspaceRoot, platform = process.platform, workspaceOnlyWhenUnscoped = true }) {
  const base = {
    toolName,
    risk: 'LOW',
    action: 'read',
    scope: 'path',
    reason: 'read-only or planning call',
    reversible: true,
    ruleId: 'read-only',
    paths: [],
    rollbackSignal: undefined,
    uncertain: false,
    /**
     * Whether the guard knows this call changes state.
     *
     * `definite` — a tool family the guard knows only writes; the ledger records
     * a mutation on success.
     * `possible` — the call may mutate (a shell command, an unknown tool); the
     * mutation is recorded only when a file version actually changed afterwards.
     * `never` — a read; the ledger never records a mutation.
     */
    mutation: 'never',
  }

  if (READ_ONLY_TOOLS.has(toolName)) return Object.freeze(base)

  if (toolName === 'bash' || toolName === 'pwsh') {
    return Object.freeze(classifyShell({ ...base, toolName, args, workspaceRoot, platform, workspaceOnlyWhenUnscoped }))
  }

  if (toolName === 'workflow' || toolName === 'run_code') {
    // These execute arbitrary nested calls; the nested calls are classified on
    // their own way through the pipeline, so the outer call is only MEDIUM but
    // never treated as reversible.
    return Object.freeze({
      ...base,
      risk: 'MEDIUM',
      action: 'delegated-execution',
      scope: 'unknown',
      reason: `${toolName} executes nested work that is classified per call`,
      reversible: false,
      ruleId: 'delegated-execution',
      uncertain: true,
      mutation: 'possible',
    })
  }

  if (toolName === 'subagent' || toolName === 'agent_team' || toolName === 'send_message') {
    return Object.freeze({
      ...base,
      risk: 'LOW',
      action: 'delegation',
      reason: 'delegation is classified through the callee\'s own calls',
    })
  }

  const fileMutation = FILE_MUTATION_TOOLS.get(toolName)
  if (fileMutation !== undefined) {
    return Object.freeze(classifyFileMutation({ ...base, toolName, args, workspaceRoot, platform, spec: fileMutation }))
  }

  // An unknown tool that is not known to be read-only: it needs the same
  // caution as a command (it may mutate), but it is NOT recorded as a mutation,
  // because guessing would make the completion gate demand verification for
  // calls that changed nothing.
  return Object.freeze({
    ...base,
    risk: 'MEDIUM',
    action: 'unknown-mutation',
    scope: 'unknown',
    reason: `tool "${toolName}" is not classified as read-only`,
    reversible: false,
    ruleId: 'unclassified-tool',
    uncertain: true,
    mutation: 'possible',
  })
}

function classifyFileMutation({ args, workspaceRoot, platform, spec }) {
  const paths = []
  for (const key of spec.pathKeys) {
    const value = args?.[key]
    if (typeof value === 'string' && value !== '') paths.push(value)
  }
  const outside = paths.some((path) => looksOutsideWorkspace(path, workspaceRoot))
  const bulk = args?.replace_all === true
  const deleting = spec.action === 'edit' && typeof args?.new_string === 'string' && args.new_string === ''
  // A delete-only edit still changes state, so every recognised file writer is
  // recorded as a mutation once it succeeds.
  const risk = outside ? 'CRITICAL' : deleting ? 'HIGH' : spec.action === 'write' ? 'MEDIUM' : 'LOW'
  return {
    toolName: spec.action,
    risk,
    action: deleting ? 'delete' : spec.action,
    scope: outside ? 'outside' : 'file',
    reason: outside
      ? `writes outside the workspace root (${paths.join(', ')})`
      : deleting
        ? 'edit removes matched text'
        : bulk
          ? 'replace-all edit'
          : `${spec.action} of one file`,
    reversible: !deleting && !outside,
    ruleId: outside ? 'write-outside-workspace' : deleting ? 'edit-delete' : `${spec.action}-file`,
    paths,
    rollbackSignal: undefined,
    uncertain: false,
    mutation: 'definite',
  }
}

function classifyShell({ toolName, args, workspaceRoot, platform, workspaceOnlyWhenUnscoped = true }) {
  const stages = resolvedShellStages(args?.command, { powershell: toolName === 'pwsh' }).filter(s => !s.assignment)
  if (!stages.length) return classifyShellStage({ args, workspaceRoot, platform, workspaceOnlyWhenUnscoped })
  const verdicts = stages.map(stage => {
    const command = stage.tokens.map(t => t.quoted ? JSON.stringify(t.value) : t.value).join(' ')
    return classifyShellStage({ args: { ...args, command }, workspaceRoot, platform, workspaceOnlyWhenUnscoped, stage })
  })
  const worst = [...verdicts].sort((a, b) => riskRank(b.risk) - riskRank(a.risk))[0]
  return { ...worst, paths: [...new Set(verdicts.flatMap(v => v.paths ?? []))],
    mutation: verdicts.every(v => v.mutation === 'never') ? 'never' : 'possible' }
}

function classifyShellStage({ args, workspaceRoot, platform, workspaceOnlyWhenUnscoped = true, stage }) {
  const command = typeof args?.command === 'string' ? args.command : ''
  const mutationTargets = shellMutationTargets(command)
  const hasRedirect = stage?.tokens.some(t => t.operator) === true
  const pureRead = READ_ONLY_VERBS.test(command.trim()) && !hasRedirect && !stage?.complex
    && !/\b(?:-exec|-delete|--delete|--output|-o)\b/.test(command)
    && !/^\s*(?:awk|find)\b/i.test(command)
  const paths = pureRead ? [] : (mutationTargets.length ? mutationTargets : extractShellPaths(command))
  const outside = paths.filter((path) => looksOutsideWorkspace(path, workspaceRoot))
  const rollbackSignal = detectRollbackSignal(command)

  const credentialTarget = mutationTargets.some(path => /(?:^|[\\/])\.(?:env(?:\.[^\\/]*)?|npmrc|pypirc|netrc|credentials\.ya?ml)$/i.test(path))
  const hit = credentialTarget ? SHELL_RULES.find(rule => rule.id === 'credential-write')
    : pureRead ? undefined : SHELL_RULES.find((rule) => rule.pattern.test(command))
  if (hit === undefined) {
    const readOnly = pureRead
    return {
      toolName: 'bash',
      risk: readOnly ? 'LOW' : 'MEDIUM',
      action: readOnly ? 'read' : hasRedirect ? 'write' : 'command',
      scope: outside.length > 0 ? 'outside' : readOnly ? 'path' : 'workspace',
      reason: readOnly ? 'read-only shell command' : 'shell command with unclassified effects',
      reversible: readOnly,
      ruleId: readOnly ? 'shell-read-only' : 'shell-unclassified',
      paths,
      rollbackSignal,
      uncertain: !readOnly,
      mutation: readOnly ? 'never' : 'possible',
    }
  }

  // An unscoped recursive delete is usually workspace-scoped intent; a delete
  // naming an absolute path outside the workspace is a system-level action.
  // `workspaceOnlyWhenUnscoped` decides the residual case: a wipe with no path
  // argument at all is treated as workspace intent when the option is on, and
  // as `unknown` scope when an operator turns it off.
  let { scope, risk } = hit
  if (outside.length > 0) {
    // A destructive command naming a path outside the workspace is always the
    // worst case: it can damage the machine, not just the repository.
    scope = 'outside'
    risk = 'CRITICAL'
  } else if (scope === 'unknown' && workspaceOnlyWhenUnscoped) {
    scope = 'workspace'
  }
  if (rollbackSignal === 'dry-run') {
    // A dry run cannot change state.
    return {
      toolName: 'bash',
      risk: 'MEDIUM',
      action: hit.action,
      scope,
      reason: `${hit.reason} (dry run)`,
      reversible: true,
      ruleId: `${hit.id}:dry-run`,
      paths,
      rollbackSignal,
      uncertain: false,
      mutation: 'never',
    }
  }
  const reversible = rollbackSignal !== undefined
  return {
    toolName: 'bash',
    risk,
    action: hit.action,
    scope,
    reason: hit.reason,
    reversible,
    ruleId: hit.id,
    paths,
    rollbackSignal,
    uncertain: false,
    // A destructive command is recorded as a mutation only when the file
    // version actually changed; the recorded mutation is what the completion
    // gate later demands verification for, so it must be observed, not assumed.
    mutation: 'possible',
  }
}

/**
 * Detect a stated plan inside a tool call's free-text arguments.
 *
 * The official `pwsh`/`bash`/`run_code` schemas do carry a `justification`
 * field, and agents commonly state intent in a `description`. The classifier
 * accepts either, plus a few conventional keys, so it does not depend on one
 * tool's schema.
 *
 * @param args - the parsed arguments.
 * @returns the stated plan text, or `''`.
 */
export function statedPlanOf(args) {
  if (args === null || typeof args !== 'object') return ''
  const keys = ['justification', 'description', 'reason', 'plan', 'rollback_plan', 'verification_plan', 'note']
  const parts = []
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') parts.push(value.trim())
  }
  return parts.join(' ').trim()
}

/**
 * Whether a stated plan mentions how the change will be verified.
 *
 * @param plan - the stated plan text.
 * @returns the matched verification signal, or `undefined`.
 */
export function detectVerificationIntent(plan) {
  const text = String(plan ?? '')
  const signals = [
    ['test', /\b(test|tests|pytest|jest|vitest|node --test|go test|cargo test|dotnet test)\b/i],
    ['typecheck', /\b(typecheck|type-check|tsc|mypy|pyright|flow)\b/i],
    ['lint', /\b(lint|eslint|ruff|flake8|golangci)\b/i],
    ['rerun', /\b(re-?run|run again|verify|confirm|check the result|assert)\b/i],
    ['re-read', /\b(re-?read|read back|inspect the file|diff)\b/i],
    ['health', /\b(health|port|endpoint|curl|probe)\b/i],
  ]
  for (const [name, pattern] of signals) {
    if (pattern.test(text)) return name
  }
  return undefined
}

/**
 * Whether a stated plan mentions how the change can be undone.
 *
 * @param plan - the stated plan text.
 * @returns the matched rollback signal, or `undefined`.
 */
export function detectRollbackIntent(plan) {
  const text = String(plan ?? '')
  const signals = [
    ['explicit', /\b(rollback|roll back|revert|undo|restore|git checkout|git reset|re-?install|previous version|backup)\b/i],
    ['additive-only', /\b(additive|append[- ]only|no destructive|does not delete|new file only)\b/i],
    ['snapshot', /\b(snapshot|checkpoint|stash|copy of|tagged)\b/i],
  ]
  for (const [name, pattern] of signals) {
    if (pattern.test(text)) return name
  }
  return undefined
}

/**
 * Collect every credential-shaped token in a call so diagnostics can report
 * their presence without their value.
 *
 * @param args - the parsed arguments.
 * @returns how many credential-shaped strings were found.
 */
export function countCredentialLikeArguments(args) {
  let count = 0
  for (const text of collectStrings(args, 80)) {
    if (/(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.test(text)) count += 1
  }
  return count
}
