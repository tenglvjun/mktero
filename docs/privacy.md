# Privacy and data handling

[English](./privacy.md) · [简体中文](./privacy.zh-CN.md) · [Back to README](../README.md)

| Data | Sent to or stored in | Zotero sync |
| --- | --- | --- |
| Complete PDF on a cache miss, with the default Mktero converter | The Mktero service for the signed-in account | Not by Mktero |
| Complete PDF on a cache miss, after you switch to your own converter | Selected MinerU cloud, the configured local MinerU service, or Mistral | Not by Mktero |
| MinerU cloud token, local MinerU address, Mistral API key, and AI credentials | Active Zotero profile, unencrypted | No |
| Email and password when signing in or registering, and the registration verification code | The Mktero service you select; the password and code are not saved | Not by Mktero |
| Mktero access token and refresh token | Active Zotero profile, unencrypted | No |
| Your account profile and conversion-activity counts, requested with the access token while the account pane is open | The Mktero service you select | Not by Mktero |
| Mktero extension version, sent with requests to the Mktero service and recorded when you sign in or refresh your token, so the operator can see which builds are still in use | The Mktero service you select; operations reporting only, never returned to the extension or shown in your profile | Not by Mktero |
| Research invitation email, the token link, the answers you submit, and the research-email opt-out | The Mktero service you select; the link token is not saved by the website | Not by Mktero |
| Cached Markdown, figures, figure metadata including OCR fragments, source maps, PDF indexes, corrections, translations, and reading positions | Active Zotero profile, unencrypted | No |
| Stored MinerU results (the result's Markdown, content list, layout JSON, and images; not the PDF copy), kept so a Mktero update can re-read a paper without converting it again | Active Zotero profile, unencrypted | No |
| Markdown availability index: library ID, item key, attachment key, cache key, parser profile, and expiry time | Active Zotero profile, unencrypted | No |
| Focused DOI/arXiv/OpenAlex identifiers and provider-specific candidate identifiers | Semantic Scholar, OpenCitations, or OpenAlex | Not by Mktero |
| Bounded citation text after the user chooses `Import reference` for a title-only reference | OpenAlex | Not by Mktero |
| A normalized DOI, arXiv ID, PMID, or OpenAlex work ID plus confirmed metadata after the user clicks the import action; optional open-access PDF request | The selected metadata/PDF provider | Not by Mktero |
| Anonymous models.dev catalog request on Zotero startup | models.dev, kept only in memory until Zotero quits | No |
| Protected Markdown translation batches | AI provider configured by you | Not by Mktero |
| Selected Markdown text for selection translation | AI provider configured by you | Not by Mktero |
| Zotero PDF annotations | Local Zotero library | According to Zotero settings |
| Saved snapshot Note and attachments, including optional figure metadata and OCR fragments | Zotero items and attachments | According to Zotero settings |
| Exported Markdown and figures | User-selected local path, including an Obsidian vault. Mktero does not sync that copy. | No |
| Obsidian export index: library ID, item key, note folder name, and content hash; the vault path preference | Active Zotero profile, unencrypted | No |
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

The version report carries only the extension's own build number. Mktero
collects no device fingerprint, no hardware, operating-system, or IP-derived
identifier, and runs no third-party analytics. The version is sent only to the
Mktero service: it is never attached to a request that goes to object storage,
to a MinerU or Mistral converter, or to an AI or citation provider you
configure. It is not part of your account profile, so no product screen
displays it back to you.

Research invitations are sent by the Mktero service, not by the extension.
The extension does not send or store survey answers. Turn invitations off on
the website account page, or with the link in an invitation sent after that
control was added. Turning them off does not affect verification codes,
password resets, or conversion, and does not delete answers already submitted.

With the default converter, a cache miss sends the complete PDF to the Mktero
service for your account. Review that service's data handling, and the privacy
policy of MinerU, Mistral, and any AI or citation provider you choose instead.
Do not process confidential PDFs unless those data-handling terms are suitable
for your use case.
