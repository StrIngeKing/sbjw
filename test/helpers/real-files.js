import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mountGuardHarness } from './harness.js'

export const plan = 'Rollback: restore the test fixture from its saved content. Verification: check the exact target after the change.'

/** Real local files and PowerShell; all writable targets stay in a fresh fixture. */
export async function realFiles(t, config = {}, plugin) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v5-'))
  assert.ok(root.startsWith(join(tmpdir(), 'dsh-v5-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const probe = await mountGuardHarness({ tools: false, config, plugin })
  t.after(() => probe.ctx.fiber.dispose())
  const targetOf = path => {
    const target = resolve(root, path)
    assert.ok(target === root || target.startsWith(root + sep), `outside test fixture: ${target}`)
    return target
  }
  probe.ctx.provide('fs', {
    async resolve(path, { cwd } = {}) {
      const target = resolve(cwd ?? root, path)
      return { targetKey: target, displayPath: target }
    },
    async stat(target) {
      try {
        const info = statSync(target.displayPath)
        return { version: `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`, size: info.size, type: info.isDirectory() ? 'directory' : 'file' }
      } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return undefined; throw error }
    },
    async readText(target) { return readFileSync(target.displayPath, 'utf8') },
  })
  const textOutput = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }
  probe.ctx.tools.register(defineTool({
    name: 'write', description: 'Write a bounded test file.',
    parameters: { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } }, output: textOutput,
    execute(args) { writeFileSync(targetOf(args.file_path), args.content); return 'written' },
  }))
  probe.ctx.tools.register(defineTool({
    name: 'read', description: 'Read a bounded test file with official observation semantics.',
    parameters: { file_path: { type: 'string', required: true } }, output: textOutput,
    async execute(args, exec) {
      const path = targetOf(args.file_path)
      const target = await probe.ctx.fs.resolve(path)
      const info = await probe.ctx.fs.stat(target)
      if (!info) {
        probe.ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
        const error = new Error(`cannot read "${path}": not found`)
        error.code = 'FS_NOT_FOUND'
        throw error
      }
      const text = readFileSync(path, 'utf8')
      probe.ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      return text
    },
  }))
  probe.ctx.tools.register(defineTool({
    name: 'pwsh', description: 'Run authored test commands in the fixture.',
    parameters: { command: { type: 'string', required: true }, description: { type: 'string' } }, output: textOutput,
    execute(args) {
      // The test scripts below use literal relative paths and no outside writes.
      assert.doesNotMatch(args.command, /\$HOME|\.\.[\\/]|Remove-Item\s+["']?[A-Z]:/i)
      try { return execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', args.command], { cwd: root, encoding: 'utf8', timeout: 10000, stdio: 'pipe' }).trim() || '(no output)' }
      catch (error) { return `${error.stdout ?? ''}\n[stderr]\n${error.stderr ?? ''}\n[exit code: ${error.status}]` }
    },
  }))
  probe.ctx.tools.register(defineTool({
    name: 'glob', description: 'Exact-name file search with the host structured result shape.',
    parameters: { pattern: { type: 'string', required: true }, path: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { root: { type: 'string', required: true }, paths: { type: 'array', required: true, items: { type: 'string' } } } },
      render: (_args, value) => [{ type: 'text', text: value.paths.join('\n') || 'No files found' }] },
    execute(args) { const dir = targetOf(args.path ?? '.'); return { root: dir, paths: readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name === args.pattern).map(entry => entry.name) } },
  }))
  probe.ctx.tools.register(defineTool({ name: 'subagent', description: 'Scripted review verdict.', parameters: { report: { type: 'string', required: true } }, output: textOutput, execute: args => args.report }))
  return { ...probe, root, targetOf, mkdir: name => mkdirSync(targetOf(name)) }
}
