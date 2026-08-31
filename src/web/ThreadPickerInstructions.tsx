import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Search } from "lucide-react";
import { apiRouteJson } from "./appHelpers.js";
import { apiRoutes } from "../shared/apiRoutes.js";
import type { DeveloperInstructionSummary } from "../shared/apiContract.js";

export type ThreadPickerInstructionsProps = {
  disabled?: boolean;
  acting: string | null;
  onBack: () => void;
  onSelect: (instructionId: string) => void;
  onOpenSettings?: () => void;
};

export const ThreadPickerInstructions: React.FC<ThreadPickerInstructionsProps> = ({
  disabled = false,
  acting,
  onBack,
  onSelect,
  onOpenSettings
}) => {
  const [templates, setTemplates] = useState<DeveloperInstructionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    let active = true;
    const fetchTemplates = async () => {
      try {
        setLoading(true);
        setError("");
        const payload = await apiRouteJson(apiRoutes.developerInstructions);
        if (active) setTemplates(payload.templates ?? []);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Failed to load templates");
      } finally {
        if (active) setLoading(false);
      }
    };
    void fetchTemplates();
    return () => {
      active = false;
    };
  }, []);

  const filteredTemplates = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return templates;
    return templates.filter((tpl) =>
      tpl.name.toLowerCase().includes(query)
      || (tpl.description && tpl.description.toLowerCase().includes(query))
      || tpl.instructions.toLowerCase().includes(query)
    );
  }, [templates, search]);

  return (
    <div className="threadPickerInstructions">
      <div className="threadPickerInstructionsHeader">
        <button
          type="button"
          className="threadPickerBackButton"
          onClick={onBack}
          disabled={disabled || acting !== null}
        >
          <ArrowLeft size={14} />
          <span>Back to candidates</span>
        </button>
        <span className="threadPickerInstructionsNotice">
          Injected snapshot is locked after thread creation
        </span>
      </div>

      <div className="threadPickerInstructionsSearch">
        <Search size={14} aria-hidden="true" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter instruction templates..."
          disabled={disabled || acting !== null}
        />
      </div>

      {error ? <div className="threadPickerError" role="alert">{error}</div> : null}

      <div className="threadPickerInstructionsList" aria-label="Developer instruction templates">
        {loading ? (
          <div className="threadPickerEmpty">Loading templates...</div>
        ) : filteredTemplates.length === 0 ? (
          <div className="threadPickerEmpty">
            {templates.length === 0 ? (
              <div>
                <p>No developer instruction templates found.</p>
                {onOpenSettings ? (
                  <button
                    type="button"
                    className="threadPickerInlineSettingsBtn"
                    onClick={onOpenSettings}
                  >
                    Open Settings to create one
                  </button>
                ) : null}
              </div>
            ) : (
              "No templates match your search."
            )}
          </div>
        ) : (
          filteredTemplates.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              className="threadPickerRow instructionTemplateRow"
              onClick={() => onSelect(tpl.id)}
              disabled={disabled || acting !== null}
            >
              <div className="threadPickerRowTitle">{tpl.name}</div>
              {tpl.description ? (
                <div className="threadPickerRowMeta">{tpl.description}</div>
              ) : null}
              <div className="threadPickerRowSnippet">
                {tpl.instructions.length > 120
                  ? `${tpl.instructions.slice(0, 120)}...`
                  : tpl.instructions}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
};
