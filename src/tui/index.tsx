import React, { useMemo, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import { Command } from "commander";
import { CodexProxy } from "../core/codexProxy.js";
import { itemText, type ProxyEvent } from "../core/events.js";
import { loadConfig } from "../core/config.js";

type Message = {
  role: "user" | "codex" | "system";
  text: string;
};

const program = new Command()
  .option("--cwd <path>", "Codex working directory")
  .option("--thread <id>", "resume a Codex thread")
  .option("--model <model>", "Codex model")
  .parse(process.argv);

const options = program.opts<{ cwd?: string; thread?: string; model?: string }>();

const App = () => {
  const { exit } = useApp();
  const config = useMemo(loadConfig, []);
  const proxy = useMemo(() => {
    return new CodexProxy(config.codexOptions, {
      ...config.defaultThreadOptions,
      model: options.model ?? config.defaultThreadOptions.model,
      workingDirectory: options.cwd ?? config.defaultThreadOptions.workingDirectory
    });
  }, [config]);

  const [input, setInput] = useState("");
  const [threadId, setThreadId] = useState<string | undefined>(options.thread);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    { role: "system", text: "Enter 提交，Ctrl+C 退出。输入 /new 开新会话。" }
  ]);

  const append = (message: Message) => setMessages((current) => [...current.slice(-80), message]);

  const runPrompt = async (prompt: string) => {
    setBusy(true);
    append({ role: "user", text: prompt });
    try {
      for await (const event of proxy.runStream({
        input: prompt,
        threadId,
        workingDirectory: options.cwd,
        skipGitRepoCheck: true
      })) {
        handleEvent(event);
      }
    } catch (error) {
      append({ role: "system", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const handleEvent = (event: ProxyEvent) => {
    if (event.type === "thread") {
      setThreadId(event.threadId);
      append({ role: "system", text: `thread: ${event.threadId}` });
      return;
    }

    if (event.type === "item") {
      const text = itemText(event.item);
      if (text && event.item.type !== "agent_message") append({ role: "system", text });
      return;
    }

    if (event.type === "final") {
      append({ role: "codex", text: event.text });
      return;
    }

    if (event.type === "error") {
      append({ role: "system", text: event.message });
    }
  };

  useInput((char, key) => {
    if (key.ctrl && char === "c") {
      exit();
      return;
    }
    if (busy) return;
    if (key.return) {
      const value = input.trim();
      setInput("");
      if (!value) return;
      if (value === "/new") {
        setThreadId(undefined);
        append({ role: "system", text: "started a new local thread slot" });
        return;
      }
      void runPrompt(value);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1));
      return;
    }
    if (char) setInput((current) => current + char);
  });

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text color="cyan">codex-proxy tui</Text>
        <Text dimColor>cwd: {options.cwd ?? config.defaultThreadOptions.workingDirectory}</Text>
        <Text dimColor>thread: {threadId ?? "(new)"}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {messages.map((message, index) => (
          <Text key={index} color={message.role === "user" ? "green" : message.role === "codex" ? "white" : "gray"}>
            {message.role === "user" ? "> " : message.role === "codex" ? "codex: " : ""}{message.text}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={busy ? "yellow" : "cyan"}>{busy ? "running..." : "prompt"} </Text>
        <Text>{input}</Text>
      </Box>
    </Box>
  );
};

render(<App />);
