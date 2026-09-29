/**
 * Extraction of the model's own explicit statements of uncertainty.
 *
 * The guard never reads reasoning. It only reads what the model chose to write
 * in a message, and only lines that explicitly mark something as unknown,
 * unverified, or assumed. Those become ledger entries so the completion gate
 * can require them to be resolved or reported.
 *
 * @module dsh-reliability-guard/declarations
 */

/**
 * Markers that introduce an explicit uncertainty statement.
 *
 * Each pattern has to be specific enough that ordinary prose does not match:
 * a bare "maybe" is not a declaration, while "unverified:" is.
 */
const DECLARATION_PATTERNS = [
  /^\s*(?:[-*•]\s*)?(?:unknown|unverified|unconfirmed|not verified|not yet verified|assumption|assumed|open question|未验证|未确认|未知|待确认|假设)\s*[:：\-–]\s*(.+)$/gim,
  /\b(?:I (?:have not|haven't|did not|didn't) (?:verified|confirmed|checked|tested))\b([^.\n]{0,200})/gi,
  /\b(?:this is|that is|it is) (?:still )?(?:unverified|unconfirmed|an assumption|not confirmed)\b([^.\n]{0,200})/gi,
]

/**
 * Extract bounded uncertainty declarations from one message.
 *
 * @param text - the message text.
 * @param limit - maximum declarations to return.
 * @returns the declared unknowns, bounded and deduplicated.
 */
export function detectUnknownDeclarations(text, limit = 6) {
  const body = String(text ?? '')
  if (body.trim() === '') return []
  const found = []
  const seen = new Set()
  for (const pattern of DECLARATION_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags)
    for (const match of body.matchAll(regex)) {
      const captured = (match[1] ?? match[0] ?? '').trim().replace(/\s+/g, ' ')
      if (captured.length < 4) continue
      const value = captured.slice(0, 240)
      const key = value.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      found.push(value)
      if (found.length >= limit) return found
    }
  }
  return found
}
