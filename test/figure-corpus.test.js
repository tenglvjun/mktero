import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFigureCorpus, FIGURE_CORPUS_ENV } from '../scripts/figure-corpus-check.mjs';

const corpusDir = process.env[FIGURE_CORPUS_ENV];

test('matches committed figure expectations for every local corpus archive', {
    skip: corpusDir ? false : `set ${FIGURE_CORPUS_ENV} to a directory of MinerU result archives`,
}, async () => {
    const report = await checkFigureCorpus({ corpusDir, log: () => {} });
    assert.ok(report.checked.length + report.skipped.length > 0,
        'no committed figure corpus expectations were found');
    assert.equal(report.failures.length, 0,
        report.failures.map(failure => failure.message).join('\n'));
});
