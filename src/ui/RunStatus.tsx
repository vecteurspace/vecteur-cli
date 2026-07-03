import { Box, Text } from "ink";
import Spinner from "ink-spinner";

const MAX_VISIBLE = 8;

export function RunStatus({ stages }: { stages: string[] }): JSX.Element {
  const hidden = Math.max(0, stages.length - MAX_VISIBLE);
  const shown = stages.slice(-MAX_VISIBLE);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>▸ oracle agent working…</Text>
      {hidden > 0 ? <Text dimColor>{`  ✓ ${hidden} earlier step${hidden > 1 ? "s" : ""}`}</Text> : null}
      {shown.map((stage, index) => {
        const active = index === shown.length - 1;
        return (
          <Text key={`${stage}-${index}`} dimColor={!active}>
            {active ? (
              <>
                <Spinner type="dots" /> {stage}
              </>
            ) : (
              <>✓ {stage}</>
            )}
          </Text>
        );
      })}
    </Box>
  );
}
