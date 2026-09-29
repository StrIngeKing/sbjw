# sbjw 1.1.9 Branding / Packaging Validation

This release renames the public project to **Cyber Internal Affairs / 赛博纪委** and the npm package to **`sbjw`** while retaining selected legacy internal ids for compatibility.

## Expected package metadata

- `package.json.name`: `sbjw`
- English DSH title: `Cyber Internal Affairs`
- Chinese DSH title: `赛博纪委`
- English README: `README.md`
- Chinese README: `README.zh-CN.md`
- DSH host-version peers: omitted

## Deliberately retained compatibility ids

- bundle id: `sbjw`
- tool names: `sbjw`, `sbjw_reconcile`
- prompt section: `sbjw:policy`
- checkpoint directory: `reliability-guard/checkpoints`
- existing error/source identifiers used by integrations

These are compatibility identifiers, not the public product name.
