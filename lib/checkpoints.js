/** Durable count-only reset receipts. Never restore stale evidence as PASS. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, unlinkSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { EvidenceLedger } from './evidence.js'

const FIELDS = ['mutations', 'risks', 'failures', 'unknowns', 'review', 'inFlight']
const zero = () => Object.fromEntries(FIELDS.map(key => [key, 0]))
const total = counts => FIELDS.reduce((sum, key) => sum + counts[key], 0)
const valid = counts => counts && FIELDS.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)

export function openCounts(state) {
  return {
    mutations: new EvidenceLedger(state).pendingMutations().length,
    risks: state.unresolvedMutationCount,
    failures: state.unexplainedFailures.filter(item => item.at > state.turnStartSeq).length,
    unknowns: state.unknowns.length,
    review: state.review?.required && state.review.verdict?.verdict !== 'PASS' ? 1 : 0,
    inFlight: state.inFlightRiskCalls?.size ?? 0,
  }
}

export class Checkpoints {
  #dir
  #logger
  #legacyDir
  #run = randomUUID()
  #last = new WeakMap()

  constructor(profileDir, logger) {
    this.#logger = logger
    if (typeof profileDir === 'string' && isAbsolute(profileDir)) {
      this.#dir = join(profileDir, 'sbjw', 'checkpoints')
      this.#legacyDir = join(profileDir, 'reliability-guard', 'checkpoints')
    }
    else logger.info('checkpoint persistence skipped: no launcher profileContext.dir; restart history is unavailable')
  }

  #path(state, dir = this.#dir) { return join(dir, `${createHash('sha256').update(state.key).digest('hex')}.json`) }

  load(state) {
    state.history = { storage: this.#dir ? 'profile' : 'unavailable', status: 'history-unavailable', reset: zero(), resetCount: 0, resolvedByRestart: 0 }
    if (!this.#dir) return
    try {
      let raw
      try { raw = readFileSync(this.#path(state), 'utf8') }
      catch (error) {
        if (error?.code !== 'ENOENT' || !this.#legacyDir) throw error
        raw = readFileSync(this.#path(state, this.#legacyDir), 'utf8')
        this.#logger.info('loaded legacy checkpoint receipt; future writes use sbjw/checkpoints')
      }
      const saved = JSON.parse(raw)
      if (saved.version !== 1 || !valid(saved.open) || !valid(saved.reset)) throw new Error('invalid checkpoint')
      state.history.reset = { ...saved.reset }
      for (const key of FIELDS) state.history.reset[key] += saved.open[key]
      state.history.resetCount = total(state.history.reset)
      state.history.status = state.history.resetCount ? 'reset' : 'no-open-items-at-checkpoint'
      state.history.previousOpenCount = total(saved.open)
      if (total(saved.open)) this.#logger.warn(`previous guard instance had ${total(saved.open)} open obligation(s): reset, NOT resolved / 旧实例缺口已重置，非已解决`)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        state.history.storage = 'error'
        this.#logger.warn('checkpoint read failed; history is unknown, not empty; preserving the existing receipt')
      }
    }
  }

  /** Archive only obligations actually dropped by a turn boundary. */
  noteTurnReset(state, before) {
    const after = openCounts(state)
    for (const key of FIELDS) state.history.reset[key] += Math.max(0, before[key] - after[key])
    state.history.resetCount = total(state.history.reset)
    if (state.history.resetCount) state.history.status = 'reset'
  }

  save(state) {
    if (!this.#dir || state.history.storage === 'error') return
    const data = JSON.stringify({ version: 1, run: this.#run, open: openCounts(state), reset: state.history.reset })
    if (this.#last.get(state) === data) return
    const temporary = `${this.#path(state)}.${this.#run}.tmp`
    try {
      mkdirSync(this.#dir, { recursive: true, mode: 0o700 })
      writeFileSync(temporary, data, { mode: 0o600 })
      const fd = openSync(temporary, 'r+')
      try { fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temporary, this.#path(state))
      this.#last.set(state, data)
      state.history.storage = 'profile'
    } catch (error) {
      state.history.storage = 'error'
      this.#logger.warn(`checkpoint write failed (${error?.code ?? 'unknown'}); restart accounting is NOT guaranteed / 重启记账不可保证`)
      try { unlinkSync(temporary) } catch { /* Only this writer's exact temporary file. */ }
    }
  }
}
