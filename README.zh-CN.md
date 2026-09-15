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
> 处理敏感文档前，请阅读[数据与隐私](./docs/privacy.zh-CN.md)。

常用链接：[产品介绍页](https://mktero.com/) ·
[下载最新版本](https://github.com/tenglvjun/mktero/releases/latest) ·
[Discussions](https://github.com/tenglvjun/mktero/discussions) ·
[Issues](https://github.com/tenglvjun/mktero/issues)

## 核心能力

- 将 OCR 结果、双栏正文、公式、表格、图片、列表和代码重排成连续的论文阅读文档。
- 只在版面证据、页面坐标和 Markdown 范围一致时，从本地 PDF 恢复图组。恢复在后台 Worker 中进行并就地替换占位，慢的图不会阻塞阅读。
- 隐藏出版商刊头、重复页眉页脚和页码，并保留可靠的页码与区域映射，使正文、公式、表格和图片可以跳回 PDF 来源。
- 通过目录或图表索引浏览文档，预览引用、作者单位、图片和表格，并用 `Cmd/Ctrl+F` 查找正文。
- 在 Markdown 中显示 Zotero PDF 高亮和下划线，并支持新建、编辑、改色、评论和删除标注。
- 在不修改不可变 OCR 结果的前提下，校对已有段落、标题和 GFM 表格单元格。
- 通过配置的 Vercel AI SDK Provider 翻译整篇文章，并在原文、译文和连续块级双语阅读之间切换；也可按需查询选中的术语或段落。
- 在 Markdown 引用弹窗中检查文献是否存在于可访问的 Zotero 文库，复制其他文库中的文献，并导入缺失的元数据和公开 PDF。
- 只在当前 Zotero 文库内展示可匹配的直接引用关系，并在支持时使用 Semantic Scholar、OpenCitations 和 OpenAlex 刷新数据。
- 保存便携 Zotero 快照，或将修正后的原文 Markdown 和提取图片导出到本地文件夹。
- 界面跟随 Zotero 的英文或简体中文显示语言，其他语言回退为英文。

## 快速开始

### 使用要求

- 桌面版 Zotero `7.0` 至 `10.0.*`
- 已下载并可在本机访问的 PDF 附件
- 需要所选转换服务的 API key：[MinerU](https://mineru.net/apiManage/token) 或 [Mistral](https://console.mistral.ai/api-keys/)
- 能够访问所选转换 API 的网络环境

文件大小、页数、账户额度和服务可用性由各服务控制，请以
[MinerU API 文档](https://mineru.net/apiManage/docs)或
[Mistral OCR 文档](https://docs.mistral.ai/studio/document-processing/basic_ocr)中的当前限制为准。

### 安装

1. 从 [GitHub Releases](https://github.com/tenglvjun/mktero/releases/latest)
   下载最新的 `mktero-<version>.xpi`。
2. 在 Zotero 中打开 `工具 -> 插件`。
3. 打开齿轮菜单，选择 `Install Add-on From File...`。
4. 选择 XPI 文件并按 Zotero 提示完成安装。

正式 GitHub Release 可以通过 Zotero 自动更新；草稿和预发布版本不会成为自动更新目标。

### 配置

安装后打开 `设置 -> Mktero`，选择转换服务并填写对应的 API key。AI 功能和阅读选项都是可选的，凭据会作为普通的未加密首选项存储在当前的 Zotero 配置文件中。

所有设置项见[配置](./docs/configuration.zh-CN.md)，发送与存储位置见[数据与隐私](./docs/privacy.zh-CN.md)。

### 打开 PDF

1. 在 Zotero 中打开 PDF，点击阅读器工具栏的 Mktero 文件图标；也可以右键 PDF 或文库条目，选择
   `Read as Markdown with Mktero`。
2. 在临时 Mktero 标签页中查看上传、转换和下载进度。存在有效缓存时会跳过远程转换。
3. 使用目录、查找、引用、图表预览、来源链接和 Zotero 笔记面板浏览文档。

Mktero 标签页是会话级的，Zotero 重启后不会恢复。关闭标签页或关闭扩展时，进行中的转换和翻译请求会被取消。再次打开同一 PDF 和同一转换配置时，会回到上次阅读的段落。

## 文档

- [配置](./docs/configuration.zh-CN.md) —— 所有设置项及默认值。
- [阅读与标注工作流](./docs/workflows.zh-CN.md) —— 校对、标注、AI 翻译、引用、文献导入、快照和导出。
- [图组恢复流程](./docs/figure-pipeline.zh-CN.md) —— 如何从本地 PDF 重建图组。
- [数据与隐私](./docs/privacy.zh-CN.md) —— Mktero 发送了哪些数据、存储在哪里。
- [当前限制](./docs/limitations.zh-CN.md) —— 支持的 PDF、导航方式和资源上限。
- [开发](./docs/development.zh-CN.md) —— 构建、测试、图组回归语料和贡献流程。

## 数据与隐私

- 缓存未命中时，完整 PDF 会发送到所选的 MinerU 或 Mistral 服务。
- 凭据、缓存的 Markdown 和图片、校对、译文和阅读位置会以未加密形式存储在当前 Zotero 配置文件中，Mktero 不会同步这些数据。
- 引用、文献和翻译请求都是受限且本地优先的；日志不会包含 API Token、预签名地址、PDF 字节或带认证的响应。

完整说明和数据表见[数据与隐私](./docs/privacy.zh-CN.md)。

## 开发

使用 [`.node-version`](./.node-version) 指定的 Node.js 版本，目前为 `24.15.0`。Node.js 25 不在支持范围内。

```bash
npm ci
npm run check
npm test
npm run build
```

图组回归语料见[开发](./docs/development.zh-CN.md)。

## 贡献

欢迎提交 Pull Request。功能想法、阅读工作流和 Beta 反馈请前往
[GitHub Discussions](https://github.com/tenglvjun/mktero/discussions)；确认且可复现的问题请提交到 [GitHub Issues](https://github.com/tenglvjun/mktero/issues)。修改运行时行为时，请运行上面的完整验证命令并为受影响的行为补充测试。请勿在 Issue、Pull Request 或日志中提交凭据、私密 PDF 或其他敏感信息。

## License

[MIT](./LICENSE) © 2026 Tony
