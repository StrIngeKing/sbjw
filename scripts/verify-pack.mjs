#!/usr/bin/env node
/**
 * Pre-pack verification.
 *
 * `npm pack` / `pnpm pack` runs this before the tarball is produced, so a
 * release cannot be published with a missing entry point, a patch file that
 * would not parse, or a manifest that does not declare the bundle. It checks
 * only what a consumer needs; it deliberately does not run the test suite,
 * because packing must stay fast and offline.
 *
 * @module sbjw/scripts/verify-pack
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

/** Record a failed check with a reason a reader can act on. */
function check(condition, description) {
  if (!condition) failures.push(description)
}

const manifestPath = join(root, 'package.json')
check(existsSync(manifestPath), 'package.json is missing')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

check(typeof manifest.name === 'string' && manifest.name.length > 0, 'package.json declares no name')
check(manifest.name === 'sbjw', `package.json name must be sbjw, got ${JSON.stringify(manifest.name)}`)
check(/^\d+\.\d+\.\d+/.test(manifest.version ?? ''), `package.json version "${manifest.version}" is not a release version`)
check(manifest.type === 'module', 'package.json must declare type: module')
check(manifest.main === 'lib/index.js', 'package.json main must be lib/index.js')
check(
  manifest.exports?.['.']?.default === './lib/index.js',
  'package.json exports["."].default must be ./lib/index.js',
)
check(
  manifest.dsh?.bundle?.patch === './cordis.patch.yml',
  'package.json must declare dsh.bundle.patch so DSH treats the package as a bundle',
)
check(
  manifest.exports?.['./locale/*.json'] === './locale/*.json',
  'package.json must export locale/*.json for bilingual plugin metadata',
)

// A bundle without a parsable patch installs but composes nothing.
const patchPath = join(root, 'cordis.patch.yml')
check(existsSync(patchPath), 'cordis.patch.yml is missing')
if (existsSync(patchPath)) {
  const patch = readFileSync(patchPath, 'utf8')
  check(/^\s*-\s*insert:/m.test(patch), 'cordis.patch.yml has no "- insert:" row')
  check(/id:\s*sbjw/.test(patch), 'cordis.patch.yml does not name the sbjw entry')
}

const entryPath = join(root, 'lib', 'index.js')
check(existsSync(entryPath), 'lib/index.js is missing')
if (existsSync(entryPath)) {
  const entry = readFileSync(entryPath, 'utf8')
  check(/export const name/.test(entry), 'lib/index.js does not export the plugin name')
  check(/export const inject/.test(entry), 'lib/index.js does not declare its service dependencies')
  check(/export function apply/.test(entry), 'lib/index.js does not export apply()')
  check(/export \{ GuardConfig as Config \}/.test(entry), 'lib/index.js does not export the Config schema')
  check(
    !/process\.stderr\.write\('\[guard/.test(entry),
    'lib/index.js still contains a debug trace write',
  )
}

for (const file of ['README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'LICENSE']) {
  check((manifest.files ?? []).includes(file), `package.json files[] does not ship ${file}`)
  check(existsSync(join(root, file)), `${file} is listed in files[] but does not exist`)
}
check((manifest.files ?? []).includes('locale/*.json'), 'package.json files[] does not ship locale/*.json')

for (const language of ['en', 'zh']) {
  const localePath = join(root, 'locale', `${language}.json`)
  if (!existsSync(localePath)) continue
  const locale = JSON.parse(readFileSync(localePath, 'utf8'))
  check(typeof locale.meta?.title === 'string' && locale.meta.title.trim().length > 0, `${language} locale has no meta.title`)
  check(
    locale.meta?.title === (language === 'en' ? 'Cyber Internal Affairs' : '赛博纪委'),
    `${language} locale title must match the localized Cyber Internal Affairs / 赛博纪委 display name`,
  )
  check(typeof locale.meta?.description === 'string' && locale.meta.description.trim().length > 0, `${language} locale has no meta.description`)
}

// Every peer range must point at the runtime this release was built against;
// a floating range is what makes an installed plugin load against a version
// whose seams have moved.
for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
  check(typeof range === 'string' && range.length > 0, `peer dependency ${name} has no range`)
  check(!/[\^*]/.test(range) || /^\d+\.\d+\.\d+$/.test(range) || /^~/.test(range), `peer dependency ${name} range "${range}" is too loose`)
}

check(
  !Object.keys(manifest.peerDependencies ?? {}).some(name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')),
  '1.1.7+ must not declare DSH host-version peers; missing host peers are the intentional compatibility policy',
)

if (failures.length > 0) {
  console.error('verify-pack failed:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`verify-pack ok: ${manifest.name}@${manifest.version}`)
