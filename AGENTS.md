# AGENTS.md

This file applies to the entire repository.

## Project overview

Mktero is a restartless Zotero extension for Zotero 7 through 9. It reads a
local PDF attachment, sends the PDF to MinerU, and opens the returned Markdown
and images in a read-only Zotero tab.

The project is plain JavaScript, not TypeScript. Source files use ES modules,
while esbuild bundles the two runtime entry points as browser IIFEs for
Firefox 115. Zotero supplies the privileged runtime globals used by the
extension, including `Zotero`, `IOUtils`, `PathUtils`, `Components`,
`ChromeUtils`, and `Services`.

## Commands

Use the Node.js version in `.node-version` (currently 24.15.0); it is the
shared local and CI version source. Do not use Node.js 25, which is outside the
supported dependency engine range.

```bash
npm ci
npm run check
npm test
npm run build
```

- Run one test file with `node --test test/<name>.test.js` while iterating.
- `npm run check` syntax-checks every source module explicitly. Add new source
  files to the `check` script in `package.json`.
- `npm run build` recreates `build/package`, the reproducible
  `build/mktero-<version>.xpi`, its `.sha256` checksum, and `build/updates.json`.
  Both `build/` and `node_modules/` are generated and ignored; never edit or
  commit them.
- `scripts/build.mjs` has an explicit list of copied runtime assets. Update it
  when adding a non-imported file required by the packaged extension.

Before handing off a change, run the narrow tests for the touched behavior,
then `npm run check`, `npm test`, and `npm run build` unless the change is
documentation-only. Report any command that could not be run.

## Repository map

- `manifest.json`: Zotero compatibility, extension ID, version, and update URL.
- `prefs.js`: defaults for every Zotero preference.
- `src/bootstrap.js`: extension lifecycle and dependency composition. It owns
  startup/shutdown, conversion cancellation, tabs, toolbar actions, context
  menus, preferences, cache, and proxy transport.
- `src/config/`: preference keys and preference-pane registration.
- `src/core/`: provider-independent conversion orchestration and progress.
- `src/extractors/`: adapters from Zotero items or MinerU results to the core
  document shape.
- `src/mineru/`: MinerU API client, parsing profile, ZIP extraction, binary
  helpers, and Markdown normalization.
- `src/cache/`: content-addressed Markdown and image cache under the active
  Zotero profile.
- `src/platform/`: Zotero/runtime adapters for aborting requests and applying
  proxy settings.
- `src/markdown/`: pure Markdown parsing, analysis, normalization, rendering,
  and safety logic.
- `src/editor/`: CodeMirror 6 read-only presentation, image previews, and
  citation/table/figure interactions.
- `src/ui/`: Zotero toolbar, item menu, tab presenter/view, loading state, and
  preference controller.
- `ui/`: packaged XHTML, CSS, and icons.
- `test/`: Node test runner coverage, with jsdom or linkedom where DOM behavior
  is needed.

## Architecture and runtime rules

- Keep `src/bootstrap.js` as the composition root. Prefer constructor or
  function injection over importing Zotero globals into pure modules.
- Preserve the dependency direction: UI and runtime adapters may depend on
  core and pure helpers; core and pure helpers must not depend on Zotero UI.
- Use explicit `.js` extensions in imports. Do not introduce Node-only APIs
  into files bundled for Zotero.
- Preserve all bootstrap lifecycle globals: `install`, `startup`, `shutdown`,
  `uninstall`, `onMainWindowLoad`, and `onMainWindowUnload`.
- Every registration, listener, object URL, proxy context, tab, and in-flight
  conversion needs a matching cleanup path. Closing a tab or shutting down the
  extension must abort its active conversion.
- Mktero tabs are session-only and there is at most one live tab per PDF item.
  Do not make them restorable without redesigning stale-tab cleanup and tests.
- The Markdown viewer is intentionally read-only. Keep
  `EditorView.editable.of(false)` and `EditorState.readOnly.of(true)` unless a
  request explicitly restores an editing workflow with persistence semantics.
- The viewer lives in a shadow root and mixes Zotero XUL containers with HTML.
  Create HTML elements with the XHTML namespace and test against Zotero-like
  DOM behavior.
- Keep the reader toolbar compatible with Zotero 7, 8, and the Zotero 9.0
  listener cleanup workaround.

## Data and security invariants

Treat PDFs, MinerU Markdown, result archives, image paths, API responses, and
preference values as untrusted input.

- Do not insert unescaped PDF content or arbitrary raw HTML into the Zotero
  chrome document. Extend the existing renderer/sanitizer and add adversarial
  tests for new markup.
- Keep Markdown links restricted to `http`, `https`, `zotero`, and document
  fragments. Do not load remote Markdown images; resolve only supported images
  extracted from the current result archive.
- Preserve archive, Markdown, image, and KaTeX resource budgets. ZIP extraction
  must continue to reject oversized data before unnecessary inflation.
- Normalize archive paths and never allow an extracted path to escape its
  logical result root.
- Never log or expose API tokens, proxy credentials, pre-signed upload URLs,
  PDF bytes/content, or raw authenticated responses. Existing progress logs
  deliberately contain only item IDs and conversion stages.
- API tokens, proxy credentials, cached Markdown, and cached figures are stored
  unencrypted in the local Zotero profile. User-facing documentation and UI
  must continue to state that accurately.
- Cache keys include the PDF content hash and MinerU parser profile. When parser
  behavior changes, update `MINERU_PARSER_PROFILE_ID` through the parser option
  constants so old results are not reused incorrectly.
- Cache failures are non-fatal to successful conversion. Preserve atomic
  replacement, serialized operations, expiry, and limit enforcement.

## Code and test conventions

- Match the existing style: four-space indentation, single quotes, semicolons,
  trailing commas in multiline literals, and named exports.
- Keep functions small and keep parsing/normalization logic deterministic.
  Prefer injected platform functions in code that needs network, time, files,
  timers, or Zotero APIs.
- Add comments only for constraints or non-obvious Zotero/browser behavior.
- Follow the language of the surrounding UI surface. Preferences and Zotero
  menu copy are currently English; Markdown reader controls are currently
  Chinese.
- Use `node:test` and `node:assert/strict`. Test names should describe observable
  behavior, and tests must not call the real MinerU service.
- Pair renderer/parser changes with normal, boundary, and malicious-input
  cases. Pair Zotero integration changes with cleanup and multi-window cases.
- Keep tests deterministic: inject clocks, delays, fetch, file adapters, and
  DOM implementations instead of depending on the host machine.

## Cross-file change checklist

- New or changed preference: update `prefs.js`,
  `src/config/mineru-preferences.js`, the preference XHTML/controller/styles,
  and preference tests.
- New runtime asset: update `scripts/build.mjs` and packaging tests.
- New source module: update the `npm run check` file list.
- Dependency change: update both `package.json` and `package-lock.json`, then
  verify the Firefox 115 bundle.
- Version change: keep `manifest.json`, `package.json`, `package-lock.json`, XPI
  naming, release URLs, and generated update metadata consistent.
- User-visible behavior, requirements, storage, or privacy change: update
  `README.md` in the same change.
