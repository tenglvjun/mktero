# Conversion and local cache

[English](./conversion.md) · [简体中文](./conversion.zh-CN.md) · [Back to README](../README.md)

Choose where a new PDF conversion runs, prepare papers in advance, or import a local result. This page also explains how Mktero retains and cleans its local copies.

## Choose a converter

Open `Settings -> Mktero` to choose the conversion service. A usable local cache skips remote conversion; a new conversion needs network access to the selected service.

| Converter | Where the complete PDF goes on a cache miss | What you need |
| --- | --- | --- |
| Mktero, the default | The hosted Mktero service for your account | A Mktero account; no MinerU or Mistral key |
| MinerU cloud | MinerU cloud | Your MinerU API key |
| Self-hosted MinerU 4.0 | Your configured local MinerU service | A service address; a local API key is optional |
| Mistral OCR 4.1 | Mistral | Your Mistral API key |

Choosing MinerU or Mistral sends the PDF to that service instead of Mktero. [Importing a supported local llm-for-zotero result](#import-a-local-llm-for-zotero-result) and reopening its saved copy work offline without an account or converter key, with local caching enabled.

See [Configuration](./configuration.md) for settings and [Privacy and data handling](./privacy.md) for sending, storage, and sync rules.

## Hosted parser models

The operator can select MinerU-VLM or MinerU Pipeline independently for each MinerU account managed by the hosted service. This is a server-side decision: the extension has no hosted model setting, and the direct MinerU cloud preference below does not reach it. A PDF follows a stable parser route; newly created jobs use the route's current model, while existing jobs retain their saved model.

Before using a hosted cache, Mktero looks up the applicable parser profile with only the PDF SHA-256, byte size, and content type. The lookup uploads no PDF and uses no conversion allowance. If the model changes, the next open looks for a result with that model. It may need conversion and another PDF upload; new results follow normal quota accounting. Switching back can reuse a retained result for the previous model.

Retained content can be read offline, but offline reading cannot verify the current hosted model. Authentication failures and invalid or inconsistent target metadata are reported. Explicit local imports keep working offline without this hosted lookup.

Corrections belong to the parser identity that produced the reading. A hosted `Pipeline` reading never opens a revision saved for `VLM`, and a route that switches back to `VLM` still finds the `VLM` corrections, including ones recorded under an older `VLM` parser profile.

## MinerU cloud parsing model

With your own MinerU cloud key, `Settings -> Mktero` also offers `Parsing model`: `VLM` (the default) or `Pipeline`. It applies to direct MinerU cloud operations only. The hosted Mktero service chooses its model on the server, and a self-hosted MinerU service keeps its own fixed request, so neither follows this setting.

Each operation fixes the MinerU cloud model when it starts: before the local-import check and before Mktero loads the PDF. Changing `Parsing model` afterwards therefore applies to later operations only. If the same item already has an active run, opening it again joins that run, so a new setting neither moves nor cancels work already in progress. An accepted task keeps the model it was sent with: it is never polled or resumed as the other model, and becomes resumable again when you switch back. Opening the same PDF under the other model starts a separate task for that model. A pending task recorded before this choice existed is a `VLM` task, and a stored preference value this build does not recognize also reads as `VLM`.

The two models keep separate local caches and separate pending task records. Switching the setting therefore neither overwrites nor deletes the other model's retained result or unfinished task: switching back can reuse a matching retained result, and can still resume a task that is still valid for that model. If a pending task belongs to the other model, Mktero reports the mismatch instead of resuming it under the wrong model or discarding it.

The Markdown cache identity is the parser profile, so a direct MinerU cloud conversion reuses the local Markdown entry that the same model already produced through the hosted Mktero service, and the other way round. The retained raw MinerU results stay separate for the two paths; only the readable Markdown and its figures are shared.

This choice does not carry a reading across models. A result parsed by one model is not presented as the other model's result, and a `Pipeline` reading does not pick up corrections saved on a `VLM` reading. Switching back to `VLM` still finds those earlier `VLM` corrections, including ones saved under an older `VLM` parser profile. Figures belong to the result they were restored for: a matching cached result keeps them, a result that still needs them is restored from the local PDF for whichever model is open, and they are never carried across models as a correction.

## Page and size limits

The selected converter controls file-size, page-count, quota, and service-availability limits. Check the current [MinerU API documentation](https://mineru.net/apiManage/docs) or [Mistral OCR documentation](https://docs.mistral.ai/studio/document-processing/basic_ocr) when using those services.

Mktero hosted conversion and MinerU cloud accept at most **200 pages per PDF**. Mktero counts pages locally before sending and stops with a message if the PDF exceeds that limit. It does not perform this page-count check for local MinerU or Mistral.

## Hosted daily quota

When enabled by the service, a UTC daily document quota applies to new hosted results. The account pane in `Settings -> Mktero` reads the limit from the service and shows used, in-progress (reserved), and available slots, plus the full reset date and time in your local time zone.

If quota blocks a request, the preparation window keeps that item and pending items while already submitted jobs continue. Choose an action:

- `Check quota and continue` queries the quota, rechecks local readiness, and explicitly resumes pending work. It is available even at zero balance: a document this account already converted can be admitted without new quota; a new document is refused again and pauses the account.
- `Cancel remaining` discards pending items without aborting in-flight jobs.

New items for the paused account wait until you explicitly resume. The list lasts only for this Zotero session; it does not restart at midnight. Switching accounts does not transfer it: select the PDF again to submit it with another account or your own converter.

Local cached reading, corrections, export, your own converters, and AI translation are unaffected. See [quota accounting](#quota-accounting) for reservations, refunds, and reuse.

## Prepare several PDFs

1. Select several library items or PDF attachments, then choose `Prepare selected Markdown`. For a collection, right-click it and choose `Prepare collection tree Markdown`.
2. A collection includes all descendants. Confirm the number of unique PDFs in the collection tree before preparation starts.
3. Follow each item's progress in Zotero's progress window. Minimizing keeps the queue running; `Cancel` stops items that have not finished.

These actions queue PDFs without opening a reader tab for each one. Cached or already preparing PDFs are skipped, including a readable imported result for that specific attachment. An import for one PDF does not make its parent's other PDFs ready, and an import selection without readable content is not skipped as ready.

Opening a queued PDF joins its existing preparation instead of uploading it again. Each uncached PDF in a batch is sent the same way as a single conversion. For export of already prepared papers, see [batch export to Obsidian](./references-and-export.md#batch-export).

## Tabs, cancellation, and reparsing

For one paper, open its PDF and click the Mktero file icon in Zotero's reader toolbar, or choose `Read as Markdown with Mktero` from the PDF or library item's context menu. The temporary tab shows upload, conversion, and download progress; a valid cache skips remote conversion.

- Mktero tabs are session-only and do not return after Zotero restarts. Reopening the same PDF and conversion profile restores the last reading paragraph.
- Closing a tab leaves its active conversion running in the background preparation window. Shutting down the extension cancels active conversion and translation requests.
- `Reparse PDF` is in the reader's `⋯` menu. It uses the current converter and may upload the PDF; for a selected imported result, only a successful reparse replaces that attachment's import selection.

Identical PDF bytes with the same parser profile share an in-progress hosted conversion within one running Mktero instance and account session, even with local caching off. Each attachment keeps its own reading state, title, annotations, corrections, and figure processing. See [shared conversion and cancellation](#shared-conversion-and-cancellation) for cancellation and forced-reparse rules.

## Import a local llm-for-zotero result

1. Make the PDF available locally, finish parsing it in llm-for-zotero, and enable Mktero's local cache. If you only have a synced result ZIP, restore it locally with llm-for-zotero first; Mktero does not import that ZIP directly.
2. Right-click one PDF attachment or its parent item in the Zotero library. When a local candidate is found, choose `Import parsed result from llm-for-zotero…`. If the parent has several candidate PDFs, choose the intended attachment from the submenu.
3. Clicking the action starts the import: Mktero validates the result, saves its own copy, and opens that PDF in the normal reader tab. The menu check only finds candidates; full validation happens after the click.

The import works offline without an account or API key. It uploads neither the PDF nor the result and does not modify the source cache. Cancellation or failure keeps the previous import selection; failure, corrupt content, read errors, and cancellation do not trigger conversion.

Repeat the import to replace it with a new result. Use the chosen PDF's own reading action to reopen it: importing another attachment does not change the parent's `Read as Markdown with Mktero` action, which still opens its first PDF.

See [supported input and retained copies](#supported-input-and-retained-copies) for formats, offline rebuilding, and when a later reading action may upload the PDF.

## See which items already have Markdown

The library item list has a Markdown column:

| Indicator | Meaning |
| --- | --- |
| Ready mark | This computer can open readable cached Markdown for the current conversion settings or that PDF's selected imported result. For hosted conversion it reports a retained result only; the model the server currently assigns is known once the PDF is opened |
| Spinner | The PDF is queued or converting in this session; the spinner is not stored |

The ready marker stays in the Zotero profile, does not change the Zotero item, and does not sync. Clearing the cache turns it off. Changing provider, MinerU service, or the MinerU cloud parsing model changes which converted cache is ready. For hosted conversion the marker only says a retained result exists; it does not follow the server's current model, which a real open resolves. A selected imported result keeps its own identity, but its selection record alone is not a ready mark.

Hide the column with the item-list column picker if you prefer; Zotero remembers the choice.

## Local cache cleanup

Mktero does not automatically evict Markdown or raw MinerU results by entry count, total size, or inactivity. Moving an item or PDF attachment to Zotero trash, or removing it from a collection, does not delete its Mktero data.

After background checks confirm that a registered PDF attachment is permanently absent and its cache has no remaining references, cleanup can remove its data with no extra retention period. Restoring the attachment before cleanup protects it. Shared PDFs remain protected, including attachments in other libraries or trash that were never opened in Mktero.

Open `Settings -> Mktero -> Automatic cleanup` to see retained-cache counts, released rebuildable cache sets, missing local PDFs, the reason, up to ten blocking attachment keys with library IDs, and the next check. Cache usage refreshes after a completed check. `Check again` runs the same safety checks; it does not bypass protection or clear the whole cache.

Manual `Clear cache` remains available in Mktero settings. Manual clearing, self-healing of damaged entries, or profile filesystem loss or unavailability can remove cached data; individual archive, document, image, and parsing resource limits still apply. See [cleanup scope](#cleanup-scope), [checks and retries](#checks-and-retries), and [missing or uncertain PDFs](#missing-or-uncertain-pdfs) for the full rules.

## Details

### Quota accounting

- A request reserves a slot. Success consumes it; only a server-confirmed final failure or cancellation releases it. A client timeout or closed tab does not refund a job still running on the server.
- A job that completes after midnight belongs to the UTC day it was admitted.
- Reusing an existing authorized result does not consume another slot. A first shared result for another account counts for that account. This does not guarantee unlimited future regeneration of expired results.
- Observation mode shows usage without claiming a limit is enforced. Older servers without the quota endpoint keep working.

### Shared conversion and cancellation

- Cancelling one participant leaves the others running. Only the last participant leaving attempts to cancel the hosted job; the server may refuse once processing has started.
- A forced reparse joins an active acquisition, including its archive save. Once that result is ready, a new forced reparse starts a new acquisition. A replacement reserved while work was active can still take the result after completion.
- Signing out, signing in again, or changing provider or API address separates subsequent hosted work. Automatic token refresh keeps the current account session.
- Sharing does not survive a restart or coordinate separate Zotero processes or devices.

### Supported input and retained copies

A supported local result needs `full.md` and either a standard content list with valid page numbers and bounding boxes or a supported layout. Required figures must be available as original images, supported llm-for-zotero crops, or regions Mktero can safely recover from the local PDF. Removing original images after llm-for-zotero makes its crops does not by itself invalidate the cache.

Plain Markdown, older loose Markdown files, and local MinerU V1 content lists without bounding boxes are unsupported. The menu may find such a candidate; the import then explains why it cannot be used.

After import, reading uses Mktero's independent copy. Deleting only the llm-for-zotero source still allows offline reading. Retention follows [local cache cleanup](#local-cache-cleanup), including its manual-clearing, damaged-entry, filesystem, and resource-limit rules.

Mktero first uses saved corrections or a prepared reading document. If only the retained raw result remains, it rebuilds the document offline. If **all** local content for the selected import is missing, a later ordinary `Read as Markdown with Mktero` uses the current converter and may upload the PDF; the import action itself always stays local.

A newly imported snapshot has separate correction, translation, and reading-position identities. Explicitly reparsing follows the [current-converter rule](#tabs-cancellation-and-reparsing); it does not silently replace an imported selection on failure.

### Cleanup scope

| Background cleanup can remove registered orphaned data | Background cleanup does not delete |
| --- | --- |
| Markdown, figures, translations, raw MinerU results, matching saved corrections, PDF text indexes, and reading positions | Zotero PDF files, notes, annotations, and saved snapshots |
| The deleted attachment's local highlights, highlight-group records, import selections, and readiness markers | Exported files and llm-for-zotero source caches |

Ownership is registered when Mktero next reads or imports a PDF. Recognizable older parser variants are adopted then; historical data whose ownership cannot be established stays on disk. Already recorded permanent deletions follow the same cleanup policy, and startup checks reconcile missed notifications.

Citation caches and the legacy separate translation cache keep their existing expiry and size rules.

### Checks and retries

- Permanent deletion notifications are combined for about **5 seconds** before a background check. Checks also run about **60 seconds** after startup and **hourly** while Zotero runs.
- Only use of the affected attachment or cache, such as reading, conversion, or pending writes, defers its cleanup. Reading an unrelated paper does not block it. Mktero checks again when that use ends without waiting for the next hourly check.
- Matching file sizes are checked locally before hashing; no attachment is downloaded or uploaded.
- Uncertain ownership or shared references, inaccessible libraries, damaged ownership records, and incomplete scans retain the affected data. Scan resource limits can also postpone cleanup.
- Failed deletions are retried; the notification delay does not promise that files disappear within 5 seconds. Uncertain checks and failed operations retry after about **1, 5, 15, and then 60 minutes**, subject to an earlier startup or hourly check. Relevant Zotero file or item notifications bring the retry forward.

### Missing or uncertain PDFs

A missing or unreadable PDF does not stop enumeration of the remaining attachments. Checks track uncertainty per candidate: a readable, rechecked file size can rule out different-size candidates even when the file's bytes cannot be read. Historical ownership hashes and Zotero's last-synced MD5 are never used to assume different content; known shared sources remain protected, including trash and other libraries.

A completely missing PDF is handled in two stages so that one absent file cannot pin unrelated caches forever:

1. Markdown, raw conversion results, and PDF text indexes can be rebuilt by converting again. They are released once no readable PDF still shares them.
2. Corrections and reading positions cannot be rebuilt. They stay while the attachment record itself exists.

A file that exists but cannot be verified, a PDF that changes during the check, or an incomplete library scan retains everything. Restoring a missing local PDF lets the next check establish whether it shares the cached content.
