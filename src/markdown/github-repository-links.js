const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const RESERVED_OWNERS = new Set([
    'about',
    'account',
    'apps',
    'blog',
    'codespaces',
    'collections',
    'contact',
    'copilot',
    'customer-stories',
    'dashboard',
    'enterprise',
    'events',
    'explore',
    'features',
    'gist',
    'gists',
    'login',
    'logout',
    'marketplace',
    'new',
    'notifications',
    'orgs',
    'organizations',
    'pricing',
    'pulls',
    'search',
    'settings',
    'signup',
    'sponsors',
    'topics',
    'trending',
]);
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPO_PATTERN = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
const ISSUE_NUMBER_PATTERN = /^[1-9]\d{0,8}$/;
const SUBPAGES = new Set([
    'blob',
    'issues',
    'pull',
    'pulls',
    'releases',
    'tree',
]);

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/igu;
const TRAILING_URL_PUNCTUATION = /[.,;:!?)\]]+$/;
const MAX_SOURCE_LENGTH = 2 * 1024 * 1024;
const MAX_REPOSITORIES = 50;

export function findGitHubRepositories(markdown) {
    const source = String(markdown || '').slice(0, MAX_SOURCE_LENGTH);
    const repositories = [];
    const seen = new Set();
    for (const match of source.matchAll(URL_PATTERN)) {
        const href = String(match[0] || '').replace(TRAILING_URL_PUNCTUATION, '');
        const parsed = parseGitHubRepositoryLink(href);
        if (!parsed) continue;
        const key = `${parsed.owner}/${parsed.repo}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        repositories.push({
            owner: parsed.owner,
            repo: parsed.repo,
            label: `${parsed.owner}/${parsed.repo}`,
            href: `https://github.com/${parsed.owner}/${parsed.repo}`,
        });
        if (repositories.length >= MAX_REPOSITORIES) break;
    }
    return repositories;
}

export function parseGitHubRepositoryLink(value) {
    const href = String(value || '').trim();
    if (!href) return null;
    let url;
    try {
        url = new URL(href);
    }
    catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) {
        return parseGitHubPagesLink(href, url);
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repo = parts[1].endsWith('.git')
        ? parts[1].slice(0, -4)
        : parts[1];
    if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
    if (!GITHUB_OWNER_PATTERN.test(owner) || !GITHUB_REPO_PATTERN.test(repo)) {
        return null;
    }

    const section = parts[2]?.toLowerCase() || '';
    if (section && !SUBPAGES.has(section)) return null;

    let kind = 'repository';
    let label = `${owner}/${repo}`;
    if (section === 'tree' || section === 'blob' || section === 'releases') {
        kind = section;
    }
    else if (section === 'issues' || section === 'pull' || section === 'pulls') {
        kind = section === 'issues' ? 'issues' : 'pull';
        if (ISSUE_NUMBER_PATTERN.test(parts[3] || '')) {
            label = `${owner}/${repo}#${parts[3]}`;
        }
    }

    return {
        href,
        owner,
        repo,
        kind,
        label,
    };
}

const GITHUB_PAGES_HOST_PATTERN =
    /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\.github\.io$/i;

function parseGitHubPagesLink(href, url) {
    const match = GITHUB_PAGES_HOST_PATTERN.exec(url.hostname);
    if (!match) return null;
    const owner = match[1];
    if (owner.toLowerCase() === 'www') return null;
    if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
    if (!GITHUB_OWNER_PATTERN.test(owner)) return null;
    const repoName = url.pathname.split('/').filter(Boolean)[0];
    const repo = repoName
        ? (repoName.endsWith('.git') ? repoName.slice(0, -4) : repoName)
        : `${owner}.github.io`;
    if (!GITHUB_REPO_PATTERN.test(repo)) return null;
    return {
        href,
        owner,
        repo,
        kind: 'pages',
        label: `${owner}/${repo}`,
    };
}
