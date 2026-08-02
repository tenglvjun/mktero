const messages = {
    zh: {
        'nav.workflow': '工作流',
        'nav.evidence': '证据链',
        'nav.privacy': '隐私',
        'hero.eyebrow': 'ZOTERO READING LAYER',
        'hero.title': '把复杂论文重排成好读的正文，同时保留每条证据回到 PDF 的路径。',
        'hero.lede': 'Mktero 是一个面向 Zotero 的来源关联重排阅读器。阅读双栏、公式和表格密集的论文，在 Markdown 中标注，再回到原始 PDF 核对。',
        'hero.download': '下载最新版本',
        'hero.beta': '加入种子用户',
        'hero.support': '支持 Zotero 7、8 和 9',
        'hero.openSource': 'MIT 开源',
        'hero.demoLabel': '从 Zotero PDF 到可核验阅读',
        'hero.demoCaption': '重排阅读 · Zotero 标注 · PDF 来源跳转',
        proof: '不是另一个 Markdown 编辑器。Mktero 让 PDF 成为事实源，让阅读、标注和摘录保持可核验。',
        'workflow.eyebrow': 'THE READING LOOP',
        'workflow.title': '一篇论文，三步进入你的阅读工作流。',
        'workflow.lede': 'Mktero 把转换结果留在 Zotero 的阅读上下文里，不迫使你在 PDF、笔记和浏览器之间来回切换。',
        'workflow.one.title': '打开',
        'workflow.one.body': '从 PDF 阅读器工具栏或文库右键打开。Mktero 使用 MinerU 解析正文、公式、表格、图片和引用。',
        'workflow.two.title': '阅读与标注',
        'workflow.two.body': '在连续、只读的 Markdown 视图中搜索、浏览目录、预览引用和图表，并直接创建 Zotero 标注。',
        'workflow.three.title': '核对与复用',
        'workflow.three.body': '点击来源回到 PDF 原位，或复制带论文标题、物理页码和 Zotero 回链的摘录。',
        'evidence.eyebrow': 'READ WITH PROOF',
        'evidence.title': '每一次摘录，都有回去的路。',
        'evidence.lede': 'MinerU 的内容块与 PDF 页码、区域坐标建立关联。Mktero 只在匹配可靠时显示跳转，宁可少一个按钮，也不猜测原文位置。',
        'evidence.pin': '第 4 页 · 来源块',
        'evidence.note': '同步到 Zotero 的高亮',
        'evidence.itemOne': '正文、公式、表格和图表都可以回到 PDF 来源',
        'evidence.itemTwo': 'Markdown 与 Zotero PDF 标注保持同步',
        'evidence.itemThree': '复制摘录时保留页码与 Zotero 回链',
        'features.eyebrow': 'MADE FOR PAPERS',
        'features.title': '为真正难读的论文而做。',
        'features.one.title': '连续正文',
        'features.one.body': '把双栏布局、OCR 断行、公式和表格整理成适合连续阅读的视图。',
        'features.two.title': '学术结构',
        'features.two.body': '目录、引用预览、图表引用、图片放大和 KaTeX 公式都保留在阅读上下文中。',
        'features.three.title': '来源意识',
        'features.three.body': '不把 Markdown 当作新的事实源。PDF 仍是原文，Mktero 负责让它更容易读和核对。',
        'features.four.title': '本地缓存',
        'features.four.body': '相同 PDF 可从本机缓存打开，避免每次重新上传和解析。',
        'privacy.eyebrow': 'KNOW WHERE YOUR PAPER GOES',
        'privacy.title': '数据边界清楚，选择留给你。',
        'privacy.body': '首次转换或缓存未命中时，完整 PDF 会上传到 MinerU。API Token、Markdown、图片和标注缓存保存在本机 Zotero 配置文件中，未加密且不会通过 Zotero 同步。',
        'privacy.link': '阅读完整隐私说明',
        'closing.eyebrow': 'START WITH ONE PAPER',
        'closing.title': '让下一篇论文更容易读懂，也更容易核对。',
        'closing.download': '下载 Mktero',
        'closing.source': '查看源代码',
        'closing.meta': '需要 MinerU API Token · 支持 Zotero 7–9 · MIT License',
        footer: '一个让学术阅读更可核验的 Zotero 插件。',
    },
    en: {
        'nav.workflow': 'Workflow',
        'nav.evidence': 'Evidence',
        'nav.privacy': 'Privacy',
        'hero.eyebrow': 'ZOTERO READING LAYER',
        'hero.title': 'Read complex papers as clean text without losing the path back to the PDF.',
        'hero.lede': 'Mktero is a source-linked reflow reader for Zotero. Read papers with dense layouts, formulas, and tables in Markdown, annotate them, and verify every passage in the original PDF.',
        'hero.download': 'Download latest release',
        'hero.beta': 'Join the seed cohort',
        'hero.support': 'Supports Zotero 7, 8, and 9',
        'hero.openSource': 'MIT licensed',
        'hero.demoLabel': 'From a Zotero PDF to verifiable reading',
        'hero.demoCaption': 'Reflowed reading · Zotero annotations · PDF source navigation',
        proof: 'Not another Markdown editor. Mktero keeps the PDF as the source of truth while making reading, annotation, and reuse verifiable.',
        'workflow.eyebrow': 'THE READING LOOP',
        'workflow.title': 'One paper, three steps into your reading workflow.',
        'workflow.lede': 'Mktero keeps the parsed result in Zotero, so you can move through reading, annotation, and verification without losing context.',
        'workflow.one.title': 'Open',
        'workflow.one.body': 'Open from the PDF reader toolbar or the library context menu. MinerU extracts text, formulas, tables, figures, and references.',
        'workflow.two.title': 'Read and annotate',
        'workflow.two.body': 'Search a continuous, read-only Markdown view, browse the outline, preview references and figures, and create Zotero annotations.',
        'workflow.three.title': 'Verify and reuse',
        'workflow.three.body': 'Jump back to the source PDF or copy a passage with its paper title, physical page, and Zotero link.',
        'evidence.eyebrow': 'READ WITH PROOF',
        'evidence.title': 'Every excerpt has a way back.',
        'evidence.lede': 'MinerU content blocks are linked to PDF pages and region coordinates. Mktero only shows navigation when the match is reliable; it does not guess.',
        'evidence.pin': 'Page 4 · source block',
        'evidence.note': 'Highlight synced to Zotero',
        'evidence.itemOne': 'Return to the PDF source for text, formulas, tables, and figures',
        'evidence.itemTwo': 'Keep Markdown annotations in sync with Zotero PDF annotations',
        'evidence.itemThree': 'Copy excerpts with page numbers and Zotero links',
        'features.eyebrow': 'MADE FOR PAPERS',
        'features.title': 'Built for papers that are hard to read.',
        'features.one.title': 'Continuous text',
        'features.one.body': 'Turn columns, OCR line breaks, formulas, and tables into a view made for focused reading.',
        'features.two.title': 'Academic structure',
        'features.two.body': 'Keep outlines, citation previews, figure references, image zoom, and KaTeX formulas in context.',
        'features.three.title': 'Source-aware by design',
        'features.three.body': 'Markdown is a reading surface, not a replacement source. The PDF remains the paper; Mktero makes it easier to read and check.',
        'features.four.title': 'Local cache',
        'features.four.body': 'Open unchanged PDFs from the local cache instead of uploading and parsing them again.',
        'privacy.eyebrow': 'KNOW WHERE YOUR PAPER GOES',
        'privacy.title': 'Clear data boundaries. Your choice.',
        'privacy.body': 'On the first conversion or a cache miss, the complete PDF is uploaded to MinerU. API tokens, Markdown, images, and annotation caches stay unencrypted in the local Zotero profile and are not synced by Zotero.',
        'privacy.link': 'Read the full privacy notes',
        'closing.eyebrow': 'START WITH ONE PAPER',
        'closing.title': 'Make your next paper easier to understand and easier to verify.',
        'closing.download': 'Download Mktero',
        'closing.source': 'View source',
        'closing.meta': 'MinerU API Token required · Zotero 7–9 · MIT License',
        footer: 'A Zotero plugin for more verifiable scholarly reading.',
    },
};

const languageButton = document.querySelector('[data-language-toggle]');
const languageNames = { zh: 'EN', en: '中' };
let language = document.documentElement.lang === 'en' ? 'en' : 'zh';

function translatePage() {
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
    for (const element of document.querySelectorAll('[data-i18n]')) {
        const message = messages[language][element.dataset.i18n];
        if (message) element.textContent = message;
    }
    languageButton.textContent = languageNames[language];
    languageButton.setAttribute(
        'aria-label',
        language === 'en' ? '切换到简体中文' : 'Switch to English'
    );
    document.title = language === 'en'
        ? 'Mktero | Source-linked reading for Zotero'
        : 'Mktero | Zotero 的来源关联阅读器';
    localStorage.setItem('mktero-language', language);
}

const savedLanguage = localStorage.getItem('mktero-language');
if (savedLanguage === 'en' || savedLanguage === 'zh') language = savedLanguage;
languageButton.addEventListener('click', () => {
    language = language === 'en' ? 'zh' : 'en';
    translatePage();
});
document.querySelector('[data-current-year]').textContent = new Date().getFullYear();
translatePage();
