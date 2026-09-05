# Mktero

[English](./README.md) · **简体中文**

[![测试](https://github.com/tenglvjun/mktero/actions/workflows/test.yml/badge.svg)](https://github.com/tenglvjun/mktero/actions/workflows/test.yml)
[![最新版本](https://img.shields.io/github/v/release/tenglvjun/mktero)](https://github.com/tenglvjun/mktero/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Zotero](https://img.shields.io/badge/Zotero-7%20%7C%208%20%7C%209%20%7C%2010-cc2936.svg)](https://www.zotero.org/)

**在 Zotero 中以带来源链接的 Markdown 阅读 PDF。**

Mktero 是适用于 Zotero 7、8、9 和 10 的无需重启扩展。需要时，它会将本地 PDF
发送到所选的 OCR 服务（[MinerU](https://mineru.net/) 或
[Mistral OCR 4.1](https://docs.mistral.ai/models/ocr-4-1)）进行转换，再在临时的阅读优先
Zotero 标签页中打开 Markdown、公式、表格、图片、引用和标注。内容寻址的本地缓存会按 PDF 内容和解析配置复用转换结果，避免重复处理。

![Mktero 在 Zotero 中转换、阅读和标注学术 PDF](./docs/assets/mktero-demo.gif)

> [!IMPORTANT]
> Mktero 目前处于 Beta 阶段。缓存未命中时，完整 PDF 会发送到所选的转换服务，因此需要
> 配置 MinerU API Token 或 Mistral API Key。可选的 AI 翻译会把受保护的 Markdown 批次发送给你配置的 Provider。
> 处理敏感文档前，请阅读[数据与隐私](#数据与隐私)。

常用链接：[产品介绍页](https://tenglvjun.github.io/mktero/) ·
[下载最新版本](https://github.com/tenglvjun/mktero/releases/latest) ·
[Discussions](https://github.com/tenglvjun/mktero/discussions) ·
[Issues](https://github.com/tenglvjun/mktero/issues)

## 核心能力

- 将 OCR 结果、双栏正文、公式、表格、图片、列表和代码重排成连续的论文阅读文档。
- Mistral 会依据图片坐标隐藏图片内部的 OCR 文字；两个 OCR Provider 都会根据图片坐标恢复多面板图表的原始排列布局。MinerU 只在有 bbox 证据时重排；Mistral 在缺少坐标时还支持保守的布局兜底。
- 保留可靠的页码和区域映射，使正文、公式、表格和图片可以跳回 PDF 来源。
- 在不丢失当前位置的情况下预览引用、作者单位、图片和表格。
- 在 Markdown 引用弹窗中检查文献是否存在于可访问的 Zotero 文库；用户可以选择可写的个人库或群组库，显式复制其他文库中的文献，针对只有标题的文献查看本地或在线元数据匹配，并导入缺失的元数据和公开 PDF。
- 在 Markdown 中显示 Zotero PDF 高亮和下划线，并支持新建、编辑、改色、评论和删除标注。
- 在不修改不可变 OCR 结果的前提下，校对已有段落、标题和 GFM 表格单元格；校对内容可查看、恢复或删除。
- 通过配置的 Vercel AI SDK Provider 翻译整篇文章，并在原文、译文和连续块级双语阅读之间切换；也可以在原文视图或双语视图的原文侧查询选中的术语或段落。
- 只在当前 Zotero 文库内展示可匹配的直接引用关系，并在支持时使用 Semantic Scholar、OpenCitations 和 OpenAlex 刷新数据。
- 保存包含 HTML、Markdown、来源映射和内嵌图片的便携 Zotero 快照。
- 将修正后的原文 Markdown 和提取图片导出到用户选择的本地位置。
- 界面跟随 Zotero 的英文或简体中文显示语言，其他语言回退为英文。

## 快速开始

### 使用要求

- 桌面版 Zotero `7.0` 至 `10.0.*`
- 已下载并可在本机访问的 PDF 附件
- 需要所选转换服务的 API key：[MinerU](https://mineru.net/apiManage/token) 或 [Mistral](https://console.mistral.ai/api-keys/)
- 能够访问所选转换 API 的网络环境

文件大小、页数、账户额度和服务可用性由各服务控制，请以
[MinerU API 文档](https://mineru.net/apiManage/docs)或
[Mistral OCR 文档](https://docs.mistral.ai/studio/document-processing/basic_ocr)中的当前限制为准。Mktero 会在创建 Base64 请求前检查 Mistral 文档列出的 50 MB PDF 和 1000 页限制。

### 安装

1. 从 [GitHub Releases](https://github.com/tenglvjun/mktero/releases/latest)
   下载最新的 `mktero-<version>.xpi`。
2. 在 Zotero 中打开 `工具 -> 插件`。
3. 打开齿轮菜单，选择 `Install Add-on From File...`。
4. 选择 XPI 文件并按 Zotero 提示完成安装。

正式 GitHub Release 可以通过 Zotero 自动更新；草稿和预发布版本不会成为自动更新目标。

### 配置

安装后打开 `设置 -> Mktero`。

| 设置 | 是否必需 | 作用 |
| --- | --- | --- |
| 转换服务 | 必需 | 选择 MinerU 或 Mistral OCR 4.1 |
| API key | 缓存未命中时必需 | 为所选服务填写 API key，可通过旁边的管理链接创建或更新 |
| AI 功能和 Provider 设置 | 可选 | 通过托管或本地回环模型服务翻译 Markdown |
| 翻译语言 | 可选 | 简体/繁体中文、日文、韩文、西班牙语、法语或巴西葡萄牙语 |
| 自动翻译 Markdown 选区 | 可选，默认关闭 | 无需再次点击即可翻译稳定的选区；关闭后保留弹窗中的手动操作 |
| 正文字体和字号 | 可选 | 选择阅读字体，并在 16–22 px 间调整字号 |
| 复用转换结果 | 可选 | 复用相同 PDF 内容和解析配置对应的结果 |

MinerU、Mistral 和 AI 凭据会作为普通的未加密首选项存储在当前 Zotero 配置文件中。Mistral
使用同步请求，可以在本地取消，但没有可恢复的服务端任务；MinerU 仍保留原有的任务恢复行为。开始翻译前，可以使用`测试连接`验证 AI 地址。

### 打开 PDF

1. 在 Zotero 中打开 PDF，点击阅读器工具栏的 Mktero 文件图标；也可以右键 PDF 或文库条目，选择
   `Read as Markdown with Mktero`。
2. 在临时 Mktero 标签页中查看上传、转换和下载进度。存在有效缓存时会跳过远程转换。
3. 使用目录、引用、图表预览、来源链接和 Zotero 笔记面板浏览文档。
4. 使用阅读器工具栏调整字体、切换阅读模式、翻译、校对识别错误、保存快照或导出 Markdown。

Mktero 标签页是会话级的，Zotero 重启后不会恢复。关闭标签页或关闭扩展时，进行中的转换和翻译请求会被取消。

## 阅读与标注工作流

### 带来源的阅读

OCR 内容映射会把 Markdown 内容块连接到 PDF 的物理页码和区域。来源跳转和附带来源复制只在映射可靠时执行；匹配存在歧义时不会猜测位置。Markdown 在隔离的 shadow root 中渲染，并使用受限的链接和图片策略。

### 校对识别错误

双击已有段落、标题或 GFM 表格单元格即可编辑，然后显式保存或取消。在 `Manage corrections` 中还可以删除和恢复已有段落或标题。校对数据独立于转换缓存，并绑定当前 PDF 内容和所选服务的解析配置；不能插入或重排内容块，也不能添加图片或原始 HTML。保存校对后会保留当前阅读位置，继续滚动时整篇文档仍可正常显示。公式、OCR 使用美元符号包裹的引用标记和已匹配的划区文字都受到保护；需要修改划区文字时，应先删除划区。划区前后的文字仍可编辑，保存后会同步更新划区锚点，重新打开文档仍能对准原位置；如果恢复校对会改变已划区的校对文本，Mktero 会拒绝恢复。在渲染后的 GFM 表格中，含受保护内容的单元格保持只读，其他单元格仍可编辑。恢复全部校对或重新解析含校对的 PDF 时，会使用阅读器内的 Mktero 确认框；按 `Escape`、点击遮罩或使用默认聚焦的“取消”都不会改变文档。

### 从 Markdown 创建标注

打开文档时会加载已有的 Zotero 文本高亮和下划线。选中 Markdown 文本后可以立即创建本地标注；只有本地 PDF 文字索引能够可靠定位唯一位置时，Mktero 才会创建对应的 Zotero 标注。重复或歧义文本会保留在本地并可重试，不会被放置到猜测的位置。跨越 PDF 分页的选区会按页面拆成多个单页 Zotero 高亮，因此完整的 Markdown 选区仍可导航。高亮与论文引用、表格引用或图表引用重叠时，语义引用保持更高的交互优先级；仍可从周围的高亮文本或笔记标记打开标注操作。
常见的 OCR LaTeX 数学符号和简单下标会转换为 PDF 提取文本的形式，因此包含公式的选区也可以继续定位。

### 使用 AI 翻译

AI 全文翻译需要用户主动触发，也不会重写原始 Markdown。Mktero 会把文章拆成受控的 Markdown 批次，保护公式、引用、链接、代码、图片和结构占位符，并最多同时执行 5 个请求。阅读器支持 `Original`、`Translation` 和 `Bilingual` 三种模式；部分结果会按内容块继续补译。

如需查询术语或复杂句子，可以在 `Original` 或 `Bilingual` 的原文侧选中文本，使用选区弹窗工具栏末尾的翻译操作；加载、结果和错误只在需要时于下方紧凑展开。使用流式 Provider 时，译文会在请求期间逐步显示，并且仍可取消；非流式 Provider 会在翻译完成后一次性显示结果。翻译成功后可以重新翻译或复制纯文本译文。`自动翻译 Markdown 选区`默认关闭；开启后，选区稳定一小段时间会自动发起一次受控请求。`Translation`、`Bilingual` 的译文侧和已保存的 HTML 快照不提供划词翻译。选区译文只显示在弹窗中，不会修改 Markdown 或笔记，也不会写入全文翻译缓存。每次选区请求只会把选中文本和附近受限长度的原文上下文发送给配置的 AI Provider，可能产生 Provider 费用。

译文会按照源内容、Provider、协议、模型、语言和提示词版本独立缓存。本地 Markdown 校对删除内容块后，其他未变内容块的译文会继续保留，已删除内容不再出现于 `Bilingual` 视图。修改已翻译内容块时，其他译文保持不变，该内容块会标记为待翻译，并提示是否仅重新翻译该内容块。Mktero 通过 Vercel AI SDK Core 支持 OpenAI、Anthropic、Google Gemini、DeepSeek、阿里云百炼、Moonshot/Kimi、MiniMax，以及自定义 OpenAI 兼容或 Open Responses 服务。远程地址必须使用 HTTPS；Ollama、LM Studio 等本地回环服务可以使用 HTTP。

### 浏览引用图谱

引用图谱只包含当前论文，以及能匹配到当前 Zotero 文库条目的直接引用。支持时会并发查询 Semantic Scholar、OpenCitations 和 OpenAlex。匹配只使用唯一且规范化的 DOI 或 arXiv 标识符，不使用标题；Provider 返回的元数据保存在本地。

### 从 Markdown 导入参考文献

打开引用弹窗时，Mktero 会先只检查本地 Zotero，不会立即发起网络查询。对只有标题的文献点击“导入文献”会明确触发一次受限的 OpenAlex 查询；标题、年份和作者构成唯一精确匹配时会直接继续导入。如果 Provider 的年份只相差一年，则还必须同时满足清理后的标题近乎一致且首位作者匹配，才会直接导入。其他情况只显示最多三个可信候选项，选择其中一项后继续同一次导入。完整引文噪声过多时会使用清理后的标题重试，这也支持没有 DOI 的 OpenAlex 图书记录。对于 IEEE 格式的引文，Mktero 会把成对直双引号或弯双引号中的论文标题与作者、期刊、卷期和页码分开检索。对于没有引号的会议引文，Mktero 会把论文标题与其后的 `In ... Conference`、会议录、Workshop 或 Symposium 信息分开。弹窗会列出可访问的个人库和群组库，并允许选择导入目标。只读文库仍可被选择以检查状态，但导入操作会被禁用并显示权限说明。如果其他文库中已有匹配条目，Mktero 会提供明确的“复制到所选文库”操作，不会静默创建重复条目。具有可靠 DOI、arXiv ID 或 PMID 的缺失文献会通过 Zotero 原生 translator 导入；目标文库允许文件时，还会尝试导入 arXiv 或配置的公开 PDF。即使 PDF 下载失败，元数据也会保留，并可稍后重试。弹窗顶部只保留目标文库选择器；每条文献在左侧显示状态，并在右侧显示自己的导入、重试、复制或打开按钮，所有操作都只作用于当前可见条目。

作者-年份分组引用会展示所有能够匹配的参考文献。如果 PDF 转换结果在 APA 参考文献列表中间插入了无关标题，Mktero 只会在标题后明确连续出现多条参考文献时继续解析，因此真正位于文献末尾的 Author Note 仍会终止列表。

### 保存便携快照

`Save snapshot` 会在 PDF 所属条目下创建专用的 `Mktero Markdown Snapshot` Note。Note 保存便携 HTML，图片作为内嵌附件，原始 Markdown 和来源映射作为关联附件。用户修改过快照 Note 后，Mktero 不会静默覆盖。没有父级文库条目的独立 PDF 无法保存快照。

### 导出 Markdown

`导出 Markdown` 会打开系统文件夹选择窗口。选择文件夹 `A`、论文标题为 `B` 时，Mktero 会创建 `A/B/B.md`，并将提取图片写入 `A/B/assets/`，同时更新 Markdown 中的图片路径。如果 `B` 已存在，则创建 `B-2` 等带序号的目录及对应的 `B-2.md`，不会覆盖已有导出。在大小写不敏感的文件系统上发生图片名冲突时，Mktero 会为图片添加序号并同步更新 Markdown 引用，避免不同图片互相覆盖。导出内容不包含译文或双语阅读视图，也不会自动导出。

## 工作原理

```text
Zotero 本地 PDF
        |
        v
所选 OCR 服务 ----------> Markdown + 图片 + 内容映射
        |                              |
        v                              v
本地内容缓存                    安全规范化与渲染
                                       |
                                       v
                            Zotero 中的 Mktero 阅读标签页
```

PDF、OCR 结果、压缩包、图片路径、API 响应和首选项都会被视为不可信输入。压缩包和 Markdown 会检查资源预算，归档路径会被规范化，远程 Markdown 图片不会加载，原始 HTML 会在渲染前转义或清理。

## 数据与隐私

| 数据 | 发送到或存储在 | Zotero 同步 |
| --- | --- | --- |
| 缓存未命中时的完整 PDF | 所选 MinerU 或 Mistral 服务 | Mktero 不同步 |
| MinerU/Mistral API 凭据和 AI 凭据 | 当前 Zotero 配置文件，未加密 | 否 |
| 缓存的 Markdown、图片、来源映射、PDF 索引、校对和译文 | 当前 Zotero 配置文件，未加密 | 否 |
| 当前论文的 DOI/arXiv 标识符及 Provider 所需的候选 DOI | Semantic Scholar、OpenCitations 或 OpenAlex | Mktero 不同步 |
| 用户为只有标题的文献点击“导入文献”后发送的受限引用文本 | OpenAlex | Mktero 不同步 |
| 用户点击导入后发送的规范化 DOI、arXiv ID、PMID 或 OpenAlex 工作 ID、已确认的元数据，以及可选的公开 PDF 请求 | 选定的元数据/PDF Provider | Mktero 不同步 |
| 受保护的 Markdown 翻译批次 | 你配置的 AI Provider | Mktero 不同步 |
| 选区翻译使用的选中文本和附近受限长度的原文上下文 | 你配置的 AI Provider | Mktero 不同步 |
| Zotero PDF 标注 | 本地 Zotero 文库 | 取决于 Zotero 设置 |
| 保存的快照 Note 和附件 | Zotero 条目和附件 | 取决于 Zotero 设置 |
| 导出的 Markdown 和图片 | 用户选择的本地路径 | 否 |
| 导入的文献元数据和 PDF 附件 | 当前 Zotero 配置文件，未加密 | 取决于 Zotero 设置 |

Mktero 不会把 PDF 标注、本地 PDF.js 索引、Zotero 笔记、完整条目记录、本地路径或缓存 Markdown 发送给文献/PDF Provider。只有标题的文献在用户明确点击“导入文献”后才会发送受限的引用文本；唯一的高置信度匹配会自动继续，不确定的匹配仍需用户确认。引用与文献请求始终匿名访问 Provider，只包含上表所述的受限引用文本、规范化标识符和已确认元数据，不会发送 Zotero key 或 PDF 字节。翻译请求包含受保护的 Markdown 和指令；如果占位符校验连续失败，最后一次重试只发送受影响内容块中的普通文本片段。选区翻译请求只包含选中文本和附近受限长度的原文上下文，不会写入全文翻译缓存。日志不会写入 API Token、预签名地址、PDF 字节或带认证的响应。

请同时阅读 MinerU、AI Provider 和引用 Provider 的隐私政策。除非相关数据处理条款符合你的使用场景，否则不要处理机密 PDF。

## 当前限制

- 仅支持本地 PDF 附件。扫描版 PDF 可以通过 OCR 转换，但没有文字层时无法生成精确的 Zotero 高亮。
- 来源跳转依赖 Provider 返回的内容块和坐标；MinerU 与 Mistral 使用独立的解析配置和缓存，旧缓存可能仍可阅读但没有来源链接。
- 当前只支持从 Markdown 跳转到 PDF，不支持反向跳转。
- 目前显示文本高亮和下划线，不显示独立便签、图片/区域标注或手写标注。
- Markdown 图片仅限当前结果压缩包中的 GIF、JPEG、PNG 和 WebP；远程图片会被阻止。
- 链接协议仅允许 `http`、`https`、`zotero` 和文档片段。
- 校对模式只能编辑或删除已有内容块。公式、MinerU 使用美元符号包裹的引用标记和已匹配的划区文字受到保护，其周围文字仍可编辑；修改划区文字前必须先删除划区，且含受保护内容的内容块不能整段删除。文档结构、图片和原始 HTML 同样不能改变。
- AI 翻译是可选的缓存阅读层，不修改源 Markdown，也不会写入快照。
- 选区翻译是独立的按需阅读辅助，只能从 Markdown 阅读视图的原文侧使用，不写入缓存，可能产生 AI Provider 费用。
- 压缩包、Markdown、图片、来源映射、PDF 索引和 KaTeX 渲染都有本地资源上限，超限时会安全停止处理。

## 转换排障

在 Zotero 中打开 `帮助 -> 调试输出日志`，启用日志后重现问题，并筛选 `Mktero:`。请确认 PDF 已下载到本机、所选 Provider 的 API 凭据有效且当前网络可以访问该服务。日志不会包含 API Token、预签名上传地址、MinerU batch ID 或 PDF 内容。

确认问题可复现后，请提交 [GitHub Issue](https://github.com/tenglvjun/mktero/issues)，并附上 Zotero 与 Mktero 版本、操作系统、PDF 类型、复现步骤、预期行为和实际行为。请勿附带 API Token、私密 PDF、带认证链接或本地文件路径。

## 开发

使用 [`.node-version`](./.node-version) 指定的 Node.js 版本，目前为 `24.15.0`。Node.js 25 不在支持范围内。

```bash
npm ci
npm run check
npm test
npm run build
```

迭代时可以使用 `node --test test/<name>.test.js` 运行单个测试。构建会在 `build/` 下生成可复现的 XPI、SHA-256 校验文件和 `build/updates.json`；`build/` 与 `node_modules/` 都是生成目录并已被忽略。

发布前请保持 `manifest.json`、`package.json` 和 `package-lock.json` 的版本一致。仓库架构、安全约束和贡献检查清单见 [AGENTS.md](./AGENTS.md)。

## 贡献

欢迎提交 Pull Request。功能想法、阅读工作流和 Beta 反馈请前往
[GitHub Discussions](https://github.com/tenglvjun/mktero/discussions)；确认且可复现的问题请提交到 [GitHub Issues](https://github.com/tenglvjun/mktero/issues)。修改运行时行为时，请运行上面的完整验证命令并为受影响的行为补充测试。请勿在 Issue、Pull Request 或日志中提交凭据、私密 PDF 或其他敏感信息。

## License

[MIT](./LICENSE) © 2026 Tony
