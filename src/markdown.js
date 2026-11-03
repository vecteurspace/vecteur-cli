// GENERATED from frontend/src/run/markdown.ts; no runtime frontend dependency.
export function inlinePlain(inline) {
    return inline.map((token) => token.text).join('');
}
export function tableGrid(block) {
    const header = block.header.map(inlinePlain);
    const rows = block.rows.map((row) => row.map(inlinePlain));
    return header.length ? [header, ...rows] : rows;
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
export function withholdOpenTokens(text) {
    const scrubbed = text.replace(/\\[*`$]/g, '  ');
    const cuts = [];
    const backticks = [...scrubbed.matchAll(/`/g)];
    if (backticks.length % 2 === 1)
        cuts.push(backticks[backticks.length - 1].index ?? 0);
    const bolds = [...scrubbed.matchAll(/\*\*/g)];
    if (bolds.length % 2 === 1)
        cuts.push(bolds[bolds.length - 1].index ?? 0);
    const openReference = /\$[A-Za-z_][A-Za-z0-9_.]*$/.exec(scrubbed);
    if (openReference)
        cuts.push(openReference.index);
    const openLink = /\[[^\]\n]*\]\([^)\s]*$/.exec(scrubbed);
    if (openLink)
        cuts.push(openLink.index);
    const tablePrefix = trailingTableDelimiterPrefix(text);
    if (tablePrefix !== null)
        cuts.push(tablePrefix);
    if (!cuts.length)
        return text;
    return text.slice(0, Math.min(...cuts));
}
function trailingTableDelimiterPrefix(text) {
    const lines = text.split('\n');
    if (lines.length < 2)
        return null;
    const candidate = lines[lines.length - 1];
    const header = lines[lines.length - 2];
    if (!TABLE_ROW.test(candidate) || !TABLE_ROW.test(header))
        return null;
    if (lines.slice(0, -1).filter((line) => line.startsWith('```')).length % 2 === 1)
        return null;
    if (lines.length > 2 && TABLE_ROW.test(lines[lines.length - 3]))
        return null;
    const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
    const delimiter = cells(candidate);
    const headerCells = cells(header);
    if (delimiter.length >= headerCells.length)
        return null;
    if (!delimiter.every((cell) => /^:?-+:?$/.test(cell)))
        return null;
    return text.lastIndexOf('\n') + 1;
}
export function splitStream(source) {
    const lines = source.split('\n');
    let fenceOpen = -1;
    let offset = 0;
    for (const line of lines) {
        if (line.startsWith('```'))
            fenceOpen = fenceOpen === -1 ? offset : -1;
        offset += line.length + 1;
    }
    if (fenceOpen !== -1) {
        return { frozen: source.slice(0, fenceOpen), tail: source.slice(fenceOpen) };
    }
    const boundary = source.lastIndexOf('\n\n');
    if (boundary === -1)
        return { frozen: '', tail: source };
    return { frozen: source.slice(0, boundary + 2), tail: source.slice(boundary + 2) };
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
            const items = [];
            while (index < lines.length) {
                const item = pattern.exec(lines[index]);
                if (!item)
                    break;
                items.push(parseInline(item[1]));
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
