# Development

[English](./development.md) · [简体中文](./development.zh-CN.md) · [Back to README](../README.md)

Use the Node.js version in [`.node-version`](../.node-version), currently
`24.15.0`. Node.js 25 is outside the supported dependency range.

```bash
npm ci
npm run check
npm test
npm run build
```

Run one test while iterating with `node --test test/<name>.test.js`. The build
creates the reproducible XPI, SHA-256 checksum, and `build/updates.json` under
`build/`; `build/` and `node_modules/` are generated and ignored.

Keep the versions in `manifest.json`, `package.json`, and `package-lock.json`
consistent before tagging a release. See [AGENTS.md](../AGENTS.md) for the
architecture, security invariants, and contribution checklist.

## Figure corpus regression

`test/fixtures/figure-corpus/` stores the figure decisions (composed figures,
preserved pages, bounding boxes) for papers that shipped figure-restoration
fixes. The matching test stays skipped unless you point it at local MinerU
result archives; the archives themselves are never committed.

```bash
export MKTERO_FIGURE_CORPUS="$HOME/mktero-figure-corpus"  # <id>.zip or <id>/result.zip
node scripts/figure-corpus-check.mjs                      # compare and print a diff
node scripts/figure-corpus-check.mjs --update             # refresh after review
```

After changing figure rules, run the check and review the diff. When you verify
another paper, add its archive to the corpus directory and commit the generated
`<id>.expected.json`. Missing archives are skipped; an archive whose bytes
changed fails until it is re-verified and updated.
