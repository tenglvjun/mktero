# Configuration

[English](./configuration.md) · [简体中文](./configuration.zh-CN.md) · [Back to README](../README.md)

Open `Settings -> Mktero` after installation. This page covers every setting and the connection and storage rules behind it.

## Account and conversion

| Setting | Required | Purpose |
| --- | --- | --- |
| Account | For the default hosted conversion | Sign in or register a Mktero account for hosted PDF conversion. The pane shows your account details and conversion counters; see [account details](#account-and-conversion-1) |
| Hosted daily quota | Informational, when supported by the service | Shows the server limit, used, reserved and available slots, and the reset date/time in your local time zone. Refreshes on opening, after hosted requests settle, or through Refresh. UTC daily accounting applies only when enabled by the service; observation mode does not block requests |
| Conversion service | Optional, Mktero by default | The Conversion tab lists Mktero, MinerU, and Mistral. Mktero uses account sign-in and hosted conversion; MinerU and Mistral use your credentials. AI translation always uses your own provider key |
| Conversion provider | When using your own API | Select MinerU or Mistral OCR 4.1 |
| MinerU service | MinerU only | Choose MinerU cloud or a self-hosted MinerU 4.0 V1 service |
| Parsing model | MinerU cloud only | Choose `VLM` (default) or `Pipeline` for direct MinerU cloud operations; each operation fixes it when it starts. The hosted Mktero service chooses its own model, and a self-hosted MinerU service is unaffected |
| Local service address | Local MinerU only | Service origin, default `http://127.0.0.1:8000`. HTTP is limited to loopback and private-network addresses |
| API key | For a cloud cache miss | Enter the MinerU cloud or Mistral key. The field is hidden for a local MinerU service |

## AI translation

| Setting | Required | Purpose |
| --- | --- | --- |
| AI features and provider settings | Optional | Configure streaming, provider, model, key, reasoning, and timeout separately for each provider; see [provider profiles](#ai-translation-1) |
| Translation language | Optional | Choose Simplified/Traditional Chinese, Japanese, Korean, Spanish, French, or Brazilian Portuguese |
| Automatically translate Markdown selections | Optional, off by default | Translate a stable selection without another click. Turning it off keeps the manual popup action |

Use the lightning icon (`Test connection`) next to the AI provider to validate an endpoint before translating.

## Reading

| Setting | Required | Purpose |
| --- | --- | --- |
| Body text font and size | Optional | Choose the reading font and a 14–28 px body size |
| Line height, column width, and alignment | Optional | Choose tight/standard/loose spacing, a narrow/standard/wide measure, and left-aligned or justified text. Left aligned is the default. The column follows the window width, up to 45rem (narrow), 80rem (standard), or 120rem (wide). Text, figures, tables, and code share that width |
| PDF source thumbnail | Optional, on by default | Show a live PDF crop of the current paragraph. The same switch is in the reader's `Typography` panel |

For controls inside the reader, see [Adjust the reading view](./reading.md#adjust-the-reading-view).

## Cache and results

| Setting | Required | Purpose |
| --- | --- | --- |
| Reuse conversion results | Optional | Reuse results for the same PDF content and parser profile |

Clearing the local cache asks for confirmation.

## Details

### Account and conversion

- The account is only used for hosted PDF conversion. Registration asks you to confirm the password and emails a six-digit code. The password is not saved.
- Debug builds can change the server address; release builds use the packaged production address.
- After sign-in, the pane shows the account name, email, registration date, and conversion counters. Use the pencil button next to the name to change the display name.
- The access token and refresh token stay unencrypted in the active Zotero profile. MinerU, Mistral, and AI credentials are also ordinary, unencrypted preferences in that profile.

If MinerU cloud returns `HTTP 401` or `token expired`, update the MinerU API key in `Settings -> Mktero`. Get a new key from [MinerU's official API key management page](https://mineru.net/apiManage/token). Signing in again in your browser does not update the key saved in the plugin.

`Parsing model` belongs to the direct MinerU cloud request only. The Mktero service picks the model on the server, so that setting never reaches hosted conversion, and a self-hosted MinerU service keeps its own fixed request. An operation fixes the model when it starts, before the local-import check and before the PDF is loaded; a setting change applies to later operations only, and opening an item that is already running joins that run instead of moving or cancelling it. A stored value this build does not recognize reads as `VLM`, and so does a pending task recorded before the choice existed. See [MinerU cloud parsing model](./conversion.md#mineru-cloud-parsing-model) for cache, pending, and resume behaviour.

The converters handle cancellation and resuming differently:

| Converter | Behaviour |
| --- | --- |
| Mistral | Uses a synchronous request. You can cancel it locally, but there is no resumable server task |
| MinerU cloud | Keeps its existing resumable task behaviour, and a resumed task keeps the parsing model fixed when that task started |
| Local MinerU | Keeps jobs only in its own process. Mktero does not resume them after that service restarts |

### AI translation

- Switching providers restores that provider's last settings, or an empty profile if it has not been configured.
- Alibaba Cloud Model Studio, Moonshot AI, and MiniMax offer international and China endpoints. Choose the site that issued your key.
- For a known model, reasoning options follow what that model supports.
- A custom URL and protocol appear only for `Custom or compatible service`.
