const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

export function markdownToAnsi(md: string): string {
  return md
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
