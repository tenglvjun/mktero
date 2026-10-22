// A Zotero 7-style main window drawn with HTML for the browser preview: tab
// bar, library pane and PDF reader pane. Only the Mktero tab is real; the rest
// is a stand-in so the reader appears in its usual context. Icons come from
// lucide and Mktero's own mark, not from Zotero's icon set.
import {
    ALargeSmall,
    BookOpen,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    FilePlus,
    FileText,
    FolderClosed,
    FolderPlus,
    Headphones,
    Highlighter,
    Landmark,
    MessageSquare,
    MoveHorizontal,
    PanelLeft,
    PanelRight,
    Paperclip,
    PenLine,
    RefreshCw,
    Search,
    SquareDashed,
    StickyNote,
    Trash2,
    Type,
    Underline,
    UserRound,
    X,
    ZoomIn,
    ZoomOut,
} from 'lucide';
import { createLucideIcon, LUCIDE_ICONS } from '../src/icons/lucide-icon.js';
import { PAGE_HEIGHT, PAGE_WIDTH } from './document.js';
import { drawPage } from './render.js';

const ICONS = {
    bookOpen: BookOpen,
    chevronDown: ChevronDown,
    chevronLeft: ChevronLeft,
    chevronRight: ChevronRight,
    filePlus: FilePlus,
    fileText: FileText,
    folder: FolderClosed,
    folderPlus: FolderPlus,
    headphones: Headphones,
    highlighter: Highlighter,
    library: Landmark,
    message: MessageSquare,
    fitWidth: MoveHorizontal,
    panelLeft: PanelLeft,
    panelRight: PanelRight,
    paperclip: Paperclip,
    pen: PenLine,
    refresh: RefreshCw,
    search: Search,
    area: SquareDashed,
    note: StickyNote,
    textSize: ALargeSmall,
    trash: Trash2,
    text: Type,
    underline: Underline,
    user: UserRound,
    close: X,
    zoomIn: ZoomIn,
    zoomOut: ZoomOut,
};

const SHELL_COPY = {
    en: {
        library: 'My Library',
        collection: 'Document AI',
        subcollection: 'Reading order',
        publications: 'My Publications',
        duplicates: 'Duplicate Items',
        unfiled: 'Unfiled Items',
        trash: 'Trash',
        search: 'All Fields & Tags',
        title: 'Title',
        creator: 'Creator',
        date: 'Date',
        info: 'Info',
        itemType: 'Item Type',
        preprint: 'Preprint',
        author: 'Author',
        repository: 'Repository',
        abstract: 'Abstract',
        attachments: 'Attachments',
        tags: 'Tags',
        viewPDF: 'View PDF',
        showFile: 'Show File',
        addNote: 'Add Note',
        moveToTrash: 'Move Item to Trash…',
        samplePaperOnly: 'This preview includes one sample paper.',
        translationOnly: 'This preview includes a Simplified Chinese translation only.',
        windowTitle: 'Zotero',
        tabs: 'Tabs',
        closeTab: 'Close',
        page: 'Page',
        of: 'of',
    },
    zh: {
        library: '我的文库',
        collection: '文档智能',
        subcollection: '阅读顺序',
        publications: '我的出版物',
        duplicates: '重复条目',
        unfiled: '未分类条目',
        trash: '回收站',
        search: '所有字段和标签',
        title: '标题',
        creator: '创建者',
        date: '日期',
        info: '信息',
        itemType: '条目类型',
        preprint: '预印本',
        author: '作者',
        repository: '仓库',
        abstract: '摘要',
        attachments: '附件',
        tags: '标签',
        viewPDF: '查看 PDF',
        showFile: '显示文件',
        addNote: '添加笔记',
        moveToTrash: '移到回收站…',
        samplePaperOnly: '这个预览只包含一篇示例论文。',
        translationOnly: '这个预览只包含简体中文译文。',
        windowTitle: 'Zotero',
        tabs: '标签页',
        closeTab: '关闭',
        page: '页',
        of: '/',
    },
};

const LIBRARY_ITEMS = [
    { key: 'sample', creator: null, year: null, sample: true },
    { key: 'layoutlm', title: 'LayoutLM: Pre-training of Text and Layout for Document Image Understanding', creator: 'Xu et al.', year: '2020' },
    { key: 'publaynet', title: 'PubLayNet: largest dataset ever for document layout analysis', creator: 'Zhong et al.', year: '2019' },
    { key: 'xycut', title: 'Recursive X-Y cut using bounding boxes of connected components', creator: 'Ha et al.', year: '1995' },
];

export function createPreviewShell({
    document,
    root,
    language,
    localization,
    paper,
    pages,
    segments,
    getAnnotations,
    figureImage,
    onOpenMarkdown,
}) {
    const copy = SHELL_COPY[language] || SHELL_COPY.en;
    const t = localization.t.bind(localization);
    const h = createElementFactory(document);
    const icon = (name, size = 16) => createLucideIcon(document, typeof name === 'string'
        ? { name, nodes: ICONS[name] }
        : name, { size, className: 'shell-icon' });

    const state = {
        active: 'reader',
        open: { pdf: true, reader: true },
        pdfScale: 0,
        renderedScale: 0,
        toastTimer: null,
    };

    const tabButtons = {};
    const panes = {};
    let pageCanvases = [];
    let pageCounter;
    let pagesHost;

    const trafficLights = h('div', { class: 'window-lights', 'aria-hidden': 'true' },
        h('span', { class: 'light light-close' }),
        h('span', { class: 'light light-minimize' }),
        h('span', { class: 'light light-zoom' }));

    const libraryTab = h('button', {
        class: 'window-tab window-tab-library',
        type: 'button',
        role: 'tab',
        'data-tab': 'library',
    }, icon('library', 16), h('span', { class: 'window-tab-title' }, copy.library));
    tabButtons.library = libraryTab;

    const readerTab = (key, label, tabIcon) => {
        const close = h('span', {
            class: 'window-tab-close',
            role: 'button',
            'aria-label': copy.closeTab,
            'data-close': key,
        }, icon('close', 13));
        const tab = h('button', {
            class: 'window-tab',
            type: 'button',
            role: 'tab',
            'data-tab': key,
            title: label,
        }, tabIcon, h('span', { class: 'window-tab-title' }, label), close);
        tabButtons[key] = tab;
        return tab;
    };
    const tabList = h('div', { class: 'window-tabs', role: 'tablist', 'aria-label': copy.tabs },
        libraryTab,
        readerTab('pdf', paper.title, pdfIcon(h)),
        readerTab('reader', paper.title, createLucideIcon(document, LUCIDE_ICONS.mktero, {
            size: 16,
            className: 'shell-icon shell-icon-mktero',
        })));
    const titlebar = h('header', { class: 'window-titlebar' },
        trafficLights,
        tabList,
        h('span', { class: 'window-tabs-menu', 'aria-hidden': 'true' }, icon('chevronDown', 16)));

    panes.library = createLibraryPane();
    panes.pdf = createPDFPane();
    panes.reader = h('section', { class: 'window-pane window-pane-reader', 'data-pane': 'reader' });
    const body = h('div', { class: 'window-body' }, panes.library, panes.pdf, panes.reader);
    const toast = h('div', { class: 'window-toast', role: 'status', hidden: '' });
    const frame = h('div', { class: 'zotero-window', 'aria-label': copy.windowTitle },
        titlebar, body, toast);
    root.appendChild(frame);

    tabList.addEventListener('click', event => {
        const close = event.target.closest('[data-close]');
        if (close) {
            event.stopPropagation();
            closeTab(close.getAttribute('data-close'));
            return;
        }
        const tab = event.target.closest('[data-tab]');
        if (tab) activate(tab.getAttribute('data-tab'));
    });

    function activate(name) {
        if (name !== 'library') state.open[name] = true;
        state.active = name;
        for (const [key, tab] of Object.entries(tabButtons)) {
            tab.hidden = key !== 'library' && !state.open[key];
            tab.classList.toggle('is-selected', key === name);
            tab.setAttribute('aria-selected', String(key === name));
        }
        for (const [key, pane] of Object.entries(panes)) {
            const visible = key === name;
            pane.classList.toggle('is-visible', visible);
            pane.inert = !visible;
            pane.setAttribute('aria-hidden', String(!visible));
        }
        if (name === 'pdf') renderPDFPages();
    }

    function closeTab(name) {
        state.open[name] = false;
        if (state.active === name) {
            activate(state.open.reader ? 'reader' : state.open.pdf ? 'pdf' : 'library');
        }
        else {
            activate(state.active);
        }
    }

    function createLibraryPane() {
        const toolbar = h('div', { class: 'library-toolbar' },
            h('div', { class: 'toolbar-group' },
                toolButton('folderPlus'), toolButton('filePlus'), toolButton('paperclip'), toolButton('note')),
            h('div', { class: 'toolbar-group toolbar-group-end' },
                toolButton('refresh'),
                h('label', { class: 'library-search' }, icon('search', 14),
                    h('input', { type: 'search', placeholder: copy.search, 'aria-label': copy.search }))));
        const collections = h('nav', { class: 'library-collections', 'aria-label': copy.library },
            collectionRow('library', copy.library, 0),
            collectionRow('folder', copy.collection, 1, { open: true }),
            collectionRow('folder', copy.subcollection, 2, { selected: true }),
            collectionRow('user', copy.publications, 1),
            collectionRow('fileText', copy.duplicates, 1),
            collectionRow('fileText', copy.unfiled, 1),
            collectionRow('trash', copy.trash, 1));
        const header = h('div', { class: 'items-row items-header', role: 'row' },
            h('span', { class: 'items-cell items-title', role: 'columnheader' }, copy.title),
            h('span', { class: 'items-cell items-creator', role: 'columnheader' }, copy.creator),
            h('span', { class: 'items-cell items-date', role: 'columnheader' }, copy.date),
            h('span', { class: 'items-cell items-attachment', role: 'columnheader', 'aria-label': copy.attachments },
                icon('paperclip', 13)),
            h('span', { class: 'items-cell items-markdown', role: 'columnheader' }, t('column.markdownReady')));
        const rows = LIBRARY_ITEMS.map(item => {
            const title = item.sample ? paper.title : item.title;
            const row = h('div', {
                class: `items-row${item.sample ? ' is-selected' : ''}`,
                role: 'row',
                tabindex: '0',
                'data-item': item.key,
            },
            h('span', { class: 'items-cell items-title', role: 'gridcell' },
                h('span', { class: 'items-twisty', 'aria-hidden': 'true' }, icon('chevronRight', 12)),
                icon('fileText', 15),
                h('span', { class: 'items-text' }, title)),
            h('span', { class: 'items-cell items-creator', role: 'gridcell' }, item.creator || paper.creators),
            h('span', { class: 'items-cell items-date', role: 'gridcell' }, item.year || paper.year),
            h('span', { class: 'items-cell items-attachment', role: 'gridcell' }, pdfIcon(h)),
            h('span', { class: 'items-cell items-markdown', role: 'gridcell' },
                item.sample ? createLucideIcon(document, LUCIDE_ICONS.fileText, {
                    size: 14,
                    className: 'shell-icon items-markdown-ready',
                }) : ''));
            return row;
        });
        const items = h('div', { class: 'library-items', role: 'grid', 'aria-label': copy.library }, header, ...rows);
        const itemPane = h('aside', { class: 'library-item-pane' },
            h('h2', { class: 'item-pane-title' }, paper.title),
            h('section', { class: 'item-pane-section' },
                h('h3', {}, copy.info),
                infoRow(copy.itemType, copy.preprint),
                infoRow(copy.title, paper.title),
                infoRow(copy.author, 'Lindqvist, Maren'),
                infoRow(copy.author, 'Okafor, Daniel'),
                infoRow(copy.author, 'Haraguchi, Yuki'),
                infoRow(copy.repository, 'Mktero preview'),
                infoRow(copy.date, paper.year)),
            h('section', { class: 'item-pane-section' },
                h('h3', {}, copy.attachments),
                h('div', { class: 'item-pane-attachment' }, pdfIcon(h), h('span', {}, `${paper.shortTitle}.pdf`))),
            h('section', { class: 'item-pane-section' },
                h('h3', {}, copy.tags),
                h('div', { class: 'item-pane-tags' },
                    h('span', { class: 'item-pane-tag' }, 'reading order'),
                    h('span', { class: 'item-pane-tag' }, 'layout'))));
        const menu = h('div', { class: 'context-menu', role: 'menu', hidden: '' },
            menuItem('pdf', copy.viewPDF),
            menuItem('reader', t('menu.readAsMarkdown'), true),
            h('hr'),
            menuItem(null, copy.showFile),
            menuItem(null, copy.addNote),
            h('hr'),
            menuItem(null, copy.moveToTrash));
        const pane = h('section', { class: 'window-pane window-pane-library', 'data-pane': 'library' },
            toolbar,
            h('div', { class: 'library-layout' }, collections, items, itemPane),
            menu);
        items.addEventListener('click', event => {
            const row = event.target.closest('.items-row[data-item]');
            if (!row) return;
            for (const candidate of rows) candidate.classList.toggle('is-selected', candidate === row);
        });
        items.addEventListener('dblclick', event => {
            const row = event.target.closest('.items-row[data-item]');
            if (!row) return;
            if (row.getAttribute('data-item') === 'sample') activate('pdf');
            else showToast(copy.samplePaperOnly);
        });
        items.addEventListener('contextmenu', event => {
            const row = event.target.closest('.items-row[data-item="sample"]');
            if (!row) return;
            event.preventDefault();
            const bounds = pane.getBoundingClientRect();
            menu.style.left = `${event.clientX - bounds.left}px`;
            menu.style.top = `${event.clientY - bounds.top}px`;
            menu.hidden = false;
        });
        menu.addEventListener('click', event => {
            const target = event.target.closest('[data-open]');
            menu.hidden = true;
            if (!target) return;
            const name = target.getAttribute('data-open');
            if (name === 'reader') onOpenMarkdown?.();
            activate(name);
        });
        document.addEventListener('pointerdown', event => {
            if (!menu.hidden && !menu.contains(event.target)) menu.hidden = true;
        });
        return pane;
    }

    function collectionRow(iconName, label, depth, { open = false, selected = false } = {}) {
        return h('div', {
            class: `collection-row${selected ? ' is-selected' : ''}`,
            style: `--depth: ${depth}`,
        },
        h('span', { class: 'collection-twisty', 'aria-hidden': 'true' },
            depth === 1 && open ? icon('chevronDown', 12) : ''),
        icon(iconName, 15),
        h('span', { class: 'collection-label' }, label));
    }

    function infoRow(label, value) {
        return h('div', { class: 'info-row' },
            h('span', { class: 'info-label' }, label),
            h('span', { class: 'info-value' }, value));
    }

    function menuItem(open, label, mktero = false) {
        return h('button', {
            class: 'context-menu-item',
            type: 'button',
            role: 'menuitem',
            ...(open ? { 'data-open': open } : { disabled: '' }),
        },
        mktero ? createLucideIcon(document, LUCIDE_ICONS.mktero, {
            size: 14,
            className: 'shell-icon shell-icon-mktero',
        }) : h('span', { class: 'context-menu-spacer' }),
        label);
    }

    function toolButton(name, attributes = {}) {
        return h('button', { class: 'toolbar-button', type: 'button', tabindex: '-1', ...attributes }, icon(name, 16));
    }

    function createPDFPane() {
        pageCounter = h('span', { class: 'pdf-page-count' }, '1');
        const mkteroButton = h('button', {
            class: 'toolbar-button pdf-mktero-button',
            type: 'button',
            title: t('toolbar.openMarkdown'),
            'aria-label': t('toolbar.openMarkdownAria'),
        }, createLucideIcon(document, LUCIDE_ICONS.mktero, {
            size: 16,
            className: 'shell-icon shell-icon-mktero',
        }));
        mkteroButton.addEventListener('click', () => {
            onOpenMarkdown?.();
            activate('reader');
        });
        const zoomOut = toolButton('zoomOut');
        const zoomIn = toolButton('zoomIn');
        zoomOut.removeAttribute('tabindex');
        zoomIn.removeAttribute('tabindex');
        zoomOut.addEventListener('click', () => setZoom(state.pdfScale / 1.15));
        zoomIn.addEventListener('click', () => setZoom(state.pdfScale * 1.15));
        const toolbar = h('div', { class: 'pdf-toolbar' },
            h('div', { class: 'toolbar-group' },
                toolButton('panelLeft'), zoomOut, zoomIn, toolButton('fitWidth'),
                toolButton('bookOpen'), toolButton('headphones'),
                h('span', { class: 'toolbar-divider' }),
                pageCounter,
                h('span', { class: 'pdf-page-total' }, `/ ${pages.length}`)),
            h('div', { class: 'toolbar-group toolbar-group-center' },
                toolButton('text'), toolButton('highlighter', { class: 'toolbar-button is-active' }),
                toolButton('underline'), toolButton('message'), toolButton('area'), toolButton('pen'),
                h('span', { class: 'pdf-color', 'aria-hidden': 'true' })),
            h('div', { class: 'toolbar-group toolbar-group-end' },
                mkteroButton, toolButton('textSize'), toolButton('search'), toolButton('panelRight')));
        pagesHost = h('div', { class: 'pdf-pages' });
        pageCanvases = pages.map(page => {
            const canvas = h('canvas', { class: 'pdf-page-canvas', 'aria-label': `${copy.page} ${page.index + 1}` });
            const wrapper = h('div', { class: 'pdf-page', 'data-page-index': String(page.index) }, canvas);
            pagesHost.appendChild(wrapper);
            return { canvas, wrapper, page };
        });
        pagesHost.addEventListener('scroll', syncPageCounter, { passive: true });
        return h('section', { class: 'window-pane window-pane-pdf', 'data-pane': 'pdf' }, toolbar, pagesHost);
    }

    function fitScale() {
        const width = pagesHost.clientWidth || 900;
        return Math.max(0.6, Math.min(1.6, (width - 64) / PAGE_WIDTH));
    }

    function setZoom(scale) {
        state.pdfScale = Math.max(0.5, Math.min(2.5, scale));
        renderPDFPages();
    }

    function renderPDFPages() {
        if (!state.pdfScale) state.pdfScale = fitScale();
        const scale = state.pdfScale;
        const pixelRatio = Math.min(2, globalThis.devicePixelRatio || 1);
        const annotations = getAnnotations?.() || [];
        for (const { canvas, wrapper, page } of pageCanvases) {
            wrapper.style.width = `${Math.round(PAGE_WIDTH * scale)}px`;
            wrapper.style.height = `${Math.round(PAGE_HEIGHT * scale)}px`;
            drawPage(canvas, page, {
                segments,
                scale: scale * pixelRatio,
                runningTitle: paper.title,
                annotations,
                figureImage,
            });
        }
        state.renderedScale = scale;
    }

    function syncPageCounter() {
        const top = pagesHost.scrollTop + pagesHost.clientHeight * 0.3;
        let current = 0;
        for (const { wrapper, page } of pageCanvases) {
            if (wrapper.offsetTop <= top) current = page.index;
        }
        pageCounter.textContent = String(current + 1);
    }

    // Open the PDF tab at a source location and flash the region, the way
    // Mktero's source navigation lands in Zotero's reader.
    function revealPDFLocation({ pageIndex, bbox }) {
        activate('pdf');
        const target = pageCanvases[pageIndex];
        if (!target) return false;
        const [x0, y0, x1, y1] = bbox;
        const flash = h('span', {
            class: 'pdf-location-flash',
            style: `left:${x0 / 10}%;top:${y0 / 10}%;width:${(x1 - x0) / 10}%;height:${(y1 - y0) / 10}%`,
        });
        target.wrapper.querySelectorAll('.pdf-location-flash').forEach(node => node.remove());
        target.wrapper.appendChild(flash);
        const offset = target.wrapper.offsetTop + target.wrapper.offsetHeight * y0 / 1000;
        pagesHost.scrollTo({ top: Math.max(0, offset - pagesHost.clientHeight * 0.3) });
        syncPageCounter();
        globalThis.setTimeout(() => flash.classList.add('is-fading'), 1400);
        globalThis.setTimeout(() => flash.remove(), 2400);
        return true;
    }

    function showToast(message) {
        toast.textContent = message;
        toast.hidden = false;
        globalThis.clearTimeout(state.toastTimer);
        state.toastTimer = globalThis.setTimeout(() => {
            toast.hidden = true;
        }, 2600);
    }

    return {
        frame,
        readerPane: panes.reader,
        activate,
        revealPDFLocation,
        showToast,
        copy,
        get activeTab() {
            return state.active;
        },
        refreshPDF() {
            if (state.renderedScale) renderPDFPages();
        },
    };
}

function pdfIcon(h) {
    const svg = h('svg', {
        class: 'shell-icon shell-icon-pdf',
        width: '16',
        height: '16',
        viewBox: '0 0 16 16',
        'aria-hidden': 'true',
    });
    svg.innerHTML = '<path d="M3.5 1.5h6l3 3v10h-9z" fill="#fff" stroke="#8a9099"/><path d="M9.5 1.5v3h3" fill="none" stroke="#8a9099"/><rect x="2" y="7" width="9" height="4.5" rx="1" fill="#e5484d"/><path d="M3.6 10.3V8.2h.9a.7.7 0 0 1 0 1.4h-.9M6.3 10.3V8.2h.6c.6 0 1 .4 1 1.05s-.4 1.05-1 1.05zM8.8 10.3V8.2h1.3M8.8 9.25h1" fill="none" stroke="#fff" stroke-width=".6"/>';
    return svg;
}

const SVG_TAGS = new Set(['svg', 'path', 'rect']);

function createElementFactory(document) {
    return function h(tag, attributes = {}, ...children) {
        const element = SVG_TAGS.has(tag)
            ? document.createElementNS('http://www.w3.org/2000/svg', tag)
            : document.createElement(tag);
        for (const [name, value] of Object.entries(attributes)) {
            if (value === false || value === null || value === undefined) continue;
            element.setAttribute(name, value === true ? '' : String(value));
        }
        for (const child of children.flat()) {
            if (child === null || child === undefined || child === '') continue;
            element.append(typeof child === 'string' ? document.createTextNode(child) : child);
        }
        return element;
    };
}
