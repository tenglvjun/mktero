import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Strip repeatedly: one pass can leave a tag behind ("<scr<script>ipt>").
function stripMarkup(value) {
    let text = String(value);
    let previous;
    do {
        previous = text;
        text = text.replace(/<[^>]*>/gu, ' ');
    } while (text !== previous);
    return text;
}

test('ships conversion, AI, cache preferences, and localized Markdown UI assets', async () => {
    const [
        prefs,
        pane,
        script,
        bootstrap,
        markdownView,
        tabPresenter,
        buildScript,
    ] = await Promise.all([
        readFile(new URL('../prefs.js', import.meta.url), 'utf8'),
        readFile(new URL('../ui/preferences.xhtml', import.meta.url), 'utf8'),
        readFile(new URL('../src/ui/preferences.js', import.meta.url), 'utf8'),
        readFile(new URL('../src/bootstrap.js', import.meta.url), 'utf8'),
        readFile(new URL('../src/ui/markdown-window.js', import.meta.url), 'utf8'),
        readFile(new URL('../src/ui/markdown-tab-presenter.js', import.meta.url), 'utf8'),
        readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8'),
    ]);

    assert.match(prefs, /pref\("extensions\.mktero\.mineruApiKey", ""\)/);
    assert.match(prefs, /pref\("extensions\.mktero\.conversionProvider", "mineru"\)/);
    assert.match(prefs, /pref\("extensions\.mktero\.mistralApiKey", ""\)/);
    assert.match(prefs, /pref\("extensions\.mktero\.cacheEnabled", true\)/);
    assert.doesNotMatch(
        prefs,
        /pref\("extensions\.mktero\.semanticScholarApiKey", ""\)/
    );
    assert.doesNotMatch(
        prefs,
        /pref\("extensions\.mktero\.openAlexApiKey", ""\)/
    );
    assert.doesNotMatch(
        prefs,
        /pref\("extensions\.mktero\.openCitationsAccessToken", ""\)/
    );
    assert.match(prefs, /pref\("extensions\.mktero\.readerFontSize", 18\)/);
    assert.doesNotMatch(prefs, /extensions\.mktero\.aiEnabled/);
    assert.match(prefs, /pref\("extensions\.mktero\.aiProvider", "openai"\)/);
    assert.match(prefs, /pref\("extensions\.mktero\.aiProtocol", "openai-responses"\)/);
    assert.match(prefs, /pref\("extensions\.mktero\.aiApiKey", ""\)/);
    assert.match(prefs, /pref\("extensions\.mktero\.aiRequestTimeoutMs", 600000\)/);
    assert.doesNotMatch(prefs, /extensions\.mktero\.aiMaxOutputTokens/);
    assert.match(
        prefs,
        /pref\("extensions\.mktero\.aiAutoTranslateSelection", false\)/
    );
    assert.match(prefs, /pref\("extensions\.mktero\.aiReasoning", "none"\)/);
    assert.match(prefs, /pref\("extensions\.mktero\.aiProviderProfiles", "\{\}"\)/);
    assert.doesNotMatch(prefs, /extensions\.mktero\.aiCacheEnabled/);
    assert.doesNotMatch(
        pane,
        /<html:option value="en-US"[^>]*preferences\.ai\.language\.enUS/
    );
    assert.match(
        prefs,
        /pref\("extensions\.mktero\.readerFont", "system-serif"\)/
    );
    assert.match(prefs, /pref\("extensions\.mktero\.readerSourcePeek", true\)/);
    assert.match(
        prefs,
        /pref\("extensions\.mktero\.readerLineHeight", "standard"\)/
    );
    assert.match(prefs, /pref\("extensions\.mktero\.readerWidth", "standard"\)/);
    assert.match(
        prefs,
        /pref\("extensions\.mktero\.readerAlignment", "start"\)/
    );
    assert.doesNotMatch(prefs, /extensions\.mktero\.language/);
    assert.doesNotMatch(pane, /id="mktero-language"/);
    assert.doesNotMatch(pane, /preference="extensions\.mktero\.language"/);
    assert.match(pane, /id="mktero-conversion-provider"[\s\S]*?<html:option value="mktero"/);
    assert.match(pane, /<html:option value="mineru" data-i18n="preferences\.conversion\.provider\.mineru"><\/html:option>/);
    assert.match(pane, /<html:option value="mistral" data-i18n="preferences\.conversion\.provider\.mistral"><\/html:option>/);
    assert.equal((pane.match(/id="mktero-api-key"/g) || []).length, 1);
    assert.doesNotMatch(pane, /mktero-mineru-api-key|mktero-mistral-api-key/);
    assert.match(pane, /data-i18n="preferences\.conversion\.apiKeyLabel"/);
    assert.match(pane, /data-i18n="preferences\.conversion\.apiKeyHelp"/);
    assert.match(pane, /data-i18n="preferences\.conversion\.apiKeyStorage"/);
    assert.match(pane, /data-i18n="preferences\.conversion\.apiKeyManage"/);
    assert.match(script, /https:\/\/console\.mistral\.ai\/api-keys\//);
    assert.match(pane, /preference="extensions\.mktero\.cacheEnabled"/);
    assert.doesNotMatch(
        pane,
        /preference="extensions\.mktero\.semanticScholarApiKey"/
    );
    assert.doesNotMatch(
        pane,
        /preference="extensions\.mktero\.openAlexApiKey"/
    );
    assert.doesNotMatch(
        pane,
        /preference="extensions\.mktero\.openCitationsAccessToken"/
    );
    assert.doesNotMatch(pane, /id="mktero-citation-section"/);
    assert.match(pane, /preference="extensions\.mktero\.readerFontSize"/);
    assert.match(pane, /preference="extensions\.mktero\.readerFont"/);
    assert.match(pane, /preference="extensions\.mktero\.readerSourcePeek"/);
    assert.match(pane, /preference="extensions\.mktero\.readerLineHeight"/);
    assert.match(pane, /preference="extensions\.mktero\.readerWidth"/);
    assert.match(pane, /preference="extensions\.mktero\.readerAlignment"/);
    assert.match(pane, /min="14"/);
    assert.match(pane, /max="28"/);
    assert.doesNotMatch(pane, /preference="extensions\.mktero\.aiEnabled"/);
    assert.doesNotMatch(pane, /id="mktero-ai-enabled"/);
    assert.match(pane, /preference="extensions\.mktero\.aiProvider"/);
    assert.match(pane, /preference="extensions\.mktero\.aiProtocol"/);
    assert.match(pane, /preference="extensions\.mktero\.aiApiBase"/);
    assert.match(pane, /preference="extensions\.mktero\.aiApiKey"/);
    assert.match(pane, /preference="extensions\.mktero\.aiModel"/);
    assert.match(pane, /id="mktero-ai-request-timeout"/);
    assert.match(pane, /id="mktero-ai-settings"/);
    assert.doesNotMatch(pane, /id="mktero-ai-advanced"/);
    assert.doesNotMatch(pane, /id="mktero-ai-test-status"/);
    assert.match(
        pane,
        /id="mktero-ai-provider"[\s\S]*?id="mktero-ai-streaming"/
    );
    assert.match(pane, /class="mktero-field-control mktero-provider-control"/);
    assert.match(pane, /class="mktero-ai-test-icon"/);
    assert.match(pane, /id="mktero-ai-moonshot-endpoint-row"/);
    assert.match(pane, /id="mktero-ai-moonshot-endpoint"/);
    assert.match(pane, /id="mktero-ai-minimax-endpoint-row"/);
    assert.match(pane, /id="mktero-ai-minimax-endpoint"/);
    assert.match(pane, /id="mktero-ai-alibaba-endpoint-row"/);
    assert.match(pane, /id="mktero-ai-alibaba-endpoint"/);
    assert.doesNotMatch(pane, /mktero-ai-max-output-tokens/);
    assert.doesNotMatch(pane, /extensions\.mktero\.aiMaxOutputTokens/);
    assert.match(
        pane,
        /id="mktero-ai-auto-translate-selection"[\s\S]*?preference="extensions\.mktero\.aiAutoTranslateSelection"/
    );
    assert.match(
        pane,
        /id="mktero-ai-request-timeout"[\s\S]*?max="3600"/
    );
    assert.match(pane, /preference="extensions\.mktero\.aiReasoning"/);
    assert.match(pane, /id="mktero-ai-reasoning"/);
    assert.doesNotMatch(pane, /value="provider-default"/);
    assert.match(pane, /<html:option value="none" data-i18n="preferences\.ai\.reasoning\.none"><\/html:option>/);
    assert.match(pane, /<html:option value="xhigh" data-i18n="preferences\.ai\.reasoning\.xhigh"><\/html:option>/);
    assert.doesNotMatch(pane, /extensions\.mktero\.aiCacheEnabled/);
    assert.match(pane, /<html:option value="es-ES" data-i18n="preferences\.ai\.language\.esES"><\/html:option>/);
    assert.match(pane, /<html:option value="fr-FR" data-i18n="preferences\.ai\.language\.frFR"><\/html:option>/);
    assert.match(pane, /<html:option value="pt-BR" data-i18n="preferences\.ai\.language\.ptBR"><\/html:option>/);
    assert.match(pane, /id="mktero-ai-test"/);
    assert.match(pane, /id="mktero-reader-font-family"/);
    assert.match(pane, /id="mktero-reader-font-size-value"/);
    assert.match(pane, /id="mktero-clear-cache"/);
    assert.doesNotMatch(pane, /onload=/);
    assert.match(script, /registerPreferencesPaneLoader/);
    const visiblePreferenceText = stripMarkup(pane);
    assert.doesNotMatch(visiblePreferenceText, /mineru/i);
    assert.match(script, /createZoteroMarkdownCache/);
    assert.match(script, /createZoteroPDFTextIndexCache/);
    assert.match(script, /createZoteroTranslationCache/);
    assert.match(script, /createZoteroCitationGraphCache/);
    assert.match(script, /createZoteroMarkdownReadingPositionStore/);
    assert.match(script, /AISDKGateway/);
    assert.match(script, /createCombinedLocalCache/);
    assert.doesNotMatch(script, /setMkteroLanguagePreference/);
    assert.match(bootstrap, /new MinerUClient/);
    assert.match(
        bootstrap,
        /locateTextQuote:\s*\(itemID, annotation\)[\s\S]*?pdfAnnotationLocator\.locateTextQuote\([\s\S]*?annotation\.text[\s\S]*?pdfPageIndexHint:\s*annotation\.pageIndex[\s\S]*?sortIndex:\s*annotation\.sortIndex/
    );
    assert.doesNotMatch(bootstrap, /observeMkteroLanguagePreference/);
    assert.doesNotMatch(bootstrap, /getSemanticScholarAPIKey/);
    assert.doesNotMatch(bootstrap, /getOpenAlexAPIKey/);
    assert.doesNotMatch(bootstrap, /getOpenCitationsAccessToken/);
    assert.match(markdownView, /createInlineMarkdownEditor/);
    assert.doesNotMatch(markdownView, /'mktero-show-source'/);
    assert.match(markdownView, /'mktero-reparse'/);
    assert.match(markdownView, /__MKTERO_MARKDOWN_STYLES__/);
    assert.doesNotMatch(markdownView, /STYLESHEET_CACHE_KEY/);
    assert.match(markdownView, /error\.markdownStylesUnavailable/);
    assert.match(tabPresenter, /TAB_ICON = 'markdown'/);
    assert.match(buildScript, /ui\/preferences\.js/);
    assert.match(buildScript, /ui\/icons\/mktero\.svg/);
    assert.match(buildScript, /__MKTERO_MARKDOWN_STYLES__/);
    assert.match(buildScript, /__MKTERO_CITATION_GRAPH_STYLES__/);
    assert.match(buildScript, /licenses\/d3-force\.txt/);
    assert.doesNotMatch(buildScript, /copyText\('ui\/markdown\.css'/);
});

test('ships responsive settings cards and a cache switch', async () => {
    const [pane, styles] = await Promise.all([
        readFile(new URL('../ui/preferences.xhtml', import.meta.url), 'utf8'),
        readFile(new URL('../ui/preferences.css', import.meta.url), 'utf8'),
    ]);

    assert.match(pane, /class="mktero-settings-card"/);
    assert.equal((pane.match(/class="mktero-switch-input"/g) || []).length, 4);
    assert.equal((pane.match(/class="mktero-switch" aria-hidden="true"/g) || []).length, 4);
    assert.equal((pane.match(/role="switch"/g) || []).length, 4);
    assert.match(pane, /data-i18n="preferences\.ai\.autoTranslateSelectionLabel"/);
    assert.match(pane, /data-i18n="preferences\.ai\.autoTranslateSelectionHelp"/);
    assert.match(pane, /id="mktero-ai-streaming"/);
    assert.match(pane, /preference="extensions\.mktero\.aiStreaming"/);
    assert.match(styles, /\.mktero-settings-card\s*\{[\s\S]*border-radius:/);
    assert.match(styles, /\.mktero-switch-input:checked\s*\+\s*\.mktero-switch/);
    assert.match(styles, /\.mktero-switch::before/);
    assert.match(
        styles,
        /#mktero-ai-moonshot-endpoint-row\[hidden\][\s\S]*#mktero-ai-minimax-endpoint-row\[hidden\][\s\S]*#mktero-ai-alibaba-endpoint-row\[hidden\][\s\S]*#mktero-mineru-local-base-row\[hidden\][\s\S]*#mktero-api-key-row\[hidden\]\s*\{[\s\S]*display:\s*none/
    );
    assert.doesNotMatch(
        styles,
        /#mktero-semantic-scholar-api-key\s*\{[\s\S]*?font-variant-ligatures:\s*none/s
    );
    assert.doesNotMatch(
        styles,
        /#mktero-openalex-api-key,[\s\S]*?#mktero-open-citations-access-token[\s\S]*?font-variant-ligatures:\s*none/s
    );
    assert.match(styles, /@media\s*\(max-width:/);
});

test('keeps preference inputs visibly distinct from the settings card', async () => {
    const styles = await readFile(
        new URL('../ui/preferences.css', import.meta.url),
        'utf8'
    );

    assert.match(
        styles,
        /\.mktero-field-control input,[\s\S]*?background-color:\s*color-mix\(/s
    );
    assert.match(
        styles,
        /\.mktero-field-control input,[\s\S]*?color:\s*CanvasText/s
    );
    assert.match(
        styles,
        /\.mktero-field-control input,[\s\S]*?border:\s*1px\s+solid\s+color-mix\(/s
    );
    assert.match(
        styles,
        /\.mktero-field-control input,[\s\S]*?opacity:\s*1/s
    );
    assert.match(
        styles,
        /#mktero-clear-cache\s*\{[\s\S]*?-moz-appearance:\s*none[\s\S]*?min-height:\s*36px[\s\S]*?border-radius:\s*8px/s
    );
});

test('does not add a second native arrow to preference selects', async () => {
    const styles = await readFile(
        new URL('../ui/preferences.css', import.meta.url),
        'utf8'
    );
    const fieldRule = styles.match(
        /\.mktero-field-control input,\s*\.mktero-field-control select\s*\{([\s\S]*?)\}/
    )?.[1] || '';

    assert.ok(fieldRule);
    assert.doesNotMatch(fieldRule, /appearance:\s*auto/);
});

test('keeps preference fields in an aligned responsive flex layout', async () => {
    const [pane, styles] = await Promise.all([
        readFile(new URL('../ui/preferences.xhtml', import.meta.url), 'utf8'),
        readFile(new URL('../ui/preferences.css', import.meta.url), 'utf8'),
    ]);

    assert.match(
        styles,
        /#mktero-preferences-pane\s*\{[\s\S]*?padding:\s*8px\s+20px\s+36px/s
    );
    assert.match(
        styles,
        /\.mktero-field-row\s*\{[\s\S]*?align-items:\s*center/s
    );
    assert.match(
        styles,
        /\.mktero-reader-font-row\s*\{[\s\S]*?align-items:\s*center/s
    );
    assert.match(
        styles,
        /\.mktero-field-control\s*\{[\s\S]*?flex:\s*0\s+1\s+200px[\s\S]*?width:\s*200px[\s\S]*?max-width:\s*42%/s
    );
    assert.match(
        styles,
        /\.mktero-field-row\s*>\s*\.mktero-setting-copy[\s\S]*?min-width:\s*0/s
    );
    assert.match(
        styles,
        /\.mktero-field-control input,[\s\S]*?min-width:\s*0/s
    );
    assert.match(
        styles,
        /\.mktero-reader-font-control input,[\s\S]*?min-width:\s*0/s
    );
    assert.match(
        styles,
        /@media\s*\(max-width:\s*700px\)[\s\S]*?\.mktero-field-row,[\s\S]*?flex-direction:\s*column/s
    );
    assert.doesNotMatch(
        styles,
        /\.mktero-field-row,[\s\S]*?display:\s*grid/s
    );
    assert.equal(
        (pane.match(
            /class="mktero-setting-row mktero-(?:field|reader-font)-row[^\"]*"/g
        ) || []).length,
        22
    );
    assert.equal(
        (pane.match(
            /<html:div class="mktero-field-control(?: [^"]+)?">/g
        ) || []).length,
        17
    );
});

test('keeps right-side preference controls aligned at one width without native spinners', async () => {
    const [pane, styles] = await Promise.all([
        readFile(new URL('../ui/preferences.xhtml', import.meta.url), 'utf8'),
        readFile(new URL('../ui/preferences.css', import.meta.url), 'utf8'),
    ]);

    assert.match(
        pane,
        /class="mktero-field-control mktero-field-control-compact"[\s\S]*?id="mktero-ai-target-language"/
    );
    assert.equal(
        (pane.match(
            /class="mktero-field-control mktero-field-control-compact mktero-field-control-numeric"/g
        ) || []).length,
        1
    );
    assert.match(
        styles,
        /\.mktero-field-control-compact,\s*\.mktero-field-control-numeric\s*\{[\s\S]*?flex-basis:\s*200px[\s\S]*?width:\s*200px[\s\S]*?max-width:\s*42%/s
    );
    assert.match(
        styles,
        /\.mktero-field-control\.mktero-provider-control\s*\{[\s\S]*?flex:\s*0\s+1\s+200px[\s\S]*?width:\s*200px[\s\S]*?max-width:\s*42%/s
    );
    assert.match(
        pane,
        /id="mktero-ai-test"[\s\S]*?id="mktero-ai-provider"/
    );
    assert.match(
        styles,
        /\.mktero-field-control input\[type='number'\]\s*\{[\s\S]*?-moz-appearance:\s*textfield/s
    );
    assert.match(
        styles,
        /::-webkit-inner-spin-button[\s\S]*?appearance:\s*none/s
    );
    assert.match(
        styles,
        /@media\s*\(max-width:\s*700px\)[\s\S]*?\.mktero-field-control-compact[\s\S]*?width:\s*100%[\s\S]*?max-width:\s*100%/s
    );
});

test('presents every preference group as one cohesive settings card', async () => {
    const [pane, styles] = await Promise.all([
        readFile(new URL('../ui/preferences.xhtml', import.meta.url), 'utf8'),
        readFile(new URL('../ui/preferences.css', import.meta.url), 'utf8'),
    ]);

    assert.equal((pane.match(/class="mktero-settings-card"/g) || []).length, 3);
    assert.equal((pane.match(/class="mktero-preferences-section"/g) || []).length, 4);
    assert.match(pane, /id="mktero-pref-tablist"[\s\S]*role="tablist"/);
    assert.match(pane, /id="mktero-tab-features"[\s\S]*aria-selected="true"/);
    assert.match(pane, /id="mktero-features-section"/);
    assert.doesNotMatch(pane, /id="mktero-tab-reader"/);
    assert.equal((pane.match(/class="mktero-pref-tab"/g) || []).length, 3);
    assert.equal((pane.match(/class="mktero-segmented-item"/g) || []).length, 0);
    assert.equal((pane.match(/data-feature-source=/g) || []).length, 0);
    assert.equal((pane.match(/data-tab-icon="/g) || []).length, 3);
    assert.equal((pane.match(/role="tabpanel"/g) || []).length, 3);
    assert.match(
        pane,
        /id="mktero-api-key"[\s\S]*aria-describedby="mktero-api-key-help mktero-api-key-storage"/
    );
    assert.match(
        pane,
        /id="mktero-conversion-section"[\s\S]*id="mktero-api-key"/
    );
    assert.match(
        pane,
        /id="mktero-cache-enabled"[\s\S]*class="mktero-switch-input"[\s\S]*role="switch"/
    );
    assert.match(
        pane,
        /id="mktero-cache-status"[\s\S]*role="status"[\s\S]*aria-live="polite"/
    );
    assert.match(styles, /#mktero-preferences-pane\s*\{[\s\S]*max-width:/);
    assert.match(styles, /\.mktero-pref-tab\[aria-selected='true'\]/);
    assert.match(styles, /\.mktero-preferences-section\[hidden\]/);
    assert.match(styles, /\.mktero-card-note/);
});

test('presents the account card with website-style tabs and an identity block', async () => {
    const [pane, styles] = await Promise.all([
        readFile(new URL('../ui/preferences.xhtml', import.meta.url), 'utf8'),
        readFile(new URL('../ui/preferences.css', import.meta.url), 'utf8'),
    ]);

    // The card mirrors mktero-web/account.html: a tab row over the form.
    assert.match(pane, /id="mktero-account-tabs"[\s\S]*?role="tablist"/);
    assert.match(pane, /id="mktero-account-tab-login"[\s\S]*?role="tab"[\s\S]*?aria-selected="true"/);
    assert.match(pane, /id="mktero-account-tab-register"[\s\S]*?role="tab"[\s\S]*?aria-selected="false"/);
    assert.doesNotMatch(pane, /id="mktero-account-switch"/);

    // Signed in shows the avatar, the name with its rename button, the email,
    // and the registration date, mirroring the website profile card.
    assert.match(pane, /id="mktero-account-avatar"/);
    assert.match(pane, /id="mktero-account-signed-in-nickname"/);
    assert.match(pane, /id="mktero-account-signed-in-email"/);
    assert.match(pane, /id="mktero-account-created"/);
    assert.match(pane, /id="mktero-account-save-nickname"/);
    // The rename control is an icon-only button next to the name, and the
    // nickname field moved into its dialog.
    assert.match(
        pane,
        /class="mktero-account-name-row"[\s\S]*?id="mktero-account-edit-nickname"[\s\S]*?aria-haspopup="dialog"[\s\S]*?aria-controls="mktero-account-nickname-dialog"/
    );
    assert.match(
        pane,
        /id="mktero-account-nickname-dialog"[\s\S]*?role="dialog"[\s\S]*?aria-modal="true"/
    );
    assert.match(pane, /id="mktero-account-nickname-dialog-cancel"/);
    assert.doesNotMatch(pane, /id="mktero-account-nickname-row"/);
    assert.doesNotMatch(pane, /mktero-account-signed-in-badge/);

    // The activity surface is the three counters.
    assert.match(pane, /id="mktero-stat-total"/);
    assert.match(pane, /id="mktero-stat-month"/);
    assert.match(pane, /id="mktero-stat-today"/);
    assert.doesNotMatch(pane, /heatmap/);

    // The registration nickname stays a separate optional field.
    assert.match(pane, /id="mktero-account-register-nickname"[\s\S]*?maxlength="32"/);
    assert.match(pane, /id="mktero-account-nickname"[\s\S]*?maxlength="32"/);

    // The account card shares the settings-card background: no own fill, no
    // own border, and no second rounded surface inside the card.
    const authCard = styles.match(/\.mktero-auth-card\s*\{([^}]*)\}/)?.[1] || '';
    assert.ok(authCard, '.mktero-auth-card rule is missing');
    assert.match(authCard, /background:\s*transparent/);
    assert.match(authCard, /border:\s*0/);
    assert.doesNotMatch(authCard, /border-radius:/);
    assert.doesNotMatch(authCard, /color-mix\(/);
    assert.match(styles, /\.mktero-auth-tabs\s*\{[\s\S]*?grid-template-columns:\s*1fr\s+1fr/s);
    assert.match(styles, /\.mktero-auth-tab\[aria-selected='true'\]/);
    assert.match(styles, /\.mktero-account-avatar\s*\{[\s\S]*?border-radius:\s*50%/s);

    // The signed-in block spans the settings-row content width so its left and
    // right edges line up with the conversion-provider row above it. The row is
    // padded 16px 28px, so the account block must use the same 28px and must not
    // re-cap the card narrower than the row.
    const accountInline = styles.match(/\.mktero-account-inline\s*\{([^}]*)\}/)?.[1] || '';
    assert.ok(accountInline, '.mktero-account-inline rule is missing');
    assert.match(accountInline, /padding:\s*24px\s+28px\s+28px/);
    assert.doesNotMatch(accountInline, /justify-content:\s*center/);
    assert.doesNotMatch(authCard, /max-width:/);
    const settingsRow = styles.match(/\.mktero-setting-row\s*\{([^}]*)\}/)?.[1] || '';
    assert.match(settingsRow, /padding:\s*16px\s+28px/);
    // Only the signed-out sign-in column keeps the website's narrow width.
    assert.match(
        styles,
        /\.mktero-auth-tabs\s*\{[\s\S]*?max-width:\s*452px/s
    );
    assert.match(
        styles,
        /\.mktero-auth-form\s*\{[\s\S]*?max-width:\s*452px/s
    );

    // Refresh sits above sign out. More stays alone under the counters.
    assert.match(
        pane,
        /id="mktero-account-refresh"[\s\S]*?id="mktero-account-logout"/
    );
    assert.match(pane, /class="mktero-account-more-row"[\s\S]*?id="mktero-account-more"/);
    assert.doesNotMatch(
        pane,
        /class="mktero-account-more-row"[\s\S]*?id="mktero-account-logout"/
    );
    const accountTop = styles.match(/\.mktero-account-top\s*\{([^}]*)\}/)?.[1] || '';
    assert.ok(accountTop, '.mktero-account-top rule is missing');
    assert.match(accountTop, /grid-template-columns:/);
    // The sign-out pill keeps its intrinsic width instead of stretching.
    assert.match(
        styles,
        /\.mktero-auth-card \.mktero-auth-submit:not\(\.mktero-button-primary\)\s*\{[\s\S]*?flex:\s*0\s+0\s+auto/s
    );
    assert.match(
        styles,
        /\.mktero-account-stats\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s
    );
    // The rename modal uses a hand-rolled backdrop: no <dialog> in the runtime.
    assert.match(
        styles,
        /\.mktero-account-dialog-backdrop\s*\{[\s\S]*?position:\s*fixed[\s\S]*?inset:\s*0/s
    );
    assert.match(styles, /\.mktero-account-dialog-backdrop::backdrop|rgba\(17, 17, 17, 0\.46\)/);
});

test('hides the account card rows that are not in use', async () => {
    const styles = await readFile(
        new URL('../ui/preferences.css', import.meta.url),
        'utf8'
    );

    // A stray trailing comma previously folded .mktero-card-note into this
    // hidden list, which forced the hidden account rows back to display: block.
    assert.match(
        styles,
        /#mktero-account-register-nickname-row\[hidden\],[\s\S]*?#mktero-ai-account-status\[hidden\]\s*\{\s*display:\s*none;/s
    );
    // The hidden list must close before .mktero-card-note starts, otherwise the
    // card-note rule would apply to the hidden account rows instead.
    const hiddenList = styles.match(
        /#mktero-account-api-base-row\[hidden\][\s\S]*?\n\}/s
    )?.[0] || '';
    assert.match(hiddenList, /#mktero-ai-account-status\[hidden\]\s*\{\s*display:\s*none;/);
    assert.doesNotMatch(hiddenList, /\.mktero-card-note/);
    assert.doesNotMatch(styles, /#mktero-account-switch\[hidden\]/);
});

test('matches the website account card controls', async () => {
    const styles = await readFile(
        new URL('../ui/preferences.css', import.meta.url),
        'utf8'
    );

    const rule = selector => styles.match(
        new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')
    )?.[1] || '';

    // The website card: white inputs, 12px radius, 44px tall, dark pill button.
    const input = rule('.mktero-auth-card .mktero-form-field input');
    assert.ok(input, 'the account input rule is missing');
    assert.match(input, /min-height:\s*44px/);
    assert.match(input, /border-radius:\s*12px/);
    assert.match(input, /background:\s*Canvas/);
    assert.match(input, /padding:\s*0\s+13px/);

    const primary = rule('.mktero-auth-card .mktero-button-primary');
    assert.ok(primary, 'the primary button rule is missing');
    assert.match(primary, /min-height:\s*46px/);
    assert.match(primary, /border-radius:\s*999px/);
    assert.match(primary, /background:\s*#111111/);
    assert.match(primary, /color:\s*#ffffff/);

    // The inline send-code button is a 12px-radius outlined control.
    const inline = rule('.mktero-auth-card .mktero-input-action .mktero-button');
    assert.ok(inline, 'the inline button rule is missing');
    assert.match(inline, /border-radius:\s*12px/);
    assert.match(inline, /min-height:\s*44px/);

    // The tab row is a pill with a 38px selected tab.
    const tab = rule('.mktero-auth-tab');
    assert.match(tab, /min-height:\s*38px/);
    assert.match(tab, /border-radius:\s*999px/);
    assert.match(rule('.mktero-auth-tabs'), /border-radius:\s*999px/);

    // "Forgot password?" uses the website blue, not the theme accent.
    assert.match(
        rule('.mktero-auth-card .mktero-auth-inline-link'),
        /color:\s*#3b82f6/
    );

    // Sign out is a plain red text action: no border, no fill, so it reads as
    // the destructive choice rather than a second primary button.
    const secondary = rule('.mktero-auth-card .mktero-auth-submit:not(.mktero-button-primary)');
    assert.ok(secondary, 'the sign-out rule is missing');
    assert.match(secondary, /border:\s*0/);
    assert.match(secondary, /background:\s*transparent/);
    assert.match(secondary, /color:\s*#b42318/);
    assert.doesNotMatch(secondary, /border-radius:\s*999px/);
    assert.doesNotMatch(secondary, /min-height:\s*4[46]px/);

    // The rename pencil is square and exactly as tall as the nickname line box
    // (1.05rem font x 1.3 line-height).
    const icon = rule('.mktero-account-icon-button');
    assert.ok(icon, 'the account icon button rule is missing');
    assert.match(icon, /border:\s*0/);
    assert.doesNotMatch(icon, /width:\s*30px/);
    assert.match(
        styles,
        /\.mktero-account-name-row \.mktero-account-icon-button\s*\{[\s\S]*?width:\s*1\.365rem[\s\S]*?height:\s*1\.365rem/s
    );
    assert.match(
        styles,
        /\.mktero-account-identity-copy strong\s*\{[\s\S]*?font-size:\s*1\.05rem[\s\S]*?line-height:\s*1\.3/s
    );
});

test('uses the same account placeholders as the website', async () => {
    const [pane, localization] = await Promise.all([
        readFile(new URL('../ui/preferences.xhtml', import.meta.url), 'utf8'),
        readFile(new URL('../src/i18n/localization.js', import.meta.url), 'utf8'),
    ]);

    const english = localization.slice(
        localization.indexOf('[LANGUAGE_ENGLISH]: Object.freeze({'),
        localization.indexOf('[LANGUAGE_SIMPLIFIED_CHINESE]: Object.freeze({')
    );
    const chinese = localization.slice(
        localization.indexOf('[LANGUAGE_SIMPLIFIED_CHINESE]: Object.freeze({')
    );

    const value = (block, key) => block.match(
        new RegExp("'" + key.replace(/[.]/g, '\\.') + "':\\s*'([^']*)'")
    )?.[1];

    // English matches mktero-web/account.js.
    assert.equal(value(english, 'preferences.account.emailPlaceholder'), 'Enter your email');
    assert.equal(value(english, 'preferences.account.passwordPlaceholder'), 'Enter your password');
    assert.equal(value(english, 'preferences.account.codePlaceholder'), 'Enter the 6-digit code');
    assert.equal(value(english, 'preferences.account.confirmPasswordPlaceholder'), 'Enter the password again');

    // Chinese matches mktero-web/account.js.
    assert.equal(value(chinese, 'preferences.account.emailPlaceholder'), '请输入邮箱');
    assert.equal(value(chinese, 'preferences.account.passwordPlaceholder'), '请输入密码');
    assert.equal(value(chinese, 'preferences.account.codePlaceholder'), '请输入 6 位验证码');
    assert.equal(value(chinese, 'preferences.account.confirmPasswordPlaceholder'), '请再次输入密码');

    // The registration nickname field asks for an optional name.
    assert.equal(value(chinese, 'preferences.account.nicknameOptionalPlaceholder'), '请你输入昵称（选填）');
    assert.match(pane, /id="mktero-account-register-nickname"[\s\S]*?data-i18n-placeholder="preferences\.account\.nicknameOptionalPlaceholder"/);

    // The signed-in rename field keeps the plain wording.
    assert.match(pane, /id="mktero-account-nickname"[\s\S]*?data-i18n-placeholder="preferences\.account\.nicknamePlaceholder"/);
    assert.equal(value(chinese, 'preferences.account.nicknamePlaceholder'), '请输入昵称');
});
