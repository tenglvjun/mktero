import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
    assert.match(prefs, /pref\("extensions\.mktero\.aiEnabled", false\)/);
    assert.match(prefs, /pref\("extensions\.mktero\.aiProvider", "openai"\)/);
    assert.match(prefs, /pref\("extensions\.mktero\.aiProtocol", "openai-responses"\)/);
    assert.match(prefs, /pref\("extensions\.mktero\.aiApiKey", ""\)/);
    assert.match(prefs, /pref\("extensions\.mktero\.aiRequestTimeoutMs", 600000\)/);
    assert.match(prefs, /pref\("extensions\.mktero\.aiMaxOutputTokens", 0\)/);
    assert.match(
        prefs,
        /pref\("extensions\.mktero\.aiAutoTranslateSelection", false\)/
    );
    assert.doesNotMatch(prefs, /extensions\.mktero\.aiReasoning/);
    assert.doesNotMatch(prefs, /extensions\.mktero\.aiCacheEnabled/);
    assert.doesNotMatch(
        pane,
        /<html:option value="en-US"[^>]*preferences\.ai\.language\.enUS/
    );
    assert.match(
        prefs,
        /pref\("extensions\.mktero\.readerFont", "system-serif"\)/
    );
    assert.doesNotMatch(prefs, /extensions\.mktero\.language/);
    assert.doesNotMatch(pane, /id="mktero-language"/);
    assert.doesNotMatch(pane, /preference="extensions\.mktero\.language"/);
    assert.match(pane, /id="mktero-conversion-provider"[\s\S]*?preference="extensions\.mktero\.conversionProvider"/);
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
    assert.match(pane, /preference="extensions\.mktero\.aiEnabled"/);
    assert.match(pane, /preference="extensions\.mktero\.aiProvider"/);
    assert.match(pane, /preference="extensions\.mktero\.aiProtocol"/);
    assert.match(pane, /preference="extensions\.mktero\.aiApiBase"/);
    assert.match(pane, /preference="extensions\.mktero\.aiApiKey"/);
    assert.match(pane, /preference="extensions\.mktero\.aiModel"/);
    assert.match(pane, /preference="extensions\.mktero\.aiRequestTimeoutMs"/);
    assert.match(pane, /preference="extensions\.mktero\.aiMaxOutputTokens"/);
    assert.match(
        pane,
        /id="mktero-ai-auto-translate-selection"[\s\S]*?preference="extensions\.mktero\.aiAutoTranslateSelection"/
    );
    assert.match(
        pane,
        /id="mktero-ai-request-timeout"[\s\S]*?max="3600000"/
    );
    assert.match(
        pane,
        /id="mktero-ai-max-output-tokens"[\s\S]*?max="262144"/
    );
    assert.doesNotMatch(pane, /extensions\.mktero\.aiReasoning/);
    assert.doesNotMatch(pane, /mktero-ai-reasoning/);
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
    const visiblePreferenceText = pane.replace(/<[^>]+>/g, ' ');
    assert.doesNotMatch(visiblePreferenceText, /mineru/i);
    assert.match(script, /createZoteroMarkdownCache/);
    assert.match(script, /createZoteroPDFTextIndexCache/);
    assert.match(script, /createZoteroTranslationCache/);
    assert.match(script, /createZoteroCitationGraphCache/);
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
        /\.mktero-field-row\s*\{[\s\S]*?align-items:\s*flex-start/s
    );
    assert.match(
        styles,
        /\.mktero-reader-font-row\s*\{[\s\S]*?align-items:\s*center/s
    );
    assert.match(
        styles,
        /\.mktero-field-control\s*\{[\s\S]*?flex:\s*0\s+1\s+460px[\s\S]*?width:\s*460px[\s\S]*?max-width:\s*48%/s
    );
    assert.match(
        styles,
        /\.mktero-field-row\s*>\s*\.mktero-setting-copy[\s\S]*?min-width:\s*240px/s
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
            /class="mktero-setting-row mktero-(?:field|reader-font)-row"/g
        ) || []).length,
        12
    );
    assert.equal(
        (pane.match(
            /<html:div class="mktero-(?:field|reader-font)-control(?: [^"]+)?">/g
        ) || []).length,
        12
    );
});

test('keeps choice and numeric AI controls compact without native spinners', async () => {
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
        2
    );
    assert.match(
        styles,
        /\.mktero-field-control-compact\s*\{[\s\S]*?flex-basis:\s*320px[\s\S]*?width:\s*320px[\s\S]*?max-width:\s*36%/s
    );
    assert.match(
        styles,
        /\.mktero-field-control-numeric\s*\{[\s\S]*?flex-basis:\s*240px[\s\S]*?width:\s*240px/s
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
        /@media\s*\(max-width:\s*700px\)[\s\S]*?\.mktero-field-control-compact\s*\{[\s\S]*?width:\s*min\(320px,\s*100%\)[\s\S]*?max-width:\s*100%/s
    );
});

test('presents every preference group as one cohesive settings card', async () => {
    const [pane, styles] = await Promise.all([
        readFile(new URL('../ui/preferences.xhtml', import.meta.url), 'utf8'),
        readFile(new URL('../ui/preferences.css', import.meta.url), 'utf8'),
    ]);

    assert.equal((pane.match(/class="mktero-settings-card"/g) || []).length, 4);
    assert.equal((pane.match(/class="mktero-preferences-section"/g) || []).length, 4);
    assert.match(
        pane,
        /id="mktero-api-key"[\s\S]*aria-describedby="mktero-api-key-help mktero-api-key-storage"/
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
    assert.match(styles, /\.mktero-preferences-section\s*\+\s*\.mktero-preferences-section/);
    assert.match(styles, /\.mktero-card-note/);
});
