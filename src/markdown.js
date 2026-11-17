// GENERATED from frontend/src/run/markdown.ts; no runtime frontend dependency.
export const studyPath = (value) => value.replace(/(?<![\w.-])(?:\/work)?\/study\//g, '');
export const readerPaths = (source) => studyPath(source.replace(/`(?:\/work)?\/study\/?`|(?<![\w/.-])(?:\/work)?\/study\/?(?=[\s:;,.!?)]|$)/g, 'the study folder'));
const LISTED_FILE = /^\s*[-*]\s+`?[\w./-]+\.\w{1,5}`?\s*$/;
const LIST_LEAD = /^(?:\*\*)?(?:all\s+|the\s+)?(?:files?|deliverables?|outputs?|everything)\b[^\n]*:\s*(?:\*\*)?$/i;
export function withoutClosingFileList(source) {
    const lines = source.split('\n');
    const out = [];
    for (let at = 0; at < lines.length; at += 1) {
        if (LIST_LEAD.test(readerPaths(lines[at]).trim())) {
            let end = at + 1;
            while (end < lines.length && lines[end].trim() === '')
                end += 1;
            let last = end;
            while (last < lines.length && LISTED_FILE.test(lines[last]))
                last += 1;
            if (last > end && (last === lines.length || !/^\s*[-*]\s/.test(lines[last]))) {
                at = last - 1;
                while (out.length && out.at(-1).trim() === '')
                    out.pop();
                continue;
            }
        }
        out.push(lines[at]);
    }
    return out.join('\n').trimEnd();
}
export function closeOpenMarks(source) {
    if (source.split('\n').filter((line) => /^\s*```/.test(line)).length % 2)
        return `${source}\n${'```'}`;
    const text = /^\s*```/.test(source.split('\n').at(-1) ?? '') ? source : source.replace(/(?:\*\*|`)+$/, '');
    const plain = text.replace(/```[\s\S]*?```/g, '');
    const code = (plain.match(/`/g) ?? []).length % 2 === 1;
    const bold = (plain.replace(/`[^`]*`?/g, '').match(/\*\*/g) ?? []).length % 2 === 1;
    return `${text}${code ? '`' : ''}${bold && !code ? '**' : ''}`;
}
const FIGURE_UNIT = /\b(\d+(?:[.,]\d+)?) (?=(?:%|‰|°[CFK]?|[A-Za-zµΩ][A-Za-zµΩ²³]{0,3}(?:[/·.][A-Za-zµΩ²³]{1,3})?)(?:$|[\s,;:.)\]]))/g;
export const keepUnits = (text) => text.replace(FIGURE_UNIT, '$1\u00a0');
export function inlinePlain(inline) {
    return inline.map((token) => token.text).join('');
}
const INLINE_PATTERN = /(!\[[^\]]*\]\([^)\s]+\)|`[^`]+`|\[[^\]\n]+\]\([^)\s]+\)|\*\*[^*]+\*\*|\*[^*]+\*|\$[A-Za-z_][A-Za-z0-9_.]*\$)/g;
const LINK_TOKEN = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/;
const IMAGE_TOKEN = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;
const ESCAPE_SPLIT = /\\([*`$])/g;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const QUOTE_ROW = /^>\s?/;
const BULLET_ROW = /^\s*[-*]\s+(.*)$/;
const NUMBERED_ROW = /^\s*\d+[.)]\s+(.*)$/;
const HR_ROW = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
function startsBlock(line) {
    return line.startsWith('```') || /^(#{1,4})\s/.test(line)
        || QUOTE_ROW.test(line) || TABLE_ROW.test(line)
        || BULLET_ROW.test(line) || NUMBERED_ROW.test(line)
        || HR_ROW.test(line);
}
function escapeSegments(text) {
    const segments = [];
    let last = 0;
    for (const match of text.matchAll(ESCAPE_SPLIT)) {
        const index = match.index ?? 0;
        if (index > last)
            segments.push({ literal: false, text: text.slice(last, index) });
        segments.push({ literal: true, text: match[1] });
        last = index + match[0].length;
    }
    if (last < text.length)
        segments.push({ literal: false, text: text.slice(last) });
    return segments;
}
function pushText(out, text) {
    if (!text)
        return;
    const tail = out[out.length - 1];
    if (tail && tail.kind === 'text')
        tail.text += text;
    else
        out.push({ kind: 'text', text });
}
export function parseInline(text) {
    const out = [];
    for (const segment of escapeSegments(text)) {
        if (segment.literal) {
            pushText(out, segment.text);
            continue;
        }
        let last = 0;
        for (const match of segment.text.matchAll(INLINE_PATTERN)) {
            const index = match.index ?? 0;
            if (index > last)
                pushText(out, segment.text.slice(last, index));
            const token = match[0];
            const image = token.startsWith('![') ? IMAGE_TOKEN.exec(token) : null;
            const link = !image && token.startsWith('[') ? LINK_TOKEN.exec(token) : null;
            if (token.startsWith('`'))
                out.push({ kind: 'code', text: token.slice(1, -1) });
            else if (image)
                out.push({ kind: 'image', text: image[1], href: image[2] });
            else if (link)
                out.push({ kind: 'link', text: link[1], href: link[2] });
            else if (token.startsWith('**'))
                out.push({ kind: 'strong', text: token.slice(2, -2) });
            else if (token.startsWith('$'))
                out.push({ kind: 'code', text: token.slice(1, -1) });
            else
                out.push({ kind: 'em', text: token.slice(1, -1) });
            last = index + token.length;
        }
        if (last < segment.text.length)
            pushText(out, segment.text.slice(last));
    }
    return out;
}
export function parseMarkdown(source) {
    const blocks = [];
    const lines = source.split('\n');
    let index = 0;
    while (index < lines.length) {
        const line = lines[index];
        if (line.trim() === '') {
            index += 1;
            continue;
        }
        if (line.startsWith('```')) {
            const language = line.slice(3).trim();
            const body = [];
            index += 1;
            while (index < lines.length && !lines[index].startsWith('```')) {
                body.push(lines[index]);
                index += 1;
            }
            index += 1;
            blocks.push({ kind: 'codeblock', text: body.join('\n'), language });
            continue;
        }
        const heading = /^(#{1,4})\s+(.*)$/.exec(line);
        if (heading) {
            blocks.push({ kind: 'heading', level: heading[1].length, inline: parseInline(heading[2]) });
            index += 1;
            continue;
        }
        if (HR_ROW.test(line)) {
            blocks.push({ kind: 'hr' });
            index += 1;
            continue;
        }
        if (QUOTE_ROW.test(line)) {
            const body = [];
            while (index < lines.length && QUOTE_ROW.test(lines[index])) {
                body.push(lines[index].replace(QUOTE_ROW, ''));
                index += 1;
            }
            blocks.push({ kind: 'quote', inline: parseInline(body.join(' ').trim()) });
            continue;
        }
        if (TABLE_ROW.test(line)) {
            const rows = [];
            while (index < lines.length && TABLE_ROW.test(lines[index])) {
                rows.push(lines[index].trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()));
                index += 1;
            }
            const isRule = (cells) => cells.every((cell) => /^:?-+:?$/.test(cell));
            const header = rows.length > 1 && rows[0].length === rows[1].length && isRule(rows[1])
                ? rows[0]
                : null;
            const body = header ? rows.slice(2) : rows;
            blocks.push({
                kind: 'table',
                header: (header ?? []).map(parseInline),
                rows: body.map((cells) => cells.map(parseInline)),
            });
            continue;
        }
        if (BULLET_ROW.test(line) || NUMBERED_ROW.test(line)) {
            const ordered = NUMBERED_ROW.test(line);
            const pattern = ordered ? NUMBERED_ROW : BULLET_ROW;
            const base = /^\s*/.exec(line)[0].length;
            const items = [];
            while (index < lines.length) {
                const indent = /^\s*/.exec(lines[index])[0].length;
                const nested = indent >= base + 2 && items.length > 0;
                const item = (nested ? BULLET_ROW.exec(lines[index]) ?? NUMBERED_ROW.exec(lines[index]) : pattern.exec(lines[index]));
                if (!item || (!nested && indent > base + 1))
                    break;
                items.push({ inline: parseInline(item[1]), depth: nested ? 1 : 0, ordered: nested ? NUMBERED_ROW.test(lines[index]) : ordered });
                index += 1;
            }
            blocks.push({ kind: 'list', ordered, items });
            continue;
        }
        const paragraph = [line];
        index += 1;
        while (index < lines.length && lines[index].trim() !== ''
            && !startsBlock(lines[index])) {
            paragraph.push(lines[index]);
            index += 1;
        }
        blocks.push({ kind: 'paragraph', inline: parseInline(paragraph.join('\n')) });
    }
    return blocks;
}
