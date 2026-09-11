# 完整 Figure 恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一次完成多子图断组修复、公共 Figure 结构、原 PDF 完整图区渲染，以及阅读、缓存、修订、翻译、引用、快照和导出的闭环。

**Architecture:** 服务商先产出保留版面证据的 FigureInput；公共恢复服务绑定源范围、判断图组、渲染 PNG，成功后按精确范围原子替换。然后运行原有正文归一化，绑定最终 figureMap 并提交缓存。可读 Markdown 使用普通图片语法，图组原始成员与 OCR 片段保存在有界元数据中。

**Tech Stack:** JavaScript ES modules、Node.js 24.15.0、Zotero 7–10、Firefox 115、PDF.js、fflate、CodeMirror 6、现有 Markdown parser、node:test、jsdom/linkedom。

**Spec:** [完整 Figure 恢复设计](../specs/2026-09-11-figure-region-restoration-design.md)。实现者必须同时阅读设计与本计划；字段、阈值、回退和资源上限以设计为准。

## Global Constraints

- 使用 `.node-version` 指定的 Node.js 24.15.0；禁止使用 Node.js 25。
- 运行时代码使用 JavaScript ES modules、显式 `.js` 导入、四空格缩进、单引号、分号和命名导出。
- esbuild 输出 Firefox 115 兼容包；支持 Zotero 7、8、9、10。
- `src/bootstrap.js` 保持组合根；纯图组算法不得导入 Zotero、DOM、IOUtils 或 Node.js API。
- 不新增生产依赖；复用现有 PDF.js、fflate、Markdown parser 和测试工具。
- 保留所有生命周期入口、一 PDF 一活动标签页、转换取消和 Zotero 9 工具栏清理兼容逻辑。
- 保留只读阅读状态以及现有受控纠错流程，不增加图片编辑或手动重排工作流。
- 新增用户可见文字进入 `src/i18n/localization.js`，英文和简体中文同步；HTML 节点使用 XHTML 命名空间。
- 不加载远程 Markdown 图片；生成 PNG 只通过受控的本地资产解析器显示。
- API token、上传 URL、PDF 内容、原始认证响应和 OCR 文字不得出现在日志中。
- 缓存错误不使成功转换失败；保持原子替换、串行操作、过期和总量限制。
- 新源码加入 `npm run check`；新非导入运行时资产加入 `scripts/build.mjs`；不手改 `build/` 或 `node_modules/`。
- 实现交付前运行相关窄测试、`npm run check`、`npm test`、`npm run build`，并完成 Zotero 实际 PDF 验证。
- README.md 与 README.zh-CN.md 同步说明行为、限制、存储与隐私变化。

上方两个 superpowers 执行技能未在本次会话的可用技能中列出。执行时若仍未安装，按本计划顺序使用现有开发工具推进、测试和自审；不把缺少执行包装技能当作省略验收的理由。当前交付是开发方案。

---

## 交付方式与依赖

一个开发分支连续完成以下 15 个任务，在同一个 PR 中交付。每个任务有独立提交便于审查和回退，三个阶段全部完成后才视为本功能完成。下表是依赖关系，不要求同时运行多个 agent。

| 任务 | 内容 | 前置 | 对应阶段 |
| --- | --- | --- | --- |
| T01 | 旧布局标记的空行断组修复 | 无 | 第一步 |
| T02 | 公共模型、限制、可复用 fixture | T01 | 第二步 |
| T03 | 精确源范围绑定与重复文字 | T02 | 第二步 |
| T04 | MinerU 稳定/详细布局适配 | T02、T03 | 第二步 |
| T05 | Mistral decode/prepare 拆分 | T02、T03 | 第二步 |
| T06 | 图组、图注和所属文字判断 | T03、T04、T05 | 第二步 |
| T07 | PDF.js 区域渲染和平台 canvas | T02 | 第三步 |
| T08 | 原子图组替换与最终 figureMap | T03、T06、T07 | 第二、三步 |
| T09 | 公共恢复服务、转换接入与取消 | T04–T08 | 三步闭环 |
| T10 | 缓存和 parser profile | T08、T09 | 三步闭环 |
| T11 | 修订、旧基线与偏移变换 | T08、T10 | 三步闭环 |
| T12 | 正文、图目录、引用、预览统一 | T08、T09 | 三步闭环 |
| T13 | 翻译和双语视图 | T11、T12 | 三步闭环 |
| T14 | 快照与导出 | T10–T13 | 三步闭环 |
| T15 | 完整样例、Zotero 验证与交付 | 全部 | 最终验收 |

## 文件布局

新模块和接口见设计第 13 节。新增运行时代码均位于现有 `src/`，由已有入口导入，不额外加入构建复制清单。PDF worker、CMap、字体与 WASM 复用已打包资产。新测试 PDF 只进入 test，不进入 XPI。

| 区域 | 文件 | 改动目的 |
| --- | --- | --- |
| 公共图组 | `src/figures/figure-limits.js`、`figure-model.js`、`figure-source-binding.js`、`figure-region-resolver.js` | 类型、身份、预算、源范围和归属 |
| 恢复事务 | `src/figures/figure-transaction.js`、`figure-restoration-service.js`、`figure-finalization.js` | 生成图、精确替换、最终绑定 |
| 视图与兼容 | `src/figures/figure-analysis.js`、`figure-map-transforms.js`、`legacy-figure-profiles.js` | 统一消费、纠错、旧修订 |
| MinerU | `src/mineru/zip-markdown.js`、新增 `figure-layout-adapter.js`、`mineru-result.js`、`mineru-conversion.js`、`parser-profile.js` | 详细布局、decode/restore/prepare、版本 |
| Mistral | `src/mistral/mistral-result.js`、`markdown-normalizer.js`、`mistral-conversion.js`、`parser-profile.js` | 保留 OCR 证据、拆分、移除数量猜测 |
| PDF 与平台 | 新增 `src/pdf/pdfjs-figure-region.js`、`src/platform/zotero-figure-canvas.js`；修改 `src/pdf/pdfjs-bootstrap-environment.js`、`pdfjs-page-crop.js` | 高清区域渲染、XHTML canvas、取消 |
| 组合/传递 | `src/bootstrap.js`、两家 extractor、`src/core/markdown-document-service.js`、`src/ui/markdown-tab-state.js`、`markdown-tab-presenter.js`、`markdown-window.js` | 注入渲染服务、保持结果字段与真实身份 |
| 持久化 | `src/cache/markdown-cache.js`、`src/core/markdown-revision-session.js`、`src/platform/zotero-markdown-revision-store.js` | 新 metadata、范围平移、回滚 |
| 图组消费 | `src/markdown/markdown-figures.js`、`markdown-figure-references.js`、`markdown-asset-outline.js`、`markdown-evidence.js`、`src/editor/inline-rendering.js`、`inline-markdown-editor.js`、`figure-preview-popup.js` | 完整图对象与 legacy 回退 |
| 翻译 | `src/markdown/markdown-translation-blocks.js`、`src/editor/translation-presentation.js`、`src/ai/markdown-translation-service.js` | 保护资产路径和保留 sourceId |
| 快照 | `src/core/saved-markdown-note-format.js`、`saved-markdown-open-resolver.js`、`src/platform/zotero-saved-markdown-store.js` | figureMap 附件、旧格式兼容 |
| 展示/文档 | `ui/markdown.css`、`src/i18n/localization.js`、`README.md`、`README.zh-CN.md`、`package.json` | 保真尺寸、本地化、check、说明 |

不要为了规划中的文件名创建空模块。每个新文件在对应任务里随实现和测试一同加入。

## T01：修复已标记图组的空行断组

**Files:** 修改 `src/markdown/markdown-figures.js`；测试 `test/markdown-figure-references.test.js`、`test/mistral-result.test.js`、`test/markdown-html.test.js`。

**Interfaces:** 消费已有 `parseFigureLayoutMarker()`；保留 `findAcademicFigureGroups(markdown)` 和所有旧调用签名。新增内部 `collectMarkedFigureImages(lines, startIndex, blockedLines, expectedCount)`，只供合法布局标记分支使用。

- [ ] **Step 1：先加入能够失败的真实分组回归。**

```js
test('keeps all marked panels after OCR removal leaves extra blank lines', () => {
    const source = [
        '<!-- mktero-figure-layout: columns=2 rows=2,2 -->',
        '![](images/a.png)',
        '',
        '',
        '![](images/b.png)',
        '',
        '![](images/c.png)',
        '',
        '![](images/d.png)',
        '',
        'Figure 1. Four panels.',
    ].join('\n');
    const groups = findAcademicFigureGroups(source);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].images.length, 4);
    assert.deepEqual(groups[0].gridRows, [2, 2]);
});
```

- [ ] **Step 2：运行 `node --test test/markdown-figure-references.test.js`，确认新测试因成员数不对而失败。**
- [ ] **Step 3：实现标记分支专用扫描。** 循环跨过空白行；只接受尚未被代码块屏蔽的独立图片；遇到图注、非图片正文或第二个布局标记立刻停止；收集数必须等于 expectedCount。普通未标记路径保留原保守边界。禁止全篇压缩空行。

```js
const expectedCount = gridMarker.rows.reduce((sum, count) => sum + count, 0);
const images = collectMarkedFigureImages(
    lines, imageStart, blockedLines, expectedCount
);
if (images.length !== expectedCount) continue;
```

- [ ] **Step 4：加入两个独立 Figure、代码围栏内伪标记、错误 count、0/1/2/5 个空白行、CRLF 的用例，并验证引用预览源包含四个图片路径。** Run: `node --test test/markdown-figure-references.test.js test/mistral-result.test.js test/markdown-html.test.js`，Expected: PASS。
- [ ] **Step 5：提交。** `git commit -m "fix: retain marked figure groups across OCR whitespace"`，仅暂存本任务文件。

此修复也适用于已有缓存中的合法标记。Mistral 原先的独立删文步骤在 T05/T09 被公共成功事务替代，不另外长期维护第二套删文管线。

## T02：公共模型、预算与可复用输入 fixture

**Files:** 新增 `src/figures/figure-limits.js`、`src/figures/figure-model.js`、`test/helpers/figure-fixtures.js`、`test/figure-model.test.js`；修改 `package.json`。

**Interfaces:** 产出设计第 5 节的 FigureInput/FigureMap/FigureBlueprint；导出 `validateFigureInput(input)`、`validateFigureMap(map, document)`、`cloneFigureMap(map)`、`normalizeFigureAssetPath(path, basePath)`。校验成功返回原值且不修改它，失败抛带稳定 code 的 TypeError；缓存调用方负责捕获并降级。validateFigureMap 的 document 参数为设计第 13 节的 markdown/assets/assetBasePath/markdownHash/persisted 对象；持久化校验必须提供实际计算的 hash。

- [ ] **Step 1：加入模型校验测试。** fixture 模块导出 `makeFigureInput({ boxes, provider = 'mineru', interleave = true, repeated = false, parent = true } = {})`，返回 `{ input, caption, label, axisLabel: label, bodyText, panelPaths }`。默认四框为 `[100,100,450,400]`、`[550,100,900,400]`、`[100,550,450,850]`、`[550,550,900,850]`；图片路径为 `images/panel-0.png` 等；图注为 `Figure 1. Treatment response in four panels.`；图内文字为 `Time since treatment (days)`；图外正文为 `Body text outside the figure. See Fig. 1.`。图片与文字均由追加字符串时的真实顺序构造，每个 block.sourceRanges 初始为 [] 以测试后续绑定；sourceOrdinal 在构造时固定，parent=true 时显式构造父图块。repeated=true 时两个 figure-text 块的文本都为 Accuracy，图外正文另含 Accuracy，并用不同 bbox 标识；它们各在不同图片锚点窗口内。默认页尺寸为 1000×1000 pt，frame 为经过 fixture 约定的 display-cropbox，rotation=0，caption bbox 为 `[100,880,900,950]`，正文 bbox 为 `[100,960,900,990]`。

```js
test('rejects figure ranges that escape the current document', () => {
    const markdown = '![](generated/figures/f.png)';
    const map = {
        version: 1,
        pipeline: 'figure-region-v1',
        markdownHash: null,
        figures: [],
        preserved: [],
    };
    assert.doesNotThrow(() => validateFigureMap(map, { markdown, assets: [] }));
    assert.throws(() => validateFigureInput({
        ...makeFigureInput().input,
        blocks: [{ id: 'x', sourceOrdinal: 0, pageIndex: 0, type: 'text',
            bboxKind: 'text', bbox: [100, 960, 900, 990], text: 'Body text.',
            role: 'body', rangeEvidence: 'explicit-range', sourceRanges: [{ from: 0, to: 10_000_000 }] }],
    }), { code: 'INVALID_FIGURE_RANGE' });
});
```

测试资产由同一 helper 导出 `createTestPNG(width, height)`，生成包含正确 IHDR/IDAT/IEND 和 CRC 的白色 RGBA PNG。原始 panel fixture 使用 8×8，成功 crop fixture 使用声明的真实尺寸；不要用 `[1,2,3]` 或伪 data URL 通过输出格式校验。

```js
import { zlibSync } from 'fflate';

export function createTestPNG(width, height) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width < 1 || height < 1 || width > 4096 || height > 4096
        || width * height > 8_000_000) {
        throw new RangeError('Invalid test PNG dimensions');
    }
    const scanlines = new Uint8Array(height * (1 + width * 4)).fill(255);
    for (let y = 0; y < height; y++) scanlines[y * (1 + width * 4)] = 0;
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    header[8] = 8;
    header[9] = 6;
    return concatPNGBytes([
        Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
        pngChunk('IHDR', header),
        pngChunk('IDAT', zlibSync(scanlines)),
        pngChunk('IEND', new Uint8Array()),
    ]);
}

function pngChunk(name, data) {
    const result = new Uint8Array(data.length + 12);
    const view = new DataView(result.buffer);
    view.setUint32(0, data.length);
    result.set(new TextEncoder().encode(name), 4);
    result.set(data, 8);
    let crc = 0xffffffff;
    for (const byte of result.subarray(4, 8 + data.length)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
    }
    view.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0);
    return result;
}

function concatPNGBytes(chunks) {
    const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return result;
}
```

- [ ] **Step 2：运行 `node --test test/figure-model.test.js`，Expected: FAIL，尚无导出实现。**
- [ ] **Step 3：实现模型白名单与设计第 10 节的集中上限。** 拒绝非有限、反向、越界 bbox；验证页索引、重复 ID、重叠消费范围、路径遍历/绝对/远程路径、资产引用和坐标 frame。适配器只构造白名单字段；校验器不修改对象；clone 深拷贝数组、bbox 和 provenance。hash 为 null 仅允许内存模型，持久化校验要求 64 位 hex。

```js
export const FIGURE_PIPELINE_PROFILE = 'figure-region-v1';
export const FIGURE_LIMITS = Object.freeze({
    maxPDFBytes: 256 * 1024 * 1024,
    maxPDFPages: 10_000,
    maxMarkdownBytes: 50 * 1024 * 1024,
    maxContentListBytes: 20 * 1024 * 1024,
    maxDetailedLayoutBytes: 20 * 1024 * 1024,
    maxCombinedLayoutBytes: 40 * 1024 * 1024,
    maxLayoutBlocks: 100_000,
    maxJSONNodes: 500_000,
    maxJSONDepth: 12,
    maxFigures: 1000,
    maxFiguresPerPage: 64,
    maxPanels: 256,
    maxMapBytes: 8 * 1024 * 1024,
    maxComparisons: 2_000_000,
    maxCaptionLength: 8192,
    maxFragmentLength: 65_536,
    maxCropPixels: 8_000_000,
    maxCropEdge: 4096,
    maxCropBytes: 12 * 1024 * 1024,
    maxGeneratedBytes: 64 * 1024 * 1024,
    maxTotalAssetBytes: 150 * 1024 * 1024,
    maxAssets: 1000,
    renderConcurrency: 1,
    cropTimeoutMs: 20_000,
    documentTimeoutMs: 120_000,
    defaultDpi: 192,
    padding: 2,
    geometryTolerance: 0.01,
    panelProjectionOverlap: 0.35,
    panelMinGap: 24,
    panelMaxGap: 180,
    panelGapFactor: 0.6,
    captionProjectionOverlap: 0.5,
    captionMinGap: 40,
    captionMaxGap: 120,
    captionGapFactor: 0.15,
    interiorTextRatio: 0.9,
    maxGapTextLines: 2,
    maxGapTextCodePoints: 120,
});
```

以上限制由测试通过 options.limits 覆盖为较小值；调用方不能散落另一组生产阈值。几何规则的具体公式见设计第 6 节。

- [ ] **Step 4：验证普通、边界和恶意值，以及 clone 后修改 bbox/fragments 不影响原对象。** Run: `node --test test/figure-model.test.js`，Expected: PASS。把两个新增源码加入 check。
- [ ] **Step 5：提交。** `git commit -m "feat: define bounded figure document metadata"`。

## T03：绑定真实源范围，处理重复标签

**Files:** 新增 `src/figures/figure-source-binding.js`、`test/figure-source-binding.test.js`；修改 `test/helpers/figure-fixtures.js`、`package.json`。

**Interfaces:** 消费 FigureInput；产出同形状的新 input，block.sourceRanges 指向 input.markdown，rangeEvidence 为 `explicit-range`、`unique-asset`、`anchored-sequence` 或 `unresolved`。不改变 markdown、资产或 PDF 坐标；可缺省的 block.sourceRanges 按 [] 处理。

- [ ] **Step 1：写重复轴标签与图外同词的测试。**

```js
test('binds repeated labels to their own anchored occurrences', () => {
    const { input, label } = makeFigureInput({ repeated: true });
    const bound = bindFigureSourceRanges(input);
    const axes = bound.blocks.filter(block => block.role === 'figure-text');
    assert.equal(axes.length, 2);
    assert.notDeepEqual(axes[0].sourceRanges, axes[1].sourceRanges);
    for (const axis of axes) {
        assert.equal(axis.sourceRanges.length, 1);
        const range = axis.sourceRanges[0];
        assert.equal(bound.markdown.slice(range.from, range.to), label);
    }
    assert.equal(bound.markdown, input.markdown);
});
```

另加入无锚点的同词多解，期待 unresolved；在图外增加相同文本块，期待它的范围不出现在 figure-text 成员中。

- [ ] **Step 2：Run `node --test test/figure-source-binding.test.js`，Expected: FAIL。**
- [ ] **Step 3：依设计 6.4 实现四层绑定。** 从 GFM AST 读取独立图片、段落、代码/表格排除区；按页与锚点建立索引；序列匹配只有唯一完整解时提交。normalize 比较生成逐字符原偏移表，而不是从规范化字符串索引反推范围。

```js
const resolved = (block.sourceRanges || []).filter(range => (
    Number.isSafeInteger(range.from)
    && Number.isSafeInteger(range.to)
    && range.from >= 0
    && range.to > range.from
    && range.to <= input.markdown.length
));
// 只有经内容核对、唯一性和页窗口校验的 resolved 才能写回。
```

- [ ] **Step 4：覆盖 CRLF→LF 后范围、Unicode、Markdown 转义、拆行、同路径重复图像、标题与代码块里的假图片、同词正文、跨页同词、达到比较预算；断言 unresolved 从不被候选消费。** Run: `node --test test/figure-source-binding.test.js test/markdown-source-map.test.js`，Expected: PASS。新增源码加入 check。
- [ ] **Step 5：提交。** `git commit -m "feat: bind figure members to exact Markdown ranges"`。

## T04：MinerU 详细布局与父子关系

**Files:** 修改 `src/mineru/zip-markdown.js`；新增 `src/mineru/figure-layout-adapter.js`、`test/mineru-figure-layout-adapter.test.js`；扩展 `test/zip-markdown.test.js`、`package.json`。

**Interfaces:** ZIP 提取结果增加可选 `detailedLayout: { schema: 'mineru-middle-v1', pdfInfo: [] }`，仅含白名单页/块/文本字段；`decodeMinerUFigureInput(result, options = {}) -> FigureInput` 将其与稳定 contentList、assets 和原 Markdown 对齐。缺少 detailedLayout 是正常输入。

- [ ] **Step 1：写 body 与 caption 分离、父块多图片的 fixture。** 原始 middle JSON 最小结构固定为：

```js
const middle = {
    pdf_info: [{
        page_idx: 0,
        page_size: [600, 800],
        para_blocks: [{
            type: 'image', bbox: [60, 80, 540, 752],
            blocks: [{
                type: 'image_body', bbox: [60, 80, 270, 320],
                lines: [{ spans: [{
                    type: 'image', bbox: [60, 80, 270, 320],
                    image_path: 'a.png',
                }] }],
            }, {
                type: 'image_body', bbox: [330, 80, 540, 320],
                lines: [{ spans: [{
                    type: 'image', bbox: [330, 80, 540, 320],
                    image_path: 'b.png',
                }] }],
            }, {
                type: 'image_caption', bbox: [60, 696, 540, 752],
                lines: [{ spans: [{ type: 'text', content: 'Figure 1. Two panels.' }] }],
            }],
        }],
    }],
};
```

通过 fflate.zipSync 构造 `result/full.md`、`result/paper_content_list.json`、`result/paper_middle.json` 和两张测试资产；提取、适配后断言两个 panel 共用 parentId，body bbox 为 `[100,100,450,400]`，caption bbox 为 `[100,870,900,940]`。父框不得变成任一 panel 的 bbox。

- [ ] **Step 2：Run `node --test test/mineru-figure-layout-adapter.test.js test/zip-markdown.test.js`，Expected: FAIL，新结构未读取。**
- [ ] **Step 3：实现同逻辑根下唯一 middle 文件选择、解压前后预算、有限深度遍历和白名单适配。** 根据实际存在的 assets 解析 span image_path，不能简单字符串拼接后信任路径；遍历全部 body/span，不只取第一个。

```js
const pageIndex = page.page_idx;
const [width, height] = page.page_size;
const normalized = [
    box[0] * 1000 / width,
    box[1] * 1000 / height,
    box[2] * 1000 / width,
    box[3] * 1000 / height,
];
```

这一变换只用于 middle 点坐标。稳定 contentList 保持原 0–1000；没有本体证据的 bboxKind 标为 group/unknown。

- [ ] **Step 4：测试没有 middle、多个 middle、其他结果根的同名文件、损坏 JSON、声明/实际超限、过深嵌套、路径穿越、span 资产缺失、caption 内恶意 HTML。** 可选布局失败时 full.md/图片仍可提取；日志/警告不含 raw JSON。Run 上述两文件，Expected: PASS；新增源码加入 check。
- [ ] **Step 5：提交。** `git commit -m "feat: preserve MinerU figure body and caption geometry"`。

## T05：Mistral 解析拆分并保留图内证据

**Files:** 修改 `src/mistral/mistral-result.js`、`src/mistral/markdown-normalizer.js`；扩展 `test/mistral-result.test.js`、`test/mistral-markdown-normalizer.test.js`；新增 `test/mistral-figure-input.test.js`。

**Interfaces:** `decodeMistralResult(response, options = {}) -> FigureInput` 只进行数据/资产安全规范化与必要表格引用展开；`prepareMistralResult(input) -> ConvertedDocument` 完成页序、正文流、sourceMap、chromeRanges。`normalizeMistralResult(response, options)` 变成二者的纯同步组合入口；正式带裁图路径由 T09 插入公共恢复。

- [ ] **Step 1：新增保留原始 OCR 证据的测试。**

```js
test('keeps image interior OCR text available until a crop succeeds', () => {
    const input = decodeMistralResult({ pages: [{
        index: 0,
        dimensions: { width: 1000, height: 1000 },
        markdown: '![](img-0.png)\n\nAccuracy\n\nFigure 1. Results.',
        images: [{ id: 'img-0.png', image_base64: 'data:image/png;base64,' + Buffer.from(createTestPNG(8, 8)).toString('base64') }],
        blocks: [
            { type: 'image', image_id: 'img-0.png', bbox: [100,100,900,700] },
            { type: 'text', content: 'Accuracy', bbox: [200,200,350,230] },
            { type: 'caption', content: 'Figure 1. Results.', bbox: [100,750,900,800] },
        ],
    }] });
    assert.match(input.markdown, /Accuracy/u);
    assert.ok(input.blocks.some(block => block.text === 'Accuracy'));
    assert.equal(input.blocks.find(block => block.type === 'image').bboxKind, 'visual-body');
});
```

- [ ] **Step 2：Run `node --test test/mistral-figure-input.test.js`，Expected: FAIL。**
- [ ] **Step 3：拆出 decode，复用现有 Base64、路径、tables、坐标校验。** blocks 和 images 的同一资产若 bbox 冲突则标记 missing/ambiguous geometry；不凭一个坐标覆盖另一个。取消独立 removeImageInteriorText 调用及提前丢弃 interiorTextRecords；新输入不再 allowFallback 按数量猜列。

```js
export function normalizeMistralResult(response, options = {}) {
    return prepareMistralResult(decodeMistralResult(response, options));
}
```

prepare 保持 publisher chrome 的原有保留/隐藏范围规则，不重新解码资产，不带入原始认证响应。正文唯一来源为当前 input.markdown；blocks/contentList 和页范围以该文本为准。providerState 仅保留 pageOrder/chromeHints 等白名单信息，不能残留旧 pages[].markdown 并在 prepare 时重新插回已消费的文字。

- [ ] **Step 4：更新旧“纯 normalizer 删除图内文字”的测试，验证无渲染能力时保留文字；它原来的“成功后没有重复正文”验收移到 T09 的真实恢复服务链路。** 保留全部既有安全、页序、table、正文/页眉回归。Run: `node --test test/mistral-figure-input.test.js test/mistral-result.test.js test/mistral-markdown-normalizer.test.js`，Expected: PASS。
- [ ] **Step 5：提交。** `git commit -m "refactor: separate Mistral decoding from figure restoration"`。

## T06：识别完整图组及其文字归属

**Files:** 新增 `src/figures/figure-region-resolver.js`、`test/figure-region-resolver.test.js`；修改 `test/helpers/figure-fixtures.js`、`package.json`。

**Interfaces:** `resolveFigureCandidates(boundInput, options = {}) -> FigureCandidate[]`；只输出 compose/preserve 决策，无 IO、不改 Markdown；所有阈值读取 FIGURE_LIMITS。panel.label 仅接受明确字段或唯一位置对应的子图标签，重复或疑似轴文字则为 null。

- [ ] **Step 1：写两条方向相反的测试。**

```js
test('owns four panels and an internal axis while excluding body prose', () => {
    const { input } = makeFigureInput();
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    const figure = candidates.find(candidate => candidate.decision === 'compose');
    assert.equal(figure.panelBlockIds.length, 4);
    assert.equal(figure.ownedTextBlockIds.length, 1);
    assert.ok(!figure.ownedTextBlockIds.some(id => (
        input.blocks.find(block => block.id === id)?.role === 'body'
    )));
});
```

第二条把一个有独立编号的 caption/panel 放到候选旁边；断言产生两个对象或 preserve，绝不输出吞掉两个编号的 compose 对象。

- [ ] **Step 2：Run `node --test test/figure-region-resolver.test.js`，Expected: FAIL。**
- [ ] **Step 3：实现设计第 6 节算法，按明确 parent → 同页几何分量＋唯一 caption → 文字归属 → 外来内容阻挡 → 完整覆盖/范围校验的顺序执行。** 每个 block 最多属于一个 compose 候选；不能用平方根、列数或 Markdown 空行推定原版式。

```js
const candidate = {
    id: `fig-p${pageIndex}-b${anchorOrdinal}`,
    pageIndex,
    label,
    captionBlockIds,
    panelBlockIds,
    ownedTextBlockIds,
    visualBBox,
    captionBBox,
    evidence,
    decision: safetyReason ? 'preserve' : 'compose',
    reason: safetyReason,
};
```

以上局部变量分别来自已绑定块、几何分量和安全检查；safetyReason 使用设计中的固定原因码，不携带源内容。

- [ ] **Step 4：覆盖 2×2/4×4/缺角/左高右上下/主图跨列/不规则尺寸、上/下图注、单个完整图、重复标签、间隙图例、图外同词、长正文阻挡、跨栏、跨页、无坐标、图注与图区相交和预算边界。** 使用交换 block 输入顺序仍得到相同成员/几何的测试验证确定性；无稳定来源序号时 preserve 而非依赖数组偶然次序。Run: `node --test test/figure-region-resolver.test.js test/figure-source-binding.test.js`，Expected: PASS；加入 check。
- [ ] **Step 5：提交。** `git commit -m "feat: resolve complete figures before prose reflow"`。

## T07：独立 PDF.js 整区渲染器

**Files:** 新增 `src/pdf/pdfjs-figure-region.js`、`src/platform/zotero-figure-canvas.js`、`test/pdfjs-figure-region.test.js`、`test/zotero-figure-canvas.test.js`；修改 `src/pdf/pdfjs-bootstrap-environment.js`、`src/pdf/pdfjs-page-crop.js`、`src/figures/figure-model.js`、`test/figure-model.test.js`、`test/pdfjs-bootstrap-environment.test.js`、`package.json`。原 `pdfjs-page-crop.js` 缩略图接口语义保持原状。

**Interfaces:** `createPDFFigureRegionRenderer({ loadDocument, createCanvas, encodePNG, workerSrc, cMapUrl, standardFontDataUrl, wasmUrl })` 返回 `{ open(fileData, options), disposeAll() }`；session 提供 `getPageGeometry(pageIndex, options)`、`renderRegion(request, options)`、`close()`。platform factory 返回 ownerDocument/createCanvas/encodePNG，均可注入测试。getPageGeometry 返回设计第 8 节完整 PageGeometry（包含 viewBox、mediaBox、viewportTransform、userUnit、显示尺寸与 rotation）；新增纯函数 alignFigureInputToPDF(input, pageGeometryByIndex, options = {}) 于 figure-model.js，失败页写明稳定原因而不猜坐标。

- [ ] **Step 1：写不依赖真实 canvas 的区域几何测试。** 这条用例检验分配尺寸和渲染平移；真实像素验收在 T15 独立完成。

```js
test('renders only the requested display region and releases its canvas', async () => {
    const signal = new AbortController().signal;
    const renderCalls = [];
    const allocations = [];
    const page = {
        view: [0, 0, 1000, 1000], rotate: 0, userUnit: 1,
        getViewport({ scale }) {
            return {
                width: 1000 * scale, height: 1000 * scale,
                transform: [scale, 0, 0, -scale, 0, 1000 * scale],
                convertToViewportRectangle: ([x0, y0, x1, y1]) => (
                    [x0 * scale, (1000 - y0) * scale,
                        x1 * scale, (1000 - y1) * scale]
                ),
            };
        },
        render(parameters) {
            renderCalls.push(parameters);
            return { promise: Promise.resolve(), cancel() {} };
        },
        cleanup() {},
    };
    const renderer = createPDFFigureRegionRenderer({
        loadDocument: () => ({
            promise: Promise.resolve({
                numPages: 1, getPage: async () => page, destroy: async () => {},
            }),
            destroy: async () => {},
        }),
        createCanvas: (width, height) => {
            const canvas = { width, height, getContext: () => ({}) };
            allocations.push({ width, height, canvas });
            return canvas;
        },
        encodePNG: async canvas => createTestPNG(canvas.width, canvas.height),
    });
    const session = await renderer.open(Uint8Array.of(1, 2, 3), { signal });
    try {
        const crop = await session.renderRegion({
            pageIndex: 0, bbox: [100, 200, 700, 500],
            coordinateFrame: 'display-cropbox', rotation: 0, dpi: 72,
        }, { signal });
        assert.equal(crop.width, 600);
        assert.equal(crop.height, 300);
        assert.deepEqual(renderCalls[0].transform, [1, 0, 0, 1, -100, -200]);
        assert.equal(allocations[0].width * allocations[0].height, 180_000);
        assert.equal(allocations[0].canvas.width, 0);
        assert.equal(allocations[0].canvas.height, 0);
    }
    finally {
        await session.close();
        await renderer.disposeAll();
    }
});
```

- [ ] **Step 2：Run `node --test test/pdfjs-figure-region.test.js test/zotero-figure-canvas.test.js`，Expected: FAIL。**
- [ ] **Step 3：实现 viewport 坐标变换、裁区 canvas、PNG 编码和全局串行 render 队列。** 从 pdfjs-page-crop.js 把 createMkteroCanvasFactory、MkteroFilterFactory 原样提取到 pdfjs-bootstrap-environment.js 并导出，旧缩略图与新入口共同导入；保持 CanvasFactory/FilterFactory、worker、CMap、字体、WASM 和禁用远程 fetch 的加载选项。向 worker 传入有界 PDF 字节副本，不能 detach 转换原始 fileData。 padding 已由 resolver 确定，renderer 不再次外扩；渲染请求的 bbox 是最终边界。

```js
async function renderCrop(page, canvas, viewport, rect, encodePNG, signal) {
    const renderTask = page.render({
        canvas,
        canvasContext: canvas.getContext('2d'),
        viewport,
        transform: [1, 0, 0, 1, -rect.x, -rect.y],
        background: 'rgb(255,255,255)',
    });
    const cancel = () => renderTask.cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
        await renderTask.promise;
        const data = await encodePNG(canvas, { signal });
        return { data, mimeType: 'image/png', width: rect.width, height: rect.height };
    }
    finally {
        signal?.removeEventListener('abort', cancel);
        canvas.width = 0;
        canvas.height = 0;
    }
}

```

rect 为经 frame/rotation/CropBox 校验后的 viewport 整数矩形；scale 在分配 canvas 之前按像素/边长预算收紧。PNG 输出长度、签名及 IHDR 宽高必须与结果一致。alignFigureInputToPDF 使用 viewportTransform 将已知输入 frame 转到显示页 0–1000，保留 sourceBBox/sourceGeometry；无 MediaBox 证据时拒绝对应 frame，未知单位/方向不靠长宽比猜测。platform 用 `createElementNS('http://www.w3.org/1999/xhtml', 'canvas')`，优先 toBlob；受限回退只解码本地 canvas 产生的 PNG data URL。

- [ ] **Step 4：覆盖 0/90/180/270 度、MediaBox/CropBox 非零偏移、裁区触边、极端长宽、未知 frame、尺寸冲突、超大 PDF、超时、排队取消、渲染取消、编码期间取消、disposeAll 幂等、两文档共用渲染队列。** 检查 canvas 分配预算、renderTask.cancel、page.cleanup、document/loadingTask.destroy 和 listener 数量。Run 上述文件及 `test/pdfjs-page-crop.test.js`、`test/pdfjs-bootstrap-environment.test.js`、`test/figure-model.test.js`、`test/zotero-source-peek.test.js`，Expected: PASS；新源码加入 check。
- [ ] **Step 5：提交。** `git commit -m "feat: render bounded figure regions from local PDFs"`。

## T08：图组替换事务与最终元数据

**Files:** 新增 `src/figures/figure-transaction.js`、`src/figures/figure-finalization.js`、`test/helpers/restored-figure-fixture.js`、`test/figure-transaction.test.js`、`test/figure-finalization.test.js`；修改 `src/mineru/mineru-result.js`、`src/mineru/figure-panel-normalizer.js`、`src/mineru/markdown-normalizer.js`、`src/markdown/figure-layout-normalizer.js`、`src/core/markdown-source-map.js`、`package.json`。

**Interfaces:** `composeFigureDraft(input, completed, options = {}) -> FigureDraft`；completed 每项为 `{ candidate, crop, assetPath }`。`finalizeFigureMap(prepared, blueprints, { hash }) -> Promise<ConvertedDocument>`。额外导出 `finalizeRestoredDocument(input, draft, { prepare, hash, signal })`，将 prepare 和最终绑定包成一个可回退操作；prepare 是注入的 provider 纯归一化函数。

- [ ] **Step 1：先证明消费范围不会吞正文。** fixture 在第一、二张图之间插入 role=body 的图外段落，保留其 bbox 在图区外；使用明确父关系候选和 renderer stub 的成功 crop。测试通过真实 compose/finalize 路径。

```js
const { input, bodyText, axisLabel } = makeFigureInput();
const boundInput = bindFigureSourceRanges(input);
const candidate = resolveFigureCandidates(boundInput)
    .find(value => value.decision === 'compose');
assert.ok(candidate);
const pngBytes = createTestPNG(1600, 1500);
const draft = composeFigureDraft(boundInput, [{
    candidate,
    crop: { data: pngBytes, mimeType: 'image/png', width: 1600, height: 1500 },
    assetPath: 'generated/figures/fig-p0-b4-0123456789abcdef.png',
}]);
assert.ok(draft.input.markdown.includes(bodyText));
assert.ok(!draft.input.markdown.includes(axisLabel));
assert.equal(draft.blueprints.length, 1);
assert.ok(draft.blueprints[0].provenance.fragments.some(fragment => (
    fragment.markdown === axisLabel
)));
assert.equal(draft.input.assets.length, boundInput.assets.length + 1);
```

本任务同时在 `test/helpers/restored-figure-fixture.js` 导出后续持久化/阅读测试共用的完整结果工厂，避免每组测试手写一份不一致的 map：

```js
import { webcrypto } from 'node:crypto';
import { makeFigureInput, createTestPNG } from './figure-fixtures.js';
import { bindFigureSourceRanges } from '../../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../../src/figures/figure-region-resolver.js';
import { composeFigureDraft } from '../../src/figures/figure-transaction.js';
import { finalizeRestoredDocument } from '../../src/figures/figure-finalization.js';
import { prepareMinerUResult } from '../../src/mineru/mineru-result.js';
import { sha256Hex } from '../../src/core/sha256.js';

export async function makeRestoredFigureDocument(options = {}) {
    const { input } = makeFigureInput({ ...options, provider: 'mineru' });
    const bound = bindFigureSourceRanges(input);
    const candidate = resolveFigureCandidates(bound)
        .find(value => value.decision === 'compose');
    if (!candidate) throw new Error('Fixture has no composable figure');
    const hash = value => sha256Hex(value, { crypto: webcrypto });
    const data = createTestPNG(1600, 1500);
    const digest = (await hash(data)).slice(0, 16);
    const draft = composeFigureDraft(bound, [{
        candidate,
        crop: { data, mimeType: 'image/png', width: 1600, height: 1500 },
        assetPath: `generated/figures/${candidate.id}-${digest}.png`,
    }]);
    return finalizeRestoredDocument(input, draft, {
        prepare: prepareMinerUResult, hash,
    });
}
```

这个工厂只模拟 crop 输出，用于元数据/事务测试；不作为 PDF 像素保真的证明。`options` 限于 makeFigureInput 的布局/文本变体，工厂的 provider 固定 MinerU；两 provider 的正式恢复链路在 T09/T15 单独覆盖。

- [ ] **Step 2：Run `node --test test/figure-transaction.test.js test/figure-finalization.test.js`，Expected: FAIL。**
- [ ] **Step 3：实现事务。** 先验证所有源范围及 metadata/资产预算，再按 from 排序构造非重叠编辑，从后向前应用；图注范围替换成一个转义后的规范图片块，其余成员逐项移除。只吸收被删除块自己的空白边界，不能全篇重排。input/contentList/assets 全部按新对象生成；移除已消费 blocks，把未消费 block.sourceRanges 和页 markdownRange 按同一 edits 平移，加入新 image 块，避免后续 prepare 读到旧范围或旧文本。

```js
let markdown = input.markdown;
for (const edit of edits.slice().sort((a, b) => b.from - a.from)) {
    markdown = markdown.slice(0, edit.from)
        + edit.replacement
        + markdown.slice(edit.to);
}
```

blueprints 保留原文、原资产身份与原坐标；新 contentList 使用设计第 9 节的 figureId/assetPath/captionText/captionBBox 契约。完整图的路径由内部生成记录授权，已有 panel/layout 重排器遇到这些图时停止跨图拼接；不能仅凭路径前缀信任外部图片。prepare 完成后仅按生成路径唯一的图片 AST 节点绑定 render.range 与 captionRanges，不能按图注全文重新搜索。在最终绑定时把图注 AST 字符范围写入 sourceMap.locationRanges，位置为 captionBBox；图片节点仍映射到 visualBBox。覆盖短图注、重复图注词和未发生正文重排时的 sourceMap，不能依赖 includeMatchedTextRanges 是否恰好开启。

- [ ] **Step 4：验证多图事务、前/后图注、无图注明确父图、同名资产冲突、公式/引用/转义图注、图片缺失、追溯超限、相交范围、恶意源文本、源对象未被修改、最终锚点缺失与幂等。** finalizeRestoredDocument 把 draft.preserved 合入最终 map；全保留但有诊断时写 figures=[] 的有效 map。只在图组最终绑定失败时回到原 input 重新 prepare，并把放弃的候选记为 ambiguous-source-range，不保留生成资产；AbortError 必须继续抛出。Run 上述文件加 `test/mineru-result.test.js test/markdown-source-map.test.js`，Expected: PASS；新增源码加入 check。
- [ ] **Step 5：提交。** `git commit -m "feat: commit restored figures with source provenance"`。

## T09：公共恢复服务与正式转换链路

**Files:** 新增 `src/figures/figure-restoration-service.js`、`test/figure-restoration-service.test.js`；修改 `src/mineru/mineru-conversion.js`、`src/mistral/mistral-conversion.js`、`src/extractors/mineru-extractor.js`、`src/extractors/mistral-extractor.js`、`src/bootstrap.js`、`src/core/conversion-progress.js`、`src/core/markdown-document-service.js`、`src/ui/markdown-loading-state.js`、`src/i18n/localization.js`、`package.json`；扩展 `test/mineru-conversion.test.js`、`test/mistral-conversion.test.js`、`test/mineru-extractor.test.js`、`test/mistral-extractor.test.js`、`test/markdown-document-service.test.js`、`test/markdown-loading-state.test.js`、`test/bootstrap-abort-controller.test.js`。

**Interfaces:** `new FigureRestorationService({ openPDF, hash, now, setTimeout, clearTimeout, limits })`；`restore(input, { fileData, signal, onProgress }) -> Promise<FigureDraft>`。两家 conversion 构造器统一接收 `prepareResult(raw, { fileData, signal, onProgress })`，并在 fresh/resumed/no-key 分支写缓存前 await；缓存命中不调用 prepareResult。Mistral 原 normalizeResult 注入更新为 prepareResult，并同步所有测试调用。

- [ ] **Step 1：把上一轮“2×2＋图内文字”放进完整服务链路。** renderer stub 对应真实坐标返回有界 PNG；断言四成员进入一个 sourceId、正文没有 axisLabel、bodyText 保留、caption 只出现一次、sourceMap 有正确 visualBBox/captionBBox。

```js
test('retains original content when figure rendering fails', async () => {
    const { input } = makeFigureInput();
    const service = new FigureRestorationService({
        openPDF: async () => ({
            getPageGeometry: async () => ({
                pageIndex: 0, width: 1000, height: 1000, rotation: 0, userUnit: 1,
                coordinateFrame: 'display-cropbox',
                viewBox: [0, 0, 1000, 1000], mediaBox: null,
                viewportTransform: [1, 0, 0, -1, 0, 1000],
            }),
            renderRegion: async () => { throw new Error('render failed'); },
            close: async () => {},
        }),
        hash: async () => 'a'.repeat(64),
    });
    const draft = await service.restore(input, { fileData: Uint8Array.of(1) });
    assert.equal(draft.input.markdown, input.markdown);
    assert.deepEqual(draft.input.assets, input.assets);
    assert.equal(draft.blueprints.length, 0);
    assert.equal(draft.preserved[0].reason, 'render-failed');
});
```

- [ ] **Step 2：Run `node --test test/figure-restoration-service.test.js test/mineru-conversion.test.js test/mistral-conversion.test.js`，Expected: FAIL，新服务/注入不存在。**
- [ ] **Step 3：实现 bind→open/getPageGeometry→alignFigureInputToPDF→resolve→render→compose，所有 session 在 finally 关闭。** 单图错误进入 preserve；全局取消立即停止且不提交。资源检查先于分配和编辑；剩余预算不足的候选保留原文。progress 的新阶段为 RESTORING_FIGURES=97，最终发布前最多 99；把客户端 progress 封顶为 96，恢复使用 97–99，文档发布才报 100，避免进度倒退。缓存命中仍直接 100。createLoadingPresentation 在 progress≥97 且仍 loading 时使用 loading.restoringFigures；完整/保留状态在发布后展示。

bootstrap 的接入骨架为：

```js
const prepareMinerUWithFigures = async (raw, context) => {
    const input = decodeMinerUFigureInput(raw);
    const draft = await figureRestoration.restore(input, context);
    return finalizeRestoredDocument(input, draft, {
        prepare: prepareMinerUResult,
        hash: sha256Hex,
        signal: context.signal,
    });
};
const prepareMistralWithFigures = async (raw, context) => {
    const input = decodeMistralResult(raw);
    const draft = await figureRestoration.restore(input, context);
    return finalizeRestoredDocument(input, draft, {
        prepare: prepareMistralResult,
        hash: sha256Hex,
        signal: context.signal,
    });
};
```

实例创建与 dispose 放在 bootstrap；DOM 环境只由 platform factory 提供。core service 不知道 Zotero。extractor/document-service 显式复制 figureMap，不把 providerState/raw response 透传到 UI/cache。

- [ ] **Step 4：验证 cold/cache/resumed/no-key/forceRefresh、两 provider 隔离、关闭标签页、两窗口同 PDF、转换代际竞争、编码结束前取消、缓存提交前取消、恢复超时和缓存写失败。** 在 MinerU commit 前复查 signal 与当前 batchID，取消不能删除尚可恢复的 pending task；旧成功标签页保持其原内容。在 `test/bootstrap-abort-controller.test.js`、`test/markdown-tab-presenter.test.js`、`test/markdown-window.test.js` 中追加对应生命周期断言。Run: `node --test test/figure-restoration-service.test.js test/mineru-conversion.test.js test/mistral-conversion.test.js test/markdown-document-service.test.js test/mineru-extractor.test.js test/mistral-extractor.test.js test/markdown-loading-state.test.js test/bootstrap-abort-controller.test.js test/markdown-tab-presenter.test.js test/markdown-window.test.js`，Expected: PASS。
- [ ] **Step 5：提交。** `git commit -m "feat: restore figures before conversion cache commits"`。

## T10：figureMap 缓存与解析身份

**Files:** 修改 `src/cache/markdown-cache.js`、`src/mineru/parser-profile.js`、`src/mistral/parser-profile.js`；扩展 `test/markdown-cache.test.js`、`test/mineru-result.test.js`、`test/mistral-conversion.test.js`。

**Interfaces:** `MarkdownCache.put(key, result)` 与 get 的公开签名不变；result 新增 figureMap。metadata 使用 `figureMapFile`、`figureMapBytes`；已有 cache schema=1。两家 parser profile 增加 `figureStructure: FIGURE_PIPELINE_PROFILE`，其他行为标识按实际替换更新。

- [ ] **Step 1：在现有内存 IO cache fixture 中加入完整往返。** fixture 的 result 由 T08/T09 真实 finalize 构建，避免手写不匹配 hash 的模型。

```js
await cache.put(key, result);
const loaded = await cache.get(key);
assert.deepEqual(loaded.figureMap, result.figureMap);
assert.equal(loaded.markdown, result.markdown);
assert.deepEqual(loaded.assets.map(asset => asset.path), result.assets.map(asset => asset.path));
```

- [ ] **Step 2：Run `node --test test/markdown-cache.test.js`，Expected: FAIL，figureMap 被丢失。**
- [ ] **Step 3：按 sourceMap/chromeRanges 的代际文件模式增加读写、校验、统计、扫描和清理。** 写 metadata 之前 figureMap hash 与 Markdown 匹配；临时文件失败清理不能删除上一代。读取未知/损坏可选 map 时忽略 map 并返回 Markdown/资产。

```js
const figureMapFile = `figure-map-${generation}.json`;
const figureMapJSON = JSON.stringify(validatedFigureMap);
const figureMapBytes = new TextEncoder().encode(figureMapJSON).length;
metadata.figureMapFile = figureMapFile;
metadata.figureMapBytes = figureMapBytes;
metadata.sizeBytes += figureMapBytes;
```

- [ ] **Step 4：覆盖缺文件、大小/hash 不符、未知版本、恶意路径、无效范围、PNG 引用缺失、8 MiB 边界、写入失败、并发 put/get、旧 metadata、clear、expiry 与总量淘汰；验证两家新 key 与 0.3.9 key 不同。** Run: `node --test test/markdown-cache.test.js test/mineru-result.test.js test/mistral-conversion.test.js`，Expected: PASS。
- [ ] **Step 5：提交。** `git commit -m "feat: persist versioned figure maps with cached documents"`。

## T11：修订范围、旧纠错基线与真实解析身份

**Files:** 新增 `src/figures/figure-map-transforms.js`、`src/figures/legacy-figure-profiles.js`、`test/figure-map-transforms.test.js`；修改 `src/core/markdown-revision-session.js`、`src/platform/zotero-markdown-revision-store.js`、`src/extractors/mineru-extractor.js`、`src/extractors/mistral-extractor.js`、`src/bootstrap.js`、`package.json`；扩展 `test/markdown-revision-session.test.js`、`test/zotero-markdown-revision-store.test.js`、`test/mineru-extractor.test.js`、`test/mistral-extractor.test.js`。

**Interfaces:** `mapFigureMapThroughEdits(map, edits, markdown)`；LEGACY_FIGURE_PROFILES 为两家 0.3.9 精确 profile 字符串。extractor 的 createCacheKey 支持第二参数 `{ parserProfile }`；readRevision 仍按 `{ itemID, cacheKey, signal }` 调用，命中后结果携带实际被选择的 parserProfile/cacheKey。

- [ ] **Step 1：测试正文前插入字符只平移视图范围。**

```js
const next = mapFigureMapThroughEdits(figureMap, [
    { from: 0, to: 0, replacementLength: 12 },
], 'New prefix. ' + markdown);
assert.equal(next.figures[0].id, figureMap.figures[0].id);
assert.deepEqual(next.figures[0].visualBBox, figureMap.figures[0].visualBBox);
assert.equal(next.figures[0].render.range.from,
    figureMap.figures[0].render.range.from + 12);
assert.equal(next.markdownHash, null);
```

另测试与图片范围相交的编辑让对应记录失效、其他 Figure 保持，以及 revision save/load/恢复原文的范围一致性。

- [ ] **Step 2：Run `node --test test/figure-map-transforms.test.js test/markdown-revision-session.test.js test/zotero-markdown-revision-store.test.js`，Expected: FAIL，元数据未传递。**
- [ ] **Step 3：实现深拷贝、偏移变换和可选持久化。** 与原 sourceMap 使用相同端点关联方向；纯函数不计算异步 hash，store.save 前计算并校验；不可变 revision base 的 figureMap 只写一次。旧 base 缺字段时取 null，不修改已有 base 文件。

在 `legacy-figure-profiles.js` 固定以下两个对象的 JSON.stringify 结果，字段顺序即旧 cache identity 的顺序：

```js
export const LEGACY_FIGURE_PROFILES = Object.freeze({
    mineru: JSON.stringify({
        batch: { model_version: 'vlm', enable_formula: true, enable_table: true },
        file: { is_ocr: true },
        sourceMap: {
            textMatching: 'exact-then-academic-v2',
            figurePanels: 'same-page-horizontal-or-labeled-vertical-ab-v2',
            figureLayouts: 'same-page-image-group-layout-v1',
            textFlow: 'cross-page-continuation-v1',
            prose: 'unclosed-parenthetical-comma-v1',
            columns: 'same-page-two-column-reading-order-v6',
            blockFlow: 'misplaced-code-page-order-v2',
            chrome: 'page-edge-repeated-v1',
        },
    }),
    mistral: JSON.stringify({
        provider: 'mistral',
        model: 'mistral-ocr-4-1',
        request: { include_blocks: true, include_image_base64: true, table_format: 'markdown' },
        headerFooter: 'edge-filter-v5-retain-chrome-ranges',
        textFlow: 'same-and-cross-page-column-continuation-v3',
        resultAdapter: 'mistral-ocr-result-v11-retain-page-chrome-ranges-text-flow-figure-layouts',
        sourceMap: 'pixel-bbox-0-1000-v1',
    }),
});
```

查询顺序固定：当前 key 修订 → 上一 profile key 修订 → 当前转换/缓存。forceRefresh 不走旧修订回退。命中旧修订时跳过裁图，不重新写旧 metadata；bootstrap 后续加载/保存修订使用 model.parserProfile 和真实 key。

- [ ] **Step 4：验证旧 profile 命中时 OCR 调用数和 render 调用数均为 0、结果 identity 仍为旧值、forceRefresh 跳过兼容查询、缓存关闭但已有修订仍可读、正文纠错/撤销后 Figure 引用与 PDF 位置一致。** Run 上述文件和 `test/mineru-extractor.test.js test/mistral-extractor.test.js`，Expected: PASS；两新源码加入 check。
- [ ] **Step 5：提交。** `git commit -m "feat: preserve figure metadata across revisions and profile upgrades"`。

## T12：统一正文、引用、图目录与预览

**Files:** 新增 `src/figures/figure-analysis.js`、`test/figure-analysis.test.js`；修改 `src/markdown/markdown-figure-references.js`、`src/markdown/markdown-asset-outline.js`、`src/markdown/markdown-evidence.js`、`src/editor/inline-rendering.js`、`src/editor/inline-markdown-editor.js`、`src/editor/figure-preview-popup.js`、`src/ui/markdown-tab-state.js`、`src/ui/markdown-tab-presenter.js`、`src/ui/markdown-window.js`、`ui/markdown.css`、`package.json`；测试清单见本任务 Step 4。

**Interfaces:** `analyzeDocumentFigures(markdown, { figureMap = null, viewRanges = null, viewKind = 'original' } = {}) -> FigureView[]`。`analyzeMarkdownFigureReferences(markdown, { figureViews = null } = {})` 增加可选参数；`extractMarkdownAssetOutline(markdown, chromeRanges = [], { figureViews = null } = {})` 增加第三参数。editor.setDocument 原对象参数增加 figureMap/figureViews；sourceMap、Markdown 与图元数据在一次 dispatch 中更新。

- [ ] **Step 1：同一输入检查三个消费方。**

```js
const figureViews = analyzeDocumentFigures(markdown, { figureMap });
const refs = analyzeMarkdownFigureReferences(markdown, { figureViews });
const outline = extractMarkdownAssetOutline(markdown, [], { figureViews });
assert.equal(figureViews.length, 1);
assert.equal(refs.targets[0].sourceId, figureMap.figures[0].id);
assert.equal(outline[0].sourceId, figureMap.figures[0].id);
assert.ok(refs.targets[0].figure.source.includes(figureMap.figures[0].render.assetPath));
assert.equal(outline[0].imageSource, figureMap.figures[0].render.assetPath);
```

源 Markdown fixture 包含一个真实 prose Figure 引用，避免只测试没有用户入口的目标对象。

- [ ] **Step 2：Run `node --test test/figure-analysis.test.js test/markdown-figure-references.test.js test/markdown-asset-outline.test.js`，Expected: FAIL。**
- [ ] **Step 3：按 figureMap 先生成明确 FigureView，再合并不与其范围相交的 legacy 分析结果。** 不让 legacy 分组把已合成 PNG 吸收到下一幅图。FigureView 带入经过验证的 panels；子图引用只在标签唯一时取 panel bbox，sourceId 仍为父图，预览保留完整 PNG。使用当前图片节点里的 caption，而不是 metadata 内的旧文字；验证 assetPath、范围和 caption label。旧无 map 文档继续走现有分析。

```js
const figureViews = analyzeDocumentFigures(value, { figureMap, viewRanges, viewKind });
view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: value },
    effects: [setFigureViews.of(figureViews)],
});
```

`setFigureViews` 是本任务在 inline-rendering 定义的 StateEffect。实际 setDocument 把该 effect 加入原 effects 数组，保留已有 annotation、chrome、translation、只读状态与清理逻辑；不能以示例中的单 effect 覆盖原数组。

完整 PNG 始终等比显示。旧显式网格取消 760px/520px 时强制改列数的规则；测试其窄宽度行为通过 T15 浏览器/Zotero 真实布局验证，不用“CSS 包含某字符串”充当排版正确性的证据。

- [ ] **Step 4：检查 sourceId 一致、公共 caption 仅一次、中文/英文 Figure 与 Fig.、唯一子图/歧义子图、重复标签安全回退、来源跳转、图注选中、失效 metadata、关闭 popup、切文档与双窗口无悬挂目标。** Run: `node --test test/figure-analysis.test.js test/markdown-figure-references.test.js test/markdown-asset-outline.test.js test/markdown-evidence.test.js test/figure-reference-editor.test.js test/inline-markdown-editor.test.js test/markdown-tab-state.test.js test/markdown-tab-presenter.test.js test/markdown-window.test.js`，Expected: PASS；加入 check。
- [ ] **Step 5：提交。** `git commit -m "feat: share restored figure identities across reader surfaces"`。

## T13：翻译与双语中的同一 Figure

**Files:** 修改 `src/markdown/markdown-translation-blocks.js`、`src/editor/translation-presentation.js`、`src/ai/markdown-translation-service.js`、`src/figures/figure-analysis.js`、`src/ui/markdown-window.js`；扩展 `test/markdown-translation-blocks.test.js`、`test/markdown-translation-service.test.js`、`test/figure-analysis.test.js`、`test/inline-markdown-editor.test.js`。

**Interfaces:** `createDocumentTranslationViews(markdown, blocks, translations, { figureMap = null } = {})` 保留所有旧返回字段，增加 `translatedFigureViews`、`comparisonFigureViews`。分析入口增加 `viewKind`，使用已有合并后的 blockRanges；FigureView.sourceId 不变，id 的模式后缀为 original/translation/comparison。

- [ ] **Step 1：在现有翻译测试文件加入完整图图注翻译回归。**

```js
test('shows one complete figure with both captions in comparison mode', async () => {
    const { markdown, figureMap } = await makeRestoredFigureDocument();
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const translations = blocks.filter(block => block.translatable).map(block => ({
        id: block.id,
        markdown: block.requestMarkdown.replace(
            'Treatment response in four panels.', '四个子图的处理结果。'
        ),
    }));
    const views = createDocumentTranslationViews(markdown, blocks, translations, { figureMap });
    const sourceId = figureMap.figures[0].id;
    assert.equal(views.translatedFigureViews.length, 1);
    assert.equal(views.translatedFigureViews[0].sourceId, sourceId);
    assert.equal(views.translatedFigureViews[0].viewKind, 'translation');
    assert.equal(views.comparisonFigureViews.length, 1);
    const comparison = views.comparisonFigureViews[0];
    assert.equal(comparison.sourceId, sourceId);
    assert.equal(comparison.viewKind, 'comparison');
    assert.equal(views.comparisonMarkdown.split(comparison.assetPath).length - 1, 1);
    assert.ok(comparison.translatedCaption.text.includes('四个子图的处理结果。'));
    assert.equal(views.comparisonMarkdown.slice(
        comparison.translatedCaption.from, comparison.translatedCaption.to
    ), comparison.translatedCaption.text);
});
```

这里调用的 makeRestoredFigureDocument 来自 T08 helper；图内原始 label 已从正文移出，gateway 的请求测试要明确检查它没有以 provenance 上下文的形式再次加入。

- [ ] **Step 2：Run `node --test test/markdown-translation-blocks.test.js test/figure-analysis.test.js`，Expected: FAIL，视图字段不存在。**
- [ ] **Step 3：沿已有 protected fragments 保护图片路径，description 走现有可翻译通路。** 保留 removeRepeatedComparisonImages 的去重行为。合并 blockRanges 后先用 sourceFrom/sourceTo 定位原 Figure 所属块，再按 viewKind 选择 translatedFrom/To 或 comparisonSourceFrom/To 窗口，最后核对实际图片 AST 节点。

```js
const blockRanges = translated.blockRanges.map(range => ({
    ...range,
    ...comparisonByID.get(range.id),
}));
const translatedFigureViews = analyzeDocumentFigures(translated.markdown, {
    figureMap, viewRanges: blockRanges, viewKind: 'translation',
});
const comparisonFigureViews = analyzeDocumentFigures(comparison.markdown, {
    figureMap, viewRanges: blockRanges, viewKind: 'comparison',
});
```

translated、comparison、comparisonByID 是该函数现有局部变量。blockRanges 的确切字段为 id/type/sourceFrom/sourceTo/translatedFrom/translatedTo/comparisonSourceFrom/comparisonSourceTo/comparisonTranslationFrom/comparisonTranslationTo，比较译文范围允许 null。

规范 Figure 使用独立 image 段落；比较视图的 comparisonTranslationFrom/To 是去掉重复图片后真实输出的译文图注范围。把该范围记为 translatedCaption，并将 FigureView.from/to 扩展到原图与译文图注整体，source 取当前切片。混合段落不能证明整段都是图注时不标记 translatedCaption，也不改动该段。翻译结果等于原文时，该字段为 null，保留已有不重复图注行为。图目录按 sourceId 只列一项，引用预览使用当前完整图组的 source。

- [ ] **Step 4：断言 provenance.fragments 不进入 gateway 请求；译文篡改 assetPath 沿现有 protected-content 失败规则拒绝；原/译/双语切换、翻译失败、纠错后重译、翻译缓存恢复均保持 sourceId 和图片完整。** 保留现有“不重复图片”测试，不能为满足新 map 修改其预期。Run: `node --test test/markdown-translation-blocks.test.js test/markdown-translation-service.test.js test/figure-analysis.test.js test/inline-markdown-editor.test.js`，Expected: PASS。
- [ ] **Step 5：仅暂存本任务文件并提交。** `git commit -m "feat: retain figure identity in translated reading views"`。

## T14：Zotero 快照、旧格式读取与普通 Markdown 导出

**Files:** 修改 `src/core/saved-markdown-note-format.js`、`src/core/saved-markdown-open-resolver.js`、`src/platform/zotero-saved-markdown-store.js`、`src/bootstrap.js`；扩展 `test/saved-markdown-note-format.test.js`、`test/saved-markdown-open-resolver.test.js`、`test/zotero-saved-markdown-store.test.js`、`test/markdown-export.test.js`、`test/zotero-markdown-exporter.test.js`、`test/bootstrap-abort-controller.test.js`。`src/markdown/markdown-export.js`、`src/platform/zotero-markdown-exporter.js` 和 `src/platform/zotero-saved-markdown-source.js` 预期无需修改，按既有接口回归。

**Interfaces:** `saveSnapshot({ pdfItem, parentItem, markdown, assets, assetBasePath, sourceMap, figureMap = null, cacheKey, parserProfile, containsUserCorrections, correctionCount })`；store.read 的旧返回对象增加 figureMap、figureMapAttachment。公开 `createSavedMarkdownManifest(options)` 新建 schemaVersion=3，增加可选 figureMapAttachmentKey/figureMapBytes/figureMapHash；导出 `FIGURE_MAP_ATTACHMENT_TITLE = 'Mktero figure-map.json'`。read 继续支持 Mktero 1/2/3；Zotero 的外层 data-schema-version=9 保持不变。

- [ ] **Step 1：在已有 store 的 createHarness 中测试保存、读取及可选附件丢失。**

```js
test('opens complete figure images when optional figure metadata is missing', async () => {
    const { store, parent, pdf, files } = createHarness();
    const document = await makeRestoredFigureDocument();
    const saved = await store.saveSnapshot({
        pdfItem: pdf, parentItem: parent,
        markdown: document.markdown, assets: document.assets,
        assetBasePath: document.assetBasePath, sourceMap: document.sourceMap,
        figureMap: document.figureMap,
        cacheKey: 'a'.repeat(64), parserProfile: MINERU_PARSER_PROFILE_ID,
    });
    const loaded = await store.read(saved.note);
    assert.equal(loaded.manifest.schemaVersion, 3);
    assert.deepEqual(loaded.figureMap, document.figureMap);
    assert.equal(loaded.figureMapAttachment.getField('title'), 'Mktero figure-map.json');
    assert.equal(loaded.figureMapAttachment.parentID, parent.id);
    files.delete(await loaded.figureMapAttachment.getFilePathAsync());
    const reopened = await store.read(saved.note);
    assert.equal(reopened.figureMap, null);
    assert.equal(reopened.markdown, document.markdown);
    assert.equal(reopened.sourceAvailable, true);
    assert.equal(reopened.assetsComplete, true);
});
```

格式测试用既有 replaceManifestMarker helper 向合法 note 注入 schemaVersion=1、2、99，分别断言 1/2 保持真实读版本、99 拒绝；另构造旧属性式 v1 note 读取，不只改变新格式的数字。

- [ ] **Step 2：Run `node --test test/saved-markdown-note-format.test.js test/zotero-saved-markdown-store.test.js test/saved-markdown-open-resolver.test.js`，Expected: FAIL，新附件及读版本尚未支持。**
- [ ] **Step 3：实现可选 metadata 附件的完整生命周期。** 创建阶段计算 Markdown hash，以 persisted=true 校验 map；JSON UTF-8 长度≤8 MiB，另计算 JSON hash。只有三项字段完整有效时才作为可读附加 metadata：

```js
const figureMapJSON = figureMap ? JSON.stringify(figureMap) : null;
const figureMapData = figureMapJSON === null
    ? null : new TextEncoder().encode(figureMapJSON);
const figureMetadata = figureMapData ? {
    figureMapAttachmentKey: attachments.figureMapAttachment.key,
    figureMapBytes: figureMapData.length,
    figureMapHash: await this.hash(figureMapData),
} : {};
```

代码位于 store 的 prepare/import/manifest 流程：map 验证和大小检查在 import 之前；附件导入使用现有 #importTextAttachment、application/json、`mktero-figure-map` 临时文件前缀和 createdAttachments 回滚登记。与 source/sourceMap 一样附在 regular parent 上，建立 note/PDF 关系；不能附在不接受普通文件附件的 note 下。

read 只按 manifest 的准确 key、title、parent/library 与所有权关系找 map，不搜索同名附件碰运气；先检查大小/JSON hash，再解析深度/节点预算、Markdown hash、图片资产和范围。不完整的可选三字段、未知 figureMap 版本、缺文件或损坏 map 都退为 null，可读图片仍保留。写入失败则沿原快照事务回滚，不发布“已保存”状态。

拆分内部读取规范化与写入建模：`normalizeSavedMarkdownManifest(raw, { forWrite = false } = {})` 为本文件内部函数；读路径先验证 raw.schemaVersion∈[1,2,3] 并保留其值，写路径固定 3。parseManifestMarker 不再通过忽略传入版本的 createSavedMarkdownManifest 冒充升级；旧属性式解析明确为 Mktero v1，未知未来版本不能被重标为 3。旧格式不必补写附件。

在 #removeOldAttachments、#rollbackSnapshot、deleteSavedNote 的附件集合中加入 figureMapAttachment，并保持只删除本次/该旧快照拥有的文件。bootstrap.saveSnapshotForModel 传入 model.figureMap；SavedMarkdownOpenResolver 的缓存路径、source 附件路径均传 map，HTML fallback 取 null。修订后的 hash 在保存前重新计算，不把原始未纠错 map 直接持久化。

- [ ] **Step 4：完成导出和快照安全回归。** Markdown 导出仍只传普通 markdown/assets，测试不能让导出器读取 figureMap 或原 PDF：

```js
const document = await makeRestoredFigureDocument();
const exported = createMarkdownExportPlan({
    markdown: document.markdown, assets: document.assets,
    assetBasePath: document.assetBasePath, assetDirectoryName: 'paper.assets',
});
const image = exported.assets.find(asset => (
    asset.relativePath.startsWith('generated/figures/')
));
assert.ok(image);
assert.ok(exported.markdown.includes(`(paper.assets/${image.relativePath})`));
assert.deepEqual([...image.data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
assert.equal(exported.markdown.split('Figure 1.').length - 1, 1);
assert.ok(!exported.markdown.includes('Time since treatment (days)'));
```

再覆盖 JSON 超限/hash 不符、恶意路径/附件 key、同名但无关系附件、跨 library 伪装、导入/保存/清理失败、旧快照覆盖、纠错快照、cache 清空后重开、原 PDF 已不存在、旧 v1/v2 恢复、生成路径大小写冲突和图注恶意 HTML。导出的所有 Markdown 图片目的地通过 AST 枚举后必须在导出资产中有对应文件；HTML 快照中 caption 只显示一次。Run 本任务全部测试及 `test/zotero-saved-markdown-source.test.js`，Expected: PASS。
- [ ] **Step 5：仅暂存本任务文件并提交。** `git commit -m "feat: preserve complete figures in saved snapshots and exports"`。

## T15：完整场景、真实 PDF 像素、Zotero 验证与交付

**Files:** 新增 `scripts/generate-figure-fixtures.mjs`、`scripts/figure-region-zotero-harness.mjs`、`test/helpers/figure-provider-fixtures.js`、`test/figure-pipeline.test.js`、`test/fixtures/figures/compound-figures.pdf`、`test/fixtures/figures/compound-figures.expected.json`、`test/fixtures/figures/README.md`、`docs/figure-region-validation.md`；修改 `README.md`、`README.zh-CN.md`、`src/i18n/localization.js`、`package.json`；扩展 `test/localization.test.js`、`test/build-artifacts.test.js`、`test/bootstrap-abort-controller.test.js`、`test/markdown-tab-presenter.test.js`、`test/markdown-window.test.js`。运行时资产复用现有打包项；只有实际需要新增非导入资产时才修改 `scripts/build.mjs` 及对应打包断言。

**Interfaces:** 纯 test helper 导出 `createFigureProviderFixture(caseID, provider, { fileData, manifest }) -> Promise<{ input, fileData, expected, pageGeometries }>`；provider 只允许 mineru/mistral，内部通过真实 ZIP/两家 decode 适配器构造 input。expected JSON 的形状为 `{ version: 1, cases: { [caseID]: scene }, pageGeometries: [] }`，scene 同时声明原始绘图元素与独立人工核对的 expected。expected 记录图数、成员数、图注、应移出/保留文字和 bbox，不调用待测 resolver 生成。Node 测试文件内的 loadFigureFixture 使用 node:fs 读取文件后调用纯 helper；Zotero harness 用注入的 IOUtils 读取后调用同一 helper，浏览器 bundle 不导入 node:fs。

手动 harness 导出 `runFigureValidation({ fixtureRoot, resourceRoot, outputRoot, signal }) -> Promise<ValidationReport>` 和 `disposeFigureValidation()`；它在 Zotero 环境使用真实 PDF.js/DOM canvas/PNG 编码与两家合成输入，生成最终 Markdown、PNG、metadata 和只包含 caseID/状态/尺寸/耗时的报告。resourceRoot 指向当前扩展包已有 pdf.worker.mjs、CMap、字体/WASM 路径，不能下载 CDN 资源。harness 是开发工具，不打进 XPI，不添加正式用户菜单或偏好。

- [ ] **Step 1：建立可以重复生成、可人工核对的样例集。** 固定使用自有内容，PDF 同时包含位图 XObject、矢量边框/连线/箭头、轴刻度、子图标签和独立图注。场景表为：

| caseID | 布局/干扰 | 期望 |
| --- | --- | --- |
| grid-2x2 | 四图＋图内文本＋Markdown 中插入图外正文 | 一个完整图；四成员；正文保留 |
| grid-4x4 | 十六图＋重复轴标签 | 一个完整图；十六成员 |
| grid-hole | 3×3 缺右下角 | 留空位置不变 |
| tall-left | 左侧通高，右侧上下各一图 | 保持跨行关系 |
| wide-top | 顶部主图跨两列，底部两小图 | 保持宽度和比例 |
| irregular | 不同尺寸、非均匀间隔、共享图例 | 几何可信时整体恢复 |
| independent | 同页两个独立编号图＋双栏段落 | 两个对象，不吞正文 |
| caption-above | 图注在上方 | 一次图注；裁图不含图注 |
| continued | 相同编号分布相邻两物理页 | 分别保留，不跨页合成 |
| rotation-90/180/270 | 三种非零 Rotate | 显示方向、位置和来源跳转正确 |
| crop-offset | MediaBox=[0,0,700,900]、CropBox=[50,70,650,870] | 以有效可见框定位；无重复偏移 |
| user-unit | UserUnit=2 | 尺寸单位换算正确、输出不超预算 |
| scan-only | 页面只有位图内容、没有 PDF 文本层 | 有布局证据仍可裁图；不依赖 getTextContent |
| uncertain | 缺框/图注重叠/跨图重复源/外来长段落 | 对应候选 preserve，原内容逐字保留 |

常规页 MediaBox 为 600×800 pt；一般图区归一化范围为 [100,100,900,800]，图注 [100,840,900,900]，正文 [100,940,900,990]。grid 的面板在该图区按固定 gap=20 均分；hole 仅删除右下格；tall-left 左框 [100,100,450,800]、右框 [550,100,900,400]/[550,500,900,800]；wide-top 为 [100,100,900,400]/[100,500,450,800]/[550,500,900,800]。expected 保存外扩一次后的最终框及用于像素核对的已知特征点，人工核对这些值后固定入库。

- [ ] **Step 2：把两个 provider 的完整恢复路径接入同一回归，先确认组合用例能发现错误。**

```js
async function loadFigureFixture(caseID, provider) {
    const root = new URL('./fixtures/figures/', import.meta.url);
    const fileData = new Uint8Array(await readFile(new URL('compound-figures.pdf', root)));
    const manifest = JSON.parse(await readFile(
        new URL('compound-figures.expected.json', root), 'utf8'
    ));
    return createFigureProviderFixture(caseID, provider, { fileData, manifest });
}

for (const provider of ['mineru', 'mistral']) {
    test(`${provider} preserves a 16-panel figure through finalization`, async () => {
        const fixture = await loadFigureFixture('grid-4x4', provider);
        const hash = value => sha256Hex(value, { crypto: webcrypto });
        const service = new FigureRestorationService({
            hash,
            openPDF: async () => ({
                getPageGeometry: async pageIndex => fixture.pageGeometries[pageIndex],
                renderRegion: async request => {
                    const geometry = fixture.pageGeometries[request.pageIndex];
                    const [x0, y0, x1, y1] = request.bbox;
                    const width = Math.ceil((x1 - x0) * geometry.width * request.dpi / 72_000);
                    const height = Math.ceil((y1 - y0) * geometry.height * request.dpi / 72_000);
                    return { data: createTestPNG(width, height),
                        mimeType: 'image/png', width, height };
                },
                close: async () => {},
            }),
        });
        const draft = await service.restore(fixture.input, { fileData: fixture.fileData });
        const document = await finalizeRestoredDocument(fixture.input, draft, {
            prepare: provider === 'mineru' ? prepareMinerUResult : prepareMistralResult,
            hash,
        });
        assert.equal(document.figureMap.figures.length, 1);
        assert.equal(document.figureMap.figures[0].panels.length, 16);
        for (const text of fixture.expected.retainedTexts) {
            assert.ok(document.markdown.includes(text));
        }
        for (const text of fixture.expected.consumedTexts) {
            assert.ok(!document.markdown.includes(text));
        }
    });
}
```

本测试文件从 node:fs/promises 导入 readFile；其余服务/准备函数和 PNG helper 按前序接口导入。fixture helper 的 provider 返回必须经过各自真实适配器，不能在该 helper 里手写最终 FigureInput 绕过 T04/T05。重复词同时属于正文时，不列入 consumedTexts 的全文 absence 断言；改为断言该词的剩余次数和精确正文切片。这里的 PNG stub 只验证串联契约，不能用于 A08 签字。

- [ ] **Step 3：实现固定样例生成脚本和真实环境 harness，完成自动回归。** 生成脚本不依赖系统字体、随机数或实网：使用 PDF 标准 Helvetica、ASCII 测试文字、固定对象序号、固定二进制位图以及显式 MediaBox/CropBox/Rotate/UserUnit。PDF writer 以实际字节数设置 stream.Length，xref 记录 UTF-8 字节偏移；生成结果必须可由现有 PDF.js 打开，页数及每页 view/rotate 与 expected 一致。最小 writer 的 xref 写法如下，objects 是脚本按 Catalog→Pages→Font→Image→各 Page/Content 顺序构造的完整 ASCII 对象正文数组：

```js
function serializeFixturePDF(objects) {
    let source = '%PDF-1.7\n';
    const offsets = [0];
    for (const [index, body] of objects.entries()) {
        offsets.push(new TextEncoder().encode(source).length);
        source += `${index + 1} 0 obj\n${body}\nendobj\n`;
    }
    const xref = new TextEncoder().encode(source).length;
    source += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
    for (const offset of offsets.slice(1)) {
        source += `${String(offset).padStart(10, '0')} 00000 n \n`;
    }
    source += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\n`;
    source += `startxref\n${xref}\n%%EOF\n`;
    return new TextEncoder().encode(source);
}
```

位图流用 ASCIIHexDecode 保持该 writer 的 ASCII 前提；矢量箭头必须是独立路径，图内文字用 PDF text operators，不能把整图预先做成一张截图冒充混合内容样例。scan-only 页使用同一组自有图形的固定栅格结果作为整页 XObject，页面不再写 text operators。fixture README 写明生成命令、来源许可为本项目自有、输入坐标 frame、PDF 物理页与 caseID 对应关系。两家原始 fixture 是格式模拟，不称为真实云服务输出；frame 映射还要与支持的服务商输出版本文档/实现及实样核对。

自动回归覆盖表内所有 caseID，补缓存→修订→翻译→快照→导出的往返；失败分支和取消使用注入时钟及计数器。运行 `node --test test/figure-pipeline.test.js test/figure-restoration-service.test.js test/pdfjs-figure-region.test.js test/localization.test.js test/build-artifacts.test.js`，Expected: PASS。

- [ ] **Step 4：在真实 Zotero 的 PDF.js/canvas 中核对像素和阅读行为。** 使用独立测试 profile 和自有 PDF；harness 将结果交给现有 createInlineMarkdownEditor/阅读模型消费入口，必要的测试注入限于开发 harness，不能在正式扩展中开放调试载荷入口。 将手动 harness 用当前 esbuild 打为开发 IIFE（例如 build/figure-validation.js，globalName 为 MkteroFigureValidation），通过 Zotero 开发运行环境调用 runFigureValidation；只读自有 fixture，输出到明确的本地验证目录，finally 调用 disposeFigureValidation。输出对照页并排显示原 PDF 区域和 PNG，标出 expected 框；不要只看 image 标签存在或 canvas 尺寸。

在 `docs/figure-region-validation.md` 记录下表的实际结果和截图/输出文件位置，未运行项写“未运行”及原因，不能打勾代替执行：

| 环境 | 必须执行 |
| --- | --- |
| Zotero 7 | 加载自有 fixture；原/译/双语、引用、目录、放大、来源跳转、快照与导出 |
| Zotero 8 | 同上；重点确认 PDF.js worker 与 canvas 编码 |
| Zotero 9 | 同上；额外核对已有 toolbar listener 清理兼容路径 |
| Zotero 10 | 同上；验证多窗口和窗口关闭时的中止 |
| 每个可交付支持环境 | 300/520/760/1200 px 阅读区；检查 PNG 等比缩放、子图位置不变 |
| 生命周期 | 每个版本执行 100 次打开/关闭，穿插两窗口、同 PDF 竞争、渲染/编码中取消 |

像素检查：位图、矢量线、箭头、短标签和共享图例全部存在；外部 caption/正文不进入 PNG；Rotate、非零 CropBox 和 UserUnit 对应的特征点正确。以确定性几何/特征检查为主，允许字体抗锯齿差异，不要求跨平台 PNG 字节相同。

生命周期报告记录开始/结束时活动 render/loading tasks、监听器、已分配 canvas 和 object URL 的计数；最终回到基线。内存只检查静置/正常 GC 后不持续增长，不能把瞬时 RSS 差异当泄漏证明。自动化 fake DOM 计数与真实 Zotero 记录分开列示。用户原报错 PDF 如果尚未取得，记录这一覆盖限制，不宣称已验证该文件。

- [ ] **Step 5：补齐用户说明、本地化和全部交付检查。** 新增阶段/提示使用以下中英文含义，并接入现有文档级 warning 展示通路；同一文档最多一次恢复不完整提示：

| 消息 key | 简体中文 | English |
| --- | --- | --- |
| loading.restoringFigures | 正在恢复完整图表… | Restoring complete figures… |
| figure.restorePartial | {count} 个图组保留了原始图片和文字，可通过来源定位核对。 | Original images and text were kept for {count} figures. Use the source location to check them. |

使用现有 translateMessage(language, key, { count }) 的花括号参数格式。达到发现预算、无法可靠计数时使用 figure.restoreIncomplete：中文“部分图组保留了原始图片和文字，可通过来源定位核对。”、英文“Original images and text were kept for some figures. Use the source location to check them.”。阅读 UI 从 figureMap.preserved 派生提示；其中存在 resource-limit 时采用不计数提示，不持久化某一语言的文字，也不改变现有普通 warnings 数组的格式。README 中英同时说明：多子图整区恢复、保守回退、原图与 generated PNG 的本地存储、被消费 OCR 片段的追溯保留、缓存不加密、token 不加密、PDF 仍按所选 OCR 服务既有方式处理、本地恢复无新增外部 OCR 请求、保存快照新增附件可随 Zotero 同步、普通 Markdown 导出不携带追溯 JSON。

全部新增 src 文件及两个开发脚本加入显式 check 清单；不改依赖版本或发布版本。更新打包测试确保 Firefox 115 bundle 成功、既有 PDF 资源可定位，开发 harness/fixtures 不进入 XPI。README 所述行为与可用服务商证据相符，不能宣传所有无坐标 PDF 都能自动还原。

使用项目指定 Node 版本，依次执行；已有 node_modules 需与 lockfile 匹配，必要时先 npm ci：

```bash
nvm use 24.15.0
node --version
node scripts/generate-figure-fixtures.mjs
node --test test/figure-pipeline.test.js test/figure-restoration-service.test.js test/pdfjs-figure-region.test.js test/markdown-figure-references.test.js test/markdown-export.test.js test/zotero-saved-markdown-store.test.js
npm run check
npm test
npm run build
git diff --check
```

没有 nvm 的环境将 `/Users/tenglvjun/.nvm/versions/node/v24.15.0/bin` 前置到 PATH，不能退回本机默认的 Node 25。第二次生成 fixture 后二进制/JSON 应无 diff。检查未执行项必须进入交付说明，实际 Zotero 矩阵缺项时不得把完整验收标为通过。

- [ ] **Step 6：仅暂存本任务产物并提交最终验收记录。** `git commit -m "test: verify complete figure restoration across document workflows"`。最后对基线以来的完整 diff 自审；一个 PR 包含三个阶段和真实验证证据，PR 标题/描述以最终行为为准。此任务不自动发布版本。

## 验收要求到任务的对应

| 设计验收 | 主要实现 | 可复核证据 |
| --- | --- | --- |
| A01 复杂布局原貌 | T01、T04–T09、T12 | resolver/两 provider 集成；真实 PDF 各布局和窄窗口截图 |
| A02 图内文字归属、正文保留 | T03、T05、T06、T08 | 重复标签/共享图例/非连续范围；逐字正文和 provenance 断言 |
| A03 不误合并独立对象 | T04、T06、T08 | 独立编号、上方图注、两栏/跨页/表格/公式阻挡样例 |
| A04 失败和取消保留内容 | T07–T11 | 每类 preserve 原因、时限/预算、取消前后 cache/pending task 检查 |
| A05 图注独立可用 | T08、T12、T13 | 图注次数、selection/search/translation、captionBBox 来源映射 |
| A06 图组消费一致 | T11–T13 | 正文、目录、预览 sourceId/PNG 一致；子图引用与歧义回退 |
| A07 所有文档通路及旧数据 | T09–T14 | cache/revision/translation/snapshot/export 往返；精确旧 profile fixture |
| A08 PDF 图形与坐标正确 | T07、T15 | 真实 PDF.js/canvas 的线、字、箭头、旋转、CropBox/UserUnit 核验 |
| A09 无新增生命周期泄漏 | T07、T09、T12、T15 | 注入计数器＋各 Zotero 版本 100 次循环与多窗口记录 |
| A10 工程与文档完整 | 各任务、T15 | 窄测试/check/full test/build 输出；中英文说明和打包检查 |

## 完成判定与实施顺序

- [ ] 三步及 T01–T15 全部完成，不能以只修断组或只定义数据模型结项。
- [ ] 成功 Figure 的 PNG、Markdown、sourceMap、figureMap 与原片段同一事务提交；所有 preserve 原因都不提前删文。
- [ ] 无 proprietary Markdown 依赖；同一完整图在阅读、快照和普通导出中均可见。
- [ ] 原/译/双语遵守现有图片去重行为；旧缓存、旧修订、旧快照的真实身份与可读性保持。
- [ ] 安全、资源预算、原子写入、取消和清理检查完整；未引入与本功能无关的重构。
- [ ] 自动验证和真实 Zotero 验证分别有证据，缺项和未检查的用户原文件如实记录。

推荐按 T01 至 T15 的编号顺序执行，T15 最后汇总前序测试；不要等到最后才运行窄测试。集成时先保障单张完整 PNG 的转换/缓存通路，再扩大 fixture 的布局范围，最终以同一 PR 交付全部三步。三个阶段不是三份需要用户重新描述需求的独立工作。
