import React, { useEffect, useState } from "react";
import { apiRouteJson } from "./appHelpers.js";
import { apiRoutes } from "../shared/apiRoutes.js";
import type { DeveloperInstructionSummary } from "../shared/apiContract.js";

type FormState = {
  id?: string;
  name: string;
  description: string;
  instructions: string;
};

export const DeveloperInstructionsSettings: React.FC = () => {
  const [templates, setTemplates] = useState<DeveloperInstructionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editingItem, setEditingItem] = useState<FormState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadTemplates = async () => {
    try {
      setLoading(true);
      setError("");
      const payload = await apiRouteJson(apiRoutes.developerInstructions);
      setTemplates(payload.templates ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load developer instructions");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTemplates();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingItem) return;
    const name = editingItem.name.trim();
    const instructions = editingItem.instructions.trim();
    if (!name || !instructions) {
      setError("Name and instructions are required.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      if (editingItem.id) {
        await apiRouteJson(apiRoutes.updateDeveloperInstruction, editingItem.id, {
          name,
          description: editingItem.description.trim() || null,
          instructions
        });
      } else {
        await apiRouteJson(apiRoutes.createDeveloperInstruction, {
          name,
          description: editingItem.description.trim() || undefined,
          instructions
        });
      }
      setEditingItem(null);
      await loadTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save template");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDuplicate = async (item: DeveloperInstructionSummary) => {
    setSubmitting(true);
    setError("");
    try {
      await apiRouteJson(apiRoutes.createDeveloperInstruction, {
        name: `${item.name} (Copy)`,
        description: item.description,
        instructions: item.instructions
      });
      await loadTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to duplicate template");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    setError("");
    try {
      await apiRouteJson(apiRoutes.deleteDeveloperInstruction, id);
      if (editingItem?.id === id) setEditingItem(null);
      await loadTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete template");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="developerInstructionsSettings">
      <div className="devInstructionsNotice">
        <strong>Developer Instructions Templates</strong>
        <p>
          Reusable instructions injected into newly created threads. Templates are fully editable,
          but each thread locks an immutable snapshot at creation time; modifying or deleting a template will not alter existing threads.
        </p>
      </div>

      {error ? <div className="settingsError" role="alert">{error}</div> : null}

      {editingItem ? (
        <form className="devInstructionForm" onSubmit={(e) => void handleSave(e)}>
          <h3>{editingItem.id ? "Edit Instruction Template" : "New Instruction Template"}</h3>
          <label>
            <span>Template Name *</span>
            <input
              type="text"
              value={editingItem.name}
              onChange={(e) => setEditingItem({ ...editingItem, name: e.target.value })}
              placeholder="e.g. Code Reviewer, Python Expert"
              required
              disabled={submitting}
              maxLength={200}
            />
          </label>
          <label>
            <span>Description (optional)</span>
            <input
              type="text"
              value={editingItem.description}
              onChange={(e) => setEditingItem({ ...editingItem, description: e.target.value })}
              placeholder="Brief summary of what this instruction does"
              disabled={submitting}
              maxLength={2000}
            />
          </label>
          <label>
            <span>Instructions *</span>
            <textarea
              value={editingItem.instructions}
              onChange={(e) => setEditingItem({ ...editingItem, instructions: e.target.value })}
              placeholder="You are an expert developer..."
              rows={8}
              required
              disabled={submitting}
              maxLength={32_768}
            />
          </label>
          <div className="devInstructionFormActions">
            <button
              type="button"
              className="secondaryButton"
              onClick={() => {
                setEditingItem(null);
                setError("");
              }}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="primaryButton"
              disabled={submitting || !editingItem.name.trim() || !editingItem.instructions.trim()}
            >
              {submitting ? "Saving..." : "Save Template"}
            </button>
          </div>
        </form>
      ) : (
        <div className="devInstructionsListWrapper">
          <div className="devInstructionsToolbar">
            <span>{templates.length} {templates.length === 1 ? "template" : "templates"} configured</span>
            <button
              type="button"
              className="primaryButton addTemplateBtn"
              onClick={() => {
                setEditingItem({ name: "", description: "", instructions: "" });
                setError("");
              }}
            >
              + Add template
            </button>
          </div>

          {loading ? (
            <div className="devInstructionsEmpty">Loading templates...</div>
          ) : templates.length === 0 ? (
            <div className="devInstructionsEmpty">
              No developer instruction templates yet. Create one to easily start threads with specialized roles or context.
            </div>
          ) : (
            <div className="devInstructionsGrid">
              {templates.map((tpl) => (
                <div key={tpl.id} className="devInstructionCard">
                  <div className="devInstructionCardHeader">
                    <strong>{tpl.name}</strong>
                    {tpl.description ? <span className="devInstructionDesc">{tpl.description}</span> : null}
                  </div>
                  <div className="devInstructionCardBody">
                    <pre>{tpl.instructions}</pre>
                  </div>
                  <div className="devInstructionCardFooter">
                    <span className="devInstructionMeta">
                      {tpl.instructions.length} chars · Updated {new Date(tpl.updatedAt).toLocaleDateString()}
                    </span>
                    <div className="devInstructionCardActions">
                      <button
                        type="button"
                        className="textButton"
                        onClick={() => {
                          setEditingItem({
                            id: tpl.id,
                            name: tpl.name,
                            description: tpl.description ?? "",
                            instructions: tpl.instructions
                          });
                          setError("");
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="textButton"
                        onClick={() => void handleDuplicate(tpl)}
                        disabled={submitting}
                      >
                        Duplicate
                      </button>
                      <button
                        type="button"
                        className="textButton danger"
                        onClick={() => void handleDelete(tpl.id)}
                        disabled={deletingId === tpl.id}
                      >
                        {deletingId === tpl.id ? "Deleting..." : "Delete"}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
