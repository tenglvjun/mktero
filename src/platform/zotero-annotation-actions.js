import {
    isZoteroAnnotationColor,
    MAX_PDF_ANNOTATION_TEXT_LENGTH,
} from '../core/pdf-annotation.js';

export function createZoteroAnnotationActions(zotero) {
    return {
        async changeColor(itemID, annotationID, color) {
            const normalizedColor = String(color || '').toLowerCase();
            if (!isZoteroAnnotationColor(normalizedColor)) {
                throw new Error('Unsupported PDF annotation color');
            }
            const annotation = editableAnnotation(
                zotero,
                itemID,
                annotationID
            );
            await saveAnnotationField(
                zotero,
                annotation,
                'annotationColor',
                normalizedColor
            );
        },
        async deleteAnnotation(itemID, annotationID) {
            const annotation = editableAnnotation(
                zotero,
                itemID,
                annotationID
            );
            await withNotifierQueue(zotero, async notifierQueue => {
                await annotation.eraseTx({ notifierQueue });
            });
        },
        async updateComment(itemID, annotationID, comment) {
            const normalizedComment = String(comment ?? '');
            if (normalizedComment.length > MAX_PDF_ANNOTATION_TEXT_LENGTH) {
                throw new Error(
                    'PDF annotation comment exceeds the safety limit'
                );
            }
            const annotation = editableAnnotation(
                zotero,
                itemID,
                annotationID
            );
            await saveAnnotationField(
                zotero,
                annotation,
                'annotationComment',
                normalizedComment
            );
        },
    };
}

async function saveAnnotationField(zotero, annotation, field, value) {
    const previousValue = annotation[field];
    try {
        await withNotifierQueue(zotero, async notifierQueue => {
            annotation[field] = value;
            await annotation.saveTx({
                skipDateModifiedUpdate: true,
                notifierQueue,
            });
        });
    }
    catch (error) {
        annotation[field] = previousValue;
        throw error;
    }
}

function editableAnnotation(zotero, itemID, annotationID) {
    const attachment = zotero.Items.get(itemID);
    const key = String(annotationID || '');
    const annotation = attachment && key
        ? zotero.Items.getByLibraryAndKey(attachment.libraryID, key)
        : null;
    if (!annotation?.isAnnotation?.()
        || annotation.parentID !== attachment.id
        || !annotation.isEditable?.()) {
        throw new Error('PDF annotation is unavailable or read-only');
    }
    return annotation;
}

async function withNotifierQueue(zotero, action) {
    const notifierQueue = new zotero.Notifier.Queue();
    try {
        await action(notifierQueue);
    }
    finally {
        await zotero.Notifier.commit(notifierQueue);
    }
}
