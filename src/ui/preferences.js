import { createZoteroMarkdownCache } from '../cache/markdown-cache.js';
import {
    notifyLocalCacheCleared,
    withSuccessfulClearNotification,
} from '../cache/cache-events.js';
import {
    createZoteroPDFTextIndexCache,
} from '../cache/pdf-text-index-cache.js';
import { createZoteroTranslationCache } from '../cache/translation-cache.js';
import {
    createZoteroCitationGraphCache,
} from '../cache/citation-graph-cache.js';
import {
    createZoteroMarkdownReadingPositionStore,
} from '../cache/markdown-reading-position-store.js';
import {
    AI_API_BASE_PREF,
    AI_PROTOCOL_PREF,
    AI_PROVIDER_ALIBABA,
    AI_PROVIDER_CUSTOM,
    AI_PROVIDER_MINIMAX,
    AI_PROVIDER_MOONSHOT,
    AI_REASONING_PREF,
    AI_REQUEST_TIMEOUT_PREF,
    aiRequestTimeoutMsFromSeconds,
    aiRequestTimeoutSecondsFromMs,
    getAIProtocolsForProvider,
    getAISettings,
    alibabaApiBaseForRegion,
    alibabaApiBaseRegion,
    miniMaxApiBaseForRegion,
    miniMaxApiBaseRegion,
    moonshotApiBaseForRegion,
    moonshotApiBaseRegion,
    switchAIProvider,
    syncCurrentAIProviderProfile,
} from '../config/ai-preferences.js';
import {
    resolveAIReasoningLevels,
    selectAIReasoningValue,
} from '../config/ai-reasoning-options.js';
import { AISDKGateway } from '../ai/ai-sdk-gateway.js';
import {
    MarkdownTranslationService,
} from '../ai/markdown-translation-service.js';
import { createRuntimeAbortController } from '../platform/abort-controller.js';
import {
    getZoteroLocale,
    PREFERENCE_CONTROL_LIMITS,
} from '../config/mineru-preferences.js';
import {
    CONVERSION_PROVIDER_MINERU,
    CONVERSION_PROVIDER_MISTRAL,
    CONVERSION_PROVIDER_MKTERO,
    CONVERSION_PROVIDER_PREF,
    MISTRAL_API_KEY_PREF,
    DEFAULT_MINERU_LOCAL_API_BASE,
    MINERU_API_KEY_PREF,
    MINERU_ENDPOINT_LOCAL,
    MINERU_ENDPOINT_PREF,
    MINERU_LOCAL_API_BASE_PREF,
    MINERU_LOCAL_API_KEY_PREF,
    getConversionProvider,
    getMinerUApiKey,
    getMinerUEndpoint,
    getMinerULocalApiBase,
    getMinerULocalApiKey,
    getMistralApiKey,
    normalizeConversionProvider,
    normalizeMinerUEndpoint,
} from '../config/conversion-preferences.js';
import {
    getMkteroAccount,
    getMkteroConversionStats,
    loginMkteroAccount,
    logoutMkteroAccount,
    refreshMkteroAccount,
    registerMkteroAccount,
    requestPasswordReset,
    sendSignupCode,
    updateMkteroNickname,
} from '../account/account-client.js';
import {
    accessTokenNeedsRefresh,
    clearAccountSession,
    getAccountApiBase,
    getAccountSession,
    isAccountSignedIn,
    saveAccountSession,
    setAccountApiBase,
} from '../config/account-preferences.js';
import { isDebugBuild } from '../config/runtime-config.js';
import {
    getMarkdownReaderAlignment,
    getMarkdownReaderFont,
    getMarkdownReaderFontSize,
    getMarkdownReaderLineHeight,
    getMarkdownReaderSourcePeek,
    getMarkdownReaderWidth,
    MARKDOWN_READER_FONT_SIZE_MAX,
    MARKDOWN_READER_FONT_SIZE_MIN,
    setMarkdownReaderAlignment,
    setMarkdownReaderFont,
    setMarkdownReaderFontSize,
    setMarkdownReaderLineHeight,
    setMarkdownReaderSourcePeek,
    setMarkdownReaderWidth,
} from '../config/reader-preferences.js';
import {
    getObsidianSubdirectory,
    getObsidianVaultPath,
    setObsidianSubdirectory,
    setObsidianVaultPath,
} from '../config/obsidian-preferences.js';
import {
    ACTIVITY_WINDOW_DAYS,
    activityCellTitle,
    activitySummaryText,
    buildActivityGrid,
    emptyActivityDays,
    formatMemberSince,
} from './account-activity.js';
import {
    createLucideIcon,
    LUCIDE_ICONS,
} from '../icons/lucide-icon.js';
import {
    createLocalization,
    translateEnglish,
} from '../i18n/localization.js';

export function registerPreferencesPaneLoader({ document, initialize }) {
    const initializations = new Map();
    const disposePane = pane => {
        const record = initializations.get(pane);
        if (!record) return;
        initializations.delete(pane);
        record.disposed = true;
        record.initialization.then(cleanup => cleanup?.(), () => {});
    };
    const handleLoad = event => {
        const pane = event.target;
        if (pane?.id !== 'mktero-preferences-pane') return;
        let record = initializations.get(pane);
        if (!record) {
            record = { disposed: false, initialization: null };
            record.initialization = Promise.resolve()
                .then(() => initialize(event))
                .then(cleanup => {
                    if (record.disposed) cleanup?.();
                    return record.disposed ? null : cleanup;
                });
            initializations.set(pane, record);
        }
        event.waitUntil?.(record.initialization);
    };
    const handleUnload = event => {
        const pane = event.target;
        if (pane?.id === 'mktero-preferences-pane') disposePane(pane);
    };
    const dispose = () => {
        document.removeEventListener('load', handleLoad, true);
        document.removeEventListener('unload', handleUnload, true);
        document.defaultView?.removeEventListener('unload', dispose);
        for (const pane of initializations.keys()) disposePane(pane);
    };
    document.addEventListener('load', handleLoad, true);
    document.addEventListener('unload', handleUnload, true);
    document.defaultView?.addEventListener('unload', dispose);
    return dispose;
}

export function createPreferencesController({
    document,
    zotero,
    cache,
    services = typeof Services === 'undefined' ? null : Services,
    localization = createLocalization({
        zoteroLocale: getZoteroLocale(zotero, services),
    }),
    reasoningCatalog = null,
    testAIConnection = null,
    notifyAITestResult = null,
    confirmClearCache = null,
    createFilePicker = null,
    createAbortController = createRuntimeAbortController,
    // Injected so tests never reach the network; the pane only reads here.
    accountFetch = globalThis.fetch,
}) {
    const status = document.getElementById('mktero-cache-status');
    const clearButton = document.getElementById('mktero-clear-cache');
    const readerFontSizeInput = document.getElementById(
        'mktero-reader-font-size'
    );
    const readerFontSizeValue = document.getElementById(
        'mktero-reader-font-size-value'
    );
    const readerFontInput = document.getElementById(
        'mktero-reader-font-family'
    );
    const readerLineHeightInput = document.getElementById(
        'mktero-reader-line-height'
    );
    const readerWidthInput = document.getElementById(
        'mktero-reader-width'
    );
    const readerAlignmentInput = document.getElementById(
        'mktero-reader-alignment'
    );
    const readerSourcePeekInput = document.getElementById(
        'mktero-reader-source-peek'
    );
    const accountEmailInput = document.getElementById('mktero-account-email');
    const accountPasswordInput = document.getElementById('mktero-account-password');
    const accountLoginButton = document.getElementById('mktero-account-login');
    const accountRegisterButton = document.getElementById('mktero-account-register');
    const accountForgotButton = document.getElementById('mktero-account-forgot');
    const accountForgotBackButton = document.getElementById('mktero-account-forgot-back');
    const accountSendResetButton = document.getElementById('mktero-account-send-reset');
    const accountCodeInput = document.getElementById('mktero-account-code');
    const accountConfirmInput = document.getElementById('mktero-account-password-confirm');
    const accountSendCodeButton = document.getElementById('mktero-account-send-code');
    // The registration nickname is optional and only shown while registering.
    const accountNicknameInput = document.getElementById('mktero-account-register-nickname');
    const accountTabLogin = document.getElementById('mktero-account-tab-login');
    const accountTabRegister = document.getElementById('mktero-account-tab-register');
    const accountAvatar = document.getElementById('mktero-account-avatar');
    const accountSignedInNickname = document.getElementById('mktero-account-signed-in-nickname');
    const accountSignedInEmail = document.getElementById('mktero-account-signed-in-email');
    const accountCreated = document.getElementById('mktero-account-created');
    const accountEditNicknameButton = document.getElementById(
        'mktero-account-edit-nickname'
    );
    const accountNicknameDialog = document.getElementById(
        'mktero-account-nickname-dialog'
    );
    const accountNicknameDialogClose = document.getElementById(
        'mktero-account-nickname-dialog-close'
    );
    const accountNicknameDialogCancel = document.getElementById(
        'mktero-account-nickname-dialog-cancel'
    );
    const accountDialogStatus = document.getElementById(
        'mktero-account-dialog-status'
    );
    const accountProfileNicknameInput = document.getElementById('mktero-account-nickname');
    const accountSaveNicknameButton = document.getElementById('mktero-account-save-nickname');
    const accountStatTotal = document.getElementById('mktero-stat-total');
    const accountStatStreak = document.getElementById('mktero-stat-streak');
    const accountStatLongest = document.getElementById('mktero-stat-longest');
    const accountHeatmap = document.getElementById('mktero-heatmap');
    const accountHeatmapSummary = document.getElementById('mktero-heatmap-summary');
    // The account activity request runs once per pane load; a failed request
    // leaves the counters at zero instead of retrying on every render.
    let accountStats = null;
    let accountStatsRequested = false;
    let accountMode = 'login';
    let codeCooldownTimer = 0;
    const accountLogoutButton = document.getElementById('mktero-account-logout');
    const accountApiBaseInput = document.getElementById('mktero-account-api-base');
    const accountStatus = document.getElementById('mktero-account-status');
    const accountPanel = document.getElementById('mktero-account-panel');
    const obsidianVaultInput = document.getElementById('mktero-obsidian-vault');
    const obsidianVaultBrowse = document.getElementById(
        'mktero-obsidian-vault-browse'
    );
    const obsidianSubdirectoryInput = document.getElementById(
        'mktero-obsidian-subdirectory'
    );
    const conversionProviderInput = document.getElementById(
        'mktero-conversion-provider'
    );
    let accountBusy = false;
    const conversionApiKeyRow = document.getElementById('mktero-api-key-row');
    const conversionApiKeyInput = document.getElementById(
        'mktero-api-key'
    );
    const conversionApiKeyManage = document.getElementById(
        'mktero-api-key-manage'
    );
    const conversionApiKeyHelp = document.getElementById('mktero-api-key-help');
    const mineruEndpointRow = document.getElementById('mktero-mineru-endpoint-row');
    const mineruEndpointInput = document.getElementById('mktero-mineru-endpoint');
    const mineruLocalBaseRow = document.getElementById('mktero-mineru-local-base-row');
    const mineruLocalBaseInput = document.getElementById('mktero-mineru-local-base');
    const conversionPrivacyNote = document.getElementById(
        'mktero-conversion-privacy-note'
    );
    const aiTestButton = document.getElementById('mktero-ai-test');
    const aiProviderInput = document.getElementById('mktero-ai-provider');
    const aiProtocolInput = document.getElementById('mktero-ai-protocol');
    const aiApiBaseInput = document.getElementById('mktero-ai-api-base');
    const aiApiBaseRow = document.getElementById('mktero-ai-api-base-row');
    const aiMoonshotEndpointInput = document.getElementById(
        'mktero-ai-moonshot-endpoint'
    );
    const aiMoonshotEndpointRow = document.getElementById(
        'mktero-ai-moonshot-endpoint-row'
    );
    const aiMiniMaxEndpointInput = document.getElementById(
        'mktero-ai-minimax-endpoint'
    );
    const aiMiniMaxEndpointRow = document.getElementById(
        'mktero-ai-minimax-endpoint-row'
    );
    const aiAlibabaEndpointInput = document.getElementById(
        'mktero-ai-alibaba-endpoint'
    );
    const aiAlibabaEndpointRow = document.getElementById(
        'mktero-ai-alibaba-endpoint-row'
    );
    const aiProtocolRow = document.getElementById('mktero-ai-protocol-row');
    const aiModelInput = document.getElementById('mktero-ai-model');
    const aiReasoningInput = document.getElementById('mktero-ai-reasoning');
    const aiRequestTimeoutInput = document.getElementById(
        'mktero-ai-request-timeout'
    );
    const tabList = document.getElementById('mktero-pref-tablist');
    const t = (key, variables) => localization.t(key, variables);
    let initialized = false;
    let activeAIProvider = '';
    let aiTestController = null;
    let unsubscribeReasoningCatalog = null;
    let reasoningOptionsTimer = null;

    function currentReasoningCatalog() {
        if (reasoningCatalog) return reasoningCatalog;
        return zotero?.Mktero?.getAIReasoningCatalog?.() || null;
    }

    function currentAIReasoningSettings() {
        const settings = getAISettings(zotero);
        return {
            provider: aiProviderInput?.value || settings.provider,
            model: String(aiModelInput?.value || settings.model || '').trim(),
            apiBase: String(aiApiBaseInput?.value || settings.apiBase || '').trim(),
        };
    }

    function localize() {
        localizePreferencesDocument(document, localization);
    }

    function preferenceTabs() {
        return [...(tabList?.querySelectorAll('[role="tab"]') || [])];
    }

    function selectPreferenceTab(tab, { focus = false } = {}) {
        if (!tab || !tabList) return;
        for (const candidate of preferenceTabs()) {
            const selected = candidate === tab;
            candidate.setAttribute(
                'aria-selected',
                selected ? 'true' : 'false'
            );
            candidate.tabIndex = selected ? 0 : -1;
            const panel = document.getElementById(
                candidate.getAttribute('aria-controls')
            );
            if (panel) panel.hidden = !selected;
        }
        if (focus) tab.focus?.();
    }

    function handlePreferenceTabClick(event) {
        selectPreferenceTab(event.currentTarget);
    }

    function handlePreferenceTabKeydown(event) {
        const tabs = preferenceTabs();
        const index = tabs.indexOf(event.currentTarget);
        if (index < 0) return;
        let next = -1;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            next = (index + 1) % tabs.length;
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            next = (index - 1 + tabs.length) % tabs.length;
        } else if (event.key === 'Home') {
            next = 0;
        } else if (event.key === 'End') {
            next = tabs.length - 1;
        }
        if (next < 0) return;
        event.preventDefault();
        selectPreferenceTab(tabs[next], { focus: true });
    }

    function initializePreferenceTabs() {
        if (!tabList) return;
        tabList.setAttribute('aria-label', t('preferences.tabsLabel'));
        for (const host of document.querySelectorAll('[data-tab-icon]')) {
            const icon = LUCIDE_ICONS[host.getAttribute('data-tab-icon')];
            if (!icon || host.querySelector('svg')) continue;
            host.replaceChildren(createLucideIcon(document, icon, {
                className: 'mktero-pref-tab-svg',
                size: 14,
            }));
        }
        for (const tab of preferenceTabs()) {
            tab.addEventListener('click', handlePreferenceTabClick);
            tab.addEventListener('keydown', handlePreferenceTabKeydown);
        }
        selectPreferenceTab(
            tabList.querySelector('[role="tab"][aria-selected="true"]')
            || preferenceTabs()[0]
        );
    }

    function updateReaderFontSize() {
        if (!readerFontSizeInput || !readerFontSizeValue) return;
        const size = setMarkdownReaderFontSize(
            zotero,
            readerFontSizeInput.value
        );
        readerFontSizeInput.value = String(size);
        readerFontSizeValue.textContent = t('viewer.textSizeValue', { size });
    }

    function initializeReaderFontSize() {
        if (!readerFontSizeInput || !readerFontSizeValue) return;
        readerFontSizeInput.min = String(MARKDOWN_READER_FONT_SIZE_MIN);
        readerFontSizeInput.max = String(MARKDOWN_READER_FONT_SIZE_MAX);
        const size = getMarkdownReaderFontSize(zotero);
        readerFontSizeInput.value = String(size);
        readerFontSizeValue.textContent = t('viewer.textSizeValue', { size });
        readerFontSizeInput.addEventListener('input', updateReaderFontSize);
    }

    function updateReaderLineHeight() {
        if (!readerLineHeightInput) return;
        readerLineHeightInput.value = setMarkdownReaderLineHeight(
            zotero,
            readerLineHeightInput.value
        );
    }

    function initializeReaderLineHeight() {
        if (!readerLineHeightInput) return;
        readerLineHeightInput.value = getMarkdownReaderLineHeight(zotero);
        readerLineHeightInput.addEventListener('change', updateReaderLineHeight);
    }

    function updateReaderWidth() {
        if (!readerWidthInput) return;
        readerWidthInput.value = setMarkdownReaderWidth(
            zotero,
            readerWidthInput.value
        );
    }

    function initializeReaderWidth() {
        if (!readerWidthInput) return;
        readerWidthInput.value = getMarkdownReaderWidth(zotero);
        readerWidthInput.addEventListener('change', updateReaderWidth);
    }

    function updateReaderAlignment() {
        if (!readerAlignmentInput) return;
        readerAlignmentInput.value = setMarkdownReaderAlignment(
            zotero,
            readerAlignmentInput.value
        );
    }

    function initializeReaderAlignment() {
        if (!readerAlignmentInput) return;
        readerAlignmentInput.value = getMarkdownReaderAlignment(zotero);
        readerAlignmentInput.addEventListener('change', updateReaderAlignment);
    }

    function updateReaderFont() {
        if (!readerFontInput) return;
        readerFontInput.value = setMarkdownReaderFont(
            zotero,
            readerFontInput.value
        );
    }

    function initializeReaderFont() {
        if (!readerFontInput) return;
        readerFontInput.value = getMarkdownReaderFont(zotero);
        readerFontInput.addEventListener('change', updateReaderFont);
    }

    function updateReaderSourcePeek() {
        if (!readerSourcePeekInput) return;
        readerSourcePeekInput.checked = setMarkdownReaderSourcePeek(
            zotero,
            readerSourcePeekInput.checked
        );
    }

    function initializeReaderSourcePeek() {
        if (!readerSourcePeekInput) return;
        readerSourcePeekInput.checked = getMarkdownReaderSourcePeek(zotero);
        readerSourcePeekInput.addEventListener('change', updateReaderSourcePeek);
    }

    function initializeObsidianExport() {
        if (obsidianVaultInput) {
            obsidianVaultInput.value = getObsidianVaultPath(zotero);
        }
        if (obsidianSubdirectoryInput) {
            obsidianSubdirectoryInput.value = getObsidianSubdirectory(zotero);
            obsidianSubdirectoryInput.addEventListener(
                'change',
                updateObsidianSubdirectory
            );
        }
        obsidianVaultBrowse?.addEventListener('click', browseObsidianVault);
    }

    function updateObsidianSubdirectory() {
        if (!obsidianSubdirectoryInput) return;
        obsidianSubdirectoryInput.value = setObsidianSubdirectory(
            zotero,
            obsidianSubdirectoryInput.value
        );
    }

    async function browseObsidianVault() {
        const picker = createObsidianVaultPicker();
        if (!picker) return;
        picker.init(
            document.defaultView,
            t('preferences.obsidian.vaultDialogTitle'),
            picker.modeGetFolder
        );
        const result = await picker.show();
        if (result === picker.returnCancel) return;
        const selected = String(picker.file || '').trim();
        if (!selected) return;
        if (!await selectedObsidianVault(selected)) {
            services?.prompt?.alert?.(
                document.defaultView,
                t('preferences.obsidian.vaultInvalidTitle'),
                t('preferences.obsidian.vaultInvalid')
            );
            return;
        }
        if (obsidianVaultInput) obsidianVaultInput.value = selected;
        setObsidianVaultPath(zotero, selected);
    }

    function createObsidianVaultPicker() {
        if (typeof createFilePicker === 'function') return createFilePicker();
        if (typeof ChromeUtils === 'undefined') return null;
        const { FilePicker } = ChromeUtils.importESModule(
            'chrome://zotero/content/modules/filePicker.mjs'
        );
        return typeof FilePicker === 'function' ? new FilePicker() : null;
    }

    async function selectedObsidianVault(vaultPath) {
        if (typeof IOUtils === 'undefined' || typeof PathUtils === 'undefined') {
            return true;
        }
        return Boolean(await IOUtils.exists(PathUtils.join(
            vaultPath,
            '.obsidian'
        )));
    }

    function getSelectedConversionProvider() {
        return normalizeConversionProvider(
            conversionProviderInput?.value || getConversionProvider(zotero)
        );
    }

    function selectedMinerUEndpoint() {
        return normalizeMinerUEndpoint(
            mineruEndpointInput?.value || getMinerUEndpoint(zotero)
        );
    }

    function getConversionApiKeyConfig(provider) {
        if (provider === CONVERSION_PROVIDER_MISTRAL) {
            return {
                preference: MISTRAL_API_KEY_PREF,
                value: getMistralApiKey(zotero),
                manageURL: 'https://console.mistral.ai/api-keys/',
                helpKey: 'preferences.conversion.apiKeyHelp',
                privacyKey: 'preferences.conversion.privacyNote',
            };
        }
        if (provider === CONVERSION_PROVIDER_MINERU
            && selectedMinerUEndpoint() === MINERU_ENDPOINT_LOCAL) {
            return {
                preference: MINERU_LOCAL_API_KEY_PREF,
                value: getMinerULocalApiKey(zotero),
                manageURL: '',
                helpKey: 'preferences.conversion.apiKeyHelpLocal',
                privacyKey: 'preferences.conversion.privacyNoteLocal',
            };
        }
        return {
            preference: MINERU_API_KEY_PREF,
            value: getMinerUApiKey(zotero),
            manageURL: 'https://mineru.net/apiManage/token',
            helpKey: 'preferences.conversion.apiKeyHelp',
            privacyKey: 'preferences.conversion.privacyNote',
        };
    }

    function updateConversionApiKeyControl() {
        const hosted = selectedConversionChoice() === CONVERSION_PROVIDER_MKTERO;
        const provider = getSelectedConversionProvider();
        const local = provider === CONVERSION_PROVIDER_MINERU
            && selectedMinerUEndpoint() === MINERU_ENDPOINT_LOCAL;
        if (mineruEndpointRow) {
            mineruEndpointRow.hidden = hosted
                || provider !== CONVERSION_PROVIDER_MINERU;
        }
        if (mineruLocalBaseRow) mineruLocalBaseRow.hidden = hosted || !local;
        if (conversionApiKeyRow) conversionApiKeyRow.hidden = hosted || local;
        if (mineruEndpointInput && !mineruEndpointInput.value) {
            mineruEndpointInput.value = getMinerUEndpoint(zotero);
        }
        if (!conversionApiKeyInput) return;
        const config = getConversionApiKeyConfig(provider);
        conversionApiKeyInput.value = config.value;
        if (conversionApiKeyManage) {
            conversionApiKeyManage.hidden = !config.manageURL;
            if (config.manageURL) {
                conversionApiKeyManage.setAttribute('href', config.manageURL);
            }
        }
        if (conversionApiKeyHelp) {
            conversionApiKeyHelp.setAttribute('data-i18n', config.helpKey);
            conversionApiKeyHelp.textContent = localization.t(config.helpKey);
        }
        if (conversionPrivacyNote) {
            conversionPrivacyNote.hidden = hosted;
            conversionPrivacyNote.setAttribute('data-i18n', config.privacyKey);
            conversionPrivacyNote.textContent = localization.t(config.privacyKey);
        }
    }

    function saveMinerUEndpoint() {
        if (!mineruEndpointInput) return;
        const endpoint = normalizeMinerUEndpoint(mineruEndpointInput.value);
        mineruEndpointInput.value = endpoint;
        zotero?.Prefs?.set?.(MINERU_ENDPOINT_PREF, endpoint, true);
        updateConversionApiKeyControl();
    }

    function saveMinerULocalApiBase() {
        if (!mineruLocalBaseInput) return;
        zotero?.Prefs?.set?.(
            MINERU_LOCAL_API_BASE_PREF,
            mineruLocalBaseInput.value,
            true
        );
    }

    function saveConversionApiKey() {
        if (!conversionApiKeyInput) return;
        const config = getConversionApiKeyConfig(
            getSelectedConversionProvider()
        );
        zotero?.Prefs?.set?.(config.preference, conversionApiKeyInput.value, true);
    }

    function setAccountStatus(key) {
        if (!accountStatus) return;
        accountStatus.textContent = key ? t(key) : '';
    }

    // Errors stay in the dialog. A successful save closes it, and the updated
    // name on the card is the confirmation, so nothing is written back there.
    function setAccountNicknameStatus(key) {
        if (!accountDialogStatus) return;
        accountDialogStatus.textContent = key ? t(key) : '';
        delete accountDialogStatus.dataset.tone;
    }

    function accountErrorKey(error) {
        if (error?.code === 'invalid_credentials') {
            return 'preferences.account.invalidCredentials';
        }
        if (error?.code === 'email_exists') {
            return 'preferences.account.emailExists';
        }
        if (error?.code === 'email_not_verified') {
            return 'preferences.account.emailNotVerified';
        }
        if (error?.code === 'invalid_password') {
            return 'preferences.account.invalidPassword';
        }
        if (error?.code === 'invalid_code') {
            return 'preferences.account.invalidCodeServer';
        }
        if (error?.code === 'code_rate_limited') {
            return 'preferences.account.codeRateLimited';
        }
        if (error?.code === 'registration_unavailable') {
            return 'preferences.account.registrationUnavailable';
        }
        if (error?.code === 'network') {
            return 'preferences.account.networkFailed';
        }
        return 'preferences.account.loginFailed';
    }

    // The conversion provider select owns the hosted/custom decision. "mktero"
    // is a real provider value: the account panel only appears for it.
    function selectedConversionChoice() {
        return normalizeConversionProvider(
            conversionProviderInput?.value || getConversionProvider(zotero)
        );
    }

    function updateServiceSources() {
        const mktero = selectedConversionChoice() === CONVERSION_PROVIDER_MKTERO;
        if (accountPanel) accountPanel.hidden = !mktero;
        updateConversionApiKeyControl();
    }

    function renderAccount() {
        const session = getAccountSession(zotero);
        const signedIn = isAccountSignedIn(session);
        const apiBaseRow = document.getElementById('mktero-account-api-base-row');

        const signedInPanel = document.getElementById('mktero-account-signed-in');
        const accountForm = document.getElementById('mktero-account-form');
        const tabs = document.getElementById('mktero-account-tabs');
        if (signedInPanel) signedInPanel.hidden = !signedIn;
        if (accountForm) accountForm.hidden = signedIn;
        // The tabs belong to the signed-out state only.
        if (tabs) tabs.hidden = signedIn;
        if (signedIn) {
            const nickname = session.nickname || session.email || '';
            if (accountAvatar) accountAvatar.textContent = accountInitial(nickname);
            if (accountSignedInNickname) accountSignedInNickname.textContent = nickname;
            if (accountSignedInEmail) accountSignedInEmail.textContent = session.email || '';
        }
        if (!signedIn) setAccountMode(accountMode);
        renderAccountActivity();
        if (apiBaseRow) apiBaseRow.hidden = !isDebugBuild();
        if (accountApiBaseInput && !accountApiBaseInput.value) {
            accountApiBaseInput.value = getAccountApiBase(zotero);
        }
        updateServiceSources();
    }

    function resetAccountActivity() {
        accountStats = null;
        accountStatsRequested = false;
    }

    // renderAccountActivity paints the counters and the heat map from the last
    // loaded stats response. It runs on every render so a language change
    // re-localizes the summary and the day tooltips. A signed-in card with no
    // stats yet still paints the empty year, so the calendar is never a hole.
    function renderAccountActivity() {
        const signedIn = isAccountSignedIn(getAccountSession(zotero));
        // A signed-in card always shows the year grid. Stats replace the zeros
        // when they arrive; a failed request must not leave the hole blank.
        const days = accountStats?.days?.length
            ? accountStats.days
            : (signedIn ? emptyActivityDays() : []);
        const grid = buildActivityGrid(days);
        // The counters use the server's window total; the grid only supplies the
        // calendar. That matches the website profile page.
        const total = accountStats ? accountStats.total : 0;
        if (accountStatTotal) accountStatTotal.textContent = String(total);
        if (accountStatStreak) {
            accountStatStreak.textContent = String(accountStats?.currentStreak || 0);
        }
        if (accountStatLongest) {
            accountStatLongest.textContent = String(accountStats?.longestStreak || 0);
        }
        if (accountHeatmapSummary) {
            accountHeatmapSummary.textContent = signedIn
                ? activitySummaryText(t('preferences.account.heatmap.summary'), {
                    total,
                    language: localization.language,
                })
                : '';
        }
        if (!accountHeatmap) return;
        if (!grid.cells.length) {
            accountHeatmap.replaceChildren();
            return;
        }
        const cells = grid.cells.map(cell => {
            const node = createHTMLElement(document, 'span');
            node.setAttribute('class', 'mktero-heatmap-cell');
            node.setAttribute('data-level', String(cell.level));
            if (cell.pad) {
                node.setAttribute('aria-hidden', 'true');
                return node;
            }
            const title = activityCellTitle(cell);
            if (title) node.setAttribute('title', title);
            return node;
        });
        accountHeatmap.replaceChildren(...cells);
        accountHeatmap.style.setProperty('--mktero-heatmap-weeks', String(grid.weeks));
        accountHeatmap.setAttribute('aria-label', t('preferences.account.heatmap.title'));
    }

    // loadAccountStats fills the counters and the heat map for the signed-in
    // account. A failure keeps the card at zero: the activity view is
    // informational, so it never blocks the settings pane.
    async function loadAccountStats() {
        if (accountStatsRequested) return;
        const session = getAccountSession(zotero);
        if (!isAccountSignedIn(session) || !session.accessToken) return;
        accountStatsRequested = true;
        try {
            accountStats = await getMkteroConversionStats({
                apiBase: getAccountApiBase(zotero),
                accessToken: session.accessToken,
                days: ACTIVITY_WINDOW_DAYS,
                fetchImpl: accountFetch,
            });
        }
        catch {
            accountStats = null;
        }
        renderAccountActivity();
    }

    // loadAccountProfile refreshes the stored nickname, email, and registration
    // date. Like the stats request it is best-effort and never blocks the pane.
    async function loadAccountProfile() {
        const session = getAccountSession(zotero);
        if (!isAccountSignedIn(session) || !session.accessToken) return;
        try {
            const profile = await getMkteroAccount({
                apiBase: getAccountApiBase(zotero),
                accessToken: session.accessToken,
                fetchImpl: accountFetch,
            });
            saveAccountSession(zotero, {
                ...session,
                email: profile.email || session.email,
                nickname: profile.nickname || session.nickname,
            });
            if (accountCreated) {
                accountCreated.textContent = formatMemberSince(
                    profile.createdAt,
                    localization.language
                );
            }
            renderAccount();
        }
        catch {
            // A stale token only skips the refresh; the stored session renders.
        }
    }

    // accountInitial returns the first character used by the avatar circle.
    function accountInitial(value) {
        const source = String(value || '').trim();
        return source ? source[0].toUpperCase() : '?';
    }

    function setHidden(id, hidden) {
        const element = document.getElementById(id);
        if (element) element.hidden = hidden;
    }

    function setAccountMode(mode) {
        accountMode = mode;
        const forgot = mode === 'forgot';
        const register = mode === 'register';
        setHidden('mktero-account-password-row', forgot);
        setHidden('mktero-account-code-row', !register);
        setHidden('mktero-account-password-confirm-row', !register);
        setHidden('mktero-account-register-nickname-row', !register);
        if (accountLoginButton) accountLoginButton.hidden = mode !== 'login';
        if (accountRegisterButton) accountRegisterButton.hidden = !register;
        if (accountSendResetButton) accountSendResetButton.hidden = !forgot;
        if (accountForgotButton) accountForgotButton.hidden = mode !== 'login';
        if (accountForgotBackButton) accountForgotBackButton.hidden = !forgot;
        // The login / register tabs stay visible while signing in or registering.
        if (accountTabLogin) {
            accountTabLogin.setAttribute('aria-selected', String(mode === 'login'));
        }
        if (accountTabRegister) {
            accountTabRegister.setAttribute('aria-selected', String(register));
        }
        if (accountPasswordInput) {
            accountPasswordInput.setAttribute(
                'autocomplete',
                register ? 'new-password' : 'current-password'
            );
        }
    }

    function selectAccountLoginTab() {
        setAccountMode('login');
        setAccountStatus('');
    }

    function selectAccountRegisterTab() {
        setAccountMode('register');
        setAccountStatus('');
    }

    // openAccountNicknameDialog seeds the field from the stored session so the
    // dialog always opens on the current nickname.
    function openAccountNicknameDialog() {
        const session = getAccountSession(zotero);
        if (accountProfileNicknameInput) {
            accountProfileNicknameInput.value = session.nickname || '';
        }
        setAccountNicknameStatus('');
        accountNicknameDialog?.removeAttribute('hidden');
        accountEditNicknameButton?.setAttribute('aria-expanded', 'true');
        accountProfileNicknameInput?.focus?.();
        accountProfileNicknameInput?.select?.();
    }

    function closeAccountNicknameDialog() {
        accountNicknameDialog?.setAttribute('hidden', 'hidden');
        accountEditNicknameButton?.setAttribute('aria-expanded', 'false');
        accountEditNicknameButton?.focus?.();
    }

    function handleAccountNicknameKeydown(event) {
        handleAccountDialogKeydown(event);
    }

    // handleAccountDialogKeydown keeps the modal keyboard-complete: Escape
    // dismisses it and Enter saves without reaching for the mouse.
    function handleAccountDialogKeydown(event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeAccountNicknameDialog();
            return;
        }
        if (event.key !== 'Enter') return;
        event.preventDefault();
        saveAccountNickname();
    }

    async function saveAccountNickname() {
        if (accountBusy) return;
        const nickname = String(accountProfileNicknameInput?.value || '').trim();
        if (!nickname) {
            setAccountNicknameStatus('preferences.account.nicknameRequired');
            return;
        }
        const session = getAccountSession(zotero);
        if (!session.refreshToken) return;
        setAccountBusy(true);
        setAccountNicknameStatus('');
        try {
            const updated = await updateMkteroNickname({
                apiBase: getAccountApiBase(zotero),
                accessToken: session.accessToken,
                nickname,
                fetchImpl: accountFetch,
            });
            saveAccountSession(zotero, {
                ...session,
                nickname: updated.nickname || nickname,
            });
            if (accountProfileNicknameInput) {
                accountProfileNicknameInput.value = updated.nickname || nickname;
            }
            renderAccount();
            closeAccountNicknameDialog();
        }
        catch (error) {
            setAccountNicknameStatus(accountErrorKey(error));
        }
        finally {
            setAccountBusy(false);
        }
    }

    function selectAccountForgotMode() {
        setAccountMode('forgot');
    }

    function selectAccountForgotBack() {
        setAccountMode('login');
    }

    function setAccountBusy(busy) {
        accountBusy = busy;
        if (accountLoginButton) accountLoginButton.disabled = busy;
        if (accountRegisterButton) accountRegisterButton.disabled = busy;
        if (accountSendResetButton) accountSendResetButton.disabled = busy;
        if (accountSendCodeButton) accountSendCodeButton.disabled = busy || accountSendCodeButton.dataset.cooling === 'true';
        if (accountLogoutButton) accountLogoutButton.disabled = busy;
        if (accountSaveNicknameButton) accountSaveNicknameButton.disabled = busy;
    }

    async function submitAccount(request) {
        if (accountBusy) return;
        const email = String(accountEmailInput?.value || '').trim();
        const password = String(accountPasswordInput?.value || '');
        if (!email || password.length < 8 || password.length > 128) {
            setAccountStatus('preferences.account.invalidPassword');
            return;
        }
        setAccountBusy(true);
        setAccountStatus('');
        try {
            const session = await request({
                apiBase: getAccountApiBase(zotero),
                email,
                password,
                fetchImpl: accountFetch,
            });
            if (session?.verificationRequired) {
                if (accountPasswordInput) accountPasswordInput.value = '';
                if (accountConfirmInput) accountConfirmInput.value = '';
                if (accountNicknameInput) accountNicknameInput.value = '';
                setAccountStatus('preferences.account.verificationSent');
                return;
            }
            saveAccountSession(zotero, session);
            if (accountPasswordInput) accountPasswordInput.value = '';
            if (accountConfirmInput) accountConfirmInput.value = '';
            if (accountNicknameInput) accountNicknameInput.value = '';
            // The pane may have opened signed out, so the initial profile and
            // stats requests never ran. Paint the empty calendar immediately,
            // then fill the date and the real counts.
            resetAccountActivity();
            renderAccount();
            await Promise.all([loadAccountProfile(), loadAccountStats()]);
        }
        catch (error) {
            setAccountStatus(accountErrorKey(error));
        }
        finally {
            setAccountBusy(false);
        }
    }

    async function sendPasswordReset() {
        if (accountBusy) return;
        const email = String(accountEmailInput?.value || '').trim();
        if (!email) {
            setAccountStatus('preferences.account.invalidPassword');
            return;
        }
        setAccountBusy(true);
        setAccountStatus('');
        try {
            await requestPasswordReset({
                apiBase: getAccountApiBase(zotero),
                email,
                fetchImpl: accountFetch,
            });
            setAccountStatus('preferences.account.resetSent');
        }
        catch (error) {
            setAccountStatus(accountErrorKey(error));
        }
        finally {
            setAccountBusy(false);
        }
    }

    function startCodeCooldown() {
        clearTimeout(codeCooldownTimer);
        let remaining = 60;
        const tick = () => {
            if (!accountSendCodeButton) return;
            if (remaining <= 0) {
                delete accountSendCodeButton.dataset.cooling;
                accountSendCodeButton.disabled = accountBusy;
                accountSendCodeButton.textContent = t('preferences.account.sendCode');
                return;
            }
            accountSendCodeButton.dataset.cooling = 'true';
            accountSendCodeButton.disabled = true;
            accountSendCodeButton.textContent = t('preferences.account.codeWait', {
                seconds: remaining,
            });
            remaining -= 1;
            codeCooldownTimer = setTimeout(tick, 1000);
        };
        tick();
    }

    async function sendAccountCode() {
        if (accountBusy || accountSendCodeButton?.dataset.cooling === 'true') return;
        const email = String(accountEmailInput?.value || '').trim();
        if (!email.includes('@')) {
            setAccountStatus('preferences.account.invalidEmail');
            return;
        }
        setAccountBusy(true);
        setAccountStatus('');
        try {
            await sendSignupCode({
                apiBase: getAccountApiBase(zotero),
                email,
                locale: accountEmailLocale(),
                fetchImpl: accountFetch,
            });
            setAccountStatus('preferences.account.codeSent');
            startCodeCooldown();
        }
        catch (error) {
            setAccountStatus(accountErrorKey(error));
        }
        finally {
            setAccountBusy(false);
        }
    }

    // accountEmailLocale reports the Zotero interface language so the server can
    // localize transactional email. The server falls back to English for tags it
    // does not know.
    function accountEmailLocale() {
        return getZoteroLocale(zotero, services);
    }

    function loginAccount() {
        return submitAccount(loginMkteroAccount);
    }

    function registerAccount() {
        const password = String(accountPasswordInput?.value || '');
        const confirmation = String(accountConfirmInput?.value || '');
        const code = String(accountCodeInput?.value || '').trim();
        if (password !== confirmation) {
            setAccountStatus('preferences.account.passwordMismatch');
            return undefined;
        }
        if (!/^\d{6}$/.test(code)) {
            setAccountStatus('preferences.account.invalidCode');
            return undefined;
        }
        const nickname = String(accountNicknameInput?.value || '').trim();
        return submitAccount(args => registerMkteroAccount({
            ...args,
            code,
            nickname,
            locale: accountEmailLocale(),
        }));
    }

    async function logoutAccount() {
        if (accountBusy) return;
        accountBusy = true;
        if (accountLogoutButton) accountLogoutButton.disabled = true;
        const session = getAccountSession(zotero);
        try {
            await logoutMkteroAccount({
                apiBase: getAccountApiBase(zotero),
                refreshToken: session.refreshToken,
                fetchImpl: accountFetch,
            });
        }
        catch {
            // A failed logout still clears the local session.
        }
        clearAccountSession(zotero);
        resetAccountActivity();
        accountBusy = false;
        if (accountLogoutButton) accountLogoutButton.disabled = false;
        renderAccount();
    }

    async function refreshAccountIfNeeded() {
        const session = getAccountSession(zotero);
        if (!accessTokenNeedsRefresh(session)) return;
        try {
            const refreshed = await refreshMkteroAccount({
                apiBase: getAccountApiBase(zotero),
                refreshToken: session.refreshToken,
                fetchImpl: accountFetch,
            });
            saveAccountSession(zotero, {
                ...refreshed,
                email: refreshed.email || session.email,
                nickname: refreshed.nickname || session.nickname,
            });
        }
        catch {
            clearAccountSession(zotero);
            resetAccountActivity();
        }
    }

    function saveConversionChoice() {
        if (!conversionProviderInput) return;
        const choice = selectedConversionChoice();
        zotero?.Prefs?.set?.(CONVERSION_PROVIDER_PREF, choice, true);
        updateServiceSources();
        renderAccount();
    }

    function saveAccountApiBase() {
        if (!isDebugBuild() || !accountApiBaseInput) return;
        try {
            accountApiBaseInput.value = setAccountApiBase(
                zotero,
                accountApiBaseInput.value
            );
            setAccountStatus('');
            renderAccount();
        }
        catch {
            setAccountStatus('preferences.account.invalidApiBase');
        }
    }

    function initializeAccount() {
        accountLoginButton?.addEventListener('click', loginAccount);
        accountRegisterButton?.addEventListener('click', registerAccount);
        accountLogoutButton?.addEventListener('click', logoutAccount);
        accountTabLogin?.addEventListener('click', selectAccountLoginTab);
        accountTabRegister?.addEventListener('click', selectAccountRegisterTab);
        accountForgotButton?.addEventListener('click', selectAccountForgotMode);
        accountForgotBackButton?.addEventListener('click', selectAccountForgotBack);
        accountSendResetButton?.addEventListener('click', sendPasswordReset);
        accountSendCodeButton?.addEventListener('click', sendAccountCode);
        accountSaveNicknameButton?.addEventListener('click', saveAccountNickname);
        accountEditNicknameButton?.addEventListener('click', openAccountNicknameDialog);
        accountNicknameDialogClose?.addEventListener('click', closeAccountNicknameDialog);
        accountNicknameDialogCancel?.addEventListener('click', closeAccountNicknameDialog);
        // Clicking the backdrop (outside the card) dismisses the modal.
        accountNicknameDialog?.addEventListener('click', event => {
            if (event.target === accountNicknameDialog) closeAccountNicknameDialog();
        });
        // Escape and Enter are handled on the backdrop, so the modal needs no
        // document-level listener and the pane keeps its own key handling.
        accountNicknameDialog?.addEventListener('keydown', handleAccountDialogKeydown);
        accountProfileNicknameInput?.addEventListener(
            'keydown',
            handleAccountNicknameKeydown
        );
        accountApiBaseInput?.addEventListener('change', saveAccountApiBase);
        renderAccount();
    }

    // initializeAccountIcons fills the two icon-only account buttons. They carry
    // no text, so their accessible name comes from data-i18n-aria-label.
    function initializeAccountIcons() {
        for (const host of [
            accountEditNicknameButton,
            accountNicknameDialogClose,
        ]) {
            if (!host || host.querySelector('svg')) continue;
            const icon = host === accountNicknameDialogClose
                ? LUCIDE_ICONS.x
                : LUCIDE_ICONS.pencil;
            if (!icon) continue;
            // The pencil shares the nickname line, so it is drawn smaller than
            // the dialog's close button.
            host.replaceChildren(createLucideIcon(document, icon, {
                className: 'mktero-account-icon-svg',
                size: host === accountNicknameDialogClose ? 15 : 13,
            }));
        }
    }

    function initializeConversionProvider() {
        if (!conversionProviderInput) {
            updateConversionApiKeyControl();
            return;
        }
        conversionProviderInput.value = getConversionProvider(zotero);
        if (mineruEndpointInput) {
            mineruEndpointInput.value = getMinerUEndpoint(zotero);
        }
        if (mineruLocalBaseInput) {
            mineruLocalBaseInput.value = getMinerULocalApiBase(zotero)
                || DEFAULT_MINERU_LOCAL_API_BASE;
        }
        updateConversionApiKeyControl();
        conversionProviderInput.addEventListener(
            'change',
            saveConversionChoice
        );
        mineruEndpointInput?.addEventListener('change', saveMinerUEndpoint);
        mineruLocalBaseInput?.addEventListener('change', saveMinerULocalApiBase);
        conversionApiKeyInput?.addEventListener(
            'change',
            saveConversionApiKey
        );
    }

    function updateAIProtocolOptions({ persist = true } = {}) {
        if (!aiProviderInput || !aiProtocolInput) return;
        const protocols = getAIProtocolsForProvider(aiProviderInput.value);
        for (const option of aiProtocolInput.options) {
            const available = protocols.includes(option.value);
            option.hidden = !available;
            option.disabled = !available;
        }
        if (!protocols.includes(aiProtocolInput.value)) {
            aiProtocolInput.value = protocols[0] || '';
            if (persist && aiProtocolInput.value) {
                zotero?.Prefs?.set?.(
                    AI_PROTOCOL_PREF,
                    aiProtocolInput.value,
                    true
                );
            }
        }
        aiProtocolInput.disabled = protocols.length < 2;
    }

    function updateAICustomFieldVisibility() {
        const custom = aiProviderInput?.value === AI_PROVIDER_CUSTOM;
        const moonshot = aiProviderInput?.value === AI_PROVIDER_MOONSHOT;
        const miniMax = aiProviderInput?.value === AI_PROVIDER_MINIMAX;
        const alibaba = aiProviderInput?.value === AI_PROVIDER_ALIBABA;
        if (aiApiBaseRow) aiApiBaseRow.hidden = !custom;
        if (aiProtocolRow) aiProtocolRow.hidden = !custom;
        if (aiMoonshotEndpointRow) aiMoonshotEndpointRow.hidden = !moonshot;
        if (aiMiniMaxEndpointRow) aiMiniMaxEndpointRow.hidden = !miniMax;
        if (aiAlibabaEndpointRow) aiAlibabaEndpointRow.hidden = !alibaba;
    }

    function applyMoonshotEndpointToControls(apiBase) {
        if (!aiMoonshotEndpointInput) return;
        aiMoonshotEndpointInput.value = moonshotApiBaseRegion(apiBase);
    }

    function applyMiniMaxEndpointToControls(apiBase) {
        if (!aiMiniMaxEndpointInput) return;
        aiMiniMaxEndpointInput.value = miniMaxApiBaseRegion(apiBase);
    }

    function saveMoonshotEndpoint() {
        if (!aiMoonshotEndpointInput) return;
        if (aiProviderInput?.value !== AI_PROVIDER_MOONSHOT) return;
        const apiBase = moonshotApiBaseForRegion(aiMoonshotEndpointInput.value);
        if (aiApiBaseInput) aiApiBaseInput.value = apiBase;
        zotero?.Prefs?.set?.(AI_API_BASE_PREF, apiBase, true);
        updateAIReasoningOptions();
    }

    function saveMiniMaxEndpoint() {
        if (!aiMiniMaxEndpointInput) return;
        if (aiProviderInput?.value !== AI_PROVIDER_MINIMAX) return;
        const apiBase = miniMaxApiBaseForRegion(aiMiniMaxEndpointInput.value);
        if (aiApiBaseInput) aiApiBaseInput.value = apiBase;
        zotero?.Prefs?.set?.(AI_API_BASE_PREF, apiBase, true);
        updateAIReasoningOptions();
    }

    function applyAlibabaEndpointToControls(apiBase) {
        if (!aiAlibabaEndpointInput) return;
        aiAlibabaEndpointInput.value = alibabaApiBaseRegion(apiBase);
    }

    function saveAlibabaEndpoint() {
        if (!aiAlibabaEndpointInput) return;
        if (aiProviderInput?.value !== AI_PROVIDER_ALIBABA) return;
        const apiBase = alibabaApiBaseForRegion(aiAlibabaEndpointInput.value);
        if (aiApiBaseInput) aiApiBaseInput.value = apiBase;
        zotero?.Prefs?.set?.(AI_API_BASE_PREF, apiBase, true);
        updateAIReasoningOptions();
    }

    function initializeAITestButton() {
        if (!aiTestButton) return;
        const label = t('preferences.ai.test');
        aiTestButton.setAttribute('aria-label', label);
        aiTestButton.setAttribute('title', label);
        if (!aiTestButton.querySelector('svg')) {
            aiTestButton.appendChild(createLucideIcon(
                document,
                LUCIDE_ICONS.zap,
                { className: 'mktero-ai-test-svg', size: 16 }
            ));
        }
    }

    function initializeAIProvider() {
        initializeAITestButton();
        if (!aiProviderInput || !aiProtocolInput) return;
        const settings = syncCurrentAIProviderProfile(zotero);
        activeAIProvider = settings.provider;
        aiProviderInput.value = settings.provider;
        aiProtocolInput.value = settings.protocol;
        updateAIProtocolOptions({ persist: false });
        updateAICustomFieldVisibility();
        aiProviderInput.addEventListener('change', handleAIProviderChange);
        aiModelInput?.addEventListener('input', updateAIReasoningOptions);
        aiModelInput?.addEventListener('change', updateAIReasoningOptions);
        aiApiBaseInput?.addEventListener('input', updateAIReasoningOptions);
        aiApiBaseInput?.addEventListener('change', updateAIReasoningOptions);
        aiMoonshotEndpointInput?.addEventListener('change', saveMoonshotEndpoint);
        aiMiniMaxEndpointInput?.addEventListener('change', saveMiniMaxEndpoint);
        aiAlibabaEndpointInput?.addEventListener('change', saveAlibabaEndpoint);
        applyMoonshotEndpointToControls(settings.apiBase);
        applyMiniMaxEndpointToControls(settings.apiBase);
        applyAlibabaEndpointToControls(settings.apiBase);
        aiReasoningInput?.addEventListener('change', saveAIReasoning);
        updateAIReasoningOptions();
        if (!reasoningCatalog && zotero?.Mktero?.subscribeAIReasoningCatalog) {
            unsubscribeReasoningCatalog = zotero.Mktero.subscribeAIReasoningCatalog(
                () => updateAIReasoningOptions()
            );
        }
        scheduleAIReasoningOptionsUpdate();
    }

    function handleAIProviderChange() {
        const nextProvider = aiProviderInput?.value;
        if (!nextProvider || nextProvider === activeAIProvider) {
            updateAIProtocolOptions();
            updateAICustomFieldVisibility();
            updateAIReasoningOptions();
            return;
        }
        const nextSettings = switchAIProvider(
            zotero,
            readAISettingsFromControls(document, zotero, {
                provider: activeAIProvider,
            }),
            nextProvider
        );
        applyAISettingsToControls(nextSettings);
        activeAIProvider = nextSettings.provider;
        updateAIProtocolOptions({ persist: false });
        updateAICustomFieldVisibility();
        updateAIReasoningOptions({ persist: false });
    }

    function applyAISettingsToControls(settings) {
        if (aiProviderInput) aiProviderInput.value = settings.provider;
        if (aiProtocolInput) aiProtocolInput.value = settings.protocol;
        if (aiApiBaseInput) aiApiBaseInput.value = settings.apiBase || '';
        applyMoonshotEndpointToControls(settings.apiBase);
        applyMiniMaxEndpointToControls(settings.apiBase);
        applyAlibabaEndpointToControls(settings.apiBase);
        if (aiModelInput) aiModelInput.value = settings.model || '';
        const apiKeyInput = document.getElementById('mktero-ai-api-key');
        if (apiKeyInput) apiKeyInput.value = settings.apiKey || '';
        if (aiReasoningInput) aiReasoningInput.value = settings.reasoning;
        if (aiRequestTimeoutInput) {
            aiRequestTimeoutInput.value = String(
                aiRequestTimeoutSecondsFromMs(settings.requestTimeoutMs)
            );
        }
        const streamingInput = document.getElementById('mktero-ai-streaming');
        if (streamingInput) streamingInput.checked = settings.streaming !== false;
    }

    function updateAIReasoningOptions({ persist = true } = {}) {
        if (!aiReasoningInput) return;
        const levels = resolveAIReasoningLevels(
            currentAIReasoningSettings(),
            currentReasoningCatalog()
        );
        const stored = String(getAISettings(zotero).reasoning || '').trim();
        const next = selectAIReasoningValue(levels, stored);
        rebuildAIReasoningOptions(aiReasoningInput, levels, t);
        aiReasoningInput.value = next;
        if (persist && next !== stored) {
            zotero?.Prefs?.set?.(AI_REASONING_PREF, next, true);
        }
    }

    function saveAIReasoning() {
        if (!aiReasoningInput) return;
        const levels = resolveAIReasoningLevels(
            currentAIReasoningSettings(),
            currentReasoningCatalog()
        );
        const next = selectAIReasoningValue(levels, aiReasoningInput.value);
        aiReasoningInput.value = next;
        zotero?.Prefs?.set?.(AI_REASONING_PREF, next, true);
    }

    function scheduleAIReasoningOptionsUpdate() {
        const view = document.defaultView;
        if (typeof view?.setTimeout !== 'function') {
            updateAIReasoningOptions();
            return;
        }
        if (reasoningOptionsTimer != null) view.clearTimeout(reasoningOptionsTimer);
        reasoningOptionsTimer = view.setTimeout(() => {
            reasoningOptionsTimer = null;
            if (!initialized) return;
            updateAIReasoningOptions();
        }, 0);
    }

    function saveAIRequestTimeout() {
        if (!aiRequestTimeoutInput) return;
        const timeoutMs = aiRequestTimeoutMsFromSeconds(
            aiRequestTimeoutInput.value
        );
        aiRequestTimeoutInput.value = String(
            aiRequestTimeoutSecondsFromMs(timeoutMs)
        );
        zotero?.Prefs?.set?.(AI_REQUEST_TIMEOUT_PREF, timeoutMs, true);
    }

    function initializeAIRequestTimeout() {
        if (!aiRequestTimeoutInput) return;
        const timeoutMs = getAISettings(zotero).requestTimeoutMs;
        aiRequestTimeoutInput.max = String(
            aiRequestTimeoutSecondsFromMs(
                PREFERENCE_CONTROL_LIMITS.aiRequestTimeoutMs
            )
        );
        aiRequestTimeoutInput.value = String(
            aiRequestTimeoutSecondsFromMs(timeoutMs)
        );
        aiRequestTimeoutInput.addEventListener('change', saveAIRequestTimeout);
    }

    async function refresh() {
        status.setAttribute('aria-busy', 'true');
        try {
            status.textContent = formatCacheStats(await cache.getStats(), t);
        }
        catch (error) {
            zotero.logError?.(error);
            status.textContent = t('preferences.cache.unavailable');
        }
        finally {
            status.setAttribute('aria-busy', 'false');
        }
    }

    async function confirmCacheClear() {
        const title = t('preferences.cache.clearConfirmTitle');
        const message = t('preferences.cache.clearConfirmMessage');
        if (typeof confirmClearCache === 'function') {
            return confirmClearCache({ title, message });
        }
        const win = document.defaultView;
        if (services?.prompt?.confirm) {
            return services.prompt.confirm(win, title, message);
        }
        if (typeof win?.confirm === 'function') {
            return win.confirm(message);
        }
        return false;
    }

    async function clear() {
        if (!await confirmCacheClear()) return;
        clearButton.disabled = true;
        status.setAttribute('aria-busy', 'true');
        status.textContent = t('preferences.cache.clearing');
        try {
            await cache.clear();
            await refresh();
        }
        catch (error) {
            zotero.logError?.(error);
            status.textContent = t('preferences.cache.clearFailed');
        }
        finally {
            clearButton.disabled = false;
            status.setAttribute('aria-busy', 'false');
        }
    }

    function notifyAITest(message) {
        const title = t('preferences.ai.test');
        if (typeof notifyAITestResult === 'function') {
            notifyAITestResult({ title, message });
            return;
        }
        const win = document.defaultView;
        if (services?.prompt?.alert) {
            services.prompt.alert(win, title, message);
            return;
        }
        win?.alert?.(message);
    }

    async function testAI() {
        if (!aiTestButton || typeof testAIConnection !== 'function') return;
        if (aiTestController) return;
        aiTestController = createAbortController();
        const controller = aiTestController;
        aiTestButton.disabled = true;
        try {
            await testAIConnection(
                readAISettingsFromControls(document, zotero),
                controller.signal
            );
            if (aiTestController === controller) {
                notifyAITest(t('preferences.ai.testSuccess'));
            }
        }
        catch (error) {
            if (controller.signal?.aborted) return;
            zotero.logError?.(error);
            if (aiTestController === controller) {
                notifyAITest(t(aiTestErrorKey(error)));
            }
        }
        finally {
            if (aiTestController === controller) {
                aiTestController = null;
                aiTestButton.disabled = false;
            }
        }
    }

    return {
        async init() {
            if (initialized) return;
            initialized = true;
            clearButton.addEventListener('click', clear);
            aiTestButton?.addEventListener('click', testAI);
            localize();
            initializePreferenceTabs();
            initializeAccount();
            initializeAccountIcons();
            await refreshAccountIfNeeded();
            renderAccount();
            await Promise.all([loadAccountProfile(), loadAccountStats()]);
            initializeConversionProvider();
            initializeAIProvider();
            initializeAIRequestTimeout();
            initializeReaderFont();
            initializeReaderFontSize();
            initializeReaderLineHeight();
            initializeReaderWidth();
            initializeReaderAlignment();
            initializeReaderSourcePeek();
            updateServiceSources();
            initializeObsidianExport();
            await refresh();
        },
        destroy() {
            if (!initialized) return;
            initialized = false;
            unsubscribeReasoningCatalog?.();
            unsubscribeReasoningCatalog = null;
            if (reasoningOptionsTimer != null) {
                document.defaultView?.clearTimeout?.(reasoningOptionsTimer);
                reasoningOptionsTimer = null;
            }
            clearButton.removeEventListener('click', clear);
            aiTestButton?.removeEventListener('click', testAI);
            aiTestController?.abort?.();
            aiTestController = null;
            aiProviderInput?.removeEventListener(
                'change',
                handleAIProviderChange
            );
            aiModelInput?.removeEventListener('input', updateAIReasoningOptions);
            aiModelInput?.removeEventListener('change', updateAIReasoningOptions);
            aiApiBaseInput?.removeEventListener(
                'input',
                updateAIReasoningOptions
            );
            aiApiBaseInput?.removeEventListener(
                'change',
                updateAIReasoningOptions
            );
            aiMoonshotEndpointInput?.removeEventListener(
                'change',
                saveMoonshotEndpoint
            );
            aiMiniMaxEndpointInput?.removeEventListener(
                'change',
                saveMiniMaxEndpoint
            );
            aiAlibabaEndpointInput?.removeEventListener(
                'change',
                saveAlibabaEndpoint
            );
            aiReasoningInput?.removeEventListener('change', saveAIReasoning);
            aiRequestTimeoutInput?.removeEventListener(
                'change',
                saveAIRequestTimeout
            );
            conversionProviderInput?.removeEventListener(
                'change',
                saveConversionChoice
            );
            mineruEndpointInput?.removeEventListener('change', saveMinerUEndpoint);
            mineruLocalBaseInput?.removeEventListener(
                'change',
                saveMinerULocalApiBase
            );
            conversionApiKeyInput?.removeEventListener(
                'change',
                saveConversionApiKey
            );
            accountLoginButton?.removeEventListener('click', loginAccount);
            accountRegisterButton?.removeEventListener('click', registerAccount);
            accountLogoutButton?.removeEventListener('click', logoutAccount);
            accountEditNicknameButton?.removeEventListener(
                'click',
                openAccountNicknameDialog
            );
            accountNicknameDialogClose?.removeEventListener(
                'click',
                closeAccountNicknameDialog
            );
            accountNicknameDialogCancel?.removeEventListener(
                'click',
                closeAccountNicknameDialog
            );
            accountNicknameDialog?.removeEventListener(
                'keydown',
                handleAccountDialogKeydown
            );
            accountProfileNicknameInput?.removeEventListener(
                'keydown',
                handleAccountNicknameKeydown
            );
            accountSaveNicknameButton?.removeEventListener('click', saveAccountNickname);
            accountForgotButton?.removeEventListener('click', selectAccountForgotMode);
            accountForgotBackButton?.removeEventListener('click', selectAccountForgotBack);
            accountSendResetButton?.removeEventListener('click', sendPasswordReset);
            accountSendCodeButton?.removeEventListener('click', sendAccountCode);
            clearTimeout(codeCooldownTimer);
            accountApiBaseInput?.removeEventListener('change', saveAccountApiBase);
            readerFontSizeInput?.removeEventListener(
                'input',
                updateReaderFontSize
            );
            readerFontInput?.removeEventListener('change', updateReaderFont);
            readerLineHeightInput?.removeEventListener(
                'change',
                updateReaderLineHeight
            );
            readerWidthInput?.removeEventListener('change', updateReaderWidth);
            readerAlignmentInput?.removeEventListener(
                'change',
                updateReaderAlignment
            );
            readerSourcePeekInput?.removeEventListener(
                'change',
                updateReaderSourcePeek
            );
            obsidianSubdirectoryInput?.removeEventListener(
                'change',
                updateObsidianSubdirectory
            );
            obsidianVaultBrowse?.removeEventListener(
                'click',
                browseObsidianVault
            );
            for (const tab of preferenceTabs()) {
                tab.removeEventListener('click', handlePreferenceTabClick);
                tab.removeEventListener('keydown', handlePreferenceTabKeydown);
            }
        },
    };
}

function regionalEndpointApiBaseFromControls(document, provider) {
    if (provider === AI_PROVIDER_MOONSHOT) {
        const region = document.getElementById('mktero-ai-moonshot-endpoint')?.value;
        return region ? moonshotApiBaseForRegion(region) : undefined;
    }
    if (provider === AI_PROVIDER_MINIMAX) {
        const region = document.getElementById('mktero-ai-minimax-endpoint')?.value;
        return region ? miniMaxApiBaseForRegion(region) : undefined;
    }
    if (provider === AI_PROVIDER_ALIBABA) {
        const region = document.getElementById('mktero-ai-alibaba-endpoint')?.value;
        return region ? alibabaApiBaseForRegion(region) : undefined;
    }
    return undefined;
}

export function readAISettingsFromControls(document, zotero, overrides = {}) {
    const settings = getAISettings(zotero);
    const value = id => document.getElementById(id)?.value;
    const provider = overrides.provider
        ?? value('mktero-ai-provider')
        ?? settings.provider;
    return {
        ...settings,
        enabled: true,
        autoTranslateSelection: document.getElementById(
            'mktero-ai-auto-translate-selection'
        )?.checked ?? settings.autoTranslateSelection,
        provider,
        protocol: value('mktero-ai-protocol') ?? settings.protocol,
        apiBase: regionalEndpointApiBaseFromControls(document, provider)
            ?? value('mktero-ai-api-base')
            ?? settings.apiBase,
        apiKey: value('mktero-ai-api-key') ?? settings.apiKey,
        model: value('mktero-ai-model') ?? settings.model,
        reasoning: value('mktero-ai-reasoning') ?? settings.reasoning,
        targetLanguage: value('mktero-ai-target-language')
            ?? settings.targetLanguage,
        requestTimeoutMs: value('mktero-ai-request-timeout') == null
            ? settings.requestTimeoutMs
            : aiRequestTimeoutMsFromSeconds(value('mktero-ai-request-timeout')),
        maxOutputTokens: settings.maxOutputTokens,
        streaming: document.getElementById('mktero-ai-streaming')
            ?.checked ?? settings.streaming,
    };
}

function aiTestErrorKey(error) {
    if (error?.code === 'AI_AUTH_ERROR') {
        return 'preferences.ai.testAuthenticationFailed';
    }
    if (error?.code === 'AI_RATE_LIMITED') {
        return 'preferences.ai.testRateLimited';
    }
    if (error?.code === 'AI_CONFIGURATION_ERROR'
        || error?.code === 'AI_PROVIDER_UNSUPPORTED') {
        return 'preferences.ai.testConfigurationFailed';
    }
    return 'preferences.ai.testFailed';
}

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

function rebuildAIReasoningOptions(select, levels, translate) {
    while (select.firstChild) select.removeChild(select.firstChild);
    for (const value of levels) {
        const option = createHTMLElement(select.ownerDocument, 'option');
        option.value = value;
        option.setAttribute('data-i18n', `preferences.ai.reasoning.${value}`);
        option.textContent = translate(`preferences.ai.reasoning.${value}`);
        select.appendChild(option);
    }
}

function createHTMLElement(document, tagName) {
    return typeof document.createElementNS === 'function'
        ? document.createElementNS(XHTML_NAMESPACE, tagName)
        : document.createElement(tagName);
}

export function localizePreferencesDocument(document, localization) {
    for (const element of document.querySelectorAll?.('[data-i18n]') || []) {
        element.textContent = localization.t(element.getAttribute('data-i18n'));
    }
    for (const element of document.querySelectorAll?.('[data-i18n-placeholder]') || []) {
        element.setAttribute(
            'placeholder',
            localization.t(element.getAttribute('data-i18n-placeholder'))
        );
    }
    for (const element of document.querySelectorAll?.('[data-i18n-aria-label]') || []) {
        element.setAttribute(
            'aria-label',
            localization.t(element.getAttribute('data-i18n-aria-label'))
        );
    }
    document.getElementById('mktero-preferences-pane')
        ?.setAttribute('lang', localization.language);
}

export function createCombinedLocalCache(caches) {
    const stores = Array.from(caches || []);
    if (!stores.length || stores.some(cache => (
        typeof cache?.getStats !== 'function'
        || typeof cache?.clear !== 'function'
    ))) {
        throw new TypeError('Local cache stores are required');
    }
    return {
        async getStats() {
            const statistics = await Promise.all(
                stores.map(cache => cache.getStats())
            );
            return statistics.reduce((combined, current) => {
                validateCacheStats(current);
                return {
                    entries: combined.entries + current.entries,
                    sizeBytes: combined.sizeBytes + current.sizeBytes,
                };
            }, { entries: 0, sizeBytes: 0 });
        },
        async clear() {
            await Promise.all(stores.map(cache => cache.clear()));
        },
    };
}

export function formatCacheStats({ entries, sizeBytes }, translate = translateEnglish) {
    if (!entries) return translate('preferences.cache.stats.none');
    return translate(
        entries === 1
            ? 'preferences.cache.stats.one'
            : 'preferences.cache.stats.many',
        {
            count: entries,
            size: formatBytes(sizeBytes),
        }
    );
}

function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${trimDecimal(bytes / 1024)} KB`;
    if (bytes < 1024 * 1024 * 1024) {
        return `${trimDecimal(bytes / (1024 * 1024))} MB`;
    }
    return `${trimDecimal(bytes / (1024 * 1024 * 1024))} GB`;
}

function trimDecimal(value) {
    return value.toFixed(1).replace(/\.0$/, '');
}

function validateCacheStats(value) {
    if (!Number.isSafeInteger(value?.entries)
        || value.entries < 0
        || !Number.isSafeInteger(value?.sizeBytes)
        || value.sizeBytes < 0) {
        throw new Error('Invalid local cache statistics');
    }
}

globalThis.MkteroPreferences = {
    async init(event) {
        const document = event.target?.ownerDocument
            || event.currentTarget?.ownerDocument
            || globalThis.document;
        const markdownCache = createZoteroMarkdownCache({
            zotero: Zotero,
            ioUtils: IOUtils,
            pathUtils: PathUtils,
        });
        const cache = createCombinedLocalCache([
            withSuccessfulClearNotification(markdownCache, () => (
                notifyLocalCacheCleared(
                    typeof Services === 'undefined' ? null : Services
                )
            )),
            createZoteroPDFTextIndexCache({
                zotero: Zotero,
                ioUtils: IOUtils,
                pathUtils: PathUtils,
            }),
            createZoteroTranslationCache({
                zotero: Zotero,
                ioUtils: IOUtils,
                pathUtils: PathUtils,
            }),
            createZoteroCitationGraphCache({
                zotero: Zotero,
                ioUtils: IOUtils,
                pathUtils: PathUtils,
            }),
            createZoteroMarkdownReadingPositionStore({
                zotero: Zotero,
                ioUtils: IOUtils,
                pathUtils: PathUtils,
            }),
        ]);
        const aiGateway = new AISDKGateway({
            createAbortController: createRuntimeAbortController,
            runtimeWindow: document?.defaultView,
            onDebug: message => Zotero.debug(message),
        });
        const translationService = new MarkdownTranslationService({
            aiGateway,
            getSettings: () => getAISettings(Zotero),
        });
        const controller = createPreferencesController({
            document,
            zotero: Zotero,
            cache,
            testAIConnection: (settings, signal) => (
                translationService.testConnection({ settings, signal })
            ),
            createAbortController: createRuntimeAbortController,
        });
        await controller.init();
        return () => controller.destroy();
    },
};

if (globalThis.document?.addEventListener) {
    registerPreferencesPaneLoader({
        document: globalThis.document,
        initialize: event => globalThis.MkteroPreferences.init(event),
    });
}
