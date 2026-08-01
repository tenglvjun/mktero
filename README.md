# Mktero

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Zotero](https://img.shields.io/badge/Zotero-7%20%7C%208%20%7C%209-cc2936.svg)](https://www.zotero.org/)

Mktero 是一个适用于 Zotero 7、8 和 9 的 PDF 阅读插件。它通过 MinerU 将本地
PDF 转换为 Markdown，并在 Zotero 标签页中以只读、行内渲染的方式展示正文、
公式、表格、图片和学术引用。

```text
Zotero 本地 PDF -> MinerU VLM 解析 -> full.md 与图片 -> 规范化与安全渲染 -> Mktero 标签页
                                                        -> 本地内容缓存
```

## 主要功能

- 从 PDF 阅读器工具栏的文件图标按钮打开当前附件。
- 在文库中右键单个 PDF 或带有 PDF 附件的条目，通过
  `Read as Markdown with Mktero` 打开；普通条目会使用找到的第一个 PDF 附件。
- 使用 MinerU VLM 模型执行 OCR，并启用公式和表格识别。
- 在转换标签页中显示排队、上传、解析和下载进度；关闭标签页只会停止本地等待。PDF
  已完成上传时，MinerU 任务可以继续执行，再次打开相同 PDF 会显示正在恢复上次转换，
  并明确提示不会重复上传。
- 可通过 Markdown 内容区域右下角的刷新按钮重新解析当前 PDF；操作提示会明确说明 PDF
  将再次上传，并可能消耗转换服务额度。重新解析期间保留当前内容，新结果失败时继续显示
  原结果。
- 以 CodeMirror 6 只读视图行内渲染标题、段落、强调、列表、任务列表、引用、代码、
  GFM/HTML 表格、MinerU 算法块、无底色 KaTeX 公式、图片及学术图表标题，并渲染图片
  标题中的行内 LaTeX；共享图题的多子图会把 MinerU 重复提取的坐标轴标签居中保留在
  对应子图下方。
- 保守修复 MinerU 在句中产生的段落断裂，包括被拆开的作者—年份引用，不合并完整段落或
  Markdown 块结构。
- 自动生成 Markdown 目录。目录支持点击跳转、拖动调整宽度，也可通过按钮或双击边缘收起。
- 识别数字引用、上标引用以及数字或字母作者单位；作者单位编号与等贡献、通讯作者等符号
  相邻时会保留符号并链接编号，也会保守恢复 MinerU 连续丢失的字母单位上标。可从错位的
  参考文献标题后恢复末尾连续编号文献表，混有统计括号数字或分页后续编号时不会误标为
  论文引用；悬停时预览文献内容，点击后跳转并临时高亮目标。
- 识别正文中的表格与图片引用，包括 MinerU 分开输出的表号标题与表题；未单独提取的子图
  引用会回退到父图，悬停时显示预览，点击后跳转并临时高亮对应图表。
- 点击文档图片可打开全屏预览，支持 25% 至 400% 缩放和拖动查看。
- 在 Markdown 正文和渲染后的表格、图题等内容中显示 Zotero PDF 高亮与下划线标注，
  保留标注颜色；匹配时兼容 PDF 与 MinerU 之间的智能引号、连字符、数字引用、句末
  脚注上标和商标上标格式差异；悬停或键盘聚焦划词时可更改颜色或删除对应 Zotero 标注，
  点击划词可新增或编辑评论；带评论的标注会在起始左上角显示笔记图标，点击或用键盘
  激活图标可继续修改评论。
- 在普通 Markdown 正文中拖动划词后显示紧凑操作条，可选择颜色立即保存 Markdown 高亮，
  或直接添加笔记；高亮和笔记会立即保存，不会阻塞 Markdown 交互。对应 PDF 已打开时会
  立即同步 Zotero 标注；未打开时保留为待同步记录，等用户以后主动打开 PDF 时再同步，
  不会仅为同步而创建 PDF 标签页。右侧笔记栏会标明待同步记录；同步失败时显示安全的失败
  原因并允许手动重试，重试不会重新上传或解析 PDF。同步成功后，在 Markdown 或 PDF 中
  改色、修改笔记和删除都会同步，已打开的 Markdown 标签页会自动刷新 PDF 端的标注变化。
- 在阅读器右侧笔记面板中按文档顺序显示划词、评论、颜色和 PDF 页码；点击已定位的
  笔记可直接跳转到 Markdown 对应位置。已同步到 Zotero 的标注还可从对应按钮打开 PDF
  并定位原标注；即使该标注未能匹配到 Markdown，也可以回到 PDF 核对。右侧笔记面板与
  左侧目录均可拖动调宽、通过按钮或双击分隔线展开和收起。
- 按 PDF 内容与解析配置缓存 Markdown 和图片；未变化的 PDF 可直接从本地缓存打开。
- 支持英文和简体中文界面；自动跟随 Zotero 的显示语言，其他语言回退为英文。
- 阅读器操作、侧栏、图片预览、加载状态和笔记标记统一使用 Lucide SVG 图标。
- 在扩展、设置、右键菜单和 Markdown 标签页中统一使用 Mktero SVG Logo。

## 使用要求

- Zotero `7.0` 至 `9.0.*`
- 可在本机访问的 PDF 附件
- 用于首次转换或缓存未命中时的 [MinerU API Token](https://mineru.net/apiManage/token)
- 能够访问 MinerU API 的网络环境

文件大小、页数、账户额度和服务可用性由 MinerU API 决定，请以
[MinerU API 文档](https://mineru.net/apiManage/docs)为准。

## 安装

### 安装 XPI

1. 从 [GitHub Releases](https://github.com/tenglvjun/mktero/releases) 下载与当前版本对应的
   `mktero-<version>.xpi`。
2. 在 Zotero 中打开 `工具 -> 插件`。
3. 点击插件管理器右上角的齿轮按钮，选择 `Install Add-on From File...`。
4. 选择 XPI 文件并按 Zotero 提示完成安装。

通过 GitHub Release 安装后，Zotero 会读取最新正式 Release 中的 `updates.json` 检查更新。
草稿和预发布版本不会成为自动更新目标。

当前仓库也可以直接从源码构建 XPI，参见[开发](#开发)。

## 配置

安装后打开 `设置 -> Mktero`。

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| API Token | 空 | 缓存未命中时必填，用于调用 MinerU API |
| Reuse conversion results | 开启 | 复用相同 PDF 内容和解析配置对应的本地结果；关闭后仍会恢复已上传但未完成的任务 |

API Token 会作为普通首选项保存在当前 Zotero 配置文件中，不会加密。

## 使用方法

1. 在 `设置 -> Mktero` 中配置 API Token。
2. 打开 PDF 后点击阅读器工具栏中的文件图标；或者在文库中右键单个 PDF/条目并选择
   `Read as Markdown with Mktero`。
3. Mktero 会创建一个临时 Zotero 标签页并显示转换进度。相同 PDF 已有有效缓存时，
   会跳过上传和远程解析；已有未完成任务时，会继续查询该任务而不再上传 PDF。
4. 在只读视图中选择和复制文本，使用 `Ctrl+F` 或 `Cmd+F` 搜索，并通过目录、引用预览
   和图表预览浏览文档。已有的 Zotero PDF 高亮和下划线会使用原标注颜色显示；悬停划词
   可更改颜色或删除标注，点击划词可添加评论，点击已有笔记图标可修改评论。拖动选中
   普通 Markdown 文本后，可从选区旁的操作条选择高亮颜色或直接添加笔记；Markdown
   高亮会立即保存并显示。对应 PDF 已打开时会立即创建 Zotero 标注；否则会在用户以后
   主动打开该 PDF 时同步，Mktero 不会仅为同步而创建 PDF 标签页。右侧笔记栏中的
   外部链接图标可打开 PDF 并定位已经同步到 Zotero 的原标注。
5. 需要忽略缓存并重新解析时，点击 Markdown 内容区域右下角的刷新按钮。该操作会再次上传
   PDF，并可能消耗转换服务额度。

Mktero 标签页不会写入 Zotero 会话状态；关闭 Zotero 后不会自动恢复这些标签页。关闭标签页
或 Zotero 会停止当前的本地查询，但不会远程取消已完成上传的 MinerU 任务。以后再次主动打开
相同 PDF 时，Mktero 会在任务记录有效期内继续查询结果。

## 缓存与隐私

缓存默认位于当前 Zotero 配置文件的 `mktero-cache/v1` 目录：

- 缓存键由 PDF 内容的 SHA-256 和 MinerU 解析配置共同生成。
- 默认最多保留 100 份文档、占用 512 MiB；超过限制时优先清理最久未访问的结果。
- 连续 30 天未访问的结果会过期，并在插件启动或读取缓存时清理。
- 可在 `设置 -> Mktero -> Local Markdown cache` 查看占用并手动清空缓存。
- 缓存中的 Markdown 和图片未加密，只保存在本机，不通过 Zotero 同步。

缓存未命中时，Mktero 会把完整 PDF 上传到 MinerU 进行解析。返回的图片仅用于当前
Markdown 标签页和本地缓存，不会导入为 Zotero 附件。

为避免关闭标签页或重启 Zotero 后重复上传，Mktero 会把已上传但尚未取得结果的任务元数据
保存在当前 Zotero 配置文件的 `mktero-conversions/v1` 目录。记录使用 PDF 内容与解析配置的
SHA-256 键，只包含 MinerU `batchID`、Mktero 生成的 `dataID` 和上传时间，不包含 API Token、
PDF 内容、文件名、本地路径、上传地址、下载地址或 API 原始响应。记录在本机未加密，最多
保留 256 条，24 小时后过期；任务成功或确认无法恢复后会删除。任务恢复独立于已完成结果的
缓存开关，即使关闭 `Reuse conversion results`，也不会因此重复提交仍可恢复的远程任务。

PDF 标注从当前 Zotero 文库的本地标注条目中读取，不会发送给 MinerU，也不会写入
Mktero Markdown 缓存。每次转换或从缓存打开文档时都会重新读取标注；评论新增或修改、
改色和删除操作都会直接保存到当前 Zotero 文库。

在 Markdown 中新建的高亮和笔记会先保存在当前 Zotero 配置文件的
`mktero-annotations/v1` 目录中。对应 PDF 已打开时会立即尝试写入 Zotero 标注；否则记录
会一直保留，等用户主动打开 PDF 后再同步，不会为此新建 PDF 标签页。同步成功后由 Zotero
负责本地保存与同步，并移除临时的 Mktero 本地记录；内容不会发送给 MinerU。只有原文能
在 PDF 中可靠定位时才会同步，失败的记录会保留在原目录中，不会猜测位置。
右侧笔记栏会区分待同步与同步失败；失败原因仅使用预定义类别，不显示底层错误详情，用户
可以从对应笔记手动重试同步。

## 安全边界与当前限制

- Markdown 内容仍是只读视图，不支持编辑、保存或导出；从 PDF 或 Markdown 发起的划词、
  笔记、改色和删除都写入当前 Zotero 文库中的 PDF 标注。
- 当前只显示具有划词文本的 Zotero 高亮和下划线标注；独立便签、图片、区域和手写标注
  不会显示。MinerU 的 OCR、断行或重排可能使少量划词无法可靠定位；存在多个候选位置时
  插件不会猜测或错误高亮。
- 新建 Markdown 标注时，选区需要位于普通正文或同一个已渲染内容块内；跨越代码块、
  表格等渲染边界的选区不会显示操作条，以免保存无法完整显示的高亮。
- 从 Markdown 新建标注时会先立即保存本地高亮。对应 PDF 已打开时会同步 Zotero PDF
  标注；否则保持待同步状态，直到用户主动打开 PDF，插件不会自动打开前台或后台 PDF
  标签页。同步时，短文本需要等待 PDF 全文完成唯一定位；较长段落在单一结果稳定后即可
  同步。PDF 文本层在换行处保留的断词连字符会在相关页面文本可用后自动兼容，无需等待
  剩余页面提取完成；找不到文字、存在多个候选、读取器初始化或文本搜索超时时会保留本地
  高亮，不会猜测位置，也不会阻塞 Markdown 划词交互。
- 仅支持具有本地文件的 Zotero PDF 附件；缺失或尚未下载的附件无法转换。
- 结果压缩包必须包含 `full.md`。插件只加载其中的 GIF、JPEG、PNG 和 WebP 图片。
- Markdown 图片只能引用当前 MinerU 结果中的本地图片，不会从外部地址加载图片。
- 可打开的链接协议限定为 `http`、`https`、`zotero` 和当前文档片段。
- 原始 HTML 默认转义；MinerU 表格只允许经过清理的有限标签与属性。
- 单个结果压缩包、Markdown、图片及公式渲染均设置了本地资源上限，超限时会停止处理。

## 开发

开发环境要求：

- Node.js `24.15.0`（建议由版本管理器读取 `.node-version`，Node.js 25 不在依赖支持范围内）
- 使用独立开发配置文件的 Zotero 7、8 或 9

安装依赖并完成全部验证：

```bash
npm ci
npm run check
npm test
npm run build
```

构建结果位于：

- `build/package/`：未压缩插件目录
- `build/mktero-0.2.3.xpi`：可安装插件包
- `build/mktero-0.2.3.xpi.sha256`：只引用 XPI 文件名的 SHA-256 校验文件
- `build/updates.json`：与当前版本、下载地址和 XPI 哈希一致的 Zotero 更新清单

XPI 中的文件顺序和时间戳固定；相同源码与依赖连续构建会得到相同的 XPI 哈希。

源码调试时，可在 Zotero 配置文件的 `extensions` 目录中新建名为
`mktero@tenglvjun.github.io` 的扩展代理文件，文件内容为本仓库
`build/package` 的绝对路径。每次启动 Zotero 前先运行 `npm run build`。

项目主要目录：

```text
src/bootstrap.js   Zotero 生命周期与依赖装配
src/mineru/        MinerU API、解析配置和结果解包
src/cache/         Markdown 与图片缓存
src/icons/         Lucide 图标定义与跨 Zotero 窗口的 SVG 创建器
src/i18n/          英文、简体中文消息与 Zotero 语言匹配逻辑
src/markdown/      Markdown 规范化、分析和安全渲染
src/editor/        CodeMirror 只读视图与引用/图片交互
src/ui/            Zotero 工具栏、菜单、标签页和设置页
ui/                打包使用的 XHTML、CSS 与图标
test/              Node.js 单元和 DOM 行为测试
scripts/build.mjs  esbuild 与 XPI 打包脚本
```

更完整的修改约束与验证清单见 [AGENTS.md](./AGENTS.md)。

### 发布新版本

发布前必须同步更新 `manifest.json`、`package.json` 和 `package-lock.json` 中的版本号并提交。
随后创建带 `v` 前缀、与清单版本完全一致的标签：

```bash
git tag v0.2.3
git push origin v0.2.3
```

标签推送后，[Release 工作流](./.github/workflows/release.yml)会自动执行语法检查、完整测试
和可复现 XPI 构建，生成构建来源证明，然后创建对应的 GitHub Release，并上传 XPI、
SHA-256 校验文件和 Zotero 更新清单。标签与 `manifest.json` 版本不一致，或同名 Release
已经存在时，工作流会直接失败，不会覆盖已发布资产。

日常推送到 `main` 或向 `main` 提交 Pull Request 时，[Test 工作流](./.github/workflows/test.yml)
会自动执行相同的语法检查、完整测试和构建，但不会创建 Release；
[CodeQL 工作流](./.github/workflows/codeql.yml)会分析 JavaScript 安全问题。Dependabot 每周
检查 npm 与 GitHub Actions 依赖更新。

## 转换排障

在 Zotero 中打开 `帮助 -> 调试输出日志`，启用日志后重新执行转换操作，再选择查看输出并
筛选 `Mktero:`。常见阶段如下：

- `requesting a MinerU upload URL`：正在创建 MinerU 任务。
- `uploading PDF to MinerU`：正在上传本地 PDF。
- `PDF upload completed; MinerU is parsing`：上传成功，MinerU 正在解析。
- `MinerU parsing finished; downloading the result`：正在下载结果压缩包。
- `completed from local cache; MinerU upload skipped`：已命中本地缓存，没有发起上传。
- `completed from a resumed MinerU task`：恢复了此前已上传的任务，没有重复上传。
- `resuming an uploaded MinerU task; PDF upload skipped`：正在继续查询此前已上传的任务。
- `completed through a new MinerU task`：本次新建并上传了 MinerU 任务。

日志不会记录 API Token、预签名上传地址、`batchID` 或 PDF 内容。若仍然失败，请优先检查
本地附件是否可用、Token 是否有效，以及当前网络能否访问 MinerU。

## License

[MIT](./LICENSE) © 2026 Tony
