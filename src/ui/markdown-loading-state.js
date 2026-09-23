import {
    CONVERSION_PROGRESS,
    normalizeConversionProgress,
} from '../core/conversion-progress.js';
import { translateEnglish } from '../i18n/localization.js';

export function createLoadingPresentation(model = {}, translate = translateEnglish) {
    if (model.status !== 'loading') return { visible: false };

    const progress = normalizeConversionProgress(model.progress);
    const preserveContent = Boolean(model.preserveContent);
    const resumingTask = Boolean(model.resumingTask);
    const batchOwned = Boolean(model.batchOwned);
    const queueAhead = Number.isInteger(model.queueAhead) && model.queueAhead >= 0
        ? model.queueAhead
        : null;
    const waiting = batchOwned
        && queueAhead !== null
        && progress < CONVERSION_PROGRESS.PREPARING;
    return {
        visible: true,
        preserveContent,
        progress,
        progressLabel: `${progress}%`,
        title: translate(waiting
            ? 'loading.preparingTitle'
            : resumingTask
                ? 'loading.resumingTitle'
                : preserveContent
                    ? 'loading.reparsingTitle'
                    : 'loading.convertingTitle'),
        detail: waiting
            ? queueDetail(queueAhead, translate)
            : conversionStageDetail(progress, { resumingTask }, translate),
        hint: translate(batchOwned && !preserveContent
            ? 'loading.batchOwnedHint'
            : resumingTask
                ? 'loading.resumeHint'
                : preserveContent
                    ? 'loading.reparseHint'
                    : 'loading.defaultHint'),
    };
}

export function conversionStageDetail(progress, state = {}, translate = translateEnglish) {
    const normalized = normalizeConversionProgress(progress);
    if (state?.resumingTask && normalized < CONVERSION_PROGRESS.DOWNLOADING) {
        return translate('loading.resuming');
    }
    return progressDetail(normalized, translate);
}

function queueDetail(queueAhead, translate) {
    return queueAhead > 0
        ? translate('loading.queueAhead', { count: queueAhead })
        : translate('loading.queued');
}

function progressDetail(progress, translate) {
    if (progress >= CONVERSION_PROGRESS.RESTORING_FIGURES) {
        return translate('loading.restoringFigures');
    }
    if (progress < CONVERSION_PROGRESS.UPLOADING) {
        return translate('loading.preparing');
    }
    if (progress < CONVERSION_PROGRESS.PARSING) {
        return translate('loading.uploading');
    }
    if (progress < CONVERSION_PROGRESS.DOWNLOADING) {
        return translate('loading.converting');
    }
    return translate('loading.downloading');
}
