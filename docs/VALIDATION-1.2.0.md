# sbjw 1.2.0 validation / 验证说明

## Rebrand completion

Current runtime-facing identifiers are unified on `sbjw`:

- npm package: `sbjw`
- DSH bundle/component id: `sbjw`
- Cordis plugin name: `sbjw`
- diagnostics tool: `sbjw`
- reconciliation tool: `sbjw_reconcile`
- prompt section: `sbjw:policy`
- injected context source: `sbjw`
- checkpoint directory: `<profile>/sbjw/checkpoints`
- error prefix: `SBJW_`

The only current-code occurrence of the former `reliability-guard` runtime id is the **legacy checkpoint read path**, used solely to import historical reset counts from pre-1.2.0 profiles. New writes go to `sbjw/checkpoints`. Historical changelog/validation documents retain old names because they describe real older releases.

## Static/package checks

- all project JavaScript files: `node --check`
- package version/name: `sbjw@1.2.0`
- locale metadata: `赛博纪委` / `Cyber Internal Affairs`
- `cordis.patch.yml`: `id: sbjw`, `name: sbjw`
- no `@deepseek-ai/dsh*` runtime peer constraints

A real DSH Desktop E2E is still the final authority for UI rendering after installation.
