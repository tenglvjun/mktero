import test from 'node:test';
import assert from 'node:assert/strict';
import {
    findGitHubRepositories,
    parseGitHubRepositoryLink,
} from '../src/markdown/github-repository-links.js';

test('collects unique GitHub repositories as owner/repo links', () => {
    assert.deepEqual(
        findGitHubRepositories([
            'Code: https://github.com/owner/repo',
            'Pages: https://xzf-thu.github.io/VoiceMem/',
            'Again: https://github.com/owner/repo/blob/main/src/app.js',
            'See [Code](https://github.com/Owner/repo).',
        ].join('\n')),
        [
            {
                owner: 'owner',
                repo: 'repo',
                label: 'owner/repo',
                href: 'https://github.com/owner/repo',
            },
            {
                owner: 'xzf-thu',
                repo: 'VoiceMem',
                label: 'xzf-thu/VoiceMem',
                href: 'https://github.com/xzf-thu/VoiceMem',
            },
        ]
    );
});

test('parses a GitHub repository homepage into a short chip label', () => {
    assert.deepEqual(
        parseGitHubRepositoryLink('https://github.com/owner/repo'),
        {
            href: 'https://github.com/owner/repo',
            owner: 'owner',
            repo: 'repo',
            kind: 'repository',
            label: 'owner/repo',
        }
    );
});

test('accepts www, trailing slashes, and a .git suffix', () => {
    assert.equal(
        parseGitHubRepositoryLink('https://www.github.com/Owner/Repo.git/')?.label,
        'Owner/Repo'
    );
    assert.equal(
        parseGitHubRepositoryLink('http://github.com/owner/repo/')?.kind,
        'repository'
    );
});

test('shortens common repository subpages without changing the destination', () => {
    assert.deepEqual(
        parseGitHubRepositoryLink(
            'https://github.com/owner/repo/blob/main/src/app.js'
        ),
        {
            href: 'https://github.com/owner/repo/blob/main/src/app.js',
            owner: 'owner',
            repo: 'repo',
            kind: 'blob',
            label: 'owner/repo',
        }
    );
    assert.equal(
        parseGitHubRepositoryLink('https://github.com/owner/repo/tree/main')?.kind,
        'tree'
    );
    assert.equal(
        parseGitHubRepositoryLink('https://github.com/owner/repo/issues/12')?.label,
        'owner/repo#12'
    );
    assert.equal(
        parseGitHubRepositoryLink('https://github.com/owner/repo/pull/8')?.label,
        'owner/repo#8'
    );
    assert.equal(
        parseGitHubRepositoryLink('https://github.com/owner/repo/releases')?.kind,
        'releases'
    );
});

test('maps a GitHub Pages project URL to its owner and repository', () => {
    assert.deepEqual(
        parseGitHubRepositoryLink('https://xzf-thu.github.io/VoiceMem/'),
        {
            href: 'https://xzf-thu.github.io/VoiceMem/',
            owner: 'xzf-thu',
            repo: 'VoiceMem',
            kind: 'pages',
            label: 'xzf-thu/VoiceMem',
        }
    );
    assert.equal(
        parseGitHubRepositoryLink('http://Owner.github.io/Repo/docs')?.label,
        'owner/Repo'
    );
});

test('maps a GitHub Pages user site to its default repository', () => {
    assert.deepEqual(
        parseGitHubRepositoryLink('https://xzf-thu.github.io/'),
        {
            href: 'https://xzf-thu.github.io/',
            owner: 'xzf-thu',
            repo: 'xzf-thu.github.io',
            kind: 'pages',
            label: 'xzf-thu/xzf-thu.github.io',
        }
    );
});

test('rejects non-repository GitHub URLs and unsafe input', () => {
    assert.equal(parseGitHubRepositoryLink('https://gist.github.com/owner/abc'), null);
    assert.equal(parseGitHubRepositoryLink('https://github.com/features'), null);
    assert.equal(parseGitHubRepositoryLink('https://github.com/login'), null);
    assert.equal(parseGitHubRepositoryLink('https://github.com/owner/repo/wiki'), null);
    assert.equal(
        parseGitHubRepositoryLink('https://github.com.evil.com/owner/repo'),
        null
    );
    assert.equal(
        parseGitHubRepositoryLink('https://xzf-thu.github.io.evil.com/VoiceMem'),
        null
    );
    assert.equal(parseGitHubRepositoryLink('javascript:alert(1)'), null);
    assert.equal(parseGitHubRepositoryLink('https://example.com/owner/repo'), null);
    assert.equal(parseGitHubRepositoryLink(''), null);
});
