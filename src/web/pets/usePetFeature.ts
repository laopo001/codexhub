import React from "react";
import { apiRoutes } from "../../shared/apiRoutes.js";
import { defaultPetId, type InvalidPetPackage, type PetManifest } from "../../shared/petTypes.js";
import type { AppSettings, OpenThreadState } from "../types.js";
import { apiRouteJson } from "../helpers/core.js";
import { parsePetCommand } from "./petCommands.js";
import {
  builtinPet,
  builtinPets,
  clearLegacyPetDatabase,
  importedPetFromFiles,
  installedPetDefinition,
  nextAvailablePetManifest,
  PetUploadError,
  type PetDefinition,
  uploadImportedPet,
} from "./petStore.js";
import type { PetPosition } from "./petMotion.js";
import { derivePetActivities, headlinePetStatus } from "./petStatus.js";

type PetPreferences = {
  position?: PetPosition;
};

const preferencesKey = "codexhub-pet-preferences-v1";
const defaultPreferences = (): PetPreferences => ({});

const loadPreferences = (): PetPreferences => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(preferencesKey) ?? "null") as Partial<PetPreferences> | null;
    const position = parsed?.position;
    return {
      position: position && Number.isFinite(position.x) && Number.isFinite(position.y)
        ? { x: position.x, y: position.y }
        : undefined,
    };
  } catch {
    return defaultPreferences();
  }
};

const sameSet = (left: ReadonlySet<string>, right: ReadonlySet<string>) =>
  left.size === right.size && [...left].every((item) => right.has(item));

type PetImportConflictAction = "reject" | "rename" | "replace";

export const usePetFeature = (
  openThreads: OpenThreadState[],
  activeThreadId: string,
  enabled: boolean,
  selectedPetId: string,
  setAppSettings: React.Dispatch<React.SetStateAction<AppSettings>>
) => {
  const [preferences, setPreferences] = React.useState<PetPreferences>(loadPreferences);
  const [importedPets, setImportedPets] = React.useState<PetDefinition[]>([]);
  const [invalidPets, setInvalidPets] = React.useState<InvalidPetPackage[]>([]);
  const [petCatalogReady, setPetCatalogReady] = React.useState(false);
  const [readyThreadIds, setReadyThreadIds] = React.useState<Set<string>>(() => new Set());
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [trayOpen, setTrayOpen] = React.useState(false);
  const [importBusy, setImportBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const previousRunning = React.useRef(new Map<string, boolean>());
  const enabledRef = React.useRef(enabled);
  enabledRef.current = enabled;
  const selectedPetIdRef = React.useRef(selectedPetId);
  selectedPetIdRef.current = selectedPetId;

  const reloadImportedPets = React.useCallback(async () => {
    const payload = await apiRouteJson(apiRoutes.pets);
    setImportedPets(payload.pets.map(installedPetDefinition));
    setInvalidPets(payload.invalidPets);
    setPetCatalogReady(true);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    void clearLegacyPetDatabase();
    void apiRouteJson(apiRoutes.pets).then((payload) => {
      if (!cancelled) {
        setImportedPets(payload.pets.map(installedPetDefinition));
        setInvalidPets(payload.invalidPets);
        setPetCatalogReady(true);
      }
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, []);

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

  const pets = React.useMemo(() => [...builtinPets, ...importedPets], [importedPets]);
  const selectedPet = pets.find((pet) => pet.id === selectedPetId) ?? builtinPet;
  const activities = React.useMemo(
    () => derivePetActivities(openThreads, readyThreadIds),
    [openThreads, readyThreadIds]
  );
  const status = headlinePetStatus(activities);

  const setEnabled = React.useCallback((nextEnabled: boolean) => {
    const previousEnabled = enabledRef.current;
    enabledRef.current = nextEnabled;
    setAppSettings((current) => ({ ...current, showFloatingPet: nextEnabled }));
    if (!nextEnabled) setTrayOpen(false);
    void apiRouteJson(apiRoutes.updateConfig, {
      ui: { showFloatingPet: nextEnabled }
    }).then((payload) => {
      if (enabledRef.current !== nextEnabled) return;
      const savedEnabled = payload.config.ui.showFloatingPet;
      enabledRef.current = savedEnabled;
      setAppSettings((current) => ({ ...current, showFloatingPet: savedEnabled }));
    }).catch((reason) => {
      if (enabledRef.current !== nextEnabled) return;
      enabledRef.current = previousEnabled;
      setAppSettings((current) => ({ ...current, showFloatingPet: previousEnabled }));
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [setAppSettings]);

  const setSelectedPetId = React.useCallback((nextPetId: string) => {
    const previousPetId = selectedPetIdRef.current;
    selectedPetIdRef.current = nextPetId;
    setAppSettings((current) => ({ ...current, selectedPetId: nextPetId }));
    void apiRouteJson(apiRoutes.updateConfig, {
      ui: { selectedPetId: nextPetId }
    }).then((payload) => {
      if (selectedPetIdRef.current !== nextPetId) return;
      const savedPetId = payload.config.ui.selectedPetId;
      selectedPetIdRef.current = savedPetId;
      setAppSettings((current) => ({ ...current, selectedPetId: savedPetId }));
    }).catch((reason) => {
      if (selectedPetIdRef.current !== nextPetId) return;
      selectedPetIdRef.current = previousPetId;
      setAppSettings((current) => ({ ...current, selectedPetId: previousPetId }));
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [setAppSettings]);

  React.useEffect(() => {
    if (!petCatalogReady || pets.some((pet) => pet.id === selectedPetId)) return;
    setSelectedPetId(defaultPetId);
  }, [petCatalogReady, pets, selectedPetId, setSelectedPetId]);

  const selectPet = React.useCallback((id: string) => {
    if (!pets.some((pet) => pet.id === id)) return;
    setSelectedPetId(id);
    setEnabled(true);
    setError("");
  }, [pets, setEnabled, setSelectedPetId]);

  const openPicker = React.useCallback(() => {
    setError("");
    setPickerOpen(true);
    setTrayOpen(false);
    void reloadImportedPets().catch((reason) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [reloadImportedPets]);

  const handleLocalComposerCommand = React.useCallback((input: string) => {
    const command = parsePetCommand(input);
    if (!command) return false;
    if (command.action === "toggle") {
      setEnabled(!enabled);
      return true;
    }
    if (command.action === "off") {
      setEnabled(false);
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
  }, [enabled, pets, selectPet, setEnabled]);

  const importFiles = React.useCallback(async (files: File[], conflictAction: PetImportConflictAction = "reject") => {
    if (!files.length) return { status: "cancelled" as const };
    setImportBusy(true);
    setError("");
    try {
      const selection = await importedPetFromFiles(files);
      if (conflictAction === "reject" && pets.some((pet) => pet.kind === "imported" && pet.id === selection.manifest.id)) {
        return {
          status: "conflict" as const,
          pet: selection.manifest,
          renamedPet: nextAvailablePetManifest(selection.manifest, pets)
        };
      }
      const attemptedPets: PetManifest[] = [...pets];
      let uploadSelection = conflictAction === "rename"
        ? { ...selection, manifest: nextAvailablePetManifest(selection.manifest, attemptedPets) }
        : selection;
      let installed: PetManifest | null = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          installed = await uploadImportedPet(uploadSelection, conflictAction === "replace");
          break;
        } catch (reason) {
          if (conflictAction !== "rename" || !(reason instanceof PetUploadError) || reason.status !== 409) throw reason;
          attemptedPets.push(uploadSelection.manifest);
          uploadSelection = {
            ...selection,
            manifest: nextAvailablePetManifest(selection.manifest, attemptedPets)
          };
        }
      }
      if (!installed) throw new Error(`Unable to find an available name for ${selection.manifest.displayName}.`);
      await reloadImportedPets();
      setSelectedPetId(installed.id);
      setEnabled(true);
      return { status: "installed" as const, pet: installed };
    } catch (reason) {
      if (conflictAction === "reject" && reason instanceof PetUploadError && reason.status === 409) {
        const selection = await importedPetFromFiles(files).catch(() => null);
        if (selection) {
          return {
            status: "conflict" as const,
            pet: selection.manifest,
            renamedPet: nextAvailablePetManifest(selection.manifest, pets)
          };
        }
      }
      setError(reason instanceof Error ? reason.message : String(reason));
      return { status: "failed" as const };
    } finally {
      setImportBusy(false);
    }
  }, [pets, reloadImportedPets, setEnabled, setSelectedPetId]);

  const removePet = React.useCallback(async (id: string) => {
    if (pets.some((pet) => pet.id === id && pet.kind === "builtin")) return;
    setError("");
    try {
      await apiRouteJson(apiRoutes.deletePet, id);
      await reloadImportedPets();
      if (selectedPetIdRef.current === id) setSelectedPetId(defaultPetId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [pets, reloadImportedPets, setSelectedPetId]);

  const markThreadRead = React.useCallback((threadId: string) => {
    setReadyThreadIds((current) => {
      if (!current.has(threadId)) return current;
      const next = new Set(current);
      next.delete(threadId);
      return next;
    });
  }, []);

  const setPosition = React.useCallback((position: PetPosition) => {
    setPreferences((current) => ({ ...current, position }));
  }, []);

  return {
    activities,
    closePicker: () => setPickerOpen(false),
    enabled,
    error,
    handleLocalComposerCommand,
    importBusy,
    importFiles,
    invalidPets,
    markThreadRead,
    openPicker,
    pets,
    pickerOpen,
    position: preferences.position,
    removePet,
    selectPet,
    selectedPet,
    setEnabled,
    setPosition,
    setTrayOpen,
    status,
    trayOpen,
  };
};

export type PetFeatureController = ReturnType<typeof usePetFeature>;
