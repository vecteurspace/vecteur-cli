import { Box, Text } from "ink";
import Spinner from "ink-spinner";

export function RunStatus({ stages }: { stages: string[] }): JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>▸ thinking…</Text>
      {stages.map((stage, index) => {
        const active = index === stages.length - 1;
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
