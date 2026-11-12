# 开发

[English](./development.md) · [简体中文](./development.zh-CN.md) · [返回 README](../README.zh-CN.md)

本文介绍 Mktero 的构建、本地回归语料检查和浏览器预览，也记录托管转换共享的生命周期规则。

## 常用命令速查

- 安装、检查、测试和打包：`npm ci`、`npm run check`、`npm test`、`npm run build`。
- 运行单个测试：`node --test test/<name>.test.js`。
- 检查本地图组：`node scripts/figure-corpus-check.mjs`。
- 检查本地阅读结果：`node scripts/reading-corpus-check.mjs --pipeline ir`。
- 构建浏览器预览：`npm run build:preview`。

## 构建与发布

使用 [`.node-version`](../.node-version) 指定的 Node.js 版本，目前为 `24.15.0`。Node.js 25 不在依赖支持范围内。

```bash
npm ci
npm run check
npm test
npm run build
```

构建会在 `build/` 下生成可复现的 XPI、SHA-256 校验文件和 `build/updates.json`。`build/` 与 `node_modules/` 都是生成目录并已被忽略。

打发布标签前，保持 `manifest.json`、`package.json` 和 `package-lock.json` 的版本一致。仓库架构、安全约束和贡献检查清单见 [AGENTS.md](../AGENTS.md)。

## 托管转换共享

### 结果获取与缓存发布

bootstrap 在运行时中创建一次 `src/mktero/shared-conversion.js`。以下身份相同的请求共享原始缓存检查、托管网络请求和一次原始归档保存：

- API 地址和账号会话范围；
- 原始请求配置；
- 完整 PDF SHA-256 和字节数。

各附件持有独立租约，直到自己的处理与注释加载完成。以下规则防止旧运行覆盖新结果：

1. 强制替换先预留新的获取，再取消旧 run；释放操作限定到具体 run signal。
2. 新一代建立时即撤销旧代的缓存发布权。缓存存储在串行队列内、元数据提交前检查 `canCommit`。新一代失败不会恢复旧代的写入权。
3. 本地缓存恢复也持有离线发布保护，延迟完成的恢复不能覆盖并行强制转换的新结果。
4. 关闭扩展时，在有界清理期内等待尚未完成的归档写入。

### 会话身份

不透明的 `accountSessionEpoch` 偏好在显式登录和退出时轮换，同邮箱重新登录也适用。刷新令牌时保留该值。

独立的运行时 scope 还观察 API 和服务切换。两种身份都不包含访问令牌或刷新令牌，磁盘缓存身份和 schema 保持原有格式。

### 超时与取消

取消清理有等待上限，且仅尽力执行。本模块不提供重启后或建单响应丢失后的托管任务恢复。

HTTP 超时和取消覆盖响应头及响应体读取：

1. 建单过程中取消时，调用方立即收到取消错误。
2. 若已经收到响应头，响应体仍可在回收窗口内返回任务 ID：默认最多 2 秒，同时受原请求剩余时限约束。随后清理只发送一次独立 DELETE。
3. DELETE 自身另有 2 秒总预算，涵盖令牌查询、传输和响应体读取。

共享层另行限制 shutdown 或替换等待清理的时间。这些上限都不代表远端任务一定已取消。

### 生命周期测试

| 测试 | 覆盖内容 |
| --- | --- |
| `test/shared-mktero-conversion*.test.js` | 通过显式时序门控制生命周期竞态 |
| `test/mktero-sharing-boundaries.test.js` | 组合真实 service、extractor 和 HTTP client，使用模拟传输 |
| `test/mktero-sharing-response-cleanup.test.js` | 通过真实共享协调器和 HTTP client 检查迟到建单响应与 DELETE 响应体时限 |
| `test/bootstrap-hosted-sharing.test.js` | 在 JSDOM 中走真实 bootstrap 入口 |

这些测试不使用生产数据或网络，仍需真实 Zotero 的人工验收。

## 图组回归语料

`test/fixtures/figure-corpus/` 保存已发布图组恢复修复的论文的图组判定结果，包括合成图、保留页和边界框。除非指向本机上的 MinerU 结果压缩包，否则对应测试会被跳过。压缩包本身从不提交。

```bash
export MKTERO_FIGURE_CORPUS="$HOME/mktero-figure-corpus"  # <id>.zip 或 <id>/result.zip
node scripts/figure-corpus-check.mjs                      # 比较并打印差异
node scripts/figure-corpus-check.mjs --update             # 复核后刷新
```

1. 修改图组规则后，运行检查并复核差异。
2. 验证新论文时，把它的压缩包加入语料目录，并提交生成的 `<id>.expected.json`。
3. 缺失的压缩包会被跳过。压缩包字节发生变化时会失败，直到重新验证并更新。

图组输入现在来自 MinerU 文档 IR。此前记录的 10 份期望由旧图组适配器生成：

`beyond-alignment`、`brainbench`、`clinical-llm`、`envharness`、`externalization`、`menstrual-wearable`、`mosaic`、`neuradock`、`olfactory`、`parsimonious`。

请在有这些压缩包的机器上对它们重新运行 `--update`，并复核差异。

## 阅读质量回归语料

`scripts/reading-corpus-check.mjs` 统计 MinerU 管线对本机每个压缩包（`<id>.zip`）的阅读结果，并与 `test/fixtures/reading-corpus/<id>.expected.json` 比较。期望文件只保存计数和 12 位标题哈希，不保存论文正文。目录取自 `MKTERO_READING_CORPUS`，未设置时使用 `MKTERO_FIGURE_CORPUS`。

```bash
node scripts/reading-corpus-check.mjs --pipeline ir            # 比较并打印表格
node scripts/reading-corpus-check.mjs --pipeline ir --update   # 复核后刷新
node scripts/reading-corpus-check.mjs --pipeline ir-pdf        # 同时用 PDF.js 读取压缩包中的 PDF
node scripts/reading-corpus-check.mjs --ids a,b --json         # 输出部分论文的完整报告
```

- `ir` 只读取 MinerU 结果。
- `ir-pdf` 还会像扩展一样，用 PDF.js 读取 MinerU 放在压缩包里的 `*_origin.pdf`，让段落合并和标题层级使用 PDF 的行与字体。
- 两种管线都有提交的期望值，复核后分别用 `--update` 刷新。

| 指标 | 含义 |
| --- | --- |
| `breaks` | 两个正文段读起来是同一句话（前段末尾未结束、后段小写开头），中间只隔着浮动体或行间公式；按来源映射给出的 PDF 边界分为 `page`、`column`、`float`、`math`、`adjacent`、`unmapped` |
| `chrome` | 被 MinerU 丢弃的页眉、页脚、页码、侧边文字（规范化后不少于 8 个字符）仍作为可见块出现的次数 |
| `textCoverage` | 版面文本 span 的 8 字符分片出现在可见文本中的比例 |
| `pageNotes` | 至少 80% 分片可见的页脚注数量 |
| `headings` | 大纲条数、层级分布，以及 `level:title`（`层级:标题`）的哈希序列 |
| `sourceMap` | 被来源映射覆盖的可见顶层块比例，以及跨多页的条目数 |
| `floats` | 输出中的图片、表格、算法、代码和行间公式数量，与版面中的数量对比 |
| `references` | 解析出的参考文献条目数，与版面 `ref_text` 块数对比 |

## 下游阅读器客户端

扩展的渲染器与文档管线都是纯模块，别的客户端可以把它们打包进去，用与 Zotero 相同
的方式渲染论文。本仓库不构建任何客户端的产物，也不读取别的仓库：下游 App 自己负责
打包、提交产物、以及校验产物是否过期。

本仓库保证的是输入的形状，不是打包方式：

- `src/markdown/markdown-html.js` 导出 `renderMarkdownHTML(markdown,
  { resolveImageURL, translate })`：Markdown 进，阅读 HTML 出。不依赖 Zotero、
  网络或 DOM。
- `src/mineru/document/prepare.js` 导出 `prepareMinerUDocument(bundle,
  { pdfText })`：MinerU 结果进，按阅读顺序排好的 Markdown 出。传 `pdfText: null`
  会跳过逐词校正，但保留排序、页面装饰剔除与标题层级推断——这正是不带 PDF 视图的
  客户端需要的。
- `src/i18n/localization.js` 导出 `createLocalization({ zoteroLocale })`，
  客户端可以用 `en-US` 或 `zh-CN` 渲染同一批标签。
- `ui/markdown.css` 是唯一的阅读器样式表。想要桌面观感的客户端从它派生自己的样式
  表，而不是重新手写一遍规则。

两条规则让这个边界可用：

- 不要把 Zotero 全局、`document`、`window` 或网络访问引入 `src/markdown/` 与
  `src/mineru/document/`。下游 bundle 运行在没有这些东西的环境里。
- Markdown 解析器只保留 `marked`、`katex` 与 `@lezer/markdown`。下游客户端钉住同样
  的版本；换一个解析器，同一份 Markdown 就会渲染出不同的文档。

因此改动 `ui/markdown.css` 或渲染器，等于要求每个下游客户端在自己的构建里跟上。请
在 PR 描述里写明这一点；本仓库没有需要重新生成的共享产物。

## 浏览器预览

`preview/` 在普通网页中挂载真实的 Markdown 阅读器（`createMarkdownTabView`），外层是 Zotero 风格的窗口和一篇示例论文，用于网站展示和浏览器兼容检查。论文、译文、注释和模拟的 PDF 页面都是夹具数据；页面不发出任何网络请求，CSP 也禁止对外连接。XPI 不包含这部分内容。

### 构建与检查

```bash
npm run build:preview   # 生成 build/preview/，用静态服务打开该目录
```

- 加上 `?lang=zh` 使用中文界面。
- 加上 `?diagnostics=1` 运行页内检查并显示结果。

要检查多个浏览器引擎，把 `MKTERO_PLAYWRIGHT_PATH` 指向一个已安装的 Playwright 模块。Playwright 不是本仓库的依赖。

```bash
export MKTERO_PLAYWRIGHT_PATH=/path/to/node_modules/playwright/index.mjs
MKTERO_PREVIEW_BROWSERS=chromium,chrome,firefox,webkit,safari \
  node scripts/validate-preview-browser.mjs
```

报告和截图写入 `build/preview-validation/`。真实 Safari 通过 `safaridriver` 运行，需要在 Safari 设置中开启“允许远程自动化”。未开启时，Safari 会被标记为跳过。

### 打包与嵌入

每次发布都会附带预览包。网站在部署时下载并校验它，不在网站仓库里保存副本。

```bash
npm run package:preview   # 生成 build/mktero-preview-<version>.tar.gz 和 .sha256
```

压缩包只含普通文件，按路径排序，权限和时间固定。它还带有 `mktero-preview.json`，其中包含 `version`、`commit` 和 `embed`。

`embed` 即 `scripts/build-preview.mjs` 里的 `PREVIEW_EMBED_VERSION`。以下任一项变化时都要递增它，让旧版网站跳过无法驱动的新预览：

- 查询参数（`lang`、`frame`、`theme`）；
- `mktero-preview-ready` 消息；
- 沙箱；
- 1280x800 布局。

网站把预览放在带沙箱的 iframe 里，并使用 `preview/embed.js` 中的 CSP。不透明来源没有存储和 cookie，不能联网，也不能导航顶层页面。预览不得依赖其中任何一项。

校验脚本也会这样加载它（`/__embed.html`）。预览无法启动、自检失败或能读到存储时，都会判为失败。
