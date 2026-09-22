# Configuration

[English](./configuration.md) · [简体中文](./configuration.zh-CN.md) · [Back to README](../README.md)

Open `Settings -> Mktero` after installation.

| Setting | Required | Purpose |
| --- | --- | --- |
| Conversion provider | Yes | Select MinerU or Mistral OCR 4.1 |
| MinerU service | MinerU only | Choose MinerU cloud, or a self-hosted MinerU 4.0 V1 service |
| Local service address | Local MinerU only | Service origin, default `http://127.0.0.1:8000`. HTTP is limited to loopback and private-network addresses |
| API key | Required for a cloud cache miss | Enter the key for MinerU cloud or Mistral. The field is hidden for a local MinerU service |
| AI features and provider settings | Optional | Configure streaming, provider, model, key, reasoning, and timeout per provider; Alibaba Cloud Model Studio, Moonshot AI, and MiniMax can use the international or China endpoint to match the site that issued the key; switching providers restores that provider's last settings or an empty profile; reasoning options follow the selected model when known; a custom URL and protocol appear only for Custom |
| Translation language | Optional | Choose Simplified/Traditional Chinese, Japanese, Korean, Spanish, French, or Brazilian Portuguese |
| Automatically translate Markdown selections | Optional, off by default | Translate a stable selection without an extra click; disabling it keeps the manual popup action |
| Body text font and size | Optional | Choose the reading font and a 14–28 px body size |
| Line height, column width, and alignment | Optional | Choose tight/standard/loose spacing, a narrow/standard/wide measure, and left-aligned or justified body text. Left aligned is the default |
| PDF source thumbnail | Optional, on by default | Show a live PDF crop of the current paragraph |
| Reuse conversion results | Optional | Reuse results for the same PDF content and parser profile |

MinerU, Mistral, and AI credentials are stored as ordinary, unencrypted
preferences in the active Zotero profile. Mistral uses a synchronous request;
it can be cancelled locally, but it has no resumable server task. MinerU cloud
keeps its existing resumable task behavior. A local MinerU service keeps jobs
only in its own process, so Mktero does not resume them after that service
restarts. Use the lightning icon next to the AI
provider to validate an endpoint before translating. Clearing the local cache
asks for confirmation.
