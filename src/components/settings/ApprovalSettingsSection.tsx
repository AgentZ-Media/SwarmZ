import { useState } from "react";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { useSwarm } from "@/store";
import {
  normalizeApprovalRules,
  validApprovalPattern,
} from "@/lib/approval-rules";
import type { ApprovalRule } from "@/types";
import { SettingsSection } from "./SettingsPrimitives";

const EMPTY_RULES: ApprovalRule[] = [];

export function ApprovalSettingsSection() {
  const storedRules = useSwarm(
    (state) => state.settings.approvalRules ?? EMPTY_RULES,
  );
  const updateApprovalRule = useSwarm((state) => state.updateApprovalRule);
  const removeApprovalRule = useSwarm((state) => state.removeApprovalRule);
  const rules = normalizeApprovalRules(storedRules);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const beginEdit = (rule: ApprovalRule) => {
    setEditing(rule.id);
    setDraft(JSON.stringify(rule.pattern));
    setError(null);
  };

  const save = async () => {
    if (!editing) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch {
      setError('Use a JSON array such as ["pnpm","test"].');
      return;
    }
    if (!validApprovalPattern(parsed)) {
      setError("The rule needs 1–24 non-empty command arguments.");
      return;
    }
    setSaving(true);
    try {
      await updateApprovalRule(editing, parsed);
      setEditing(null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setSaving(true);
    setError(null);
    try {
      await removeApprovalRule(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      label="Command approvals"
      sub="Rules created with “Always allow” are scoped to SwarmZ. Each rule matches a Codex-proposed argument prefix; trailing arguments are included."
    >
      <div className="divide-y divide-line border-y border-line">
        {rules.length === 0 ? (
          <p className="py-3 text-11 leading-relaxed text-fnt">
            No persistent command rules yet. A supported command approval can add one.
          </p>
        ) : (
          rules.map((rule) => {
            const isEditing = editing === rule.id;
            return (
              <div key={rule.id} className="py-3">
                {isEditing ? (
                  <div>
                    <div className="flex items-center gap-2">
                      <input
                        autoFocus
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void save();
                          if (event.key === "Escape") setEditing(null);
                        }}
                        aria-label="Command prefix as a JSON array"
                        className="focus-ring h-8 min-w-0 flex-1 rounded-md border border-line2 bg-card px-2 font-mono text-11 text-txt"
                      />
                      <button
                        onClick={() => void save()}
                        disabled={saving}
                        title="Save rule"
                        className="focus-ring rounded-md p-2 text-ok hover:bg-ok/10"
                      >
                        <Check size={13} />
                      </button>
                      <button
                        onClick={() => setEditing(null)}
                        title="Cancel editing"
                        className="focus-ring rounded-md p-2 text-fnt hover:bg-pop hover:text-mut"
                      >
                        <X size={13} />
                      </button>
                    </div>
                    {error && <p className="mt-1.5 text-10 text-err">{error}</p>}
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate font-mono text-11 text-mut">
                      {rule.pattern.map((token) => JSON.stringify(token)).join(" ")}
                    </code>
                    <button
                      onClick={() => beginEdit(rule)}
                      title="Edit rule"
                      className="focus-ring rounded-md p-2 text-fnt hover:bg-pop hover:text-mut"
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      onClick={() => void remove(rule.id)}
                      disabled={saving}
                      title="Delete rule"
                      className="focus-ring rounded-md p-2 text-fnt hover:bg-err/10 hover:text-err"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      {error && editing === null && (
        <p className="mt-2 text-10 text-err">{error}</p>
      )}
    </SettingsSection>
  );
}
