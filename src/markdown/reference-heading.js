// Reference-list headings, shared by every consumer that has to tell a
// bibliography apart from body text: the citation parser, the translation
// block collector, the MinerU document IR, and the EPUB exporter.
//
// The vocabulary lives here so a new spelling is added once. The four call
// sites receive a heading in different shapes and accept different spellings,
// so each keeps its own exported pattern, composed from the shared atoms
// below. Widening one site's pattern is a deliberate edit there, not a side
// effect of editing the vocabulary.
//
// Wording that starts with a reference label but continues, such as
// "References and Further Reading", names a different section and never
// matches.

// `%s` is the separator between two words of a label: a single space, a run of
// spaces and tabs, or any whitespace, depending on what the call site sees.
const ATOMS = {
    references: 'references?',
    referencesAndNotes: 'references?(?:%sand%snotes)?',
    referenceList: 'reference%slist',
    bibliography: 'bibliography',
    worksCited: 'works%scited',
    literatureCited: 'literature%scited',
    // The Chinese spellings have no separator between their characters.
    zhReferences: '参考文献',
    zhSources: '参考资料',
    zhBibliography: '参考书目',
    zhCitedWorks: '引用文献',
};

function labels(atoms, separator) {
    return atoms
        .map(name => ATOMS[name].replaceAll('%s', separator))
        .join('|');
}

// A section number ("6", "6.1", "6.") or a Roman numeral ("VI", "VI.")
// before the label. Each call site accepts a different subset: the citation
// and translation patterns take a digit run or a Roman numeral, while the
// MinerU IR takes one merged class that also accepts a bare digit.
const NUMBERED_PREFIX = '(?:\\d+(?:\\.\\d+)*)[.)]?';
const ROMAN_PREFIX = '[IVX]+\\.?';
const MINERU_NUMBER_PREFIX = '[0-9IVX]+\\.?';

function prefix(parts, separator) {
    if (!parts.length) return '';
    return `(?:${parts.map(part => part + separator).join('|')})`;
}

// A bare label, for a caller that has already stripped the heading marker and
// emphasis. A trailing period or colon is punctuation, not a new word.
export const REFERENCE_HEADING_LABEL_PATTERN = new RegExp(
    '^'
    + `${prefix([NUMBERED_PREFIX, ROMAN_PREFIX], '[ \\t]+')}?`
    + '(?:'
    + labels([
        'referencesAndNotes',
        'referenceList',
        'bibliography',
        'worksCited',
        'literatureCited',
        'zhReferences',
        'zhSources',
        'zhBibliography',
        'zhCitedWorks',
    ], '[ \\t]+')
    + ')[.:：]?$',
    'iu'
);

// A whole Markdown heading line: `## References`, `## **References**`, or
// `References` over a Setext underline. Capture 1 is the ATX `#` run, so a
// caller can read the heading level; it is undefined for a Setext heading.
export const REFERENCE_HEADING_LINE_PATTERN = new RegExp(
    '^(?:(#{1,6})[ \\t]+)?(?:\\*{1,2}|_{1,2})?'
    + `${prefix([NUMBERED_PREFIX], '[ \\t]+')}?`
    + '(?:'
    + labels([
        'references',
        'bibliography',
        'worksCited',
        'literatureCited',
        'zhReferences',
        'zhSources',
        'zhBibliography',
    ], '[ \\t]+')
    + ')'
    + '(?:\\*{1,2}|_{1,2})?[ \\t]*[:：]?[ \\t]*#*[ \\t]*$',
    'gim'
);

// Plain text with no heading marker and no emphasis, as the MinerU document IR
// sees it. The IR is matched against a heading's plain text and has always
// used the narrower vocabulary: no 参考资料, 参考书目 or 引用文献.
export const MINERU_REFERENCE_HEADING_PATTERN = new RegExp(
    '^'
    + `${prefix([MINERU_NUMBER_PREFIX], '\\s+')}?`
    + '(?:'
    + labels([
        'references',
        'bibliography',
        'literatureCited',
        'worksCited',
        'referenceList',
        'zhReferences',
    ], ' ')
    + ')$',
    'iu'
);

// The EPUB exporter matches a heading whose inline Markdown is already
// stripped. It accepts 引用文献 but neither 参考资料 nor 参考书目, and takes
// any whitespace between the words of an English label.
export const EPUB_REFERENCE_HEADING_PATTERN = new RegExp(
    '^(?:'
    + labels([
        'references',
        'bibliography',
        'worksCited',
        'literatureCited',
        'zhReferences',
        'zhCitedWorks',
    ], '\\s+')
    + ')$',
    'iu'
);
