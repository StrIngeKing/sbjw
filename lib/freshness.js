/**
 * The freshness gate.
 *
 * Any statement about a version, a release, compatibility, an official API, or
 * another externally controlled fact is only as good as the retrieval behind
 * it. The gate detects when a session is relying on such a fact and decides
 * whether a *relevant* current retrieval exists.
 *
 * Detection is deliberately narrow. A bare occurrence of a word like `api`,
 * `support`, `npm` or `version` is normal engineering prose, so a claim must
 * additionally look like a fact about the outside world: a version number, a
 * release/timeline word, or an explicit currency word. Anything that already
 * carries an honest staleness label is left alone, and a missing retrieval is
 * reported as a label requirement (advisory), never as a block.
 *
 * @module dsh-reliability-guard/freshness
 */

/** Retrieval-capable tools, by the names the shipped catalog uses. */
export const RETRIEVAL_TOOLS = new Set(['web_search', 'web_fetch'])

/**
 * Sentence-ish split, so the reported evidence is the claim rather than the
 * whole message.
 *
 * A full stop only ends a sentence when it is not between digits; that keeps
 * `Version 2.0 is not freshly verified.` in one clause, so an honest label is
 * actually seen as one.
 */
const CLAUSE_SPLIT = /(?:[!?。！？；;]\s*|(?<!\d)\.(?!\d)(?=\s|$)|\n+)/

/**
 * Currency words that make a statement a claim about the external present.
 *
 * Only words that genuinely indicate "the state of the world right now" are
 * here. Weasel words such as `supports`, `available`, `requires` or `minimum`
 * are deliberately absent: "this change supports a new option" is a statement
 * about local code, and a detector that flags it is worse than no detector.
 */
const CURRENCY = new RegExp(
  [
    '\\blatest\\b',
    '\\bnewest\\b',
    '\\bcurrent(?:ly)?\\b',
    '\\bup[ -]?to[ -]?date\\b',
    '\\bas of\\b',
    '\\bno longer\\b',
    '\\bdeprecated\\b',
    '\\bhas been released\\b',
    '\\bwere released\\b',
    '\\bannounced\\b',
    '\\bend[ -]of[ -]life\\b',
    '\\bEOL\\b',
    '\\bsecurity advis(?:ory|ories)\\b',
    '\\bCVE-\\d{4}-\\d+\\b',
    '\\bavailable (?:now|today|since|as of)\\b',
  ].join('|'),
  'i',
)

/**
 * Version-shaped tokens (`1.2`, `1.2.3`, `v2`, `2.0.1-rc.1`).
 *
 * A version number alone is not enough either — this repository has its own
 * version constants — so it only raises a clause to "candidate"; the topic
 * marker and the external-scope rules still have to agree.
 */
const VERSION_SHAPE = /\bv?\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?\b/

/**
 * Artifacts that belong to an external product rather than to the local
 * repository, so a mention of one is a candidate external fact.
 */
const EXTERNAL_ARTIFACT = /\b(release notes?|changelog|roadmap|migration guide|breaking changes?|security advis(?:ory|ories)|registry|package page|npm registry|PyPI|SDK|CLI)\b/i

/**
 * Local-repository vocabulary that makes a marker an internal reference even
 * when an artifact noun is present ("our own release notes live in CHANGELOG.md").
 */
const LOCAL_SCOPE = /\b(our own|our|my|this (?:repo|repository|project|change|patch|branch)|the (?:repo|repository|project) (?:own|local)|in-?repo|workspace|CHANGELOG\.md)\b/i

/**
 * Record a retrieval from a tool call, when the call is a retrieval.
 *
 * @param toolName - the invoked tool.
 * @param args - the parsed arguments.
 * @param record - a callback that stores the retrieval.
 * @param record.topic - the normalized topic.
 * @param record.toolName - the retrieval tool.
 * @returns whether a retrieval was recorded.
 */
export function consumeRetrieval(toolName, args, record) {
  if (!RETRIEVAL_TOOLS.has(toolName)) return false
  const query = typeof args?.query === 'string' ? args.query : undefined
  const url = typeof args?.url === 'string' ? args.url : undefined
  if (url !== undefined && url.trim() !== '') record({ topic: normalizeTopic(url), toolName })
  if (query !== undefined && query.trim() !== '') record({ topic: normalizeTopic(query), toolName })
  if ((url === undefined || url.trim() === '') && (query === undefined || query.trim() === '')) {
    record({ topic: normalizeTopic(toolName), toolName })
  }
  return true
}

/**
 * Normalize a query or URL into a stable topic key.
 *
 * @param text - the raw topic text.
 * @returns the normalized key.
 */
export function normalizeTopic(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/[^\p{L}\p{N}._/-]+/gu, ' ')
    .trim()
    .slice(0, 160)
}

/**
 * The significant words of a topic or claim, for a relevance comparison.
 *
 * @param text - the text to tokenize.
 * @returns the distinct words of four or more characters.
 */
export function significantWords(text) {
  const generic = new Set(['version', 'versions', 'release', 'releases', 'latest', 'current', 'currently', 'package', 'official', 'compatible', 'compatibility', 'support', 'with', 'that', 'this', 'https', 'http'])
  const words = String(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#.-]+/u)
    .map((word) => word.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((word) => word.length >= 4 && !generic.has(word))
  return [...new Set(words)]
}

/**
 * Whether a claim and a retrieved topic are about the same subject.
 *
 * Require two distinct subject words; generic currency/version vocabulary is
 * not evidence of relevance. This remains a lexical advisory, not fact checking.
 *
 * @param claimText - the claim.
 * @param topics - the retrieved topic keys.
 * @returns the shared subject words, or `undefined`.
 */
export function topicOverlap(claimText, topics) {
  const claimWords = new Set(significantWords(claimText))
  for (const topic of topics) {
    const shared = significantWords(topic).filter(word => claimWords.has(word))
    if (shared.length >= 2) return shared.join(' ')
  }
  return undefined
}

/**
 * Find the external-fact claims in one text.
 *
 * @param text - the text to scan.
 * @param topics - topic markers, matched case-insensitively inside a clause.
 * @param limit - maximum claims to return.
 * @returns the matched claims with their marker.
 */
export function findExternalClaims(text, topics, limit = 4) {
  const body = String(text ?? '')
  if (body.trim() === '') return []
  const claims = []
  for (const clause of body.split(CLAUSE_SPLIT)) {
    const trimmed = clause.trim()
    if (trimmed.length < 12) continue
    const lowered = trimmed.toLowerCase()
    const marker = topics.find((topic) => topic !== '' && lowered.includes(topic.toLowerCase()))
    if (marker === undefined) continue
    // A marker plus a version number is not yet a claim: this repository has its
    // own version constants. A marker plus local-scope vocabulary is an internal
    // reference, not a fact about the outside world.
    if (LOCAL_SCOPE.test(trimmed)) continue
    const versioned = VERSION_SHAPE.test(trimmed)
    const external = EXTERNAL_ARTIFACT.test(trimmed)
    const currencied = CURRENCY.test(trimmed)
    const flagged = (versioned && (external || currencied)) || (external && currencied)
    if (!flagged) continue
    // A claim that already carries an explicit staleness label is honest.
    if (isLabelled(trimmed)) continue
    claims.push({ text: trimmed.slice(0, 240), marker, versioned })
    if (claims.length >= limit) break
  }
  return claims
}

/**
 * Whether a clause already states that it is not freshly verified.
 *
 * @param clause - the clause text.
 * @returns whether an honest staleness label is present.
 */
export function isLabelled(clause) {
  return /\b(not (?:freshly )?verified|unverified|not confirmed|as of my (?:training|knowledge)|from (?:my )?training|may be outdated|might be outdated|cannot confirm|no retrieval|without (?:a )?retrieval|needs? verification)\b/i.test(
    String(clause ?? ''),
  )
}

/**
 * Evaluate the freshness gate for the text a session is about to rely on.
 *
 * @param input - evaluation input.
 * @param input.text - the text to evaluate.
 * @param input.topics - configured topic markers.
 * @param input.retrievals - topic -> { at } map; each topic keeps its own timestamp.
 * @param input.retrievedTopics - legacy single-topic input only.
 * @param input.lastRetrievalAt - legacy single-topic timestamp only.
 * @param input.now - the current timestamp.
 * @param input.maxAgeMinutes - how long a retrieval stays fresh.
 * @returns the gate result.
 */
export function evaluateFreshness({ text, topics, retrievals, retrievedTopics = [], lastRetrievalAt, now = Date.now(), maxAgeMinutes = 30 }) {
  const claims = findExternalClaims(text, topics)
  if (claims.length === 0) return { passed: true, gaps: [], claims: [] }

  const maxAgeMs = Math.max(1, maxAgeMinutes) * 60_000
  // Legacy single-topic callers remain valid. A global timestamp cannot date
  // multiple topics safely; the live pipeline always passes the topic Map.
  const records = retrievals === undefined
    ? (retrievedTopics.length === 1 ? [[retrievedTopics[0], { at: lastRetrievalAt }]] : [])
    : [...retrievals]
  let retrievalAgeMs
  for (const claim of claims) {
    const matching = records.filter(([topic, record]) => Number.isFinite(record?.at) && topicOverlap(claim.text, [topic]) !== undefined)
    const newest = matching.length ? Math.max(...matching.map(([, r]) => r.at)) : undefined
    const age = newest === undefined ? undefined : now - newest
    if (age !== undefined && age >= 0 && age <= maxAgeMs) {
      retrievalAgeMs = Math.max(retrievalAgeMs ?? 0, age)
      continue
    }
    const reason = records.length === 0 ? 'no web_search or web_fetch result exists in this session'
      : age === undefined ? 'the retrievals in this session are about a different subject'
        : age < 0 ? 'the matching retrieval has an invalid future timestamp'
          : `the matching retrieval is ${Math.round(age / 60_000)} minute(s) old, past the ${maxAgeMinutes}-minute freshness window`
    return { passed: false, claims, retrievalAgeMs: age, gaps: [gapFor(claim, reason)] }
  }
  return { passed: true, gaps: [], claims, retrievalAgeMs }
}

/**
 * Build the advisory gap for one unanswered claim.
 *
 * The gap is advisory on purpose: the guard cannot tell a genuine external fact
 * from engineering prose that happens to mention a version, so the correct
 * response is an honest label, never a blocked turn.
 *
 * @param claim - the claim to report.
 * @param reason - why the claim is unanswered.
 * @returns the gap.
 */
function gapFor(claim, reason) {
  return {
    category: 'freshness',
    severity: 'advisory',
    message: `This response states an externally controlled fact (matched "${claim.marker}": "${claim.text}") but ${reason}. Retrieve current information, or label the statement as not freshly verified and say what you are relying on instead.`,
  }
}
