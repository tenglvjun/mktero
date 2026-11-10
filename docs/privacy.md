# Privacy and data handling

[English](./privacy.md) · [简体中文](./privacy.zh-CN.md) · [Back to README](../README.md)

This page lists what Mktero sends, where it keeps data, and what local cleanup removes.

## At a glance

- A cache miss sends the complete PDF to your account's Mktero service, or to your selected MinerU or Mistral converter instead.
- Local llm-for-zotero imports leave the source unchanged. Import and reopening upload neither the PDF nor the result.
- Credentials, tokens, caches, corrections, translations, reading positions, and local highlights are unencrypted in the active Zotero profile. Mktero does not sync them.
- PDF annotations, Zotero notes, and snapshots sync according to Zotero settings. Mktero does not send notes anywhere.
- Reference, citation, and translation requests are bounded and local-first. Logs exclude API tokens, presigned URLs, PDF bytes, and authenticated responses.
- Problem reports stay on this computer. Copying or saving creates a redacted file; this version does not upload it.
- Version reporting and daily reading-activity totals go only to Mktero, without a device fingerprint. Mktero runs no third-party analytics.

## Data tables

The complete data inventory is grouped below by destination: [services](#sent-to-services), [the Zotero profile](#stored-in-your-zotero-profile), [the Zotero library](#kept-in-your-zotero-library), and [session memory or local exports](#session-memory-and-local-exports).

## Sent to services

| Data | Sent to or stored in | Zotero sync |
| --- | --- | --- |
| Complete PDF on a cache miss, with the default Mktero converter | The Mktero service for the signed-in account | Not by Mktero |
| Complete PDF on a cache miss, after you switch to your own converter | Selected MinerU cloud, the configured local MinerU service, or Mistral | Not by Mktero |
| Email and password when signing in or registering, and the registration verification code | The Mktero service you select; the password and code are not saved | Not by Mktero |
| Your account profile, conversion-activity counts and daily quota balance when supported, requested with the access token while the account pane is open; quota also refreshes after hosted requests settle or when you manually resume | The Mktero service you select | Not by Mktero |
| Account-linked hosted conversion admissions, successful documents, pages, result reuse and quota-block aggregates | The Mktero service; used for quota enforcement, service operation and capacity planning | Not by Mktero |
| Mktero extension version, sent with requests to the Mktero service and recorded when you sign in, refresh your token, or send a background heartbeat, so the operator can see which builds are still in use | The Mktero service you select; operations reporting only, never returned to the extension or shown in your profile | Not by Mktero |
| Daily reading-activity totals: reader tabs opened, distinct PDFs opened, of those scrolled and read to at least halfway, annotations created, exports completed, translations started, and the UTC day they belong to; no paper identifier, title, path, text, or per-action timestamp | The Mktero service you select; operations reporting only, never returned to the extension or shown in your profile | Not by Mktero |
| Research invitation email, the token link, the answers you submit, and the research-email opt-out | The Mktero service you select; the link token is not saved by the website | Not by Mktero |
| Focused DOI/arXiv/OpenAlex identifiers and provider-specific candidate identifiers | Semantic Scholar, OpenCitations, or OpenAlex | Not by Mktero |
| Bounded citation text after the user chooses `Import reference` for a title-only reference | OpenAlex | Not by Mktero |
| A normalized DOI, arXiv ID, PMID, or OpenAlex work ID plus confirmed metadata after the user clicks the import action; optional open-access PDF request | The selected metadata/PDF provider | Not by Mktero |
| Anonymous models.dev catalog request on Zotero startup | models.dev, kept only in memory until Zotero quits | No |
| Protected Markdown translation batches | AI provider configured by you | Not by Mktero |
| Selected Markdown text for selection translation | AI provider configured by you | Not by Mktero |

## Stored in your Zotero profile

| Data | Sent to or stored in | Zotero sync |
| --- | --- | --- |
| MinerU cloud token, local MinerU address, Mistral API key, and AI credentials | Active Zotero profile, unencrypted | No |
| Mktero access token and refresh token | Active Zotero profile, unencrypted | No |
| Cached Markdown, figures, figure metadata including OCR fragments, source maps, PDF indexes, corrections, translations, and reading positions | Active Zotero profile, unencrypted; see [local retention](#local-retention) | No |
| Stored MinerU results from Mktero, MinerU cloud, or a local MinerU service (the result's Markdown, content list, layout or middle JSON, and images; not the PDF copy), kept so a Mktero update can re-read a paper without converting it again | Active Zotero profile, unencrypted; see [local retention](#local-retention) | No |
| Explicitly imported llm-for-zotero results: text, structure, original or supported cropped figures, and locally restored figures; no PDF copy | A separate copy in the active Zotero profile, unencrypted | No |
| Import selection index: library ID, attachment key, PDF and imported-result hashes, cache keys, adapter version, import time, source-format category, and confirmation state; no source paths | Active Zotero profile, unencrypted, in `mktero-imports/v1` | No |
| Markdown availability index: library ID, item key, attachment key, cache key, parser profile, and a non-expiring readiness marker | Active Zotero profile, unencrypted | No |
| Cache ownership index: library ID, local attachment ID/key, PDF hash and byte length, resource keys, first-confirmed-absence time and whether attachment-private resources were cleaned; no titles, paths, PDF bytes or OCR text | Active Zotero profile, unencrypted, in `mktero-cache-owners/v1`; not sent to any service | No |
| Local Markdown highlights not yet in the PDF, and the Zotero annotation keys of the page parts of a cross-page highlight | Active Zotero profile, unencrypted | No |
| Reader layout preferences: which columns are open, their widths, and the selected left segment | Active Zotero profile, unencrypted | No |
| Obsidian export index: library ID, item key, note folder name, and content hash; the vault path preference | Active Zotero profile, unencrypted | No |

## Kept in your Zotero library

| Data | Sent to or stored in | Zotero sync |
| --- | --- | --- |
| Zotero PDF annotations | Local Zotero library | According to Zotero settings |
| Zotero notes written in the Notes column, and passages added with `Add to Note` or `Add Note from Annotations` | Zotero note items in the local Zotero library | According to Zotero settings |
| Saved snapshot Note and attachments, including optional figure metadata and OCR fragments | Zotero items and attachments | According to Zotero settings |
| Imported reference metadata and PDF attachments | Active Zotero profile, unencrypted | According to Zotero settings |

## Session memory and local exports

| Data | Sent to or stored in | Zotero sync |
| --- | --- | --- |
| Pending/blocked preparation list and account/provider scope | Memory only in the current Zotero session; the pending list is not uploaded or restored after restart | No |
| Session diagnostic log: recent Mktero errors and stages, conversion job ids, and the versions collected by `Report a problem` | Memory only until Zotero quits. A redacted file only if you copy or save it. Nothing is uploaded | No |
| Exported Markdown and figures | User-selected local path, including an Obsidian vault. Mktero does not sync that copy | No |

## Account requests and service records

Signing in for the default conversion sends the email and password only at sign-in. Registration also emails a verification code.

The account card shows your profile and conversion-activity counters. Its requests and the service's account-linked usage records are listed in the [service data table](#sent-to-services); pending local batch lists are not uploaded.

## References and translation

Mktero does not send PDF annotations, local PDF.js indexes, Zotero notes, complete item records, local paths, or cached Markdown to reference/PDF providers. Mktero does not send notes anywhere.

Reference import requests are local-first:

- A title-only metadata lookup sends only bounded citation text, after the explicit `Import reference` action.
- A unique high-confidence match continues automatically; uncertain matches require candidate confirmation.
- Citation and reference requests use anonymous provider access. They contain only the bounded citation text, normalized identifiers, and confirmed metadata listed above, never Zotero keys or PDF bytes.

Translation requests contain protected Markdown and instructions. If placeholder validation repeatedly fails, the final retry contains only the affected block's ordinary text segments. Selection translation requests contain only the selected text and are not written to the full-document translation cache.

## Diagnostics and logs

`Report a problem` keeps its diagnostic log in session memory, not in the profile. Open it from:

- Help > Report a Mktero Problem.
- The `Report a problem` button on a failed conversion.
- The document actions menu of a Mktero tab.

`Copy` and `Save` create a redacted package on this computer only; this version does not upload it. `Open GitHub issue` opens the empty issue form in your browser and sends nothing from the report.

The package can include:

- Extension version, Zotero version, and operating system.
- Conversion provider, parser profile label, and the paper's item key.
- The error code of its last failed conversion and conversion job ids.
- Your description and redacted log lines.

It never includes API keys, account tokens, your account email, PDF bytes, or file paths. API tokens, presigned URLs, PDF bytes, and authenticated responses are never written to logs. The log is discarded when Zotero quits.

## Version reporting

The version report carries only the extension's own build number. It goes to the Mktero service on sign-in, token refresh, and background heartbeat, so the operator can see which builds are still in use.

It collects no device fingerprint, hardware, operating-system, or IP-derived identifier. Mktero runs no third-party analytics. The version is never attached to requests to object storage, MinerU or Mistral converters, or an AI or citation provider you configure.

The version is not part of your account profile, so no product screen displays it back to you.

## Reading activity

Mktero also reports daily reading-activity totals to the same service, so the operator can tell whether a conversion was actually read or whether the reader opened it once and stopped.

**This report is sent only while the hosted Mktero converter is the selected conversion service.** Switch to your own MinerU cloud, a self-hosted MinerU service, or Mistral, and the counters stop immediately and nothing more is sent, even though you stay signed in. Switching back resumes them. Counts collected before you switched are still flushed once when Zotero quits, because they describe reading that happened while the hosted converter was selected.

One report carries seven numbers and one UTC day:

- How many Markdown reader tabs were opened.
- How many different PDFs were opened in the reader.
- How many of those were scrolled at least once.
- How many were read to at least half of the document.
- How many annotations were created.
- How many exports completed.
- How many full-document translations were started.

The report is sent at most every two minutes, and only when at least one of those numbers changed since the last send. An idle session sends nothing: closing Zotero does not trigger a final report, so up to two minutes of unsent totals can be lost when Zotero quits unexpectedly. There is no separate switch: choosing your own converter is the switch, and it works immediately without signing out.

It contains no paper identifier, title, author, file path, file name, hash, selected text, annotation text, translated text, or timestamp per action. The report does not say which paper was read, only how many reading actions happened that day. It is never attached to requests to object storage, MinerU or Mistral converters, or an AI or citation provider you configure, and it is not shown on your account page or in any product screen.

The days a reader was active and the reading totals stay in the Mktero service as account-linked aggregates for operations and capacity planning. The extension keeps the unsent totals in memory only: nothing about them is written to your Zotero profile, and a crash loses whatever had not been sent yet.

## Research invitations

The Mktero service sends research invitations; the extension does not send or store survey answers.

Turn invitations off on the website account page, or with the link in an invitation sent after that control was added. Turning them off does not affect verification codes, password resets, or conversion, and does not delete answers already submitted.

## Details

### Local retention

Markdown and raw MinerU results are not evicted by count, total size or inactivity. Once a registered PDF attachment is confirmed permanently absent and its cache has no remaining references, background local checks can remove its orphaned results, matching corrections, PDF index, reading position, local highlights, highlight groups, import selections and availability markers. There is no extra retention period.

Checks run:

- About 5 seconds after combined permanent deletion notifications.
- About 60 seconds after startup.
- Hourly while Zotero is running.

Trash and other attachments with identical PDF bytes protect shared data. Only use of the affected attachment or cache defers its cleanup; unrelated reading does not block it. Checks read only local files and never download or upload PDFs.

When ownership or sharing cannot be confirmed:

- Uncertain ownership, shared references and incomplete scans retain the affected data; failures are retried.
- A missing file does not stop enumeration. A completely missing PDF cannot be shown to share anything, so its rebuildable caches (Markdown, raw conversion results and the PDF text index) are released, while corrections and reading positions are kept.
- A file that exists but cannot be verified still protects possible shared references.

The settings pane shows cleanup reasons, released rebuildable caches, missing local PDFs, at most ten blocking attachment keys and library IDs, and the next check. This status stays in session memory and is not sent anywhere. It contains no PDF content, file paths or content hashes. Automatic retry and `Check again` use the same local-only safety checks.

Already recorded permanent deletions follow the same policy. Previously unregistered data is adopted only when its PDF is read again and its cache identity can be established; other historical data is retained. PDF index, citation and legacy translation caches keep their existing expiry/size rules. See [Local cache cleanup](./conversion.md#local-cache-cleanup).

### Local llm-for-zotero imports

Importing a supported local result reads the source cache and current PDF on this computer without changing the source cache. Import and reopening the saved copy work offline without an account or converter key, and upload neither the PDF nor the result.

Mktero saves an independent copy of the adapted result and figures, without the PDF copy, full source metadata, or upstream absolute paths. The import-selection index records which snapshot the attachment uses and contains no source paths. Mktero does not sync these copies.

The copies are subject to orphan cleanup, manual clearing, self-healing of invalid entries, and availability of the profile filesystem. Individual archive, document, image, and parsing resource limits still apply.

- Deleting only the llm-for-zotero source cache does not affect offline reading from Mktero's copy.
- Saved corrections and prepared reading documents are used first; a retained raw result can rebuild the document offline.
- If all local content for the selected import is missing, a later ordinary `Read as Markdown with Mktero` uses the current converter and may send the complete PDF there.
- Import failure, corrupt content, read errors, or cancellation do not trigger conversion. The import action itself stays local.
- Explicitly choosing to reparse also uses the current converter and may send the PDF there.
- Optional translation and reference actions keep their separate data flows described above.

### Before sending a PDF

An uncached conversion with the default converter sends the complete PDF to the Mktero service for your account. Review that service's data handling and the privacy policies of MinerU, Mistral, and any AI or citation provider you choose instead. Do not process confidential PDFs unless those terms are suitable for your use case.
