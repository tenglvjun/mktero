export function createLoadingPresentation(model = {}) {
    if (model.status !== 'loading') return { visible: false };

    const progress = normalizeProgress(model.progress);
    const preserveContent = Boolean(model.preserveContent);
    return {
        visible: true,
        preserveContent,
        progress,
        progressLabel: `${progress}%`,
        title: preserveContent ? 'Reparsing PDF…' : 'Converting PDF…',
        detail: progressDetail(progress),
        hint: preserveContent
            ? 'The current Markdown remains available until the new result is ready.'
            : 'This can take a few minutes. Keep this tab open while MinerU finishes.',
    };
}

function normalizeProgress(progress) {
    const value = Number(progress);
    if (!Number.isFinite(value)) return 0;
    return Math.min(100, Math.max(0, Math.round(value)));
}

function progressDetail(progress) {
    if (progress < 5) return 'Preparing the PDF for MinerU.';
    if (progress < 10) return 'Uploading the PDF to MinerU.';
    if (progress < 95) return 'MinerU is parsing the document.';
    return 'Downloading and preparing the Markdown result.';
}
