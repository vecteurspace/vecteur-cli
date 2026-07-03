import { Box, Text } from "ink";
import { VERSION } from "../version.js";

// The Vecteur mark is a downward triangle (the "V"), matching the web wordmark
// (`M16 26 L4 4 H28 Z`). Rendered in the brand blue next to the wordmark.
const TRIANGLE = ["╲         ╱", " ╲       ╱ ", "  ╲     ╱  ", "   ╲   ╱   ", "    ╲ ╱    ", "     ╲╱    "];
const BRAND_BLUE = "#4a9eff";

/** ASCII welcome banner shown on the first screen of an interactive session. */
export function Logo(): JSX.Element {
  return (
    <Box marginBottom={1}>
      <Box flexDirection="column">
        {TRIANGLE.map((line, i) => (
          <Text key={i} color={BRAND_BLUE} bold>
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginLeft={2} justifyContent="center">
        <Text bold color="white">
          V E C T E U R
        </Text>
        <Text dimColor>space-engineering agent · v{VERSION}</Text>
      </Box>
    </Box>
  );
}
