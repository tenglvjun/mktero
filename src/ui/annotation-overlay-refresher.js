export function createAnnotationOverlayRefresher({ presenter, service }) {
    if (!presenter?.get || !presenter?.list || !presenter?.update) {
        throw new TypeError('A Markdown tab presenter is required');
    }
    if (typeof service?.resolveAnnotations !== 'function') {
        throw new TypeError('A Markdown annotation service is required');
    }

    const generations = new Map();
    let active = true;

    return {
        async refresh(itemIDs) {
            if (!active) return;
            const presentations = itemIDs
                ? [...new Set(itemIDs)]
                    .map(itemID => (
                        presenter.get(itemID)
                        || presenter.getForSourceItem?.(itemID)
                    ))
                    .filter(Boolean)
                : presenter.list();
            await Promise.all(presentations.map(refreshPresentation));
        },
        dispose() {
            active = false;
            generations.clear();
        },
    };

    async function refreshPresentation(presentation) {
        if (presentation.closed || presentation.model.status !== 'ready') return;
        if (presentation.model.renderMode === 'html') return;
        const itemID = presentation.model.sourceItemID
            ?? presentation.model.itemID;
        const documentID = presentation.model.documentID ?? itemID;
        const { markdown, sourceMap } = presentation.model;
        const generation = Symbol('annotation-refresh');
        generations.set(documentID, generation);
        let result;
        try {
            result = await service.resolveAnnotations(itemID, markdown, {
                sourceMap,
            });
        }
        catch (error) {
            if (generations.get(documentID) === generation) {
                generations.delete(documentID);
            }
            throw error;
        }
        if (!active || generations.get(documentID) !== generation) return;
        generations.delete(documentID);
        const current = presenter.get(documentID)
            || presenter.getForSourceItem?.(itemID);
        if (!current
            || current !== presentation
            || current.closed
            || current.model.status !== 'ready'
            || current.model.markdown !== markdown
            || !result.annotationOverlay) {
            return;
        }
        presenter.update(current, {
            annotationOverlay: result.annotationOverlay,
        });
    }
}
