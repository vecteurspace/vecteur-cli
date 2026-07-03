const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

/** Server answers sometimes carry web-UI HTML entities — render the literal characters. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&"); // last, so we don't double-decode
}

/**
 * Answers can include web-UI HTML — notably `<details><summary>…</summary>…</details>`
 * collapsible blocks (subagent synthesis). A terminal can't collapse, so render the summary
 * as a dim section header and keep the body; drop the wrapper and any other stray tags.
 */
function stripHtml(s: string): string {
  return s
    .replace(/<summary[^>]*>([\s\S]*?)<\/summary>/gi, (_m, inner) => `${DIM}▸ ${inner.replace(/<[^>]+>/g, "").trim()}${RESET}`)
    .replace(/<\/?details[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "");
}

export function markdownToAnsi(md: string): string {
  return decodeEntities(stripHtml(md))
    .split(/\r?\n/)
    .filter((line) => !/^\s*---\s*$/.test(line))
    .map((line) => {
      const heading = line.match(/^\s*#{1,6}\s+(.+)$/);
      const normalized = heading ? `${BOLD}${heading[1]}${RESET}` : line.replace(/^(\s*)[-*]\s+/, "$1• ");
      return normalized
        .replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${RESET}`)
        .replace(/`([^`]+)`/g, `${DIM}${CYAN}$1${RESET}`);
    })
    .join("\n");
}
