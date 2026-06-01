import { readFile } from "node:fs/promises";
import path from "node:path";

export type DotEnvLoadResult = {
  path: string;
  loaded: boolean;
};

export const loadDotEnv = async (filePath = path.resolve(process.cwd(), ".env")): Promise<DotEnvLoadResult> => {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: filePath, loaded: false };
    throw error;
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const parsed = parseDotEnvLine(rawLine);
    if (!parsed) continue;
    if (!(parsed.key in process.env)) process.env[parsed.key] = parsed.value;
  }

  return { path: filePath, loaded: true };
};

const parseDotEnvLine = (line: string): { key: string; value: string } | null => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
  if (!match) return null;

  return {
    key: match[1],
    value: parseDotEnvValue(match[2].trim())
  };
};

const parseDotEnvValue = (value: string) => {
  const hashIndex = unquotedHashIndex(value);
  const withoutComment = hashIndex >= 0 ? value.slice(0, hashIndex).trimEnd() : value;
  if (withoutComment.length < 2) return withoutComment;

  const quote = withoutComment[0];
  const last = withoutComment[withoutComment.length - 1];
  if ((quote === "\"" || quote === "'") && last === quote) {
    const inner = withoutComment.slice(1, -1);
    return quote === "\"" ? unescapeDoubleQuoted(inner) : inner;
  }
  return withoutComment;
};

const unquotedHashIndex = (value: string) => {
  let quote: "\"" | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote === "\"") {
      escaped = true;
      continue;
    }
    if ((char === "\"" || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (char === "#" && !quote && (index === 0 || /\s/.test(value[index - 1]))) return index;
  }
  return -1;
};

const unescapeDoubleQuoted = (value: string) => value
  .replace(/\\n/g, "\n")
  .replace(/\\r/g, "\r")
  .replace(/\\t/g, "\t")
  .replace(/\\"/g, "\"")
  .replace(/\\\\/g, "\\");
