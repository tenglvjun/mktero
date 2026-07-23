# Mktero

Mktero is a Zotero 7/8 plugin that adds an **MD** button to PDF reader toolbars. It converts the opened PDF to Markdown and displays a safe rendered preview plus the Markdown source.

Zotero 8 uses Structured Document Text (SDT) when available. Zotero 7 falls back to Zotero's plain PDF full-text extractor.

## Development

Requirements:

- Node.js 20 or newer
- `zip`
- Zotero 7 or 8 with a separate development profile

Install dependencies and verify the project:

```bash
npm install
npm test
npm run build
```

The installable package is written to `build/mktero-0.1.0.xpi`.

To load source builds during development, create an extension proxy file named `mktero@tenglvjun.github.io` in the Zotero profile's `extensions` directory. Its contents should be the absolute path to `build/package`. Run `npm run build` before starting Zotero.

Alternatively, open **Tools → Add-ons**, choose **Install Add-on From File…**, and select the generated XPI.

## Current scope

- PDF reader toolbar entry
- Zotero 8 structured extraction with progress
- Zotero 7 plain-text fallback
- Headings, paragraphs, lists, tables, blockquotes, math, notes and page markers
- Rendered preview, Markdown source, and copy action
- Escaped PDF content and restricted link schemes

Scanned PDFs without a text layer currently require a separate OCR implementation. Figures are represented by their extracted labels or captions rather than exported image files.
