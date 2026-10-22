# 开发

[English](./development.md) · [简体中文](./development.zh-CN.md) · [返回 README](../README.zh-CN.md)

使用 [`.node-version`](../.node-version) 指定的 Node.js 版本，目前为 `24.15.0`。Node.js 25 不在支持范围内。

```bash
npm ci
npm run check
npm test
npm run build
```

迭代时可以使用 `node --test test/<name>.test.js` 运行单个测试。构建会在 `build/` 下生成可复现的 XPI、SHA-256 校验文件和 `build/updates.json`；`build/` 与 `node_modules/` 都是生成目录并已被忽略。

发布前请保持 `manifest.json`、`package.json` 和 `package-lock.json` 的版本一致。仓库架构、安全约束和贡献检查清单见 [AGENTS.md](../AGENTS.md)。

## 图组回归语料

`test/fixtures/figure-corpus/` 保存了已发布图组恢复修复的论文的图组判定结果（合成图、保留页、边界框）。除非指向本机上的 MinerU 结果压缩包，否则对应测试会被跳过；压缩包本身从不提交。

```bash
export MKTERO_FIGURE_CORPUS="$HOME/mktero-figure-corpus"  # <id>.zip 或 <id>/result.zip
node scripts/figure-corpus-check.mjs                      # 比较并打印差异
node scripts/figure-corpus-check.mjs --update             # 复核后刷新
```

修改图组规则后，运行检查并复核差异。验证新论文时，把它的压缩包加入语料目录，并提交生成的 `<id>.expected.json`。缺失的压缩包会被跳过；压缩包字节发生变化时会失败，直到重新验证并更新。

## 浏览器预览

`preview/` 在普通网页中挂载真实的 Markdown 阅读器（`createMarkdownTabView`），外层是 Zotero 风格的窗口和一篇示例论文，用于网站展示和浏览器兼容检查。论文、译文、批注和模拟的 PDF 页面都是夹具数据；页面不发出任何网络请求，CSP 也禁止对外连接。XPI 不包含这部分内容。

```bash
npm run build:preview   # 生成 build/preview/，用静态服务打开该目录
```

加上 `?lang=zh` 使用中文界面，加上 `?diagnostics=1` 运行页内检查并显示结果。要检查多个浏览器引擎，把 `MKTERO_PLAYWRIGHT_PATH` 指向一个已安装的 Playwright 模块（它不是本仓库的依赖）：

```bash
export MKTERO_PLAYWRIGHT_PATH=/path/to/node_modules/playwright/index.mjs
MKTERO_PREVIEW_BROWSERS=chromium,chrome,firefox,webkit,safari \
  node scripts/validate-preview-browser.mjs
```

报告和截图写入 `build/preview-validation/`。真实 Safari 通过 `safaridriver` 运行，需要在 Safari 设置中开启“允许远程自动化”；未开启时 Safari 会被标记为跳过。

每次发布也会附带预览包。网站在部署时下载并校验它，不在网站仓库里保存副本：

```bash
npm run package:preview   # 生成 build/mktero-preview-<version>.tar.gz 和 .sha256
```

压缩包只含普通文件，按路径排序，权限和时间固定，并带有 `mktero-preview.json`（`version`、`commit`、`embed`）。`embed` 即 `scripts/build-preview.mjs` 里的 `PREVIEW_EMBED_VERSION`；查询参数（`lang`、`frame`、`theme`）、`mktero-preview-ready` 消息、沙箱或 1280x800 布局变化时要递增它，这样旧版网站会跳过新预览，而不是嵌入一个它驱动不了的页面。

网站把预览放在带沙箱的 iframe 里，并使用 `preview/embed.js` 中的 CSP：不透明来源，没有存储和 cookie，不能联网，也不能导航顶层页面。预览不得依赖其中任何一项。校验脚本也会这样加载它（`/__embed.html`），预览无法启动、自检失败或能读到存储时都会判为失败。
