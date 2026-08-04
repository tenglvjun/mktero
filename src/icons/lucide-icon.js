import {
    Check,
    ChevronLeft,
    ChevronRight,
    Clock,
    Copy,
    ExternalLink,
    FileText,
    LoaderCircle,
    MessageSquarePlus,
    MessageSquareText,
    MoreHorizontal,
    RefreshCw,
    Save,
    Trash2,
    TriangleAlert,
    X,
    ZoomIn,
    ZoomOut,
} from 'lucide';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const DEFAULT_ATTRIBUTES = Object.freeze({
    xmlns: SVG_NAMESPACE,
    width: '24',
    height: '24',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
});

export const LUCIDE_ICONS = Object.freeze({
    check: Object.freeze({
        name: 'check',
        nodes: Check,
    }),
    chevronLeft: Object.freeze({
        name: 'chevron-left',
        nodes: ChevronLeft,
    }),
    chevronRight: Object.freeze({
        name: 'chevron-right',
        nodes: ChevronRight,
    }),
    clock: Object.freeze({
        name: 'clock',
        nodes: Clock,
    }),
    copy: Object.freeze({
        name: 'copy',
        nodes: Copy,
    }),
    externalLink: Object.freeze({
        name: 'external-link',
        nodes: ExternalLink,
    }),
    fileText: Object.freeze({
        name: 'file-text',
        nodes: FileText,
    }),
    loaderCircle: Object.freeze({
        name: 'loader-circle',
        nodes: LoaderCircle,
    }),
    messageSquareText: Object.freeze({
        name: 'message-square-text',
        nodes: MessageSquareText,
    }),
    messageSquarePlus: Object.freeze({
        name: 'message-square-plus',
        nodes: MessageSquarePlus,
    }),
    moreHorizontal: Object.freeze({
        name: 'more-horizontal',
        nodes: MoreHorizontal,
    }),
    refreshCw: Object.freeze({
        name: 'refresh-cw',
        nodes: RefreshCw,
    }),
    save: Object.freeze({
        name: 'save',
        nodes: Save,
    }),
    trash2: Object.freeze({
        name: 'trash-2',
        nodes: Trash2,
    }),
    triangleAlert: Object.freeze({
        name: 'triangle-alert',
        nodes: TriangleAlert,
    }),
    x: Object.freeze({
        name: 'x',
        nodes: X,
    }),
    zoomIn: Object.freeze({
        name: 'zoom-in',
        nodes: ZoomIn,
    }),
    zoomOut: Object.freeze({
        name: 'zoom-out',
        nodes: ZoomOut,
    }),
});

export function createLucideIcon(
    document,
    icon,
    { className = '', size = 24 } = {}
) {
    const classes = ['lucide', `lucide-${icon.name}`, className]
        .filter(Boolean)
        .join(' ');
    const svg = createSvgElement(document, 'svg', {
        ...DEFAULT_ATTRIBUTES,
        width: String(size),
        height: String(size),
        class: classes,
        'data-lucide': icon.name,
        'aria-hidden': 'true',
        focusable: 'false',
    });
    appendIconNodes(document, svg, icon.nodes);
    return svg;
}

function appendIconNodes(document, parent, nodes) {
    for (const [tagName, attributes] of nodes) {
        parent.appendChild(createSvgElement(document, tagName, attributes));
    }
}

function createSvgElement(document, tagName, attributes) {
    const element = document.createElementNS(SVG_NAMESPACE, tagName);
    for (const [name, value] of Object.entries(attributes)) {
        element.setAttribute(name, String(value));
    }
    return element;
}
