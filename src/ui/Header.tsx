import { basename } from "node:path";
import { Box, Text } from "ink";

export function Header({ cwd, project }: { cwd: string; project: string }): JSX.Element {
  const shortProject = project.length > 10 ? `${project.slice(0, 8)}…` : project;
  return (
    <Box flexDirection="column" width="100%">
      <Box justifyContent="space-between" width="100%">
        <Text>
          <Text bold>Vecteur</Text>
          <Text dimColor> · space-engineering agent</Text>
        </Text>
        <Text dimColor>
          {basename(cwd) || cwd} · {shortProject}
        </Text>
      </Box>
      <Text dimColor>workspace: {cwd}</Text>
    </Box>
  );
}
