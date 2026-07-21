import type { CommandPaletteEntry } from "../types.js";

export type PetCommand =
  | { action: "toggle" }
  | { action: "open_picker" }
  | { action: "off" }
  | { action: "select"; query: string };

export const parsePetCommand = (input: string): PetCommand | null => {
  const match = /^\/(pet|pets)(?:\s+(.*?))?\s*$/i.exec(input.trim());
  if (!match) return null;
  const command = match[1].toLowerCase();
  const argument = match[2]?.trim() ?? "";
  if (command === "pet" && !argument) return { action: "toggle" };
  if (!argument) return { action: "open_picker" };
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
  {
    id: "codexhub:pets",
    kind: "builtin",
    name: "pets",
    title: "Choose pet",
    shortDescription: "Open the pet picker",
    description: "Choose the built-in pet or import a Codex-compatible spritesheet.",
    insertText: "/pets",
    action: "insert",
    enabled: true,
  },
];
