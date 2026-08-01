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
    return {
        visible: true,
        preserveContent,
        progress,
        progressLabel: `${progress}%`,
        title: translate(resumingTask
            ? 'loading.resumingTitle'
            : preserveContent
                ? 'loading.reparsingTitle'
                : 'loading.convertingTitle'),
        detail: resumingTask && progress < CONVERSION_PROGRESS.DOWNLOADING
            ? translate('loading.resuming')
            : progressDetail(progress, translate),
        hint: translate(resumingTask
            ? 'loading.resumeHint'
            : preserveContent
                ? 'loading.reparseHint'
                : 'loading.defaultHint'),
    };
}

function progressDetail(progress, translate) {
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
