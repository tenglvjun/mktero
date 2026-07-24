# Mktero

Mktero is a Zotero 7/8/9 plugin that adds an **MD** button to PDF reader toolbars. It sends the opened PDF to MinerU, then displays the resulting Markdown in a Zotero tab with a safe rendered preview and source view.

Configure a MinerU API Token under **Settings → Mktero** before converting a PDF. The token is stored as a standard, unencrypted preference in the local Zotero profile. Clicking **MD** uploads the current PDF to MinerU for processing.

Successful MinerU results are cached locally by PDF content and parser profile. Opening an unchanged PDF again reuses its Markdown and figures without requiring a Token or another upload. Use **Reparse** in the Markdown tab to bypass the cached result, or disable and clear the cache under **Settings → Mktero**. Cache files are stored unencrypted in the current Zotero profile and are not synced.

## Development

Requirements:

- Node.js 20 or newer
- `zip`
- Zotero 7, 8, or 9 with a separate development profile

Install dependencies and verify the project:

```bash
npm install
npm test
npm run build
```

The installable package is written to `build/mktero-0.1.0.xpi`.

To load source builds during development, create an extension proxy file named `mktero@tenglvjun.github.io` in the Zotero profile's `extensions` directory. Its contents should be the absolute path to `build/package`. Run `npm run build` before starting Zotero.

Alternatively, open **Tools → Add-ons**, choose **Install Add-on From File…**, and select the generated XPI.

## Troubleshooting conversion

Open **Help → Debug Output Logging**, enable logging, trigger the **MD** action, and then choose **View Output**. Filter for `Mktero:`. The conversion log distinguishes these cases without recording the API Token, upload URL, or PDF content:

- `requesting a MinerU upload URL`: Mktero is creating the MinerU task.
- `uploading PDF to MinerU`: the PDF upload has started.
- `PDF upload completed; MinerU is parsing`: MinerU received the PDF successfully.
- `completed from local cache; MinerU upload skipped`: no API request was needed.
- `completed through MinerU API`: the result came back from MinerU.

## Current scope

- PDF reader toolbar entry
- MinerU VLM parsing with OCR, formula, and table recognition
- Local PDF upload through MinerU pre-signed URLs
- Parsing progress reported in the Markdown tab
- Zotero Tab with rendered preview, Markdown source, and copy action
- Escaped PDF content and restricted link schemes
- Local figure previews extracted from the MinerU result archive
- Local content-addressed cache with automatic expiry and manual clearing

The MinerU precision API currently limits each file to 200 MB and 200 pages. Mktero reads `full.md` and supported raster images from the MinerU result archive. Images are displayed for the current Tab but are not imported as Zotero attachments.
