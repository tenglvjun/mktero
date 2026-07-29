import { WidgetType } from '@codemirror/view';
import {
    appendRenderedMarkdown,
    installRenderedImagePreview,
    openRenderedLink,
} from './rendered-markdown-dom.js';
import { installRenderedAnnotations } from './pdf-annotations.js';

export class RenderedTableWidget extends WidgetType {
    constructor({
        source,
        annotationSource,
        annotationSourceFrom,
        caption,
        resolveImageURL,
        openLink,
        openImagePreview,
        renderVersion,
        highlighted = false,
        annotations = [],
        translate,
    }) {
        super();
        this.source = source;
        this.annotationSource = annotationSource;
        this.annotationSourceFrom = annotationSourceFrom;
        this.caption = caption;
        this.resolveImageURL = resolveImageURL;
        this.openLink = openLink;
        this.openImagePreview = openImagePreview;
        this.renderVersion = renderVersion;
        this.highlighted = highlighted;
        this.annotations = annotations;
        this.annotationKey = JSON.stringify(annotations);
        this.translate = translate;
    }

    eq(other) {
        return this.source === other.source
            && this.annotationSource === other.annotationSource
            && this.annotationSourceFrom === other.annotationSourceFrom
            && this.caption?.text === other.caption?.text
            && this.renderVersion === other.renderVersion
            && this.highlighted === other.highlighted
            && this.annotationKey === other.annotationKey;
    }

    toDOM(view) {
        const document = view.dom.ownerDocument;
        const container = document.createElement('div');
        container.className = [
            'cm-mktero-rendered',
            'cm-mktero-table',
            this.highlighted ? 'cm-mktero-table-target-highlight' : '',
        ].filter(Boolean).join(' ');
        appendRenderedMarkdown(container, this.source, this.resolveImageURL);
        const table = container.querySelector('table');
        if (table && this.caption) {
            table.prepend(createTableCaption(document, this.caption));
        }
        for (const cell of container.querySelectorAll('th, td')) {
            cell.setAttribute('contenteditable', 'false');
            cell.setAttribute('aria-readonly', 'true');
        }
        installRenderedAnnotations(
            container,
            this.annotations,
            this.translate,
            {
                source: this.annotationSource,
                sourceFrom: this.annotationSourceFrom,
            }
        );
        container.addEventListener('mousedown', event => {
            if (event.target?.closest?.('img')) return;
            openRenderedLink(event, this.openLink);
        });
        installRenderedImagePreview(
            container,
            this.openImagePreview,
            this.translate
        );
        return container;
    }

    ignoreEvent(event) {
        if (event.type === 'mousedown'
            && event.target?.closest?.('.cm-mktero-pdf-annotation')) {
            return true;
        }
        return !event.target?.closest?.('.cm-mktero-pdf-annotation');
    }
}

function createTableCaption(document, caption) {
    const element = document.createElement('caption');
    const label = document.createElement('span');
    label.className = 'mktero-table-label';
    label.textContent = caption.label;
    element.append(label, ` ${caption.description}`);
    return element;
}
