import React from "react";
import { Check, PawPrint, Trash2, Upload, X } from "lucide-react";
import { petAnimationRows, petAtlas, petAtlasBackgroundPosition, type PetAnimationState } from "./petAtlas.js";
import type { PetDefinition } from "./petStore.js";
import { petAnimationForStatus, petStatusLabel, type PetActivity, type PetActivityStatus } from "./petStatus.js";
import type { PetFeatureController } from "./usePetFeature.js";

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
  pet: PetDefinition;
  status: PetActivityStatus;
  compact?: boolean;
};

export const PetVisual = ({ pet, status, compact = false }: PetVisualProps) => {
  const reducedMotion = useReducedMotion();
  const animation = petAnimationForStatus(status);
  const frame = usePetFrame(animation, reducedMotion);
  const position = petAtlasBackgroundPosition(animation, frame);
  if (pet.kind === "imported" && pet.spriteUrl) {
    return (
      <span
        className={`petSprite${compact ? " compact" : ""}`}
        role="img"
        aria-label={`${pet.displayName} · ${petStatusLabel(status)}`}
        style={{
          backgroundImage: `url(${JSON.stringify(pet.spriteUrl).slice(1, -1)})`,
          backgroundPosition: `${position.x} ${position.y}`,
          backgroundSize: `${petAtlas.columns * 100}% ${petAtlas.rows * 100}%`,
        }}
      />
    );
  }
  return (
    <span className={`spudPet${compact ? " compact" : ""}`} data-status={status} role="img" aria-label={`${pet.displayName} · ${petStatusLabel(status)}`}>
      <span className="spudPetLeaf left" />
      <span className="spudPetLeaf right" />
      <span className="spudPetBody">
        <span className="spudPetEye left" />
        <span className="spudPetEye right" />
        <span className="spudPetMouth" />
        <span className="spudPetArm left" />
        <span className="spudPetArm right" />
      </span>
      <span className="spudPetShadow" />
    </span>
  );
};

const activityStatusClass = (status: PetActivityStatus) => status.replace("_", "-");

type PetOverlayProps = {
  controller: PetFeatureController;
  onOpenThread: (threadId: string) => void | Promise<void>;
};

export const PetOverlay = ({ controller, onOpenThread }: PetOverlayProps) => {
  if (!controller.enabled) return null;
  const activeActivities = controller.activities.filter((activity) => activity.status !== "idle");
  const openActivity = (activity: PetActivity) => {
    controller.markThreadRead(activity.threadId);
    controller.setTrayOpen(false);
    void onOpenThread(activity.threadId);
  };
  return (
    <aside className="petOverlay" data-status={controller.status} aria-live="polite">
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
        type="button"
        className="petButton"
        onClick={() => controller.setTrayOpen(!controller.trayOpen)}
        aria-label={`${controller.selectedPet.displayName}: ${petStatusLabel(controller.status)}. Open activity.`}
        aria-expanded={controller.trayOpen}
      >
        <PetVisual pet={controller.selectedPet} status={controller.status} />
        {activeActivities.length ? <span className="petAttentionCount">{activeActivities.length}</span> : null}
      </button>
    </aside>
  );
};

export const PetPicker = ({ controller }: { controller: PetFeatureController }) => {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
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
              void controller.importFiles([...event.currentTarget.files ?? []]);
              event.currentTarget.value = "";
            }}
          />
        </div>
        <p className="petFormatHint">Codex format: transparent PNG/WebP, 1536 × 1872, up to 20 MiB. Select its pet.json at the same time when available.</p>
        {controller.error ? <div className="petPickerError" role="alert">{controller.error}</div> : null}
        <div className="petGrid">
          {controller.pets.map((pet) => {
            const selected = controller.selectedPet.id === pet.id;
            return (
              <article key={pet.id} className={`petCard${selected ? " selected" : ""}`}>
                <button type="button" className="petCardSelect" onClick={() => controller.selectPet(pet.id)} aria-pressed={selected}>
                  <span className="petCardPreview"><PetVisual pet={pet} status="idle" compact /></span>
                  <span className="petCardText"><strong>{pet.displayName}</strong><em>{pet.description}</em></span>
                  {selected ? <span className="petSelectedMark"><Check size={15} /></span> : null}
                </button>
                {pet.kind === "imported" ? (
                  <button type="button" className="petDeleteButton" onClick={() => void controller.removePet(pet.id)} aria-label={`Delete ${pet.displayName}`}><Trash2 size={15} /></button>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
};
