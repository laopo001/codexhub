import React from "react";
import { Button, Modal } from "antd";
import { Check, PawPrint, Trash2, Upload, X } from "lucide-react";
import {
  petAnimationRows,
  petAtlasBackgroundPosition,
  petAtlasCellBackgroundPosition,
  petAtlasForVersion,
  petLookCellForVector,
  type PetAnimationState,
  type PetLookCell,
} from "./petAtlas.js";
import { clampPetPosition, defaultPetPosition, type PetPosition, type PetSize } from "./petMotion.js";
import type { PetDefinition } from "./petStore.js";
import { petAnimationForPresentation, petStatusLabel, type PetActivity, type PetActivityStatus } from "./petStatus.js";
import type { PetFeatureController } from "./usePetFeature.js";

type PetDragDirection = "left" | "right" | null;

type PetDragSession = {
  lastClientX: number;
  moved: boolean;
  origin: PetPosition;
  pointerId: number;
  startClientX: number;
  startClientY: number;
};

const dragThreshold = 5;

const viewportSize = (): PetSize => ({ width: window.innerWidth, height: window.innerHeight });

const petSizeForViewport = (): PetSize => window.innerWidth <= 700
  ? { width: 96, height: 104 }
  : { width: 126, height: 136 };

const samePosition = (left: PetPosition, right: PetPosition) => left.x === right.x && left.y === right.y;

const sameLookCell = (left: PetLookCell | null, right: PetLookCell | null) =>
  left === right || (left?.row === right?.row && left?.column === right?.column);

const useReducedMotion = () => {
  const [reduced, setReduced] = React.useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  React.useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
};

const usePetFrame = (animation: PetAnimationState, reducedMotion: boolean) => {
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => setFrame(0), [animation]);
  React.useEffect(() => {
    if (reducedMotion) return undefined;
    const row = petAnimationRows[animation];
    const timeout = window.setTimeout(
      () => setFrame((current) => (current + 1) % row.durationsMs.length),
      row.durationsMs[frame % row.durationsMs.length]
    );
    return () => window.clearTimeout(timeout);
  }, [animation, frame, reducedMotion]);
  return reducedMotion ? 0 : frame;
};

type PetVisualProps = {
  composerRecentlyChanged?: boolean;
  pet: PetDefinition;
  status: PetActivityStatus;
  compact?: boolean;
  dragDirection?: PetDragDirection;
  frame?: number;
  lookCell?: PetLookCell | null;
};

export const PetVisual = ({ composerRecentlyChanged = false, pet, status, compact = false, dragDirection = null, frame = 0, lookCell = null }: PetVisualProps) => {
  const animation = petAnimationForPresentation(status, { composerRecentlyChanged, dragDirection });
  const atlas = petAtlasForVersion(pet.spriteVersionNumber);
  const useLookCell = pet.spriteVersionNumber === 2 && status === "idle" && !composerRecentlyChanged && !dragDirection && lookCell;
  const position = useLookCell
    ? petAtlasCellBackgroundPosition(useLookCell.row, useLookCell.column, 2)
    : petAtlasBackgroundPosition(animation, frame, pet.spriteVersionNumber);
  return (
    <span
      className={`petSprite${compact ? " compact" : ""}`}
      role="img"
      aria-label={`${pet.displayName} · ${petStatusLabel(status)}`}
      style={{
        backgroundImage: `url(${JSON.stringify(pet.spriteUrl).slice(1, -1)})`,
        backgroundPosition: `${position.x} ${position.y}`,
        backgroundSize: `${atlas.columns * 100}% ${atlas.rows * 100}%`,
      }}
    />
  );
};

const AnimatedPetVisual = (props: Omit<PetVisualProps, "frame">) => {
  const reducedMotion = useReducedMotion();
  const animation = petAnimationForPresentation(props.status, {
    composerRecentlyChanged: props.composerRecentlyChanged,
    dragDirection: props.dragDirection,
  });
  const frame = usePetFrame(animation, reducedMotion);
  return <PetVisual {...props} frame={frame} />;
};

const PetCardPreview = ({ pet, eager }: { pet: PetDefinition; eager: boolean }) => {
  const ref = React.useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = React.useState(() => eager || typeof IntersectionObserver === "undefined");
  React.useEffect(() => {
    if (visible || eager || !ref.current) {
      if (eager) setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: "96px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [eager, visible]);
  return (
    <span ref={ref} className="petCardPreview">
      {visible ? <PetVisual pet={pet} status="idle" compact /> : <PawPrint className="petCardPreviewPlaceholder" size={28} aria-hidden="true" />}
    </span>
  );
};

const activityStatusClass = (status: PetActivityStatus) => status.replace("_", "-");

type PetOverlayProps = {
  composerRecentlyChanged: boolean;
  controller: PetFeatureController;
  onOpenThread: (threadId: string) => void | Promise<void>;
};

export const PetOverlay = ({ composerRecentlyChanged, controller, onOpenThread }: PetOverlayProps) => {
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const dragSessionRef = React.useRef<PetDragSession | null>(null);
  const lastPointerRef = React.useRef<{ x: number; y: number } | null>(null);
  const lookFrameRef = React.useRef<number | null>(null);
  const suppressClickRef = React.useRef(false);
  const initialPosition = React.useMemo(() => {
    const viewport = viewportSize();
    const size = petSizeForViewport();
    return controller.position
      ? clampPetPosition(controller.position, viewport, size)
      : defaultPetPosition(viewport, viewport.width <= 700);
  }, []);
  const [position, setPosition] = React.useState(initialPosition);
  const positionRef = React.useRef(position);
  const [dragDirection, setDragDirection] = React.useState<PetDragDirection>(null);
  const [lookCell, setLookCell] = React.useState<PetLookCell | null>(null);

  const updateRenderedPosition = React.useCallback((next: PetPosition) => {
    positionRef.current = next;
    setPosition((current) => samePosition(current, next) ? current : next);
  }, []);

  React.useEffect(() => {
    if (!controller.position) return;
    updateRenderedPosition(clampPetPosition(controller.position, viewportSize(), petSizeForViewport()));
  }, [controller.position?.x, controller.position?.y, updateRenderedPosition]);

  React.useEffect(() => {
    const handleResize = () => {
      const next = clampPetPosition(positionRef.current, viewportSize(), petSizeForViewport());
      updateRenderedPosition(next);
      if (controller.position && !samePosition(controller.position, next)) controller.setPosition(next);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [controller.position, controller.setPosition, updateRenderedPosition]);

  const updateLookForPointer = React.useCallback((clientX: number, clientY: number) => {
    if (!controller.enabled
      || controller.selectedPet.spriteVersionNumber !== 2
      || controller.status !== "idle"
      || dragSessionRef.current) {
      setLookCell((current) => current ? null : current);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const next = petLookCellForVector(clientX - (rect.left + rect.width / 2), clientY - (rect.top + rect.height / 2));
    setLookCell((current) => sameLookCell(current, next) ? current : next);
  }, [controller.enabled, controller.selectedPet.spriteVersionNumber, controller.status]);

  const scheduleLookForPointer = React.useCallback((clientX: number, clientY: number) => {
    lastPointerRef.current = { x: clientX, y: clientY };
    if (lookFrameRef.current !== null) return;
    lookFrameRef.current = window.requestAnimationFrame(() => {
      lookFrameRef.current = null;
      const pointer = lastPointerRef.current;
      if (pointer) updateLookForPointer(pointer.x, pointer.y);
    });
  }, [updateLookForPointer]);

  React.useEffect(() => {
    if (!controller.enabled || controller.selectedPet.spriteVersionNumber !== 2 || controller.status !== "idle") {
      setLookCell(null);
      return undefined;
    }
    const handlePointerMove = (event: PointerEvent) => scheduleLookForPointer(event.clientX, event.clientY);
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      if (lookFrameRef.current !== null) window.cancelAnimationFrame(lookFrameRef.current);
      lookFrameRef.current = null;
    };
  }, [controller.enabled, controller.selectedPet.spriteVersionNumber, controller.status, scheduleLookForPointer]);

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    dragSessionRef.current = {
      lastClientX: event.clientX,
      moved: false,
      origin: positionRef.current,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
    };
    suppressClickRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragSessionRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startClientX;
    const deltaY = event.clientY - drag.startClientY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < dragThreshold) return;
    if (!drag.moved) controller.setTrayOpen(false);
    drag.moved = true;
    const next = clampPetPosition({
      x: drag.origin.x + deltaX,
      y: drag.origin.y + deltaY,
    }, viewportSize(), petSizeForViewport());
    updateRenderedPosition(next);
    const stepX = event.clientX - drag.lastClientX;
    if (Math.abs(stepX) >= 0.5) setDragDirection(stepX > 0 ? "right" : "left");
    drag.lastClientX = event.clientX;
    setLookCell(null);
    event.preventDefault();
  };

  const finishDrag = (event: React.PointerEvent<HTMLButtonElement>, cancelled = false) => {
    const drag = dragSessionRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) {
      const next = clampPetPosition({
        x: drag.origin.x + event.clientX - drag.startClientX,
        y: drag.origin.y + event.clientY - drag.startClientY,
      }, viewportSize(), petSizeForViewport());
      updateRenderedPosition(next);
      controller.setPosition(next);
      suppressClickRef.current = !cancelled;
    }
    dragSessionRef.current = null;
    setDragDirection(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const pointer = lastPointerRef.current;
    if (pointer) scheduleLookForPointer(pointer.x, pointer.y);
  };

  if (!controller.enabled) return null;
  const activeActivities = controller.activities.filter((activity) => activity.status !== "idle");
  const viewport = viewportSize();
  const petSize = petSizeForViewport();
  const trayVertical = position.y + petSize.height / 2 > viewport.height / 2 ? "above" : "below";
  const trayHorizontal = position.x + petSize.width / 2 > viewport.width / 2 ? "right" : "left";
  const openActivity = (activity: PetActivity) => {
    controller.markThreadRead(activity.threadId);
    controller.setTrayOpen(false);
    void onOpenThread(activity.threadId);
  };
  return (
    <aside
      className="petOverlay"
      data-composer-recently-changed={composerRecentlyChanged ? "true" : "false"}
      data-dragging={dragDirection ? "true" : "false"}
      data-status={controller.status}
      data-tray-horizontal={trayHorizontal}
      data-tray-vertical={trayVertical}
      style={{ left: position.x, top: position.y }}
      aria-live="polite"
    >
      {controller.trayOpen ? (
        <section className="petActivityTray" aria-label="Codex activity">
          <header>
            <div>
              <strong>Codex activity</strong>
              <span>{activeActivities.length ? `${activeActivities.length} active` : "All quiet"}</span>
            </div>
            <button type="button" className="petIconButton" onClick={() => controller.setTrayOpen(false)} aria-label="Close activity"><X size={16} /></button>
          </header>
          <div className="petActivityList">
            {activeActivities.length ? activeActivities.map((activity) => (
              <button key={activity.threadId} type="button" className="petActivityItem" onClick={() => openActivity(activity)}>
                <span className={`petActivityDot ${activityStatusClass(activity.status)}`} />
                <span className="petActivityText">
                  <strong>{activity.title}</strong>
                  <em>{petStatusLabel(activity.status)}</em>
                </span>
              </button>
            )) : <div className="petActivityEmpty">No Codex work needs attention.</div>}
          </div>
          <button type="button" className="petTraySettings" onClick={controller.openPicker}><PawPrint size={15} /> Choose pet</button>
        </section>
      ) : null}
      <span className={`petStatusBubble ${activityStatusClass(controller.status)}`}>{petStatusLabel(controller.status)}</span>
      <button
        ref={buttonRef}
        type="button"
        className="petButton"
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          controller.setTrayOpen(!controller.trayOpen);
        }}
        onDragStart={(event) => event.preventDefault()}
        onPointerCancel={(event) => finishDrag(event, true)}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finishDrag(event)}
        aria-label={`${controller.selectedPet.displayName}: ${petStatusLabel(controller.status)}. Drag to move; click to open activity.`}
        aria-expanded={controller.trayOpen}
      >
        <AnimatedPetVisual
          composerRecentlyChanged={composerRecentlyChanged}
          pet={controller.selectedPet}
          status={controller.status}
          dragDirection={dragDirection}
          lookCell={lookCell}
        />
        {activeActivities.length ? <span className="petAttentionCount">{activeActivities.length}</span> : null}
      </button>
    </aside>
  );
};

export const PetPicker = ({ controller }: { controller: PetFeatureController }) => {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const importFiles = React.useCallback(async (files: File[]) => {
    const result = await controller.importFiles(files);
    if (result.status !== "conflict") return;
    const modal = Modal.confirm({
      title: `${result.pet.displayName} already exists`,
      content: `Keep both to import this pet as “${result.renamedPet.displayName}” with id “${result.renamedPet.id}”. Replacing moves the current package to ~/.codex/pets/.trash.`,
      cancelText: "Keep current",
      focusable: { autoFocusButton: null },
      footer: (_originNode, { CancelBtn }) => (
        <>
          <CancelBtn />
          <Button danger onClick={() => {
            modal.destroy();
            void controller.importFiles(files, "replace");
          }}>Replace pet</Button>
          <Button type="primary" onClick={() => {
            modal.destroy();
            void controller.importFiles(files, "rename");
          }}>Keep both</Button>
        </>
      ),
    });
  }, [controller]);

  const confirmRemovePet = React.useCallback((pet: PetDefinition) => {
    Modal.confirm({
      title: `Remove ${pet.displayName}?`,
      content: "The package will be moved to ~/.codex/pets/.trash so it can be recovered manually.",
      okText: "Remove pet",
      cancelText: "Cancel",
      okButtonProps: { danger: true },
      onOk: async () => { await controller.removePet(pet.id); },
    });
  }, [controller]);
  React.useEffect(() => {
    if (!controller.pickerOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") controller.closePicker();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [controller]);
  if (!controller.pickerOpen) return null;
  return (
    <div className="modalOverlay petPickerOverlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) controller.closePicker();
    }}>
      <section className="petPicker" role="dialog" aria-modal="true" aria-labelledby="petPickerTitle">
        <header className="petPickerHeader">
          <div>
            <h2 id="petPickerTitle">Pets</h2>
            <p>Follow Codex work with an animated companion.</p>
          </div>
          <button type="button" className="petIconButton" onClick={controller.closePicker} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="petPickerToolbar">
          <label className="petEnabledControl">
            <input type="checkbox" checked={controller.enabled} onChange={(event) => controller.setEnabled(event.currentTarget.checked)} />
            <span>Show floating pet</span>
          </label>
          <button type="button" className="petImportButton" disabled={controller.importBusy} onClick={() => fileInputRef.current?.click()}>
            <Upload size={16} /> {controller.importBusy ? "Importing…" : "Import pet"}
          </button>
          <input
            ref={fileInputRef}
            className="petFileInput"
            type="file"
            accept=".json,image/png,image/webp"
            multiple
            onChange={(event) => {
              void importFiles([...event.currentTarget.files ?? []]);
              event.currentTarget.value = "";
            }}
          />
        </div>
        <p className="petFormatHint">Codex V1/V2: transparent PNG/WebP, 1536 × 1872 or 1536 × 2288, up to 20 MiB. Select pet.json with the image so V2 can be detected.</p>
        {controller.error ? <div className="petPickerError" role="alert">{controller.error}</div> : null}
        {controller.invalidPets.length ? (
          <div className="petPickerWarning" role="status">
            <strong>{controller.invalidPets.length} invalid pet package{controller.invalidPets.length === 1 ? " was" : "s were"} skipped</strong>
            <ul>{controller.invalidPets.map((pet) => <li key={pet.id}><code>{pet.id}</code>: {pet.error}</li>)}</ul>
          </div>
        ) : null}
        <div className="petGrid">
          {controller.pets.map((pet) => {
            const selected = controller.selectedPet.id === pet.id;
            return (
              <article key={pet.id} className={`petCard${selected ? " selected" : ""}`}>
                <button type="button" className="petCardSelect" onClick={() => controller.selectPet(pet.id)} aria-pressed={selected}>
                  <PetCardPreview pet={pet} eager={selected} />
                  <span className="petCardText"><strong>{pet.displayName}</strong><em>{pet.description}</em></span>
                  {selected ? <span className="petSelectedMark"><Check size={15} /></span> : null}
                </button>
                {pet.kind === "imported" ? (
                  <button type="button" className="petDeleteButton" onClick={() => confirmRemovePet(pet)} aria-label={`Remove ${pet.displayName}`}><Trash2 size={15} /></button>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
};
