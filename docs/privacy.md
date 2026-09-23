# Privacy and data handling

[English](./privacy.md) · [简体中文](./privacy.zh-CN.md) · [Back to README](../README.md)

| Data | Sent to or stored in | Zotero sync |
| --- | --- | --- |
| Complete PDF on a cache miss | Selected MinerU cloud, the configured local MinerU service, or Mistral | Not by Mktero |
| MinerU cloud token, local MinerU address, Mistral API key, and AI credentials | Active Zotero profile, unencrypted | No |
| Cached Markdown, figures, figure metadata including OCR fragments, source maps, PDF indexes, corrections, translations, and reading positions | Active Zotero profile, unencrypted | No |
| Markdown availability index: library ID, item key, attachment key, cache key, parser profile, and expiry time | Active Zotero profile, unencrypted | No |
| Focused DOI/arXiv/OpenAlex identifiers and provider-specific candidate identifiers | Semantic Scholar, OpenCitations, or OpenAlex | Not by Mktero |
| Bounded citation text after the user chooses `Import reference` for a title-only reference | OpenAlex | Not by Mktero |
| A normalized DOI, arXiv ID, PMID, or OpenAlex work ID plus confirmed metadata after the user clicks the import action; optional open-access PDF request | The selected metadata/PDF provider | Not by Mktero |
| Anonymous models.dev catalog request on Zotero startup | models.dev, kept only in memory until Zotero quits | No |
| Protected Markdown translation batches | AI provider configured by you | Not by Mktero |
| Selected Markdown text for selection translation | AI provider configured by you | Not by Mktero |
| Zotero PDF annotations | Local Zotero library | According to Zotero settings |
| Saved snapshot Note and attachments, including optional figure metadata and OCR fragments | Zotero items and attachments | According to Zotero settings |
| Exported Markdown and figures | User-selected local path | No |
| Imported reference metadata and PDF attachments | Active Zotero profile, unencrypted | According to Zotero settings |

Mktero does not send PDF annotations, local PDF.js indexes, Zotero notes,
complete item records, local paths, or cached Markdown to reference/PDF
providers. Reference import requests are local-first. A title-only metadata
lookup sends only bounded citation text after the explicit import action. A
unique high-confidence match continues automatically; uncertain matches require
candidate confirmation. Citation and reference requests use anonymous provider access and
contain only the bounded citation text, normalized identifiers, and confirmed
metadata described above, never Zotero keys or PDF bytes.
Translation requests contain protected Markdown and instructions; if
placeholder validation repeatedly fails, the final retry contains only the
affected block's ordinary text segments. API Tokens, presigned URLs, PDF bytes,
and authenticated responses are not written to logs. Selection translation
requests contain only the selected text; they
are not written to the full-document translation cache.

Review the privacy policy of MinerU and any AI or citation provider Mktero uses.
Do not process confidential PDFs unless their data-handling terms are suitable
for your use case.
