import test from 'node:test';
import assert from 'node:assert/strict';

import { OpenAlexClient } from '../src/citations/openalex-client.js';

test('resolves the best OpenAlex open-access PDF from a DOI-only request', async () => {
    let request;
    const client = new OpenAlexClient({
        fetch: async (url, options) => {
            request = { url: String(url), options };
            return jsonResponse({
                results: [{
                    best_oa_location: {
                        pdf_url: 'https://repository.example/paper.pdf#view=fit',
                    },
                    locations: [],
                }],
            });
        },
    });

    assert.equal(await client.resolveOpenAccessPDF({
        doi: 'DOI:10.1000/TEST',
        apiKey: 'openalex-secret',
    }), 'https://repository.example/paper.pdf');
    const parsed = new URL(request.url);
    assert.equal(parsed.searchParams.get('filter'), 'doi:10.1000/test');
    assert.match(parsed.searchParams.get('select'), /best_oa_location/);
    assert.equal(parsed.searchParams.get('api_key'), 'openalex-secret');
    assert.deepEqual(request.options.headers, {});
});

test('rejects malformed OpenAlex open-access responses', async () => {
    const malformed = new OpenAlexClient({
        fetch: async () => jsonResponse({ results: {} }),
    });
    await assert.rejects(
        () => malformed.resolveOpenAccessPDF({ doi: '10.1000/malformed' }),
        error => error.code === 'OPENALEX_INVALID_RESPONSE'
    );
});

test('honors cancellation during an OpenAlex open-access lookup', async () => {
    const controller = new AbortController();
    const client = new OpenAlexClient({
        fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(
                new DOMException('Aborted', 'AbortError')
            ), { once: true });
        }),
    });
    const pending = client.resolveOpenAccessPDF({
        doi: '10.1000/cancel',
        signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
});

test('matches OpenAlex references through DOI-only local paper requests', async () => {
    const requests = [];
    const client = new OpenAlexClient({
        now: () => 5_000,
        fetch: async (url, options) => {
            requests.push({ url, options });
            const parsed = new URL(url);
            const select = parsed.searchParams.get('select');
            if (select === 'id,referenced_works') {
                return jsonResponse({
                    results: [{
                        id: 'https://openalex.org/W100',
                        referenced_works: [
                            'https://openalex.org/W200',
                            'https://openalex.org/W999',
                        ],
                    }],
                });
            }
            assert.equal(select, 'id,doi');
            return jsonResponse({
                results: [{
                    id: 'https://openalex.org/W200',
                    doi: 'https://doi.org/10.1000/b',
                }],
            });
        },
    });
    const papers = [
        paper(1, 'A', { doi: '10.1000/a', title: 'Private A' }),
        paper(2, 'B', { doi: '10.1000/b', title: 'Private B' }),
        paper(3, 'C', { doi: '', arxivID: '2401.12345' }),
        paper(4, 'D', { doi: '', arxivID: '' }),
    ];

    assert.equal(client.supports(papers[0]), true);
    assert.equal(client.supports(papers[2]), false);
    assert.deepEqual(client.cacheScopeIdentifiers(papers, papers[0]), [
        'doi:10.1000/b',
    ]);
    const result = await client.fetchReferences({
        doi: '10.1000/a',
        papers,
        apiKey: ' openalex-key ',
    });

    assert.deepEqual(result, {
        status: 'fetched',
        paperID: 'W100',
        references: [{
            paperID: 'W200',
            title: 'Private B',
            year: 2024,
            doi: '10.1000/b',
            arxivID: '',
            authors: [],
        }],
        truncated: false,
        fetchedAt: 5_000,
    });
    assert.equal(requests.length, 2);
    for (const request of requests) {
        assert.equal(
            new URL(request.url).searchParams.get('api_key'),
            'openalex-key'
        );
        assert.deepEqual(request.options.headers, {});
        assert.doesNotMatch(request.url, /Private|W100|W200|2401\.12345/);
        const filter = new URL(request.url).searchParams.get('filter');
        assert.match(filter, /^doi:10\.1000\//);
    }
});

test('batches DOI mappings at one hundred identifiers per request', async () => {
    const mappingFilters = [];
    const papers = Array.from({ length: 205 }, (_, index) => paper(
        index + 1,
        `P${index}`,
        { doi: `10.1000/${index}` }
    ));
    const client = new OpenAlexClient({
        fetch: async url => {
            const parsed = new URL(url);
            if (parsed.searchParams.get('select') === 'id,referenced_works') {
                return jsonResponse({ results: [{
                    id: 'W100',
                    referenced_works: [],
                }] });
            }
            mappingFilters.push(parsed.searchParams.get('filter'));
            return jsonResponse({ results: [] });
        },
    });

    await client.fetchReferences({ doi: '10.1000/0', papers });

    assert.equal(mappingFilters.length, 3);
    assert.ok(mappingFilters.every(filter => filter.split('|').length <= 100));
});

test('returns a negative record when the DOI is absent from OpenAlex', async () => {
    const client = new OpenAlexClient({
        now: () => 6_000,
        fetch: async () => jsonResponse({ results: [] }),
    });

    assert.deepEqual(await client.fetchReferences({
        doi: '10.1000/missing',
        papers: [paper(1, 'A', { doi: '10.1000/missing' })],
    }), {
        status: 'unindexed',
        paperID: '',
        references: [],
        truncated: false,
        fetchedAt: 6_000,
    });
});

test('skips an OpenAlex work mapped from multiple unique local DOIs', async () => {
    const client = new OpenAlexClient({
        fetch: async url => {
            const select = new URL(url).searchParams.get('select');
            if (select === 'id,referenced_works') {
                return jsonResponse({ results: [{
                    id: 'W100',
                    referenced_works: ['W200'],
                }] });
            }
            return jsonResponse({ results: [{
                id: 'W200',
                doi: 'https://doi.org/10.1000/b',
            }, {
                id: 'W200',
                doi: 'https://doi.org/10.1000/c',
            }] });
        },
    });

    const result = await client.fetchReferences({
        doi: '10.1000/a',
        papers: [
            paper(1, 'A', { doi: '10.1000/a' }),
            paper(2, 'B', { doi: '10.1000/b' }),
            paper(3, 'C', { doi: '10.1000/c' }),
        ],
    });

    assert.equal(result.status, 'unindexed');
    assert.deepEqual(result.references, []);
});

test('rejects malformed OpenAlex work data and never accepts title lookup input', async () => {
    const client = new OpenAlexClient({
        fetch: async url => {
            const select = new URL(url).searchParams.get('select');
            return select === 'id,referenced_works'
                ? jsonResponse({ results: [{ id: 'W100', referenced_works: 'bad' }] })
                : jsonResponse({ results: [] });
        },
    });

    await assert.rejects(
        () => client.fetchReferences({
            doi: '10.1000/a',
            paper: { title: 'Do not send this title' },
            papers: [paper(1, 'A', { doi: '10.1000/a' })],
        }),
        error => error.code === 'OPENALEX_INVALID_RESPONSE'
    );
});

test('rejects ambiguous focus works and unsolicited DOI mappings', async () => {
    const ambiguousFocus = new OpenAlexClient({
        fetch: async () => jsonResponse({ results: [{
            id: 'W100',
            referenced_works: [],
        }, {
            id: 'W101',
            referenced_works: [],
        }] }),
    });
    await assert.rejects(
        () => ambiguousFocus.fetchReferences({
            doi: '10.1000/a',
            papers: [],
        }),
        error => error.code === 'OPENALEX_INVALID_RESPONSE'
    );

    const unsolicitedMapping = new OpenAlexClient({
        fetch: async url => {
            const select = new URL(url).searchParams.get('select');
            return select === 'id,referenced_works'
                ? jsonResponse({ results: [{
                    id: 'W100',
                    referenced_works: [],
                }] })
                : jsonResponse({ results: [{
                    id: 'W999',
                    doi: 'https://doi.org/10.1000/not-requested',
                }] });
        },
    });
    await assert.rejects(
        () => unsolicitedMapping.fetchReferences({
            doi: '10.1000/a',
            papers: [paper(2, 'B', { doi: '10.1000/b' })],
        }),
        error => error.code === 'OPENALEX_INVALID_RESPONSE'
    );
});

test('honors caller cancellation while OpenAlex batches are active', async () => {
    const controller = new AbortController();
    const client = new OpenAlexClient({
        fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'));
            }, { once: true });
        }),
    });
    const pending = client.fetchReferences({
        doi: '10.1000/a',
        papers: [paper(1, 'A', { doi: '10.1000/a' })],
        signal: controller.signal,
    });

    controller.abort();

    await assert.rejects(pending, error => error.name === 'AbortError');
});

test('searches bounded OpenAlex metadata and normalizes candidate identifiers', async () => {
    let request;
    const client = new OpenAlexClient({
        now: () => 7_000,
        fetch: async (url, options) => {
            request = { url: String(url), options };
            return jsonResponse({
                results: [{
                    id: 'https://openalex.org/W123',
                    title: '  A  searchable title  ',
                    publication_year: 2024,
                    doi: 'https://doi.org/10.1000/SEARCH',
                    ids: {
                        arxiv: 'https://arxiv.org/abs/2401.12345',
                        pmid: 'https://pubmed.ncbi.nlm.nih.gov/123456/',
                    },
                    authorships: [{ author: { display_name: 'Jane Doe' } }],
                    best_oa_location: {
                        pdf_url: 'https://repository.example/paper.pdf#page=1',
                    },
                }],
            });
        },
    });

    const result = await client.searchReferences({
        text: 'Jane Doe. A searchable title. Journal. 2024.',
        year: 2024,
        authorSearchText: 'jane doe',
        apiKey: ' openalex-key ',
    });

    const parsed = new URL(request.url);
    assert.equal(parsed.searchParams.get('search'),
        'Jane Doe. A searchable title. Journal. 2024.');
    assert.equal(parsed.searchParams.get('filter'), 'publication_year:2024');
    assert.equal(parsed.searchParams.get('per-page'), null);
    assert.equal(parsed.searchParams.get('per_page'), '10');
    assert.equal(parsed.searchParams.get('api_key'), 'openalex-key');
    assert.deepEqual(result, {
        status: 'found',
        candidates: [{
            source: 'openalex',
            paperID: 'W123',
            title: 'A searchable title',
            year: 2024,
            authors: ['Jane Doe'],
            matchConfidence: 'exact',
            identifiers: {
                doi: '10.1000/search',
                arxivID: '2401.12345',
                pmid: '123456',
                pdfURL: 'https://repository.example/paper.pdf',
            },
        }],
        searchedAt: 7_000,
    });
    assert.deepEqual(request.options.headers, {});
});

test('retries a full citation without the year filter for an adjacent-year match', async () => {
    const requests = [];
    const citation = 'Shilaih, M.; Goodale, B.M.; Falco, L.; Kübler, F.; '
        + 'De Clerck, V.; Leeners, B. Modern fertility awareness methods: '
        + 'Wrist wearables capture the changes of temperature associated with '
        + 'the menstrual cycle. Biosci. Rep. 2018, 38, BSR20171279. [CrossRef]';
    const title = 'Modern fertility awareness methods: Wrist wearables capture '
        + 'the changes of temperature associated with the menstrual cycle';
    const client = new OpenAlexClient({
        fetch: async url => {
            const parsed = new URL(url);
            requests.push({
                search: parsed.searchParams.get('search'),
                filter: parsed.searchParams.get('filter'),
            });
            if (parsed.searchParams.has('filter')) {
                return jsonResponse({ results: [] });
            }
            return jsonResponse({
                results: [{
                    id: 'https://openalex.org/W2768584306',
                    title: 'Modern fertility awareness methods: wrist wearables '
                        + 'capture the changes in temperature associated with '
                        + 'the menstrual cycle',
                    publication_year: 2017,
                    doi: 'https://doi.org/10.1042/BSR20171279',
                    ids: {
                        openalex: 'https://openalex.org/W2768584306',
                        pmid: 'https://pubmed.ncbi.nlm.nih.gov/29175999/',
                    },
                    authorships: [{
                        author: { display_name: 'Mohaned Shilaih' },
                    }],
                    best_oa_location: {
                        pdf_url: 'https://portlandpress.com/bsr-2017-1279-t.pdf',
                    },
                }],
            });
        },
    });

    const result = await client.searchReferences({
        text: citation,
        year: 2018,
        authorSearchText: 'shilaih m goodale b m falco l',
    });

    assert.equal(requests.length, 3);
    assert.deepEqual(requests[2], { search: title, filter: null });
    assert.equal(result.status, 'found');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].matchConfidence, 'exact');
    assert.equal(result.candidates[0].identifiers.doi, '10.1042/bsr20171279');
});

test('rejects adjacent-year fallback results without strong author and year evidence', async () => {
    const cases = [{
        publicationYear: 2023,
        author: 'Jane Roe',
    }, {
        publicationYear: 2022,
        author: 'Jane Doe',
    }];
    for (const candidate of cases) {
        const client = new OpenAlexClient({
            fetch: async () => jsonResponse({ results: [{
                id: 'https://openalex.org/W101',
                title: 'A shared paper title',
                publication_year: candidate.publicationYear,
                doi: 'https://doi.org/10.1000/shared',
                authorships: [{
                    author: { display_name: candidate.author },
                }],
            }] }),
        });

        const result = await client.searchReferences({
            text: 'Jane Doe. A shared paper title. Journal. 2024.',
            year: 2024,
            authorSearchText: 'jane doe',
        });

        assert.deepEqual(result.candidates, []);
    }
});

test('keeps only the unique exact match from broad metadata results', async () => {
    const client = new OpenAlexClient({
        fetch: async () => jsonResponse({
            results: [{
                id: 'https://openalex.org/W3954913288',
                title: 'An update on pain management for elderly patients undergoing ambulatory surgery',
                publication_year: 2016,
                doi: 'https://doi.org/10.1097/ACO.0000000000000396',
                authorships: [{ author: { display_name: 'X Cao' } }],
            }, {
                id: 'https://openalex.org/W2558756074',
                title: 'Update on Prevalence of Pain in Patients With Cancer: Systematic Review and Meta-Analysis',
                publication_year: 2016,
                doi: 'https://doi.org/10.1016/j.jpainsymman.2015.12.340',
                authorships: [{ author: { display_name: 'M H van den Beuken-van Everdingen' } }],
            }, {
                id: 'https://openalex.org/W2523640398',
                title: '2016 ESC Guidelines for the management of atrial fibrillation developed in collaboration with EACTS',
                publication_year: 2016,
                doi: 'https://doi.org/10.1093/eurheartj/ehw210',
                authorships: [{ author: { display_name: 'P Kirchhof' } }],
            }],
        }),
    });

    const result = await client.searchReferences({
        text: 'Cao, X.; Elvir-Lazo, O.L.; White, P.F.; Yumul, R.; Tang, J. '
            + 'An update on pain management for elderly patients undergoing '
            + 'ambulatory surgery. Curr. Opin. Anaesthesiol. 2016, 29, '
            + '674-682. [CrossRef] [PubMed]',
        year: 2016,
        authorSearchText: 'cao x elvir lazo o l white p f yumul r tang j',
    });

    assert.equal(result.candidates.length, 1);
    assert.equal(
        result.candidates[0].identifiers.doi,
        '10.1097/aco.0000000000000396'
    );
    assert.equal(result.candidates[0].matchConfidence, 'exact');
});

test('does not mark title matches exact without the same first author and year', async () => {
    const client = new OpenAlexClient({
        fetch: async () => jsonResponse({
            results: [{
                id: 'https://openalex.org/W101',
                title: 'A shared paper title',
                publication_year: 2024,
                doi: 'https://doi.org/10.1000/shared',
                authorships: [{ author: { display_name: 'Jane Roe' } }],
            }],
        }),
    });

    const wrongAuthor = await client.searchReferences({
        text: 'Jane Doe; Jane Roe. A shared paper title. 2024.',
        year: 2024,
        authorSearchText: 'jane doe jane roe',
    });
    const missingYear = await client.searchReferences({
        text: 'Jane Roe. A shared paper title.',
        authorSearchText: 'jane roe',
    });

    assert.equal(wrongAuthor.candidates[0].matchConfidence, 'probable');
    assert.equal(missingYear.candidates[0].matchConfidence, 'probable');
});

test('retries noisy book citations with the title and keeps OpenAlex-only matches', async () => {
    const searches = [];
    const client = new OpenAlexClient({
        now: () => 7_100,
        fetch: async url => {
            const parsed = new URL(url);
            searches.push(parsed.searchParams.get('search'));
            if (searches.length === 1) return jsonResponse({ results: [] });
            return jsonResponse({
                results: [{
                    id: 'https://openalex.org/W1721908487',
                    title: 'Compilers: Principles, Techniques, and Tools (2nd Edition)',
                    publication_year: 2006,
                    type: 'book',
                    ids: { openalex: 'https://openalex.org/W1721908487' },
                    authorships: [{ author: { display_name: 'Alfred V. Aho' } }, {
                        author: { display_name: 'Monica S. Lam' },
                    }, { author: { display_name: 'Ravi Sethi' } }, {
                        author: { display_name: 'Jeffrey D. Ullman' },
                    }],
                    primary_location: {
                        source: { display_name: 'Addison-Wesley' },
                    },
                }],
            });
        },
    });

    const result = await client.searchReferences({
        text: 'Aho, A. V., Lam, M. S., Sethi, R. & Ullman, J. D. '
            + 'Compilers: Principles, Techniques, and Tools 2nd edn '
            + '(Addison-Wesley, 2006).',
        year: 2006,
        authorSearchText: 'aho a',
    });

    assert.deepEqual(searches, [
        'Aho, A. V., Lam, M. S., Sethi, R. & Ullman, J. D. '
            + 'Compilers: Principles, Techniques, and Tools 2nd edn '
            + '(Addison-Wesley, 2006).',
        'Compilers: Principles, Techniques, and Tools',
    ]);
    assert.equal(result.status, 'found');
    assert.deepEqual(result.candidates, [{
        source: 'openalex',
        paperID: 'W1721908487',
        title: 'Compilers: Principles, Techniques, and Tools (2nd Edition)',
        year: 2006,
        authors: [
            'Alfred V. Aho',
            'Monica S. Lam',
            'Ravi Sethi',
            'Jeffrey D. Ullman',
        ],
        matchConfidence: 'probable',
        identifiers: {
            doi: '',
            arxivID: '',
            pmid: '',
            openAlexID: 'W1721908487',
            pdfURL: '',
        },
        metadata: {
            itemType: 'book',
            title: 'Compilers: Principles, Techniques, and Tools (2nd Edition)',
            year: 2006,
            authors: [
                'Alfred V. Aho',
                'Monica S. Lam',
                'Ravi Sethi',
                'Jeffrey D. Ullman',
            ],
            publisher: 'Addison-Wesley',
            url: '',
        },
    }]);
    assert.equal(result.searchedAt, 7_100);
});

test('uses the longest citation segment for title-only fallback queries', async () => {
    const searches = [];
    const client = new OpenAlexClient({
        fetch: async url => {
            const parsed = new URL(url);
            searches.push(parsed.searchParams.get('search'));
            return jsonResponse({
                results: searches.length === 1
                    ? []
                    : [{
                        id: 'W700',
                        title: 'A searchable title',
                        publication_year: 2024,
                        doi: 'https://doi.org/10.1000/title',
                    }],
            });
        },
    });

    const result = await client.searchReferences({
        text: 'Doe, J. A searchable title. Journal. 2024.',
        year: 2024,
    });
    assert.deepEqual(searches, [
        'Doe, J. A searchable title. Journal. 2024.',
        'A searchable title',
    ]);
    assert.equal(result.candidates[0].identifiers.doi, '10.1000/title');
});

test('finds an unquoted conference paper before its venue segment', async () => {
    const searches = [];
    const citation = 'S. Abbaspourazad, O. Elachqar, A. Miller, S. Emrani, '
        + 'U. Nallasamy, and I. Shapiro. Large-scale training of foundation '
        + 'models for wearable biosignals. In The Twelfth International '
        + 'Conference on Learning Representations, 2024.';
    const title = 'Large-scale training of foundation models for wearable '
        + 'biosignals';
    const client = new OpenAlexClient({
        fetch: async url => {
            const parsed = new URL(url);
            searches.push({
                query: parsed.searchParams.get('search'),
                filter: parsed.searchParams.get('filter'),
            });
            return jsonResponse({
                results: searches.length < 3
                    ? []
                    : [{
                        id: 'https://openalex.org/W4389649986',
                        title: 'Large-scale Training of Foundation Models for '
                            + 'Wearable Biosignals',
                        publication_year: 2023,
                        doi: 'https://doi.org/10.48550/arxiv.2312.05409',
                        authorships: [{
                            author: { display_name: 'Salar Abbaspourazad' },
                        }],
                    }],
            });
        },
    });

    const result = await client.searchReferences({
        text: citation,
        year: 2024,
        authorSearchText: 's abbaspourazad o elachqar a miller s emrani '
            + 'u nallasamy and i shapiro',
    });

    assert.deepEqual(searches, [{
        query: citation,
        filter: 'publication_year:2024',
    }, {
        query: title,
        filter: 'publication_year:2024',
    }, {
        query: title,
        filter: null,
    }]);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].matchConfidence, 'exact');
    assert.equal(
        result.candidates[0].identifiers.doi,
        '10.48550/arxiv.2312.05409'
    );
});

test('keeps a paper title beginning with In separate from its journal', async () => {
    const searches = [];
    const title = 'In conference rooms, wearable sensors remain reliable';
    const citation = `Doe, J. ${title}. Journal of Biosignal Research. 2024.`;
    const client = new OpenAlexClient({
        fetch: async url => {
            const parsed = new URL(url);
            searches.push(parsed.searchParams.get('search'));
            return jsonResponse({
                results: searches.length === 1
                    ? []
                    : [{
                        id: 'W701',
                        title,
                        publication_year: 2024,
                        doi: 'https://doi.org/10.1000/in-conference-rooms',
                    }],
            });
        },
    });

    const result = await client.searchReferences({
        text: citation,
        year: 2024,
    });

    assert.deepEqual(searches, [citation, title]);
    assert.equal(
        result.candidates[0].identifiers.doi,
        '10.1000/in-conference-rooms'
    );
});

test('finds the STRAViT IEEE reference from its quoted article title', async () => {
    const searches = [];
    const citation = 'Y. Li, L. Wang, W. Zheng, Y. Zong, L. Qi, Z. Cui, '
        + 'T. Zhang, and T. Song, “A novel bi-hemispheric discrepancy model '
        + 'for eeg emotion recognition,” IEEE Transactions on Cognitive and '
        + 'Developmental Systems, vol. 13, no. 2, pp. 354–367, 2020.';
    const title = 'A novel bi-hemispheric discrepancy model for eeg emotion '
        + 'recognition';
    const client = new OpenAlexClient({
        fetch: async url => {
            const parsed = new URL(url);
            searches.push({
                query: parsed.searchParams.get('search'),
                filter: parsed.searchParams.get('filter'),
            });
            return jsonResponse({
                results: searches.length === 1
                    ? []
                    : [{
                        id: 'https://openalex.org/W3033046106',
                        title: 'A Novel Bi-Hemispheric Discrepancy Model for '
                            + 'EEG Emotion Recognition',
                        publication_year: 2020,
                        doi: 'https://doi.org/10.1109/TCDS.2020.2999337',
                        authorships: [{
                            author: { display_name: 'Yang Li' },
                        }],
                    }],
            });
        },
    });

    const result = await client.searchReferences({
        text: citation,
        year: 2020,
        authorSearchText: 'y li l wang w zheng y zong l qi z cui t zhang '
            + 'and t song',
    });

    assert.deepEqual(searches, [{
        query: citation,
        filter: 'publication_year:2020',
    }, {
        query: title,
        filter: 'publication_year:2020',
    }]);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].matchConfidence, 'exact');
    assert.equal(
        result.candidates[0].identifiers.doi,
        '10.1109/tcds.2020.2999337'
    );
});

test('finds metadata when a citation article title contains a colon', async () => {
    const searches = [];
    const client = new OpenAlexClient({
        fetch: async url => {
            const parsed = new URL(url);
            searches.push(parsed.searchParams.get('search'));
            return jsonResponse({
                results: searches.length === 1
                    ? []
                    : [{
                        id: 'W700',
                        title: 'Knowledge, attitudes, and practices regarding '
                            + 'conception and fertility: a population-based '
                            + 'survey among reproductive-age United States women',
                        publication_year: 2014,
                        doi: 'https://doi.org/10.1016/j.fertnstert.2013.12.006',
                        authorships: [{
                            author: { display_name: 'Lisbet S. Lundsberg' },
                        }],
                    }],
            });
        },
    });
    const title = 'Knowledge, attitudes, and practices regarding conception '
        + 'and fertility: A population-based survey among reproductive-age '
        + 'United States women';
    const citation = 'Lundsberg, L.S.; Pal, L.; Gariepy, A.M.; Xu, X.; '
        + 'Chu, M.C.; Illuzzi, J.L. '
        + `${title}. Fertil. Steril. 2014, 101, 767–774. [CrossRef]`;

    const result = await client.searchReferences({
        text: citation,
        year: 2014,
        authorSearchText: 'lundsberg l s pal l gariepy a m xu x chu m c '
            + 'illuzzi j l',
    });

    assert.deepEqual(searches, [citation, title]);
    assert.equal(result.status, 'found');
    assert.equal(
        result.candidates[0].identifiers.doi,
        '10.1016/j.fertnstert.2013.12.006'
    );
    assert.equal(result.candidates[0].matchConfidence, 'exact');
});

test('keeps at most three plausible metadata candidates', async () => {
    const client = new OpenAlexClient({
        fetch: async () => jsonResponse({
            results: [
                { id: 'W1', title: 'No identifier' },
                ...Array.from({ length: 12 }, (_, index) => ({
                    id: `W${index + 2}`,
                    title: index === 0
                        ? '<script>alert(1)</script>'
                        : `Candidate ${index}`,
                    publication_year: 2023,
                    doi: `https://doi.org/10.1000/${index}`,
                })),
                { id: 'bad', title: 'Missing DOI', doi: 'not-a-doi' },
            ],
        }),
    });

    const result = await client.searchReferences({ text: 'candidate' });
    assert.equal(result.status, 'found');
    assert.equal(result.candidates.length, 3);
    assert.deepEqual(result.candidates.map(candidate => candidate.paperID),
        ['W3', 'W4', 'W5']);
    assert.equal(result.candidates[0].title, 'Candidate 1');
    assert.equal(result.candidates[0].matchConfidence, 'probable');
});

test('honors cancellation during an explicit OpenAlex metadata search', async () => {
    const controller = new AbortController();
    const client = new OpenAlexClient({
        fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(
                new DOMException('Aborted', 'AbortError')
            ), { once: true });
        }),
    });
    const pending = client.searchReferences({
        text: 'cancel me',
        signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
});

test('does not accept arbitrary URL suffixes as PMID identifiers', async () => {
    const client = new OpenAlexClient({
        fetch: async () => jsonResponse({
            results: [{
                id: 'W700',
                title: 'Untrusted PMID',
                ids: { pmid: 'https://evil.example/700' },
            }],
        }),
    });
    const result = await client.searchReferences({ text: 'untrusted PMID' });
    assert.deepEqual(result.candidates, []);
});

function paper(itemID, key, values = {}) {
    return {
        id: `1:${key}`,
        itemID,
        key,
        libraryID: 1,
        title: key,
        year: 2024,
        doi: '',
        arxivID: '',
        attachmentIDs: [],
        ...values,
    };
}

function jsonResponse(value, status = 200, headers = {}) {
    return new Response(JSON.stringify(value), { status, headers });
}
