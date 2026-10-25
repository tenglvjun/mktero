# 数据与隐私

[English](./privacy.md) · [简体中文](./privacy.zh-CN.md) · [返回 README](../README.zh-CN.md)

| 数据 | 发送到或存储在 | Zotero 同步 |
| --- | --- | --- |
| 使用默认 Mktero 转换时，缓存未命中的完整 PDF | 已登录账号所使用的 Mktero 服务 | Mktero 不同步 |
| 改用自己的转换服务后，缓存未命中的完整 PDF | 所选 MinerU 云端、配置的本地 MinerU 服务或 Mistral | Mktero 不同步 |
| MinerU 云端 Token、本地 MinerU 地址、Mistral API key，以及 AI 凭据 | 当前 Zotero 配置文件，未加密 | 否 |
| 登录或注册时的邮箱和密码，以及注册验证码 | 你选择的 Mktero 服务；密码和验证码不会保存 | Mktero 不同步 |
| Mktero 访问令牌和刷新令牌 | 当前 Zotero 配置文件，未加密 | 否 |
| 账号资料和转换活跃度计数，在账号面板打开时使用访问令牌请求 | 你选择的 Mktero 服务 | Mktero 不同步 |
| Mktero 插件版本号，随发往 Mktero 服务的请求一起发送，并在登录或刷新令牌时记录，用于让运营方了解仍有哪些版本在使用 | 你选择的 Mktero 服务；仅用于运营统计，不会返回给插件，也不会在你的账号资料中显示 | Mktero 不同步 |
| 运营调研的邀请邮件、带令牌的链接、你提交的回复内容，以及调研邮件退订开关 | 你选择的 Mktero 服务；链接中的令牌不会保存在网站上 | Mktero 不同步 |
| 缓存的 Markdown、图片、图表元数据（含 OCR 片段）、来源映射、PDF 索引、校对、译文和阅读位置 | 当前 Zotero 配置文件，未加密 | 否 |
| 保存的 MinerU 结果，来自 Mktero、MinerU 云端或本地 MinerU 服务（结果中的 Markdown、内容列表、版面或中间 JSON 和图片；不含 PDF 副本），用于 Mktero 更新后无需重新转换即可重新读取论文 | 当前 Zotero 配置文件，未加密 | 否 |
| Markdown 可用索引：文库 ID、条目 key、附件 key、缓存键、解析配置和过期时间 | 当前 Zotero 配置文件，未加密 | 否 |
| 当前论文的 DOI/arXiv 标识符及 Provider 所需的候选 DOI | Semantic Scholar、OpenCitations 或 OpenAlex | Mktero 不同步 |
| 用户为只有标题的文献点击“导入文献”后发送的受限引用文本 | OpenAlex | Mktero 不同步 |
| 用户点击导入后发送的规范化 DOI、arXiv ID、PMID 或 OpenAlex 工作 ID、已确认的元数据，以及可选的公开 PDF 请求 | 选定的元数据/PDF Provider | Mktero 不同步 |
| Zotero 启动时匿名请求的 models.dev 模型目录 | models.dev，只保存在内存中，退出后释放 | 否 |
| 受保护的 Markdown 翻译批次 | 你配置的 AI Provider | Mktero 不同步 |
| 选区翻译使用的选中文本 | 你配置的 AI Provider | Mktero 不同步 |
| Zotero PDF 标注 | 本地 Zotero 文库 | 取决于 Zotero 设置 |
| 尚未同步到 PDF 的本地 Markdown 高亮，以及跨页高亮各分段的 Zotero 标注 key | 当前 Zotero 配置文件，未加密 | 否 |
| 保存的快照 Note 和附件（含可选图表元数据和 OCR 片段） | Zotero 条目和附件 | 取决于 Zotero 设置 |
| 导出的 Markdown 和图片 | 用户选择的本地路径，包括 Obsidian 库。Mktero 不参与该副本的同步。 | 否 |
| Obsidian 导出索引：文库 ID、条目 key、笔记文件夹名和内容哈希，以及库路径设置 | 当前 Zotero 配置文件，未加密 | 否 |
| 导入的文献元数据和 PDF 附件 | 当前 Zotero 配置文件，未加密 | 取决于 Zotero 设置 |

Mktero 不会把 PDF 标注、本地 PDF.js 索引、Zotero 笔记、完整条目记录、本地路径或缓存 Markdown 发送给文献/PDF Provider。只有标题的文献在用户明确点击“导入文献”后才会发送受限的引用文本；唯一的高置信度匹配会自动继续，不确定的匹配仍需用户确认。引用与文献请求始终匿名访问 Provider，只包含上表所述的受限引用文本、规范化标识符和已确认元数据，不会发送 Zotero key 或 PDF 字节。翻译请求包含受保护的 Markdown 和指令；如果占位符校验连续失败，最后一次重试只发送受影响内容块中的普通文本片段。选区翻译请求只包含选中文本，不会写入全文翻译缓存。日志不会写入 API Token、预签名地址、PDF 字节或带认证的响应。

版本上报只包含插件自身的版本号。Mktero 不采集设备指纹，不采集硬件、操作系统或由 IP 推导的标识，也不接入任何第三方统计。版本号只发送给 Mktero 服务：它不会附加到发往对象存储、MinerU 或 Mistral 转换服务，以及你配置的 AI 或引用 Provider 的请求上。它不属于你的账号资料，因此任何产品界面都不会把它展示给你。

调研邀请由 Mktero 服务发送，不是插件发送的。插件不发送也不保存调研回复。可以在网站账号页关闭调研邀请；增加这个开关之后发出的邀请邮件里也有直接退订链接。关闭后不影响验证码、密码重置和论文转换，也不会删除已经提交的回复。

使用默认转换时，缓存未命中会把完整 PDF 发送到已登录账号所使用的 Mktero 服务。请同时阅读该服务的数据处理方式，以及你改选的 MinerU、Mistral、AI Provider 和引用 Provider 的隐私政策。除非相关数据处理条款符合你的使用场景，否则不要处理机密 PDF。
