# Getting started

[English](./getting-started.md) · [简体中文](./getting-started.zh-CN.md) · [Back to README](../README.md)

Install Mktero, choose where a new conversion sends your PDF, and open your first
paper. Read [Privacy and data handling](./privacy.md) before processing sensitive documents.

## Requirements

- **Zotero:** desktop `7.0` through `10.0.*`.
- **PDF:** a downloaded attachment available as a local file.
- **Account:** a Mktero account for the default hosted conversion. It does not
  require a MinerU or Mistral key.
- **Network:** access to Mktero or your selected converter for a new conversion.

Supported local llm-for-zotero results can be imported and their saved copies
reopened offline without an account or converter key, with local caching enabled.
See [Import a local result](./conversion.md#import-a-local-llm-for-zotero-result).

The interface follows Zotero's English or Simplified Chinese display language.
Other locales fall back to English.

## Install

1. Download the latest `mktero-<version>.xpi` from
   [GitHub Releases](https://github.com/tenglvjun/mktero/releases/latest).
2. In Zotero, open `Tools -> Plugins`.
3. Open the gear menu and choose `Install Add-on From File...`.
4. Select the XPI and follow Zotero's prompts.

Formal GitHub releases receive automatic updates through Zotero. Drafts and
prereleases are not offered as automatic updates.

## Sign in or choose a converter

1. Open `Settings -> Mktero` and select the `Conversion` tab.
2. Keep the default `Mktero` service, then sign in or register. A new conversion
   without a usable cache sends the complete PDF to the Mktero service for your
   account; no separate OCR key is required.
3. To use your own converter, choose [MinerU](https://mineru.net/) or
   [Mistral OCR 4.1](https://docs.mistral.ai/models/ocr-4-1). The complete PDF then
   goes to that service instead, and is not sent to Mktero.

MinerU cloud and [Mistral](https://console.mistral.ai/api-keys/) need your own API
key. You can also choose a self-hosted MinerU 4.0 service, whose key is optional.
See [Choose a converter](./conversion.md#choose-a-converter) for the alternatives
and [Configuration](./configuration.md) for MinerU authentication help.

AI features and reading options are optional. AI translation uses your own
provider key; each provider keeps its own model, key, and related settings.
Credentials are ordinary, unencrypted preferences in the active Zotero profile.
All settings are listed in [Configuration](./configuration.md).

The selected converter controls file-size, page-count, quota, and availability
limits. Check [Page and size limits](./conversion.md#page-and-size-limits) and
[Hosted daily quota](./conversion.md#hosted-daily-quota) before a new conversion.

## Read your first PDF

1. Open a PDF in Zotero and click the Mktero file icon in the reader toolbar.
   Alternatively, right-click a PDF attachment or its parent library item and
   choose `Read as Markdown with Mktero`.
2. Follow upload, conversion, and download progress in the temporary Mktero tab.
   A valid cache skips remote conversion.
3. Read with the outline, `Cmd/Ctrl+F`, citation and figure/table previews,
   source links, the `Annotations` segment, and the Notes column.

Mktero tabs are session-only. For closing tabs, cancellation, restoring your
reading position, and forced reparsing, see
[Tabs, cancellation, and reparsing](./conversion.md#tabs-cancellation-and-reparsing).

## Next steps

| Task | Guide |
| --- | --- |
| Prepare a selection or a collection without opening a tab for every PDF | [Prepare several PDFs](./conversion.md#prepare-several-pdfs) |
| Import a supported result already parsed by llm-for-zotero | [Import a local result](./conversion.md#import-a-local-llm-for-zotero-result) |
| Check which items have readable Markdown | [Markdown availability](./conversion.md#see-which-items-already-have-markdown) |
| Navigate, change the reading view, or translate | [Reading](./reading.md) |
| Highlight, write Zotero notes, or correct recognition errors | [Annotations, notes, and corrections](./annotations.md) |
| Import a reference, save a snapshot, or export to a folder or Obsidian | [References and export](./references-and-export.md) |
| Understand what cleanup retains or removes | [Local cache cleanup](./conversion.md#local-cache-cleanup) |
