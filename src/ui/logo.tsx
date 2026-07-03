import { Box, Text, useStdout } from "ink";
import { VERSION } from "../version.js";

const BRAND_BLUE = "#4a9eff";

// "VECTEUR" in an ANSI-shadow block font — the brand wordmark for a wide terminal.
const WORDMARK = [
  "██╗   ██╗███████╗ ██████╗████████╗███████╗██╗   ██╗██████╗",
  "██║   ██║██╔════╝██╔════╝╚══██╔══╝██╔════╝██║   ██║██╔══██╗",
  "██║   ██║█████╗  ██║        ██║   █████╗  ██║   ██║██████╔╝",
  "╚██╗ ██╔╝██╔══╝  ██║        ██║   ██╔══╝  ██║   ██║██╔══██╗",
  " ╚████╔╝ ███████╗╚██████╗   ██║   ███████╗╚██████╔╝██║  ██║",
  "  ╚═══╝  ╚══════╝ ╚═════╝   ╚═╝   ╚══════╝ ╚═════╝ ╚═╝  ╚═╝",
];
const WORDMARK_WIDTH = 58;

/** Brand banner for the interactive welcome. Full wordmark when it fits; a compact mark otherwise. */
export function Logo(): JSX.Element {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;

  if (cols >= WORDMARK_WIDTH + 6) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        {WORDMARK.map((line, i) => (
          <Text key={i} color={BRAND_BLUE}>
            {line}
          </Text>
        ))}
        <Text dimColor>{`  space-engineering agent · v${VERSION}`}</Text>
      </Box>
    );
  }

  // Compact mark for narrow (but ink-capable) terminals — a downward-triangle "V" + wordmark.
  return (
    <Box marginBottom={1}>
      <Text color={BRAND_BLUE} bold>
        {"▽ "}
      </Text>
      <Text bold color="white">
        VECTEUR
      </Text>
      <Text dimColor>{`   space-engineering agent · v${VERSION}`}</Text>
    </Box>
  );
}
