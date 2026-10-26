import { translateEnglish } from '../i18n/localization.js';

export async function saveDiagnosticText({
    createFilePicker,
    ioUtils,
    ownerWindow,
    fileName,
    text,
    translate = translateEnglish,
}) {
    if (typeof createFilePicker !== 'function' || !ioUtils?.writeUTF8) {
        throw new Error(translate('diagnostics.saveFailed'));
    }
    if (typeof text !== 'string' || !text) {
        throw new Error(translate('diagnostics.saveFailed'));
    }
    const picker = createFilePicker();
    if (!picker?.init || typeof picker.show !== 'function' || picker.modeSave == null) {
        throw new Error(translate('diagnostics.saveFailed'));
    }
    picker.init(
        ownerWindow,
        translate('diagnostics.saveDialogTitle'),
        picker.modeSave
    );
    picker.defaultString = fileName;
    picker.appendFilter?.(translate('diagnostics.saveFilter'), '*.json');
    const result = await picker.show();
    if (result === picker.returnCancel) return { status: 'cancelled' };
    const filePath = String(picker.file || '');
    if (!filePath) throw new Error(translate('diagnostics.saveFailed'));
    await ioUtils.writeUTF8(filePath, text);
    return { status: 'saved' };
}
