// A sample paper written for the website preview. It is not a real study:
// the method, data and numbers are illustrative, and the closing note says so
// in the rendered document. The references are real, well-known papers, cited
// without identifiers so the preview never links to a guessed DOI.

export const PAPER_TITLE = 'Learning Reading Order for Multi-Column Scientific PDFs';

export const PAPER_SHORT_TITLE = 'Learning Reading Order for Multi-Column';

export const PAPER_CREATORS = 'Lindqvist et al.';

export const PAPER_YEAR = '2025';

export const FIGURE_PATH = 'images/figure-1.png';

export const PAPER_MARKDOWN = [
    `# ${PAPER_TITLE}`,
    'Maren Lindqvist<sup>1</sup>, Daniel Okafor<sup>1,2</sup>, Yuki Haraguchi<sup>2</sup>',
    '<sup>1</sup> Department of Computer Science, Northbridge University  <sup>2</sup> Institute for Document Intelligence',
    '## Abstract',
    'Scientific PDFs store text as positioned glyphs, not as an ordered stream. Recovering the order a person reads in is the first step of every conversion pipeline, and errors at this step break paragraphs, separate captions from figures and push footnotes into body text. We treat reading order as a pairwise ranking problem over layout blocks and decode the ranking with column constraints. On 1,240 annotated pages, the method reaches a Kendall\'s $\\tau$ of 0.947 and reduces paragraph-order errors by 38% relative to a geometric baseline, while adding about 12 ms per page on a laptop CPU.',
    '## 1. Introduction',
    'A two-column article interleaves body text, floating figures, full-width tables and running headers. Rule-based methods such as the recursive X-Y cut [1] split the page into rectangles and read them top to bottom, left to right. They are fast and predictable, but they fail when a figure spans both columns or when a caption sits beside the figure instead of below it.',
    'Learned layout models [2, 3] classify blocks well, yet most systems still order those blocks with hand-written rules. Our goal is narrower than full layout analysis: given blocks that are already detected, predict the order in which a reader visits them, quickly enough to run on every page of a personal library.',
    '## 2. Method',
    '### 2.1 Pairwise precedence',
    'For each pair of blocks $b_i$ and $b_j$ on a page, a small network estimates the probability that $b_i$ is read before $b_j$:',
    '$$\nP(b_i \\prec b_j) = \\sigma\\left(\\mathbf{w}^{\\top} \\phi(b_i, b_j) + c\\right)\n$$',
    'where $\\phi$ encodes the relative position, column membership, font size and block type of the pair, and $\\sigma$ is the logistic function. The features are cheap to compute and do not depend on the language of the text.',
    '### 2.2 Constrained decoding',
    'The predicted order is the permutation $\\pi$ that agrees most with the pairwise scores while keeping each column contiguous. Exact search is expensive, so we start from a column-aware topological sort and apply local swaps while the objective improves:',
    '```python\ndef decode(blocks, score):\n    order = column_topological_sort(blocks)\n    improved = True\n    while improved:\n        improved = False\n        for i in range(len(order) - 1):\n            a, b = order[i], order[i + 1]\n            if score(b, a) > score(a, b) and same_column(a, b):\n                order[i], order[i + 1] = b, a\n                improved = True\n    return order\n```',
    '## 3. Experiments',
    'We evaluate on 1,240 pages from 96 papers in physics, biology and computer science, each annotated with a reference reading order. Table 1 compares the method with two baselines. Kendall\'s $\\tau$ measures agreement with the reference order; paragraph error counts paragraphs that are split or merged incorrectly.',
    'Table 1. Reading-order quality and speed on the evaluation pages.',
    '<table><tr><td>Method</td><td>Kendall\'s τ</td><td>Paragraph error</td><td>Time per page</td></tr><tr><td>Recursive X-Y cut</td><td>0.861</td><td>14.2%</td><td>1.9 ms</td></tr><tr><td>Geometric rules</td><td>0.902</td><td>9.7%</td><td>3.4 ms</td></tr><tr><td>Ours</td><td>0.947</td><td>6.0%</td><td>11.6 ms</td></tr></table>',
    'The learned ranking gives the largest gain on pages with floating figures and full-width tables, where both baselines often read a caption before the figure it describes. Figure 1 shows the error rate by page layout.',
    `![](${FIGURE_PATH})`,
    'Figure 1. Paragraph-order error by page layout. The gap between the methods widens as layouts become less regular.',
    '## 4. Discussion',
    'The pairwise model stays small enough to run on every page during conversion, so it does not need a GPU or a network call. It still struggles with pages that mix three or more columns with irregular insets, and its decisions are only as good as the block detector that feeds it.',
    '## 5. Conclusion',
    'A small pairwise model with constrained decoding recovers reading order accurately at a cost low enough for a local conversion pipeline.',
    '*This paper was written for the Mktero preview. The method and numbers are illustrative.*',
    '## References',
    '[1] J. Ha, R. M. Haralick and I. T. Phillips. Recursive X-Y cut using bounding boxes of connected components. ICDAR, 1995.',
    '[2] X. Zhong, J. Tang and A. Jimeno Yepes. PubLayNet: largest dataset ever for document layout analysis. ICDAR, 2019.',
    '[3] Y. Xu, M. Li, L. Cui, S. Huang, F. Wei and M. Zhou. LayoutLM: pre-training of text and layout for document image understanding. KDD, 2020.',
].join('\n\n');

// Simplified Chinese translations, keyed by the English block text they
// replace. The preview pairs them with translatable blocks at startup and
// reports any block left without a translation. Math, citations and
// figure/table labels are protected by the reader and stay verbatim, the same
// way a provider translation must keep them.
export const PAPER_TRANSLATIONS_ZH_CN = new Map([
    [`# ${PAPER_TITLE}`, '# 为多栏科学 PDF 学习阅读顺序'],
    ['## Abstract', '## 摘要'],
    ['Scientific PDFs store text', '科学 PDF 以定位后的字形保存文字，而不是一条有序的文本流。恢复人的阅读顺序是每条转换流水线的第一步；这一步出错会打断段落，让图注和图分开，把脚注混进正文。我们把阅读顺序看作版面块之间的成对排序问题，并在分栏约束下解码这个排序。在 1,240 个标注页面上，该方法的 Kendall $\\tau$ 达到 0.947，段落顺序错误比几何基线相对减少 38%，在笔记本 CPU 上每页只多花约 12 ms。'],
    ['## 1. Introduction', '## 1. 引言'],
    ['A two-column article', '双栏论文里交错着正文、浮动图、通栏表格和页眉。递归 X-Y 切分 [1] 这类基于规则的方法把页面切成矩形，再按从上到下、从左到右的顺序读取。它们快且可预测，但当一张图横跨两栏，或者图注放在图旁边而不是下方时就会出错。'],
    ['Learned layout models', '学习型版面模型 [2, 3] 对版面块的分类效果很好，但大多数系统仍然用手写规则给这些块排序。我们的目标比完整的版面分析更窄：给定已经检测出的块，预测读者访问它们的顺序，而且要快到能在个人文库的每一页上运行。'],
    ['## 2. Method', '## 2. 方法'],
    ['<sup>1</sup> Department', '<sup>1</sup> 北桥大学计算机科学系  <sup>2</sup> 文档智能研究所'],
    ['### 2.1 Pairwise precedence', '### 2.1 成对先后关系'],
    ['For each pair of blocks', '对于页面上的每一对块 $b_i$ 和 $b_j$，一个小网络估计 $b_i$ 先于 $b_j$ 被阅读的概率：'],
    ['where $\\phi$ encodes', '其中 $\\phi$ 编码这对块的相对位置、所属栏、字号和块类型，$\\sigma$ 是 logistic 函数。这些特征计算代价低，也不依赖文字的语言。'],
    ['### 2.2 Constrained decoding', '### 2.2 约束解码'],
    ['The predicted order is', '预测的顺序是在保持每一栏连续的前提下，与成对分数最一致的排列 $\\pi$。精确搜索代价很高，所以我们从按栏的拓扑排序出发，只要目标函数还在改善就做局部交换：'],
    ['## 3. Experiments', '## 3. 实验'],
    ['We evaluate on 1,240 pages', '我们在来自物理、生物和计算机科学 96 篇论文的 1,240 个页面上评估，每页都标注了参考阅读顺序。Table 1 把该方法与两个基线比较。Kendall $\\tau$ 衡量与参考顺序的一致程度；段落错误统计被错误拆分或合并的段落。'],
    ['Table 1. Reading-order quality', 'Table 1. 评估页面上的阅读顺序质量与速度。'],
    ['The learned ranking gives', '在含浮动图和通栏表格的页面上，学习到的排序提升最大；这类页面上两个基线经常先读图注、后读它描述的图。Figure 1 给出按页面版式统计的错误率。'],
    ['Figure 1. Paragraph-order error', 'Figure 1. 按页面版式统计的段落顺序错误。版式越不规则，两种方法的差距越大。'],
    ['## 4. Discussion', '## 4. 讨论'],
    ['The pairwise model stays', '成对模型足够小，可以在转换时对每一页运行，不需要 GPU，也不需要联网。它在混合三栏以上且带不规则插图的页面上仍然吃力，而且它的判断取决于上游块检测器的质量。'],
    ['## 5. Conclusion', '## 5. 结论'],
    ['A small pairwise model', '一个小型成对模型加上约束解码，就能以足够低的代价准确恢复阅读顺序，适合本地转换流水线。'],
    ['*This paper was written', '*本文为 Mktero 预览而写，其中的方法和数字仅作演示。*'],
]);

// Zotero PDF annotations that the preview shows as already matched to the
// Markdown, the way a real reader tab shows annotations made in the PDF.
export const PAPER_ANNOTATIONS = [
    {
        id: 'PREVIEW1',
        type: 'highlight',
        text: 'We treat reading order as a pairwise ranking problem over layout blocks',
        comment: 'Core idea: rank pairs, then decode with column constraints.',
        color: '#ffd400',
    },
    {
        id: 'PREVIEW2',
        type: 'highlight',
        text: 'reduces paragraph-order errors by 38% relative to a geometric baseline',
        comment: 'Compare with Table 1 before citing.',
        color: '#5fb236',
    },
    {
        id: 'PREVIEW3',
        type: 'underline',
        text: 'they fail when a figure spans both columns',
        comment: '',
        color: '#2ea8e5',
    },
    {
        id: 'PREVIEW4',
        type: 'highlight',
        text: 'It still struggles with pages that mix three or more columns with irregular insets',
        comment: 'Limitation to check on our lab\'s poster PDFs.',
        color: '#a28ae5',
    },
];
