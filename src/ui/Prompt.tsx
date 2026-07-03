import { Box, Text } from "ink";
import TextInput from "ink-text-input";

const PLACEHOLDER = "Ask anything — /help for commands, @file to attach";

export function Prompt({
  value,
  disabled,
  onChange,
  onSubmit,
}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}): JSX.Element {
  return (
    <Box borderStyle="round" paddingX={1} width="100%">
      <Text color="cyan">› </Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder={PLACEHOLDER}
        focus={!disabled}
        showCursor={!disabled}
      />
    </Box>
  );
}
