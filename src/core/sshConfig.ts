import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type SshHostConfig = {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFiles: string[];
  proxyJump?: string;
};

type SshHostSection = {
  aliases: string[];
  values: Map<string, string[]>;
};

export const defaultSshConfigPath = () => process.env.CODEX_HUB_SSH_CONFIG || path.join(os.homedir(), ".ssh", "config");

export const listSshHosts = async (configPath = defaultSshConfigPath()): Promise<SshHostConfig[]> => {
  const text = await readSshConfigTree(configPath);
  if (!text.trim()) return [];

  const sections = parseSshConfig(text);
  const hosts = new Map<string, SshHostConfig>();
  for (const section of sections) {
    for (const alias of section.aliases) {
      if (!isConcreteHostAlias(alias)) continue;
      hosts.set(alias, {
        alias,
        hostName: firstValue(section, "hostname"),
        user: firstValue(section, "user"),
        port: parsePort(firstValue(section, "port")),
        identityFiles: section.values.get("identityfile") ?? [],
        proxyJump: firstValue(section, "proxyjump")
      });
    }
  }

  return [...hosts.values()].sort((left, right) => left.alias.localeCompare(right.alias, undefined, {
    sensitivity: "base"
  }));
};

const readSshConfigTree = async (configPath: string, seen = new Set<string>()): Promise<string> => {
  const filePath = path.resolve(expandHome(configPath));
  if (seen.has(filePath)) return "";
  seen.add(filePath);

  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return "";
  }

  const lines: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    const match = line.match(/^([^\s=]+)(?:\s+|=)(.+)$/);
    if (!match || match[1].toLowerCase() !== "include") {
      lines.push(rawLine);
      continue;
    }

    const patterns = splitConfigWords(match[2].trim());
    for (const pattern of patterns) {
      const includePattern = resolveIncludePattern(pattern, path.dirname(filePath));
      const includeFiles = await expandIncludePattern(includePattern);
      for (const includeFile of includeFiles) {
        const included = await readSshConfigTree(includeFile, seen);
        if (included.trim()) lines.push(included);
      }
    }
  }
  return lines.join("\n");
};

const parseSshConfig = (text: string) => {
  const sections: SshHostSection[] = [];
  let current: SshHostSection | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const match = line.match(/^([^\s=]+)(?:\s+|=)(.+)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = unquote(match[2].trim());

    if (key === "host") {
      current = {
        aliases: splitConfigWords(value),
        values: new Map()
      };
      sections.push(current);
      continue;
    }

    if (!current) continue;
    const values = current.values.get(key) ?? [];
    values.push(value);
    current.values.set(key, values);
  }

  return sections;
};

const firstValue = (section: SshHostSection, key: string) => section.values.get(key)?.[0];

const parsePort = (value: string | undefined) => {
  if (!value) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
};

const splitConfigWords = (value: string) => value.split(/\s+/).map(unquote).filter(Boolean);

const isConcreteHostAlias = (alias: string) =>
  Boolean(alias) && !alias.startsWith("!") && !/[?*]/.test(alias);

const resolveIncludePattern = (value: string, configDir: string) => {
  const expanded = expandHome(value);
  return path.isAbsolute(expanded) ? expanded : path.resolve(configDir, expanded);
};

const expandHome = (value: string) =>
  value === "~" || value.startsWith("~/")
    ? path.join(os.homedir(), value.slice(2))
    : value;

const expandIncludePattern = async (pattern: string) => {
  if (!hasGlob(pattern)) {
    const info = await safeStat(pattern);
    return info?.isFile() ? [path.resolve(pattern)] : [];
  }
  const root = path.parse(path.resolve(pattern)).root;
  const segments = path.relative(root, path.resolve(pattern)).split(path.sep).filter(Boolean);
  return expandGlobSegments(root, segments);
};

const expandGlobSegments = async (base: string, segments: string[]): Promise<string[]> => {
  if (!segments.length) {
    const info = await safeStat(base);
    return info?.isFile() ? [path.resolve(base)] : [];
  }

  const [segment, ...rest] = segments;
  if (!hasGlob(segment)) return expandGlobSegments(path.join(base, segment), rest);

  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  const matcher = globSegmentRegex(segment);
  const matches = entries
    .filter((entry) => matcher.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  const files: string[] = [];
  for (const entry of matches) {
    const nextPath = path.join(base, entry.name);
    if (rest.length === 0) {
      if (entry.isFile()) files.push(path.resolve(nextPath));
      continue;
    }
    if (entry.isDirectory()) files.push(...await expandGlobSegments(nextPath, rest));
  }
  return files;
};

const hasGlob = (value: string) => /[*?]/.test(value);

const globSegmentRegex = (segment: string) => new RegExp(`^${segment
  .split("")
  .map((char) => {
    if (char === "*") return ".*";
    if (char === "?") return ".";
    return char.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
  })
  .join("")}$`);

const unquote = (value: string) => {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed.at(-1);
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) return trimmed.slice(1, -1);
  }
  return trimmed;
};

const stripComment = (line: string) => {
  let quote: "\"" | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") return line.slice(0, index);
  }
  return line;
};

const safeStat = async (filePath: string) => {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
};
