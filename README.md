# Mktero

**English** · [简体中文](./README.zh-CN.md)

[![Test](https://github.com/tenglvjun/mktero/actions/workflows/test.yml/badge.svg)](https://github.com/tenglvjun/mktero/actions/workflows/test.yml)
[![Latest release](https://img.shields.io/github/v/release/tenglvjun/mktero)](https://github.com/tenglvjun/mktero/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Zotero](https://img.shields.io/badge/Zotero-7%20%7C%208%20%7C%209%20%7C%2010-cc2936.svg)](https://www.zotero.org/)

**Read Zotero PDFs as source-linked Markdown.**

Mktero is a restartless extension for Zotero 7, 8, 9, and 10 that opens PDFs as
Markdown, formulas, tables, figures, citations, and annotations in a temporary
reading tab. A content-addressed local cache reuses results for the same PDF
and parser profile.

[Download](https://github.com/tenglvjun/mktero/releases/latest) ·
[Product page](https://mktero.com/) ·
[Documentation](#documentation) ·
[Community](#community) ·
[Support Mktero](#support-mktero)

> [!IMPORTANT]
> Mktero is in beta. Requesting an uncached conversion with the default converter
> sends the complete PDF to the Mktero service for your account. Sign in from
> `Settings -> Mktero`; no separate OCR key is required. If you choose
> [MinerU](https://mineru.net/) or [Mistral OCR 4.1](https://docs.mistral.ai/models/ocr-4-1),
> the PDF goes there instead and is not sent to Mktero. Optional AI translation
> sends protected Markdown batches to your configured provider. Read
> [Privacy and data handling](./docs/privacy.md) before processing sensitive documents.

![Mktero converting, reading, and annotating an academic PDF in Zotero](./docs/assets/mktero-demo.gif)

## Features

### Reading

- Read multi-column papers as continuous text with formulas, tables, lists, and code, with page chrome hidden. [Reading](./docs/reading.md)
- Navigate headings, figures, citations, and search results; jump between Markdown and its PDF source. [Navigation](./docs/reading.md#move-around-the-document)
- Copy formula LaTeX, code, or tables as Markdown or CSV from the reader. [Copy actions](./docs/reading.md#copy-a-formula-a-code-block-or-a-table)
- Restore figures from the local PDF in the background while you read. [Figure pipeline](./docs/figure-pipeline.md)

### Annotations and translation

- Display and edit PDF highlights and underlines, and write item or standalone notes with Zotero's native editor. [Annotations and notes](./docs/annotations.md)
- Correct paragraphs, headings, and GFM table cells while preserving the immutable OCR result. [Corrections](./docs/annotations.md#correct-recognition-errors)
- Translate an article or a selection through a Vercel AI SDK provider; read `Original`, `Translation`, or `Bilingual`. [AI translation](./docs/reading.md#translate-with-ai)

### Library and export

- Import supported local llm-for-zotero MinerU results without an account, API key, or another upload. [Import a result](./docs/conversion.md#import-a-local-llm-for-zotero-result)
- Check references across accessible Zotero libraries, copy existing items, or import missing metadata and an optional public PDF. [References](./docs/references-and-export.md#import-references-from-markdown)
- Explore direct reference relationships in your current library through Semantic Scholar, OpenCitations, and OpenAlex. [Citation graph](./docs/references-and-export.md#explore-the-citation-graph)
- Save a portable Zotero snapshot or export corrected Markdown and figures to a folder. [Save and export](./docs/references-and-export.md#save-a-portable-snapshot)
- Export the current reading view as EPUB with formulas rendered as images for reader compatibility, or batch-export original Markdown and complete saved translations to Obsidian. [EPUB](./docs/references-and-export.md#export-epub) · [Obsidian](./docs/references-and-export.md#export-to-obsidian)
- See cached Markdown availability and preparation progress in the item list's local Markdown column. [Availability](./docs/conversion.md#see-which-items-already-have-markdown)

## Quick start

1. Download the latest `mktero-<version>.xpi` from [GitHub Releases](https://github.com/tenglvjun/mktero/releases/latest) and install it in Zotero.
2. Open `Settings -> Mktero` and sign in, register, or choose your own converter.
3. Open a PDF and click the Mktero toolbar icon, or right-click it and choose `Read as Markdown with Mktero`.
4. Follow the conversion progress, then read with the outline, find, previews, and source links. A valid cache skips remote conversion.

For requirements, installation steps, and converter setup, see [Getting started](./docs/getting-started.md).

## Documentation

| Guide | What it covers |
| --- | --- |
| [Getting started](./docs/getting-started.md) | Requirements, installation, and your first PDF |
| [Reading](./docs/reading.md) | Navigation, source links, copying, layout, and translation |
| [Annotations, notes, and corrections](./docs/annotations.md) | PDF annotations, Zotero notes, and recognition fixes |
| [References and export](./docs/references-and-export.md) | Reference import, citation graphs, snapshots, and export |
| [Conversion and local cache](./docs/conversion.md) | Converters, quotas, batch preparation, imports, and cleanup |
| [Configuration](./docs/configuration.md) | Every setting and its default |
| [Privacy and data handling](./docs/privacy.md) | What is sent, where it is stored, and what syncs |
| [Limitations](./docs/limitations.md) | Supported PDFs, navigation, and resource limits |
| [Figure pipeline](./docs/figure-pipeline.md) | How figures are rebuilt from the local PDF |
| [Development](./docs/development.md) | Build, test, browser preview, and regression corpora |

The [workflow index](./docs/workflows.md) links to each task.

## Privacy

- An uncached conversion with the default converter sends the complete PDF to the
  Mktero service for your account.
- Choosing MinerU cloud, a local MinerU service, or Mistral sends the complete PDF
  there instead, and not to Mktero.
- Local llm-for-zotero imports leave the source cache unchanged and save a separate,
  unencrypted copy and import selection. Import and local reopening upload neither
  the PDF nor the result. If all local content is missing, a later ordinary open may
  upload the PDF; an explicit reparse may also upload it. Import failure, corruption,
  read errors, or cancellation do not trigger conversion.
- Credentials, cached Markdown and figures, raw MinerU results without the PDF,
  corrections, translations, reading positions, local highlights not yet in the
  PDF, and cross-page highlight annotation keys stay unencrypted in the Zotero
  profile. Mktero does not sync them.
- Sign-in sends your email and password; registration also emails a verification
  code. Tokens stay in the profile. The account pane reads your profile, conversion
  counts, and supported daily quota; the service keeps account-linked usage
  aggregates for operation and capacity planning. Pending local batches are not uploaded.
- Version reporting on sign-in, token refresh, and background heartbeat sends only
  the extension version to Mktero. It carries no device fingerprint or hardware,
  operating-system, or IP-derived identifier, runs no third-party analytics, stays
  off requests to your other providers, and is not part of your account profile.
- Reference, citation, and translation requests are bounded and local-first. Logs
  never contain API tokens, presigned URLs, PDF bytes, or authenticated responses.

Full details, including local import retention and the complete data tables, are in
[Privacy and data handling](./docs/privacy.md).

## Development

Use the Node.js version in [`.node-version`](./.node-version), currently
`24.15.0`. Node.js 25 is outside the supported dependency range.

```bash
npm ci
npm run check
npm test
npm run build
```

See [Development](./docs/development.md) for the browser preview and regression corpora.

## Community

Usage questions can go to the QQ group, WeChat, or
[Discord](https://discord.gg/uyxmxah2sh). Share ideas, reading workflows, and beta
feedback in [GitHub Discussions](https://github.com/tenglvjun/mktero/discussions).
Report reproducible bugs in [GitHub Issues](https://github.com/tenglvjun/mktero/issues).

Use `Help > Report a Mktero Problem…`, the `Report a problem` button on a failed
conversion, or `⋯ > Report a problem` in a Mktero tab to copy or save a redacted
diagnostic file on this computer. Nothing is uploaded; paste the file into an
issue or send it to the group. Keep API keys, credentials, private PDF contents,
and other sensitive data out of QQ, WeChat, Discord, issues, pull requests, and logs.

Pull requests are welcome. For runtime behavior changes, run the complete
verification commands above and include tests for the affected behavior.

QQ is a group: scan the code, or search `616518076` in QQ.

<table>
  <tr>
    <td align="center" width="220">
      <img src="./docs/assets/qq-group.png" width="180" alt="QR code for the Mktero QQ group, number 616518076"><br>
      <b>QQ</b>
    </td>
    <td align="center" width="220">
      <img src="./docs/assets/wechat.png" width="180" alt="WeChat QR code for the Mktero maintainer"><br>
      <b>WeChat</b>
    </td>
  </tr>
</table>

## Support Mktero

If Mktero makes reading papers easier for you, consider buying me a coffee.
Your support helps with ongoing development, maintenance, and hosting costs.

[![Support me on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/tenglvjun)

## License

[MIT](./LICENSE) © 2026 Tony
