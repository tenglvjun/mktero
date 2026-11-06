# 快速上手

[English](./getting-started.md) · [简体中文](./getting-started.zh-CN.md) · [返回 README](../README.zh-CN.md)

安装 Mktero，选择新转换会把 PDF 发送到哪里，再打开第一篇论文。处理敏感文档前，请先阅读[数据与隐私](./privacy.zh-CN.md)。

## 准备条件

- **Zotero：**桌面版 `7.0` 至 `10.0.*`。
- **PDF：**已下载、能在本机访问的附件。
- **账号：**默认托管转换需要 Mktero 账号，无需 MinerU 或 Mistral 密钥。
- **网络：**新的转换需要能访问 Mktero 或你选择的转换服务。

启用本地缓存后，可以离线导入受支持的 llm-for-zotero 本地结果，并重新打开已保存的副本，无需账号或转换服务密钥。
见[导入本地结果](./conversion.zh-CN.md#导入-llm-for-zotero-本地结果)。

界面跟随 Zotero 的英文或简体中文显示语言，其他语言回退为英文。

## 安装

1. 从 [GitHub Releases](https://github.com/tenglvjun/mktero/releases/latest) 下载最新的 `mktero-<version>.xpi`。
2. 在 Zotero 中打开 `工具 -> 插件`。
3. 打开齿轮菜单，选择 `Install Add-on From File...`。
4. 选择 XPI 文件并按 Zotero 提示完成安装。

正式 GitHub Release 可以通过 Zotero 自动更新；草稿和预发布版本不会成为自动更新目标。

## 登录或选择转换服务

1. 打开 `设置 -> Mktero`，进入`转换`页。
2. 保留默认的 `Mktero` 服务，在这里登录或注册。没有可用缓存的新转换会把完整 PDF 发送到你账号所使用的 Mktero 服务，无需另外的 OCR 密钥。
3. 若要自备转换服务，改选 [MinerU](https://mineru.net/) 或 [Mistral OCR 4.1](https://docs.mistral.ai/models/ocr-4-1)。完整 PDF 会改发到那里，不再发到 Mktero。

MinerU 云端和 [Mistral](https://console.mistral.ai/api-keys/) 需要你自己的 API key，也可以选择自部署的 MinerU 4.0 服务，其密钥可选。
转换方式见[选择转换服务](./conversion.zh-CN.md#选择转换服务)，MinerU 认证问题见[配置](./configuration.zh-CN.md)。

AI 功能和阅读选项均可选。AI 翻译使用你自己的厂商密钥；每个厂商分别保存模型、密钥和相关设置。
凭据作为普通的未加密首选项保存在当前 Zotero 配置文件中。所有设置项见[配置](./configuration.zh-CN.md)。

文件大小、页数、额度和服务可用性由所选转换服务决定。新转换前，请查看[页数与大小限制](./conversion.zh-CN.md#页数与大小限制)和[托管转换日额度](./conversion.zh-CN.md#托管转换日额度)。

## 阅读第一篇 PDF

1. 在 Zotero 中打开 PDF，点击阅读器工具栏的 Mktero 文件图标。也可以右键 PDF 附件或其父文献条目，选择`使用 Mktero 阅读 Markdown`。
2. 在临时 Mktero 标签页中查看上传、转换和下载进度。存在有效缓存时会跳过远程转换。
3. 使用目录、`Cmd/Ctrl+F`、引用和图表预览、来源链接、`注释`分段和笔记栏阅读文档。

Mktero 标签页只在当前会话中保留。关闭标签页、取消任务、恢复阅读位置和强制重新解析的规则，见[标签页、取消与重新解析](./conversion.zh-CN.md#标签页取消与重新解析)。

## 下一步

| 任务 | 文档 |
| --- | --- |
| 准备所选条目或分类，无需为每篇 PDF 打开标签页 | [批量准备 PDF](./conversion.zh-CN.md#批量准备-pdf) |
| 导入 llm-for-zotero 已解析的受支持结果 | [导入本地结果](./conversion.zh-CN.md#导入-llm-for-zotero-本地结果) |
| 查看哪些条目已有可读的 Markdown | [Markdown 状态](./conversion.zh-CN.md#查看哪些条目已有-markdown) |
| 导航、调整阅读视图或翻译 | [阅读](./reading.zh-CN.md) |
| 高亮、写 Zotero 笔记或校对识别错误 | [注释、笔记与校对](./annotations.zh-CN.md) |
| 导入参考文献、保存快照或导出到文件夹、Obsidian | [参考文献与导出](./references-and-export.zh-CN.md) |
| 了解缓存清理会保留和移除哪些内容 | [本地缓存清理](./conversion.zh-CN.md#本地缓存清理) |
