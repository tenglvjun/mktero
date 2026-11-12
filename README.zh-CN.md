# Mktero

[English](./README.md) · **简体中文**

[![测试](https://github.com/tenglvjun/mktero/actions/workflows/test.yml/badge.svg)](https://github.com/tenglvjun/mktero/actions/workflows/test.yml)
[![最新版本](https://img.shields.io/github/v/release/tenglvjun/mktero)](https://github.com/tenglvjun/mktero/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Zotero](https://img.shields.io/badge/Zotero-7%20%7C%208%20%7C%209%20%7C%2010-cc2936.svg)](https://www.zotero.org/)

**在 Zotero 中以带来源链接的 Markdown 阅读 PDF。**

Mktero 是适用于 Zotero 7、8、9 和 10 的无需重启扩展，将 PDF 中的正文、公式、表格、图片、引用和注释呈现在临时的 Markdown 阅读标签页中。
内容寻址的本地缓存会复用相同 PDF 和解析配置的结果，避免重复转换。

[下载最新版本](https://github.com/tenglvjun/mktero/releases/latest) ·
[产品介绍页](https://mktero.com/) ·
[文档](#文档) ·
[社区](#社区) ·
[支持 Mktero](#支持-mktero)

> [!IMPORTANT]
> Mktero 目前处于 Beta 阶段。主动请求未缓存的转换且使用默认转换服务时，完整 PDF 会发送到你账号所使用的 Mktero 服务。
> 在 `设置 -> Mktero` 登录即可，无需另外的 OCR 密钥。若改用
> [MinerU](https://mineru.net/) 或 [Mistral OCR 4.1](https://docs.mistral.ai/models/ocr-4-1)，PDF 改发到那里，不再发到 Mktero。
> 可选的 AI 翻译会把受保护的 Markdown 批次发送给你配置的模型厂商或服务。处理敏感文档前，请阅读[数据与隐私](./docs/privacy.zh-CN.md)。

![Mktero 在 Zotero 中转换、阅读并为学术 PDF 添加注释](./docs/assets/mktero-demo.gif)

## 核心能力

### 阅读

- 将双栏论文重排为连续正文，保留公式、表格、列表和代码，并隐藏刊头、页眉页脚等页面装饰。[阅读](./docs/reading.zh-CN.md)
- 通过目录、图表、引用和查找定位，在 Markdown 与 PDF 来源之间跳转。[文档导航](./docs/reading.zh-CN.md#在文档中定位)
- 在阅读器内复制公式 LaTeX、代码，或将表格复制为 Markdown、CSV。[复制操作](./docs/reading.zh-CN.md#复制公式代码块与表格)
- 阅读时在后台从本地 PDF 恢复图组，保留共享图注（包括图号后使用破折号的格式），也支持能核验原始图片的无编号图形摘要。[图组恢复流程](./docs/figure-pipeline.zh-CN.md)

### 注释、校对和翻译

- 显示和编辑 PDF 高亮、下划线，并用 Zotero 原生编辑器写条目笔记或独立笔记。[注释与笔记](./docs/annotations.zh-CN.md)
- 校对段落、标题和 GFM 表格单元格，保留不可变的 OCR 结果。[校对](./docs/annotations.zh-CN.md#校对识别错误)
- 通过配置的 Vercel AI SDK 厂商翻译全文或选区，在`原文`、`译文`和`双语`之间切换。[AI 翻译](./docs/reading.zh-CN.md#使用-ai-翻译)

### 文库与导出

- 导入受支持的 llm-for-zotero 本地 MinerU 结果，无需账号、API 密钥或再次上传。[导入结果](./docs/conversion.zh-CN.md#导入-llm-for-zotero-本地结果)
- 在可访问的 Zotero 文库中检查引用，复制已有条目，或导入缺失的元数据与可选的公开 PDF。[参考文献](./docs/references-and-export.zh-CN.md#从-markdown-导入参考文献)
- 借助 Semantic Scholar、OpenCitations 和 OpenAlex，浏览当前文库内的直接引用关系。[引用图谱](./docs/references-and-export.zh-CN.md#浏览引用图谱)
- 保存便携 Zotero 快照，或将校对后的 Markdown 和图片导出到本地文件夹。[保存与导出](./docs/references-and-export.zh-CN.md#保存便携快照)
- 将当前阅读视图导出为 EPUB，公式以图片保留排版以兼容阅读器；也可对整批所选文献或整个分类树批量导出快照、Markdown、EPUB 和 Obsidian 笔记。[EPUB](./docs/references-and-export.zh-CN.md#导出-epub) · [Obsidian](./docs/references-and-export.zh-CN.md#导出到-obsidian) · [批量导出](./docs/references-and-export.zh-CN.md#批量导出)
- 在文献列表的本地 Markdown 列中查看缓存可用状态与准备进度。[Markdown 状态](./docs/conversion.zh-CN.md#查看哪些条目已有-markdown)

## 快速开始

1. 从 [GitHub Releases](https://github.com/tenglvjun/mktero/releases/latest) 下载最新的 `mktero-<version>.xpi`，安装到 Zotero。
2. 打开 `设置 -> Mktero`，登录、注册账号，或选择自备的转换服务。
3. 打开 PDF 并点击阅读器工具栏的 Mktero 图标，或右键 PDF，选择`使用 Mktero 阅读 Markdown`。
4. 等待转换完成后，用目录、查找、预览和来源链接阅读。命中有效缓存时会跳过远程转换。

使用要求、安装步骤与转换服务设置见[快速上手](./docs/getting-started.zh-CN.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [快速上手](./docs/getting-started.zh-CN.md) | 准备条件、安装和第一篇 PDF |
| [阅读](./docs/reading.zh-CN.md) | 导航、来源跳转、复制、排版和翻译 |
| [注释、笔记与校对](./docs/annotations.zh-CN.md) | PDF 注释、Zotero 笔记和识别纠错 |
| [参考文献与导出](./docs/references-and-export.zh-CN.md) | 文献导入、引用图谱、快照和导出 |
| [转换与本地缓存](./docs/conversion.zh-CN.md) | 转换服务、额度、批量准备、导入和清理 |
| [配置](./docs/configuration.zh-CN.md) | 所有设置项及默认值 |
| [数据与隐私](./docs/privacy.zh-CN.md) | 发送内容、存储位置和同步规则 |
| [当前限制](./docs/limitations.zh-CN.md) | 支持的 PDF、导航方式和资源上限 |
| [图组恢复流程](./docs/figure-pipeline.zh-CN.md) | 如何从本地 PDF 重建图组 |
| [开发](./docs/development.zh-CN.md) | 构建、测试、浏览器预览和回归语料 |

按任务查阅可使用[工作流索引](./docs/workflows.zh-CN.md)。

## 数据与隐私

- 主动请求未缓存的转换且使用默认转换服务时，完整 PDF 会发送到你账号所使用的 Mktero 服务。
- 若改选 MinerU 云端、本地 MinerU 服务或 Mistral，完整 PDF 改发到那里，不再发到 Mktero。
- 导入 llm-for-zotero 本地结果时不改动源缓存，另存未加密的副本和导入选择。导入及本地重开不上传 PDF 或结果；
  如果本地内容全部缺失，之后普通打开可能上传 PDF。主动重新解析也可能上传。导入失败、内容损坏、读取错误或取消不会触发转换。
- 凭据、缓存的 Markdown 和图片、MinerU 原始结果（不含 PDF）、校对、译文、阅读位置、尚未写入 PDF 的本地高亮，
  以及跨页高亮的注释 key，均未加密地保存在 Zotero 配置文件中。Mktero 不同步这些数据。
- 登录会发送邮箱和密码，注册还会向邮箱发送验证码。令牌保存在配置文件中。账号面板会读取资料、转换计数与服务支持的每日额度；
  服务端保留关联账号的使用聚合，用于服务运行与容量规划。本地待处理批次不会上传。
- 登录、刷新令牌和后台心跳时，仅向 Mktero 上报扩展版本，不含设备指纹、硬件、操作系统或由 IP 推导的标识，
  不接入第三方统计，不附加到发往你配置的其他服务的请求中，也不属于账号资料。
- 每日阅读活动计数（打开的阅读标签页数、打开的不同 PDF 数、其中滚动过和读到一半以上的篇数，以及注释、导出和翻译的次数）
  会上报 Mktero，便于运营方判断一次转换是否真的被读过。这些数字不含论文标识、标题、路径或文字内容，
  并且只在转换服务选择 Mktero 托管转换时发送：改用自己的 MinerU 或 Mistral 服务会立即停止上报。
- 引用、文献和翻译请求都有范围限制，优先使用本地数据。日志不会包含 API Token、预签名地址、PDF 字节或带认证的响应。

完整说明、本地导入副本的保留规则及数据表见[数据与隐私](./docs/privacy.zh-CN.md)。

## 开发

使用 [`.node-version`](./.node-version) 指定的 Node.js 版本，目前为 `24.15.0`。Node.js 25 不在支持范围内。

```bash
npm ci
npm run check
npm test
npm run build
```

浏览器预览和回归语料见[开发](./docs/development.zh-CN.md)。

## 社区

使用问题可以进 QQ 群、微信，或加入 [Discord](https://discord.gg/uyxmxah2sh)。功能想法、阅读工作流和 Beta 反馈请前往
[GitHub Discussions](https://github.com/tenglvjun/mktero/discussions)。可复现的问题请提交到
[GitHub Issues](https://github.com/tenglvjun/mktero/issues)。

从`帮助 > 报告 Mktero 问题…`、转换失败时的`报告问题`按钮，或 Mktero 标签页的 `⋯ > 报告问题`，
可以在这台电脑上复制或保存脱敏诊断文件，不会上传；把文件粘贴到 Issue 或发到群里即可。
请勿在 QQ 群、微信、Discord、Issue、Pull Request 或日志中提交 API Key、其他凭据、私密 PDF 原文或其他敏感数据。

欢迎提交 Pull Request。修改运行时行为时，请运行上面的完整验证命令，并为受影响的行为补充测试。

QQ 是用户群：可以扫码，也可以在 QQ 中搜索群号 `616518076`。

<table>
  <tr>
    <td align="center" width="220">
      <img src="./docs/assets/qq-group.png" width="180" alt="Mktero 用户群二维码，群号 616518076"><br>
      <b>QQ</b>
    </td>
    <td align="center" width="220">
      <img src="./docs/assets/wechat.png" width="180" alt="Mktero 维护者的微信二维码"><br>
      <b>微信</b>
    </td>
  </tr>
</table>

## 支持 Mktero

如果 Mktero 让你阅读论文更轻松，欢迎请我喝杯咖啡。
你的支持将用于项目的持续开发、维护和托管费用。

[![通过 Ko-fi 支持 Mktero](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/tenglvjun)

## License

[MIT](./LICENSE) © 2026 Tony
