import React from "react";
import type { OpenThreadState } from "../types.js";
import { parsePetCommand } from "./petCommands.js";
import {
  builtinPet,
  deleteStoredPet,
  importedPetFromFiles,
  loadStoredPets,
  saveStoredPet,
  type PetDefinition,
  type StoredPet,
} from "./petStore.js";
import { derivePetActivities, headlinePetStatus } from "./petStatus.js";

type PetPreferences = {
  enabled: boolean;
  selectedPetId: string;
};

const preferencesKey = "codexhub-pet-preferences-v1";
const defaultPreferences = (): PetPreferences => ({ enabled: false, selectedPetId: builtinPet.id });

const loadPreferences = (): PetPreferences => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(preferencesKey) ?? "null") as Partial<PetPreferences> | null;
    return {
      enabled: typeof parsed?.enabled === "boolean" ? parsed.enabled : false,
      selectedPetId: typeof parsed?.selectedPetId === "string" && parsed.selectedPetId.trim()
        ? parsed.selectedPetId
        : builtinPet.id,
    };
  } catch {
    return defaultPreferences();
  }
};

const sameSet = (left: ReadonlySet<string>, right: ReadonlySet<string>) =>
  left.size === right.size && [...left].every((item) => right.has(item));

const storedPetDefinition = (pet: StoredPet): PetDefinition => ({
  id: pet.id,
  displayName: pet.displayName,
  description: pet.description,
  spritesheetPath: pet.spritesheetPath,
  kind: "imported",
  spriteUrl: URL.createObjectURL(pet.blob),
});

export const usePetFeature = (openThreads: OpenThreadState[], activeThreadId: string) => {
  const [preferences, setPreferences] = React.useState<PetPreferences>(loadPreferences);
  const [importedPets, setImportedPets] = React.useState<PetDefinition[]>([]);
  const importedPetsRef = React.useRef<PetDefinition[]>([]);
  const [readyThreadIds, setReadyThreadIds] = React.useState<Set<string>>(() => new Set());
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [trayOpen, setTrayOpen] = React.useState(false);
  const [importBusy, setImportBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const previousRunning = React.useRef(new Map<string, boolean>());

  const replaceImportedPets = React.useCallback((pets: StoredPet[]) => {
    for (const pet of importedPetsRef.current) {
      if (pet.spriteUrl) URL.revokeObjectURL(pet.spriteUrl);
    }
    const definitions = pets.map(storedPetDefinition);
    importedPetsRef.current = definitions;
    setImportedPets(definitions);
  }, []);

  const reloadImportedPets = React.useCallback(async () => {
    replaceImportedPets(await loadStoredPets());
  }, [replaceImportedPets]);

  React.useEffect(() => {
    let cancelled = false;
    void loadStoredPets().then((pets) => {
      if (!cancelled) replaceImportedPets(pets);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      cancelled = true;
      for (const pet of importedPetsRef.current) {
        if (pet.spriteUrl) URL.revokeObjectURL(pet.spriteUrl);
      }
      importedPetsRef.current = [];
    };
  }, [replaceImportedPets]);

  React.useEffect(() => {
    window.localStorage.setItem(preferencesKey, JSON.stringify(preferences));
  }, [preferences]);

  React.useEffect(() => {
    setReadyThreadIds((current) => {
      const next = new Set(current);
      const existingIds = new Set(openThreads.map((thread) => thread.threadId));
      for (const id of next) {
        if (!existingIds.has(id)) next.delete(id);
      }
      for (const thread of openThreads) {
        const wasRunning = previousRunning.current.get(thread.threadId);
        if (wasRunning === true && !thread.running && (thread.threadId !== activeThreadId || document.hidden)) {
          next.add(thread.threadId);
        }
        previousRunning.current.set(thread.threadId, thread.running);
      }
      for (const id of previousRunning.current.keys()) {
        if (!existingIds.has(id)) previousRunning.current.delete(id);
      }
      if (!document.hidden && activeThreadId) next.delete(activeThreadId);
      return sameSet(current, next) ? current : next;
    });
  }, [activeThreadId, openThreads]);

  React.useEffect(() => {
    const markVisibleThreadRead = () => {
      if (document.hidden || !activeThreadId) return;
      setReadyThreadIds((current) => {
        if (!current.has(activeThreadId)) return current;
        const next = new Set(current);
        next.delete(activeThreadId);
        return next;
      });
    };
    markVisibleThreadRead();
    document.addEventListener("visibilitychange", markVisibleThreadRead);
    return () => document.removeEventListener("visibilitychange", markVisibleThreadRead);
  }, [activeThreadId]);

  const pets = React.useMemo(() => [builtinPet, ...importedPets], [importedPets]);
  const selectedPet = pets.find((pet) => pet.id === preferences.selectedPetId) ?? builtinPet;
  const activities = React.useMemo(
    () => derivePetActivities(openThreads, readyThreadIds),
    [openThreads, readyThreadIds]
  );
  const status = headlinePetStatus(activities);

  const setEnabled = React.useCallback((enabled: boolean) => {
    setPreferences((current) => ({ ...current, enabled }));
    if (!enabled) setTrayOpen(false);
  }, []);

  const selectPet = React.useCallback((id: string) => {
    if (!pets.some((pet) => pet.id === id)) return;
    setPreferences({ enabled: true, selectedPetId: id });
    setError("");
  }, [pets]);

  const openPicker = React.useCallback(() => {
    setError("");
    setPickerOpen(true);
    setTrayOpen(false);
  }, []);

  const handleLocalComposerCommand = React.useCallback((input: string) => {
    const command = parsePetCommand(input);
    if (!command) return false;
    if (command.action === "toggle") {
      setEnabled(!preferences.enabled);
      return true;
    }
    if (command.action === "off") {
      setEnabled(false);
      return true;
    }
    if (command.action === "open_picker") {
      openPicker();
      return true;
    }
    const query = command.query.toLowerCase();
    const match = pets.find((pet) => pet.id.toLowerCase() === query || pet.displayName.toLowerCase() === query);
    if (match) selectPet(match.id);
    else {
      setError(`No pet named “${command.query}” is installed.`);
      setPickerOpen(true);
    }
    return true;
  }, [openPicker, pets, preferences.enabled, selectPet, setEnabled]);

  const importFiles = React.useCallback(async (files: File[]) => {
    if (!files.length) return;
    setImportBusy(true);
    setError("");
    try {
      const pet = await importedPetFromFiles(files);
      await saveStoredPet(pet);
      await reloadImportedPets();
      setPreferences({ enabled: true, selectedPetId: pet.id });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImportBusy(false);
    }
  }, [reloadImportedPets]);

  const removePet = React.useCallback(async (id: string) => {
    if (id === builtinPet.id) return;
    setError("");
    try {
      await deleteStoredPet(id);
      await reloadImportedPets();
      setPreferences((current) => current.selectedPetId === id
        ? { ...current, selectedPetId: builtinPet.id }
        : current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [reloadImportedPets]);

  const markThreadRead = React.useCallback((threadId: string) => {
    setReadyThreadIds((current) => {
      if (!current.has(threadId)) return current;
      const next = new Set(current);
      next.delete(threadId);
      return next;
    });
  }, []);

  return {
    activities,
    closePicker: () => setPickerOpen(false),
    enabled: preferences.enabled,
    error,
    handleLocalComposerCommand,
    importBusy,
    importFiles,
    markThreadRead,
    openPicker,
    pets,
    pickerOpen,
    removePet,
    selectPet,
    selectedPet,
    setEnabled,
    setTrayOpen,
    status,
    trayOpen,
  };
};

export type PetFeatureController = ReturnType<typeof usePetFeature>;
