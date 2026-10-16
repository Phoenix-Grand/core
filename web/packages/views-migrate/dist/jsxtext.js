/**
 * JSX text the way React sees it (Babel's / TypeScript's `cleanJSXElementLiteralChild`): lines are trimmed, lines
 * made only of whitespace are dropped, the remaining lines are joined with one space, and tabs become spaces.
 * A converted view must show the very same text, so the codemod applies the same rule before writing `Text`.
 */
export function cleanJsxText(raw) {
    const lines = raw.split(/\r\n|\n|\r/);
    let lastNonEmpty = 0;
    for (let i = 0; i < lines.length; i++)
        if (/[^ \t]/.test(lines[i]))
            lastNonEmpty = i;
    let out = '';
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isFirst = i === 0;
        const isLast = i === lines.length - 1;
        const isLastNonEmpty = i === lastNonEmpty;
        let trimmed = line.replace(/\t/g, ' ');
        if (!isFirst)
            trimmed = trimmed.replace(/^[ ]+/, '');
        if (!isLast)
            trimmed = trimmed.replace(/[ ]+$/, '');
        if (trimmed) {
            if (!isLastNonEmpty)
                trimmed += ' ';
            out += trimmed;
        }
    }
    return out;
}
/** Decodes the HTML entities JSX text and attribute strings may hold (`&nbsp;`, `&amp;`, `&#x2019;`…). */
export function decodeEntities(s) {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '\u2014', ndash: '–', middot: '·', rsquo: '’', lsquo: '‘', laquo: '«', raquo: '»', copy: '©' };
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
        if (e[0] === '#') {
            const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : m;
        }
        return named[e] ?? m;
    });
}
/** An XML attribute value (double-quoted): `&`, `<`, `"` escaped, line breaks and tabs as character references. */
export function xmlAttr(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/\n/g, '&#10;')
        .replace(/\r/g, '&#13;')
        .replace(/\t/g, '&#9;');
}
/**
 * Whether a literal can be written as an attribute value as it is: the `.kbview` grammar reads `{…}` as a markup
 * extension and has no escape, so such a literal goes through a getter instead.
 */
export function isSafeLiteral(s) {
    const t = s.trim();
    return !(t.startsWith('{') && t.endsWith('}'));
}
