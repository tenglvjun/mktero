# 数据与隐私

[English](./privacy.md) · [简体中文](./privacy.zh-CN.md) · [返回 README](../README.zh-CN.md)

| 数据 | 发送到或存储在 | Zotero 同步 |
| --- | --- | --- |
| 缓存未命中时的完整 PDF | 所选 MinerU 或 Mistral 服务 | Mktero 不同步 |
| MinerU/Mistral API 凭据和 AI 凭据 | 当前 Zotero 配置文件，未加密 | 否 |
| 缓存的 Markdown、图片、图表元数据（含 OCR 片段）、来源映射、PDF 索引、校对、译文和阅读位置 | 当前 Zotero 配置文件，未加密 | 否 |
| 当前论文的 DOI/arXiv 标识符及 Provider 所需的候选 DOI | Semantic Scholar、OpenCitations 或 OpenAlex | Mktero 不同步 |
| 用户为只有标题的文献点击“导入文献”后发送的受限引用文本 | OpenAlex | Mktero 不同步 |
| 用户点击导入后发送的规范化 DOI、arXiv ID、PMID 或 OpenAlex 工作 ID、已确认的元数据，以及可选的公开 PDF 请求 | 选定的元数据/PDF Provider | Mktero 不同步 |
| Zotero 启动时匿名请求的 models.dev 模型目录 | models.dev，只保存在内存中，退出后释放 | 否 |
| 受保护的 Markdown 翻译批次 | 你配置的 AI Provider | Mktero 不同步 |
| 选区翻译使用的选中文本 | 你配置的 AI Provider | Mktero 不同步 |
| Zotero PDF 标注 | 本地 Zotero 文库 | 取决于 Zotero 设置 |
| 保存的快照 Note 和附件（含可选图表元数据和 OCR 片段） | Zotero 条目和附件 | 取决于 Zotero 设置 |
| 导出的 Markdown 和图片 | 用户选择的本地路径 | 否 |
| 导入的文献元数据和 PDF 附件 | 当前 Zotero 配置文件，未加密 | 取决于 Zotero 设置 |

Mktero 不会把 PDF 标注、本地 PDF.js 索引、Zotero 笔记、完整条目记录、本地路径或缓存 Markdown 发送给文献/PDF Provider。只有标题的文献在用户明确点击“导入文献”后才会发送受限的引用文本；唯一的高置信度匹配会自动继续，不确定的匹配仍需用户确认。引用与文献请求始终匿名访问 Provider，只包含上表所述的受限引用文本、规范化标识符和已确认元数据，不会发送 Zotero key 或 PDF 字节。翻译请求包含受保护的 Markdown 和指令；如果占位符校验连续失败，最后一次重试只发送受影响内容块中的普通文本片段。选区翻译请求只包含选中文本，不会写入全文翻译缓存。日志不会写入 API Token、预签名地址、PDF 字节或带认证的响应。

请同时阅读 MinerU、AI Provider 和引用 Provider 的隐私政策。除非相关数据处理条款符合你的使用场景，否则不要处理机密 PDF。
