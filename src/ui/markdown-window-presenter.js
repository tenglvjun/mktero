export class MarkdownWindowPresenter {
    constructor({ zotero, rootURI }) {
        this.zotero = zotero;
        this.rootURI = rootURI;
        this.presentations = new Map();
    }

    open(itemID) {
        const existing = this.presentations.get(itemID);
        if (existing && !existing.window.closed) {
            existing.window.focus();
            return { ...existing, created: false };
        }

        const owner = this.zotero.getMainWindow?.();
        if (!owner?.openDialog) {
            throw new Error('The Zotero main window is not available');
        }

        const model = {
            itemID,
            title: 'Converting PDF…',
            status: 'loading',
            progress: 0,
            markdown: '',
            sourceKind: null,
            warnings: [],
            error: '',
        };
        const window = owner.openDialog(
            `${this.rootURI}ui/markdown.xhtml`,
            `mktero-markdown-${itemID}`,
            'chrome,dialog=no,resizable,centerscreen,width=960,height=760',
            model
        );
        const presentation = { window, model };
        this.presentations.set(itemID, presentation);
        window.addEventListener('unload', () => {
            if (this.presentations.get(itemID)?.window === window) {
                this.presentations.delete(itemID);
            }
        }, { once: true });
        return { ...presentation, created: true };
    }

    update(presentation, changes) {
        Object.assign(presentation.model, changes);
        const window = presentation.window;
        if (!window.closed) {
            window.dispatchEvent(new window.CustomEvent('mktero:model-update'));
        }
    }

    closeAll() {
        for (const { window } of this.presentations.values()) {
            if (!window.closed) window.close();
        }
        this.presentations.clear();
    }
}
