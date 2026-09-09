export type CodexhubInvocation = {
  operation: "start" | "send" | "stop" | "end";
  threadId?: string;
  name?: string;
  cwd?: string;
  machineId?: string;
  model?: string;
  effort?: string;
  connectUrl?: string;
  input?: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEXHUB_EXECUTABLES = new Set(["codexhub", "cxh", "codexhub.cmd", "cxh.cmd"]);
const SHELL_EXECUTABLES = new Set(["ash", "bash", "dash", "fish", "ksh", "sh", "zsh"]);
const VALUE_OPTIONS = new Set(["--connect", "--cwd", "--effort", "--machine", "--model", "--name", "--server", "--timeout"]);
// `--stream` is retired from the CLI. Keep it only for historical tool-record
// parsing so old shell records remain inspectable in the Web UI.
const FLAG_OPTIONS = new Set(["--json", "--no-wait", "--stream", "--wait"]);

type ShellToken = {
  value: string;
};

type Heredoc = {
  command: string;
  input: string;
};

type TokenizedShell = {
  segments: ShellToken[][];
  valid: boolean;
};

type HeredocScan =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "found"; value: Heredoc };

export function parseCodexhubInvocation(command: string | string[]): CodexhubInvocation | null {
  if (Array.isArray(command)) return command.join(" ").length > 64_000 ? null : parseArgumentVector(command);
  if (typeof command !== "string" || command.trim() === "") return null;
  return parseShellSource(command);
}

export function codexhubThreadIdFromOutput(output: string): string | undefined {
  if (typeof output !== "string") return undefined;

  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*Thread ID:\s*([^\s]+)\s*$/.exec(line);
    if (match?.[1] && UUID_PATTERN.test(match[1])) return match[1];
  }
  return undefined;
}

function parseShellSource(source: string, depth = 0): CodexhubInvocation | null {
  if (depth > 6 || source.length > 64_000) return null;
  const heredoc = scanHeredoc(source);
  if (heredoc.kind === "invalid") return null;

  const shellSource = heredoc.kind === "found" ? heredoc.value.command : source;
  const tokenized = tokenizeShell(shellSource);
  if (!tokenized.valid || tokenized.segments.length !== 1) return null;

  const segment = tokenized.segments[0];
  const executable = resolveExecutable(segment);
  if (!executable) return null;

  if (executable.kind === "shell") {
    if (heredoc.kind === "found") return null;
    return parseShellSource(executable.command, depth + 1);
  }

  return parseInvocationArguments(
    executable.args.map((token) => token.value),
    heredoc.kind === "found" ? heredoc.value.input : undefined
  );
}

function parseArgumentVector(argv: string[]): CodexhubInvocation | null {
  if (argv.length === 0 || argv.some((value) => typeof value !== "string")) return null;

  // Some app-server shell records serialize the complete shell invocation as
  // one command-array element, e.g. ["/usr/bin/zsh -lc \"codexhub ...\""]
  // instead of preserving the argv boundaries. Re-enter the existing shell
  // parser for that shape; real argv arrays continue through the vector path.
  if (argv.length === 1) {
    return parseShellSource(argv[0]);
  }

  const executable = resolveExecutable(argv.map((value) => ({ value })));
  if (!executable) return null;
  if (executable.kind === "shell") return parseShellSource(executable.command);
  return parseInvocationArguments(executable.args.map((token) => token.value));
}

function parseInvocationArguments(args: string[], heredocInput?: string): CodexhubInvocation | null {
  let operation: CodexhubInvocation["operation"] | undefined;
  let name: string | undefined;
  let cwd: string | undefined;
  let machineId: string | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let connectUrl: string | undefined;
  const sawHeredoc = heredocInput !== undefined;
  const positionals: string[] = [];
  const seenOptions = new Set<string>();
  let optionsEnded = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }

    if (!optionsEnded && token.startsWith("--")) {
      const option = readOption(args, index);
      if (!option || seenOptions.has(option.name)) return null;
      if (!operation && option.name !== "--connect" && option.name !== "--server") return null;
      if (operation && !optionAllowedForOperation(operation, option.name)) return null;
      if ((option.name === "--wait" && seenOptions.has("--no-wait")) ||
        (option.name === "--no-wait" && seenOptions.has("--wait"))) return null;
      seenOptions.add(option.name);
      index = option.nextIndex;

      if (option.name === "--connect" || option.name === "--server") {
        if (connectUrl !== undefined) return null;
        connectUrl = option.value;
      } else if (option.name === "--name") {
        name = option.value;
      } else if (option.name === "--cwd") {
        cwd = option.value;
      } else if (option.name === "--machine") {
        machineId = option.value;
      } else if (option.name === "--model") {
        model = option.value;
      } else if (option.name === "--effort") {
        effort = option.value;
      }
      continue;
    }

    if (!optionsEnded && token.startsWith("-") && token !== "-") return null;

    if (!operation && isOperation(token)) {
      operation = token;
      continue;
    }

    if (!operation) return null;
    positionals.push(token);
  }

  if (!operation) return null;
  if (operation === "start") {
    if (name === undefined || positionals.length !== 1) return null;
    if (positionals[0] === "-") {
      if (!sawHeredoc) return null;
      return optionalInvocation(operation, {
        name,
        cwd,
        machineId,
        model,
        effort,
        connectUrl,
        input: heredocInput
      });
    }
    if (sawHeredoc) return null;
    return optionalInvocation(operation, { name, cwd, machineId, model, effort, connectUrl, input: positionals[0] });
  }

  if (sawHeredoc) return null;
  if (operation === "send") {
    if (positionals.length !== 2 || !UUID_PATTERN.test(positionals[0])) return null;
    return optionalInvocation(operation, {
      threadId: positionals[0],
      cwd,
      machineId,
      model,
      effort,
      connectUrl,
      input: positionals[1]
    });
  }

  if (positionals.length !== 1 || !UUID_PATTERN.test(positionals[0])) return null;
  return optionalInvocation(operation, { threadId: positionals[0], connectUrl });
}

function optionalInvocation(operation: CodexhubInvocation["operation"], values: Omit<CodexhubInvocation, "operation">): CodexhubInvocation {
  const result: CodexhubInvocation = { operation };
  if (values.threadId !== undefined) result.threadId = values.threadId;
  if (values.name !== undefined) result.name = values.name;
  if (values.cwd !== undefined) result.cwd = values.cwd;
  if (values.machineId !== undefined) result.machineId = values.machineId;
  if (values.model !== undefined) result.model = values.model;
  if (values.effort !== undefined) result.effort = values.effort;
  if (values.connectUrl !== undefined) result.connectUrl = values.connectUrl;
  if (values.input !== undefined) result.input = values.input;
  return result;
}

function optionAllowedForOperation(operation: CodexhubInvocation["operation"], option: string): boolean {
  if (option === "--connect" || option === "--server") return true;
  if (option === "--timeout" || option === "--json") return true;
  if (operation === "stop" || operation === "end") return false;
  if (option === "--cwd" || option === "--machine" || option === "--model" || option === "--effort") return true;
  if (operation === "start" && option === "--name") return true;
  return option === "--stream" || option === "--wait" || option === "--no-wait";
}

function readOption(args: string[], index: number):
  | { name: string; value?: string; nextIndex: number }
  | null {
  const token = args[index];
  const equalsIndex = token.indexOf("=");
  const name = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
  const inlineValue = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);

  if (VALUE_OPTIONS.has(name)) {
    if (inlineValue !== undefined) {
      return inlineValue === "" ? null : { name, value: inlineValue, nextIndex: index };
    }
    const value = args[index + 1];
    if (value === undefined || value === "" || value.startsWith("-")) return null;
    return { name, value, nextIndex: index + 1 };
  }

  if (FLAG_OPTIONS.has(name)) {
    return inlineValue === undefined ? { name, nextIndex: index } : null;
  }

  return null;
}

function isOperation(value: string): value is CodexhubInvocation["operation"] {
  return value === "start" || value === "send" || value === "stop" || value === "end";
}

function resolveExecutable(tokens: ShellToken[]):
  | { kind: "codexhub"; args: ShellToken[] }
  | { kind: "shell"; command: string }
  | null {
  let index = 0;

  while (index < tokens.length && isAssignment(tokens[index].value)) index += 1;
  if (index >= tokens.length) return null;

  if (tokens[index].value === "env") {
    index += 1;
    while (index < tokens.length && isEnvOption(tokens[index].value)) index += 1;
    while (index < tokens.length && isAssignment(tokens[index].value)) index += 1;
    if (index >= tokens.length) return null;
  }

  const executable = executableName(tokens[index].value);
  if (CODEXHUB_EXECUTABLES.has(executable)) {
    return { kind: "codexhub", args: tokens.slice(index + 1) };
  }

  if (!SHELL_EXECUTABLES.has(executable)) return null;
  const shellArgs = tokens.slice(index + 1).map((token) => token.value);
  const commandIndex = shellCommandIndex(shellArgs);
  if (commandIndex === null || shellArgs.length !== commandIndex + 1) return null;
  return { kind: "shell", command: shellArgs[commandIndex] };
}

function shellCommandIndex(args: string[]): number | null {
  if (args.length >= 2 && (args[0] === "-c" || args[0] === "-lc" || args[0] === "-cl")) return 1;
  if (args.length >= 3 && args[0] === "-l" && args[1] === "-c") return 2;
  return null;
}

function executableName(value: string): string {
  const slashIndex = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return value.slice(slashIndex + 1).toLowerCase();
}

function isAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function isEnvOption(value: string): boolean {
  return value === "-i" || value === "--ignore-environment" || value === "--";
}

function tokenizeShell(source: string): TokenizedShell {
  const segments: ShellToken[][] = [];
  let current: ShellToken[] = [];
  let value = "";
  let tokenStarted = false;
  let quote: "single" | "double" | null = null;

  const flushToken = () => {
    if (!tokenStarted) return;
    current.push({ value });
    value = "";
    tokenStarted = false;
  };

  const flushSegment = () => {
    flushToken();
    if (current.length > 0) segments.push(current);
    current = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (quote === "single") {
      if (character === "'") quote = null;
      else value += character;
      tokenStarted = true;
      continue;
    }

    if (quote === "double") {
      if (character === '"') {
        quote = null;
        tokenStarted = true;
      } else if (character === "\\") {
        const next = source[index + 1];
        if (next === "\n") index += 1;
        else if (next === "\r" && source[index + 2] === "\n") index += 2;
        else if (next === '"' || next === "\\" || next === "$") {
          value += next;
          index += 1;
        } else {
          value += character;
          tokenStarted = true;
        }
      } else {
        value += character;
        tokenStarted = true;
      }
      continue;
    }

    if (character === "'") {
      quote = "single";
      tokenStarted = true;
      continue;
    }
    if (character === '"') {
      quote = "double";
      tokenStarted = true;
      continue;
    }
    if (character === "\\") {
      const next = source[index + 1];
      if (next === undefined) return { segments: [], valid: false };
      if (next === "\n") index += 1;
      else if (next === "\r" && source[index + 2] === "\n") index += 2;
      else {
        value += next;
        tokenStarted = true;
        index += 1;
      }
      continue;
    }
    if (/\s/.test(character)) {
      if (character === "\n") flushSegment();
      else flushToken();
      continue;
    }
    if (character === "#" && !tokenStarted) {
      while (index < source.length && source[index] !== "\n") index += 1;
      index -= 1;
      continue;
    }
    if (character === ";" || character === "&" || character === "|" || character === "(" || character === ")" || character === "<" || character === ">") {
      if (character === "(" || character === ")" || character === "<" || character === ">") {
        return { segments: [], valid: false };
      }
      flushSegment();
      if ((character === "&" || character === "|") && source[index + 1] === character) index += 1;
      continue;
    }

    value += character;
    tokenStarted = true;
  }

  if (quote !== null) return { segments: [], valid: false };
  flushSegment();
  return { segments, valid: true };
}

function scanHeredoc(source: string): HeredocScan {
  let quote: "single" | "double" | null = null;
  let tokenStarted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (quote === "single") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === "double") {
      if (character === '"') quote = null;
      else if (character === "\\") index += 1;
      continue;
    }
    if (character === "'") {
      quote = "single";
      tokenStarted = true;
      continue;
    }
    if (character === '"') {
      quote = "double";
      tokenStarted = true;
      continue;
    }
    if (character === "\\") {
      index += 1;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      tokenStarted = false;
      continue;
    }
    if (character === "#" && !tokenStarted) {
      while (index < source.length && source[index] !== "\n") index += 1;
      index -= 1;
      continue;
    }
    if (character === "<" && source[index + 1] === "<") {
      const operatorEnd = character === "<" && source[index + 2] === "-" ? index + 3 : index + 2;
      const delimiter = readHeredocDelimiter(source, operatorEnd);
      if (!delimiter) return { kind: "invalid" };
      const lineEnd = findLineEnd(source, delimiter.end);
      if (lineEnd === null) return { kind: "invalid" };
      const bodyStart = lineEnd.next;
      const bodyEnd = findHeredocEnd(source, bodyStart, delimiter.value, operatorEnd === index + 3);
      if (bodyEnd === null) return { kind: "invalid" };
      const remainder = source.slice(bodyEnd.next);
      if (/\S/.test(remainder)) return { kind: "invalid" };
      let input = source.slice(bodyStart, bodyEnd.start);
      if (input.endsWith("\n")) {
        input = input.slice(0, -1);
        if (input.endsWith("\r")) input = input.slice(0, -1);
      }
      return { kind: "found", value: { command: source.slice(0, index), input } };
    }
    tokenStarted = true;
  }

  return { kind: "none" };
}

function readHeredocDelimiter(source: string, start: number): { value: string; end: number } | null {
  let index = start;
  while (index < source.length && (source[index] === " " || source[index] === "\t")) index += 1;
  const wordStart = index;
  let value = "";
  let quote: "single" | "double" | null = null;

  for (; index < source.length; index += 1) {
    const character = source[index];
    if (quote === "single") {
      if (character === "'") quote = null;
      else value += character;
      continue;
    }
    if (quote === "double") {
      if (character === '"') quote = null;
      else if (character === "\\") return null;
      else value += character;
      continue;
    }
    if (character === "'") {
      quote = "single";
      continue;
    }
    if (character === '"') {
      quote = "double";
      continue;
    }
    if (character === "\\") return null;
    if (character === " " || character === "\t" || character === "\r" || character === "\n") break;
    value += character;
  }

  if (quote !== null || index === wordStart || value === "" || /[$`(]/.test(value)) return null;
  while (index < source.length && (source[index] === " " || source[index] === "\t" || source[index] === "\r")) index += 1;
  if (source[index] !== "\n") return null;
  return { value, end: index };
}

function findLineEnd(source: string, start: number): { next: number } | null {
  const newline = source.indexOf("\n", start);
  return newline === -1 ? null : { next: newline + 1 };
}

function findHeredocEnd(source: string, start: number, delimiter: string, stripTabs: boolean): { start: number; next: number } | null {
  let lineStart = start;
  while (lineStart <= source.length) {
    const newline = source.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? source.length : newline;
    let line = source.slice(lineStart, lineEnd);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (stripTabs) line = line.replace(/^\t+/, "");
    if (line === delimiter) return { start: lineStart, next: newline === -1 ? source.length : newline + 1 };
    if (newline === -1) return null;
    lineStart = newline + 1;
  }
  return null;
}
