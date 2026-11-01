# AGENTS.md

This file applies to the entire repository.

## Project overview

Mktero is a restartless Zotero extension for Zotero 7 through 10. It reads a
local PDF attachment, sends it to the selected OCR provider (MinerU or Mistral
OCR) when needed, and opens the resulting Markdown, figures, citations,
annotations, and optional AI translation in a session-only, reading-first
Zotero tab.

The project is plain JavaScript, not TypeScript. Source files use ES modules,
while esbuild bundles the runtime entry points as browser IIFEs for Firefox 115
(the bootstrap, the preferences UI, and the figure render worker), plus the
bundled pdf.js worker. Zotero supplies the privileged runtime globals used by
the extension, including `Zotero`, `IOUtils`, `PathUtils`, `Components`,
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
  menus, preferences, and cache.
- `src/ai/`: Vercel AI SDK gateway, translation service, and request tracking.
- `src/cache/`: content-addressed Markdown, figure, translation, citation-graph,
  and reading-position stores under the active Zotero profile.
- `src/citations/`: citation-graph building and the Semantic Scholar,
  OpenCitations, and OpenAlex clients.
- `src/config/`: preference keys, preference-pane registration, and the
  session-only models.dev reasoning catalog used by the AI reasoning menu.
- `src/core/`: provider-independent conversion orchestration and progress.
- `src/extractors/`: adapters from Zotero items or provider results to the core
  document shape.
- `src/figures/`: figure region resolution, panel/label recovery, reading-order
  reunion, and the worker-based restoration pipeline.
- `src/i18n/`: English and Simplified Chinese user-facing copy.
- `src/icons/`: bundled lucide icon helpers.
- `src/mineru/`: MinerU API client, parsing profile, ZIP extraction, binary
  helpers, and the raw result archive.
- `src/mineru/document/`: the MinerU reading document. It ingests `layout.json`
  (or the content list) into a block IR, classifies page chrome, repairs reading
  order, stitches paragraphs across pages, columns and floats, and serializes
  Markdown with its exact source map and figure-pipeline input.
- `src/mistral/`: Mistral OCR client, parsing profile, and result normalization.
- `src/pdf/`: PDF.js text engine, page crops, annotation location, and outlines.
- `src/platform/`: Zotero/runtime adapters for aborting requests and Zotero APIs.
- `src/markdown/`: pure Markdown parsing, analysis, normalization, rendering,
  and safety logic.
- `src/editor/`: CodeMirror 6 presentation, inline correction editing, image
  previews, and citation/table/figure interactions.
- `src/ui/`: Zotero toolbar, item menu, tab presenter/view, loading state, and
  preference controller.
- `ui/`: packaged XHTML, CSS, and icons.
- `docs/`: README-linked user documentation. The directory is gitignored except
  for an explicit allowlist in `.gitignore`; see the cross-file checklist.
- `preview/`: browser preview of the reader for the website and browser
  compatibility checks (`npm run build:preview`). Fixture data only; not part
  of the XPI. See `docs/development.md`.
- `scripts/`: build, figure validation harnesses, the figure-corpus check, and
  the browser preview build, packaging, and validation.
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
- Every registration, listener, object URL, tab, and in-flight
  conversion needs a matching cleanup path. Closing a tab or shutting down the
  extension must abort its active conversion.
- Mktero tabs are session-only and there is at most one live tab per PDF item.
  Do not make them restorable without redesigning stale-tab cleanup and tests.
- The Markdown reading surface is intentionally read-only. Keep the document
  `EditorView.editable.of(false)` / `EditorState.readOnly.of(true)`. The only
  editable Mktero surface is the inline correction editor, and corrections must
  persist through the revision store instead of mutating the cached OCR
  Markdown. The notes column hosts Zotero's own `note-editor`, which edits a
  Zotero note item, never the Markdown.
- The viewer lives in a shadow root and mixes Zotero XUL containers with HTML.
  Create HTML elements with the XHTML namespace and test against Zotero-like
  DOM behavior.
- Keep the reader toolbar compatible with Zotero 7 through 10, including the
  Zotero 9.0 listener cleanup workaround.

## Annotations and Zotero notes

- Displayed terms follow Zotero: annotation (`注释`) for a Zotero PDF
  annotation or a local Markdown highlight not yet in the PDF, comment
  (`评论`) for its text, note (`笔记`) only for a Zotero note item, and
  footnote (`脚注`) for a paper's footnote. Internal i18n keys and CSS classes
  such as `viewer.notes*` and `.markdown-note-*` keep their historical names.
- The reader's left column has the Headings, Figures, and Annotations
  segments. The right column lists and edits the current paper's child notes
  plus standalone notes from the same Zotero library in separate tabs.
- Mktero stores no notes. Notes are Zotero note items edited with Zotero's own
  `note-editor`; do not add a note store, a rich-text editor, or a note cache.
  The reader does not mix in other libraries or other papers' child notes.
- Do not patch Zotero's context pane (`_hasContextPaneTypes` in 8.0 to 10.0,
  the hardcoded `'reader'` check in 7.0). The Mktero tab hosts its own
  `note-editor`, hides the leftover context pane while selected, and falls
  back to Zotero's note window when the editor cannot be hosted.
- `Add to Note` goes through the editor instance's `insertAnnotations()` and
  needs a PDF position. Refuse an annotation or selection the PDF index cannot
  locate instead of inserting text without a source. Never target or list a
  `Mktero Markdown Snapshot` note.

## Data and security invariants

Treat PDFs, OCR-provider Markdown and results (MinerU and Mistral), result
archives, image paths, API responses, and preference values as untrusted input.

- Do not insert unescaped PDF content or arbitrary raw HTML into the Zotero
  chrome document. Extend the existing renderer/sanitizer and add adversarial
  tests for new markup.
- Keep Markdown links restricted to `http`, `https`, `zotero`, and document
  fragments. Do not load remote Markdown images; resolve only supported images
  extracted from the current result archive.
- Preserve archive, Markdown, image, figure-crop/canvas, and KaTeX resource
  budgets. ZIP extraction must continue to reject oversized data before
  unnecessary inflation.
- Normalize archive paths and never allow an extracted path to escape its
  logical result root.
- Never log or expose API tokens, pre-signed upload URLs,
  PDF bytes/content, or raw authenticated responses. Existing progress logs
  deliberately contain only item IDs and conversion stages.
- API tokens, cached Markdown, cached figures, corrections, translations, and
  reading positions are stored unencrypted in the local Zotero profile.
  User-facing documentation and UI must continue to state that accurately.
- Cache keys include the PDF content hash and the provider parser profile
  (`MINERU_PARSER_PROFILE_ID` or `MISTRAL_PARSER_PROFILE_ID`). When parser
  behavior changes, update the matching profile ID through the parser option
  constants. Figure behavior is versioned by `FIGURE_PIPELINE_PROFILE`, which is
  part of both profiles, so a figure-pipeline change must bump it as well.
  The MinerU profile is the request options plus `MINERU_DOCUMENT_PIPELINE`
  and `FIGURE_PIPELINE_PROFILE`: bump `MINERU_DOCUMENT_PIPELINE` with any
  change to `src/mineru/document/` output. The raw result store is keyed by
  `MINERU_REQUEST_PROFILE_ID`, so such a bump re-reads stored results offline.
  Keep each shipped profile as a literal in `MINERU_PREVIOUS_PARSER_PROFILE_IDS`
  so corrected revisions stay reachable.
- Cache failures are non-fatal to successful conversion. Preserve atomic
  replacement, serialized operations, expiry, and limit enforcement.

## Code and test conventions

- Match the existing style: four-space indentation, single quotes, semicolons,
  trailing commas in multiline literals, and named exports.
- Keep functions small and keep parsing/normalization logic deterministic.
  Prefer injected platform functions in code that needs network, time, files,
  timers, or Zotero APIs.
- Add comments only for constraints or non-obvious Zotero/browser behavior.
- Put user-visible Mktero copy in `src/i18n/localization.js` and keep the
  English and Simplified Chinese message sets in sync. Do not hardcode a UI
  language in preferences, Zotero menus, or Markdown reader controls. Keep
  provider-specific wording out of shared copy that both providers use (see
  `src/ui/provider-neutral-copy.js`).
- Keep the English and Simplified Chinese READMEs and their `docs/` pages in
  sync. User-facing claims about sending, storage, and privacy must match the
  code.
- Use `node:test` and `node:assert/strict`. Test names should describe observable
  behavior, and tests must not call the real MinerU or Mistral service.
- Pair renderer/parser changes with normal, boundary, and malicious-input
  cases. Pair Zotero integration changes with cleanup and multi-window cases.
- Keep tests deterministic: inject clocks, delays, fetch, file adapters, and
  DOM implementations instead of depending on the host machine.
- The figure corpus expectations in `test/fixtures/figure-corpus/` are checked
  by `scripts/figure-corpus-check.mjs` against local MinerU archives named by
  `MKTERO_FIGURE_CORPUS`. After reviewing a real-data change, refresh them with
  `--update`; never commit the archives themselves.

## Cross-file change checklist

- New or changed preference: update `prefs.js`, the relevant
  `src/config/*-preferences.js`, the preference XHTML/controller/styles, and
  preference tests.
- New runtime asset: update `scripts/build.mjs` and packaging tests.
- New source module: update the `npm run check` file list.
- Dependency change: update both `package.json` and `package-lock.json`, then
  verify the Firefox 115 bundle.
- Version change: keep `manifest.json`, `package.json`, `package-lock.json`, XPI
  naming, release URLs, and generated update metadata consistent.
- Browser preview embedding change (query parameters, the ready message, the
  sandbox and CSP in `preview/embed.js`, or the 1280x800 layout): bump
  `PREVIEW_EMBED_VERSION` in `scripts/build-preview.mjs`.
  Each release publishes `mktero-preview-X.Y.Z.tar.gz` and its `.sha256`, and
  the website installs them at deploy time; a site that does not know the new
  embed version shows its still image instead.
- User-visible behavior, requirements, storage, or privacy change: update the
  English and Simplified Chinese READMEs and the matching `docs/*.md` pages in
  the same change.
- New README-linked document: add it to the `.gitignore` allowlist and to both
  READMEs' Documentation lists. `docs/` is otherwise gitignored because it also
  holds local research files and the GitHub Pages shim, so an untracked document
  breaks its README links.
