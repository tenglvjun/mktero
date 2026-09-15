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
