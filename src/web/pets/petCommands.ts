import type { CommandPaletteEntry } from "../types.js";

export type PetCommand =
  | { action: "toggle" }
  | { action: "off" }
  | { action: "select"; query: string };

export const parsePetCommand = (input: string): PetCommand | null => {
  const match = /^\/pet(?:\s+(.*?))?\s*$/i.exec(input.trim());
  if (!match) return null;
  const argument = match[1]?.trim() ?? "";
  if (!argument) return { action: "toggle" };
  if (argument.toLowerCase() === "off") return { action: "off" };
  return { action: "select", query: argument };
};

export const petCommandPaletteEntries: CommandPaletteEntry[] = [
  {
    id: "codexhub:pet",
    kind: "builtin",
    name: "pet",
    title: "Wake or tuck away pet",
    shortDescription: "Toggle the CodexHub pet",
    description: "Show or hide the floating Codex-compatible pet overlay.",
    insertText: "/pet",
    action: "insert",
    enabled: true,
  },
];
