import { useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import { buildLocalContextQuery, openBrowser, streamTurn, webBase } from "../runner.js";
import { handleSlashCommand, parseMentions, SLASH_COMMANDS } from "../session.js";
import { markdownToAnsi } from "./markdown.js";
import { Header } from "./Header.js";
import { Logo } from "./logo.js";
import { Prompt } from "./Prompt.js";
import { RunStatus } from "./RunStatus.js";

interface TranscriptItem {
  id: number;
  user: string;
  answer: string;
  sawVisual?: boolean;
  tone?: "normal" | "error" | "warning";
}

export interface AppProps {
  project: string;
  cwd: string;
  created: boolean;
  userLabel: string;
}

function highlightMentions(line: string): JSX.Element {
  const parts = line.split(/(@\S+)/g);
  return (
    <Text>
      <Text color="cyan">› </Text>
      {parts.map((part, index) =>
        part.startsWith("@") ? (
          <Text key={index} color="green">
            {part}
          </Text>
        ) : (
          <Text key={index}>{part}</Text>
        ),
      )}
    </Text>
  );
}

function TranscriptTurn({ item, project }: { item: TranscriptItem; project: string }): JSX.Element {
  const color = item.tone === "error" ? "red" : item.tone === "warning" ? "yellow" : undefined;
  return (
    <Box flexDirection="column" marginTop={1}>
      {highlightMentions(item.user)}
      <Text color={color}>{markdownToAnsi(item.answer)}</Text>
      {item.sawVisual ? (
        <Text dimColor>↳ visual artifacts — open in the web app: {webBase()}/projects/{project}</Text>
      ) : null}
    </Box>
  );
}

/** Commands whose name starts with the typed `/prefix` (empty when not in slash mode). */
function slashMatches(value: string): typeof SLASH_COMMANDS {
  if (!value.startsWith("/")) return [] as unknown as typeof SLASH_COMMANDS;
  const prefix = value.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(prefix));
}

function SlashMenu({ value, selected }: { value: string; selected: number }): JSX.Element | null {
  const matches = slashMatches(value);
  if (matches.length === 0) return null;
  const sel = Math.min(selected, matches.length - 1);
  return (
    <Box flexDirection="column" marginLeft={2}>
      {matches.map((cmd, i) => (
        <Text key={cmd.name}>
          <Text color="cyan" bold={i === sel}>{i === sel ? "❯ " : "  "}/{cmd.name}</Text>
          <Text dimColor>  {cmd.desc}</Text>
        </Text>
      ))}
    </Box>
  );
}

export function App({ project, cwd, created }: AppProps): JSX.Element {
  const { exit } = useApp();
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | undefined>(undefined);
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [stages, setStages] = useState<string[]>([]);
  const [turns, setTurns] = useState(0);
  const [lastTaskId, setLastTaskId] = useState<string | undefined>(undefined);
  const [tokenTotal, setTokenTotal] = useState(0);
  const [selected, setSelected] = useState(0); // highlighted row in the slash-command menu
  const [notice, setNotice] = useState<string | undefined>(created ? `workspace bound to ${project}` : undefined);

  const pushItem = (item: Omit<TranscriptItem, "id">) => {
    setItems((prev) => [...prev, { id: prev.length + 1, ...item }]);
  };

  // Reset the slash-menu highlight whenever the input text changes.
  const onInputChange = (value: string) => {
    setInput(value);
    setSelected(0);
  };

  const submit = async (submitted: string) => {
    const raw = submitted.trim();
    if (!raw || streaming) return;
    setInput("");
    setHistory((prev) => [...prev, raw]);
    setHistoryIndex(undefined);
    setNotice(undefined);

    if (raw.startsWith("/")) {
      // Enter runs the HIGHLIGHTED action even when only a prefix was typed (no Tab needed):
      // exact command → itself; otherwise the currently-selected match.
      const token = raw.slice(1).split(/\s+/)[0] ?? "";
      const isExact = SLASH_COMMANDS.some((c) => c.name === token);
      const matches = slashMatches(raw);
      const name = isExact ? token : matches.length ? matches[Math.min(selected, matches.length - 1)].name : token;
      const result = await handleSlashCommand(`/${name}`, { project, cwd });
      if (result.clear) setItems([]);
      if (result.reset) {
        setTurns(0);
        setLastTaskId(undefined);
      }
      if (result.open) void openBrowser(result.open);
      if (result.output) pushItem({ user: raw, answer: result.output });
      if (result.exit) exit();
      return;
    }

    const { text, files } = parseMentions(raw);
    let query: string;
    try {
      query = buildLocalContextQuery(text, files.length ? files : undefined);
    } catch (e) {
      pushItem({ user: raw, answer: `✗ ${(e as Error).message}`, tone: "error" });
      return;
    }

    setStreaming(true);
    setStages([]);
    try {
      const result = await streamTurn({
        project,
        query,
        followUp: turns > 0,
        contextTaskId: lastTaskId,
        onStep: (label) => {
          setStages((prev) => (prev[prev.length - 1] === label ? prev : [...prev, label]));
        },
      });
      if (result.quotaExceeded) {
        pushItem({ user: raw, answer: result.failed ?? "Quota exceeded.", tone: "warning" });
      } else if (result.failed) {
        pushItem({ user: raw, answer: `✗ ${result.failed}`, tone: "error" });
      } else {
        pushItem({ user: raw, answer: result.answer ?? "(no answer)", sawVisual: result.sawVisual });
        setLastTaskId(result.taskId);
        setTurns((prev) => prev + 1);
        setTokenTotal((prev) => prev + (result.tokens?.total ?? 0));
      }
    } finally {
      setStreaming(false);
      setStages([]);
    }
  };

  useInput((value, key) => {
    if ((key.ctrl && (value === "c" || value === "d")) || value === "\u0003" || value === "\u0004") {
      if (streaming) {
        setNotice("finishing current turn...");
        return;
      }
      exit();
      return;
    }
    if (streaming) return;
    // Slash-menu navigation takes over the arrows/Tab while typing a `/command`.
    const matches = slashMatches(input);
    if (matches.length > 0) {
      if (key.upArrow) {
        setSelected((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSelected((i) => Math.min(matches.length - 1, i + 1));
        return;
      }
      if (key.tab) {
        const pick = matches[Math.min(selected, matches.length - 1)];
        setInput(`/${pick.name} `);
        setSelected(0);
        return;
      }
    }
    if (key.upArrow && history.length > 0) {
      const index = historyIndex === undefined ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(index);
      setInput(history[index] ?? "");
    } else if (key.downArrow && history.length > 0) {
      if (historyIndex === undefined) return;
      const index = historyIndex + 1;
      if (index >= history.length) {
        setHistoryIndex(undefined);
        setInput("");
      } else {
        setHistoryIndex(index);
        setInput(history[index] ?? "");
      }
    }
  });

  return (
    <Box flexDirection="column" width="100%">
      <Header cwd={cwd} project={project} />
      {items.length === 0 && turns === 0 ? (
        <Box flexDirection="column">
          <Logo />
          <Text dimColor>New workspace. Try: "design a sun-synchronous orbit at 550 km" — or @mention a local file.</Text>
        </Box>
      ) : null}
      <Static items={items}>
        {(item) => <TranscriptTurn key={item.id} item={item} project={project} />}
      </Static>
      {streaming ? <RunStatus stages={stages.length ? stages : ["starting run"]} /> : null}
      <Prompt value={input} onChange={onInputChange} onSubmit={submit} disabled={streaming} />
      <SlashMenu value={input} selected={selected} />
      {notice ? <Text dimColor>{notice}</Text> : null}
      <Box justifyContent="space-between" width="100%">
        <Text dimColor>enter send · /help · ctrl-d exit</Text>
        <Text dimColor>tokens: {tokenTotal}</Text>
      </Box>
    </Box>
  );
}
