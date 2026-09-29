import assert from 'node:assert/strict'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'

/** A local scripted model; the production loop and tool scheduler remain real. */
export class ScriptedAdapter extends LlmAdapter {
  requests = []

  constructor(script) {
    super()
    this.script = [...script]
  }

  async resolveModel(provider, model) {
    return { provider, id: model, name: model }
  }

  async *stream(options) {
    this.requests.push(options)
    const blocks = this.script.shift()
    if (!blocks) throw new Error('Script exhausted: unexpected extra model request')
    for (const [index, block] of blocks.entries()) {
      yield { type: 'block-start', index, blockType: block.type }
      if (block.type === 'text') yield { type: 'text-delta', index, text: block.text }
      else yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments }
      yield { type: 'block-end', index, block }
    }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: blocks.some(b => b.type === 'tool-call') ? 'tool-calls' : 'stop' } }
  }
}

export const tool = (id, name, args) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) })
export const done = [{ type: 'text', text: 'Checks complete.' }]

/** Drive a whole turn, including scheduler commit and subsequent model requests. */
export async function runTurn(ctx, agent) {
  let dispose
  let timer
  const idle = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Agent did not become idle within 5 seconds')), 5000)
    dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') resolve()
    })
  })
  try {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run the scripted checks.' }], source: { kind: 'user' } }))
    await idle
  } finally {
    clearTimeout(timer)
    dispose()
  }
  const events = agent.session.snapshotEvents()
  const ends = events.filter(event => event.type === 'turn/end')
  assert.equal(ends.at(-1)?.data.reason.kind, 'completed', JSON.stringify(ends.at(-1)?.data))
  assert.equal(agent.inbox.hasPending, false, 'all context must be consumed before the turn ends')
  return events
}

/** Guard contexts must be inserted once, claimed, and reach a subsequent request. */
export function assertDeliveredOnce(events, adapter, tag, expectedCount = 1) {
  const inserted = events.filter(event => event.type === 'agent/inbox/spliced')
    .flatMap(event => event.data.inserted)
    .filter(message => message.source?.kind === 'sbjw' && message.source.tag === tag)
  assert.equal(inserted.length, expectedCount)
  assert.equal(new Set(inserted.map(message => message.id)).size, expectedCount)
  for (const notice of inserted) {
    const recorded = events.filter(event => event.type === 'user/message' && event.data.id === notice.id)
    assert.equal(recorded.length, 1, 'the context must be admitted exactly once')
    const text = notice.content.map(part => part.text ?? '').join('')
    const counts = adapter.requests.map(request => request.messages.filter(message =>
      message.content?.some(part => part.type === 'text' && part.text === text)).length)
    assert.ok(counts.some(count => count === 1), 'a subsequent model request must contain the correction')
    assert.ok(counts.every(count => count <= 1), 'a request must never contain the correction twice')
  }
}
