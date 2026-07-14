import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Check,
  Database,
  KeyRound,
  Plus,
  RefreshCw,
  Save,
  Server,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type {
  RuntimeCommandSpec,
  RuntimeEnvironmentSpec,
  RuntimeSecretBinding,
  RuntimeServiceSpec,
} from "@/lib/runtime/core";
import { validateRuntimeEnvironment } from "@/lib/runtime/core";
import {
  createDefaultRuntimeEnvironment,
  hydrateRuntimeEnvironments,
  useRuntimeEnvironments,
} from "@/lib/runtime/store";
import {
  listRuntimeServices,
  reconcileRuntimeServices,
  stopRuntimeService,
  type RuntimeServiceSnapshot,
} from "@/lib/runtime/native";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogDescription, DialogTitle, DrawerContent } from "./ui/dialog";

export interface RuntimeEnvironmentsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
  projectDir: string | null;
}

const inputClass =
  "focus-ring h-8 w-full rounded-md border border-line bg-card px-2.5 font-mono text-11 text-txt placeholder:text-fnt focus:border-acc/55";
const textareaClass =
  "focus-ring min-h-20 w-full resize-y rounded-md border border-line bg-card px-2.5 py-2 font-mono text-11 leading-relaxed text-txt placeholder:text-fnt focus:border-acc/55";
// Zustand's React 19 subscription bridge requires a referentially stable
// snapshot when a project has no saved environments. Returning a fresh `[]`
// from the selector makes `useSyncExternalStore` treat every read as a state
// change and can tear down the whole React tree as soon as this drawer mounts.
const EMPTY_RUNTIME_SPECS: RuntimeEnvironmentSpec[] = [];

function cloneSpec(spec: RuntimeEnvironmentSpec): RuntimeEnvironmentSpec {
  return JSON.parse(JSON.stringify(spec)) as RuntimeEnvironmentSpec;
}

function newCommand(id: string): RuntimeCommandSpec {
  return {
    id,
    argv: ["pnpm", "test"],
    cwdRelative: ".",
    timeoutMs: 120_000,
    maxOutputBytes: 262_144,
    continueOnFailure: false,
    idempotent: false,
  };
}

function newService(index: number): RuntimeServiceSpec {
  return {
    id: `service-${index}`,
    label: `Service ${index}`,
    command: { ...newCommand(`start-service-${index}`), argv: ["pnpm", "dev"] },
    ports: [{ env: "PORT", preferred: null }],
    healthcheckUrl: "http://127.0.0.1:${PORT}/health",
  };
}

export function RuntimeEnvironmentsPanel({
  open,
  onOpenChange,
  projectId,
  projectDir,
}: RuntimeEnvironmentsPanelProps) {
  const hydrated = useRuntimeEnvironments((state) => state.hydrated);
  const hydrateError = useRuntimeEnvironments((state) => state.hydrateError);
  const specs = useRuntimeEnvironments((state) =>
    projectId ? (state.byProject[projectId] ?? EMPTY_RUNTIME_SPECS) : EMPTY_RUNTIME_SPECS,
  );
  const selectedId = useRuntimeEnvironments((state) =>
    projectId ? (state.selectedByProject[projectId] ?? null) : null,
  );
  const upsert = useRuntimeEnvironments((state) => state.upsert);
  const remove = useRuntimeEnvironments((state) => state.remove);
  const select = useRuntimeEnvironments((state) => state.select);
  const [draft, setDraft] = useState<RuntimeEnvironmentSpec | null>(null);
  const [services, setServices] = useState<RuntimeServiceSnapshot[]>([]);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const refreshServices = async () => {
    setRefreshing(true);
    try {
      await reconcileRuntimeServices();
      setServices(await listRuntimeServices());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Runtime services could not be read");
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setError(null);
    void hydrateRuntimeEnvironments().catch(() => {});
    void refreshServices();
  }, [open]);

  useEffect(() => {
    const selected = specs.find((spec) => spec.id === selectedId) ?? specs[0] ?? null;
    setDraft(selected ? cloneSpec(selected) : null);
    setDeleteArmed(false);
  }, [projectId, selectedId, specs]);

  const validation = useMemo(
    () => (draft ? validateRuntimeEnvironment(draft) : { valid: false, errors: [] }),
    [draft],
  );
  const projectServices = useMemo(
    () => services.filter((service) =>
      !projectId || service.ownerProjectId === projectId || service.mainRoot === projectDir,
    ),
    [projectDir, projectId, services],
  );

  const createEnvironment = async () => {
    if (!projectId) return;
    let index = specs.length + 1;
    while (specs.some((spec) => spec.id === `local-${index}`)) index += 1;
    const spec = createDefaultRuntimeEnvironment(index);
    try {
      await upsert(projectId, spec);
      await select(projectId, spec.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Environment could not be created");
    }
  };

  const save = async () => {
    if (!projectId || !draft || !validation.valid) return;
    setSaving(true);
    setError(null);
    try {
      await upsert(projectId, cloneSpec(draft));
      await select(projectId, draft.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Environment could not be saved");
    } finally {
      setSaving(false);
    }
  };

  const deleteSelected = async () => {
    if (!projectId || !draft) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    await remove(projectId, draft.id).catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : "Environment could not be deleted"),
    );
    setDeleteArmed(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="w-[820px]">
        <DialogTitle className="sr-only">Runtime environments</DialogTitle>
        <DialogDescription className="sr-only">
          Configure isolated setup, services, cleanup and secret references per project.
        </DialogDescription>
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <Box size={15} className="text-acc" />
          <div>
            <div className="text-14 font-semibold tracking-[-0.01em] text-txt">
              Runtime environments
            </div>
            <div className="font-mono text-10 text-fnt">optional · most missions need no runtime</div>
          </div>
          <span className="flex-1" />
          <button
            className="focus-ring flex h-7 w-7 items-center justify-center rounded-md text-fnt hover:bg-card hover:text-txt"
            onClick={() => onOpenChange(false)}
            aria-label="Close runtime environments"
          >
            <X size={14} />
          </button>
        </div>

        {!projectId || !projectDir ? (
          <EmptyState text="Open a project to configure its runtime environments." />
        ) : hydrateError ? (
          <EmptyState text={`Runtime configuration is unavailable: ${hydrateError}`} tone="error" />
        ) : !hydrated ? (
          <EmptyState text="Loading runtime environments…" tone="loading" />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <aside className="flex max-h-48 w-full shrink-0 flex-col border-b border-line bg-panel sm:max-h-none sm:w-52 sm:border-b-0 sm:border-r">
              <div className="flex items-center justify-between px-3 py-2.5">
                <span className="font-mono text-10 uppercase tracking-[.1em] text-fnt">
                  Configurations
                </span>
                <button
                  onClick={() => void createEnvironment()}
                  className="focus-ring flex h-6 w-6 items-center justify-center rounded-md text-fnt hover:bg-card hover:text-acc"
                  aria-label="Create runtime environment"
                >
                  <Plus size={13} />
                </button>
              </div>
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2">
                {specs.length === 0 ? (
                  <button
                    onClick={() => void createEnvironment()}
                    className="focus-ring w-full rounded-lg border border-dashed border-line2 p-3 text-left text-11 text-fnt hover:border-acc/40 hover:text-mut"
                  >
                    <Plus size={14} className="mb-2" />
                    Create the first environment
                  </button>
                ) : (
                  specs.map((spec) => (
                    <button
                      key={spec.id}
                      onClick={() => void select(projectId, spec.id)}
                      aria-pressed={selectedId === spec.id}
                      className={cn(
                        "focus-ring w-full rounded-lg border px-2.5 py-2 text-left",
                        selectedId === spec.id
                          ? "border-acc/45 bg-acc/10"
                          : "border-transparent hover:border-line hover:bg-card",
                      )}
                    >
                      <div className="truncate text-12 font-medium text-txt">{spec.name}</div>
                      <div className="mt-0.5 flex gap-2 font-mono text-10 text-fnt">
                        <span>{spec.services.length} services</span>
                        <span>{spec.secrets.length} refs</span>
                      </div>
                    </button>
                  ))
                )}
              </div>
              <div className="border-t border-line p-2">
                <LiveServices
                  services={projectServices}
                  refreshing={refreshing}
                  refresh={() => void refreshServices()}
                  stop={async (service) => {
                    await stopRuntimeService(
                      service.instanceId,
                      service.serviceId,
                      service.projectRoot,
                    );
                    await refreshServices();
                  }}
                />
              </div>
            </aside>

            {draft ? (
              <main className="min-w-0 flex-1 overflow-y-auto">
                <div className="mx-auto max-w-[590px] space-y-5 px-5 py-5 pb-24">
                  <IdentityEditor draft={draft} update={setDraft} idLocked={specs.some((spec) => spec.id === draft.id)} />
                  <CommandSection
                    title="Setup"
                    description="Runs serially before services start. Each line in argv is one exact argument."
                    commands={draft.setup}
                    onChange={(setup) => setDraft({ ...draft, setup })}
                  />
                  <ServicesEditor draft={draft} update={setDraft} />
                  <CommandSection
                    title="Cleanup"
                    description="Runs serially after every owned service group has stopped."
                    commands={draft.cleanup}
                    onChange={(cleanup) => setDraft({ ...draft, cleanup })}
                  />
                  <SecretsEditor draft={draft} update={setDraft} />
                </div>
              </main>
            ) : (
              <EmptyState text="Optional for advanced E2E work: add a runtime only when a Mission needs a dev server, API or local database." />
            )}
          </div>
        )}

        {draft && projectId && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line bg-panel px-4 py-2.5">
            <div className="min-w-0 flex-1">
              {error ? (
                <p role="alert" aria-live="assertive" className="break-words text-11 text-err">{error}</p>
              ) : validation.valid ? (
                <p className="flex items-center gap-1.5 text-11 text-ok">
                  <Check size={12} /> Ready to save · no secret values stored
                </p>
              ) : (
                <p className="truncate text-11 text-warn" title={validation.errors.join(" · ")}>
                  {validation.errors[0]}
                  {validation.errors.length > 1 ? ` · +${validation.errors.length - 1} more` : ""}
                </p>
              )}
            </div>
            <Button
              variant={deleteArmed ? "danger" : "ghost"}
              size="sm"
              onClick={() => void deleteSelected()}
            >
              <Trash2 size={12} /> {deleteArmed ? "Delete now" : "Delete"}
            </Button>
            <Button size="sm" disabled={!validation.valid || saving} onClick={() => void save()}>
              <Save size={12} /> {saving ? "Saving…" : "Save environment"}
            </Button>
          </div>
        )}
      </DrawerContent>
    </Dialog>
  );
}

function EmptyState({ text, tone }: { text: string; tone?: "error" | "loading" }) {
  return (
    <div
      role={tone === "error" ? "alert" : tone === "loading" ? "status" : undefined}
      aria-live={tone ? (tone === "error" ? "assertive" : "polite") : undefined}
      className="flex min-h-0 flex-1 items-center justify-center p-8"
    >
      <div className="max-w-sm text-center">
        <Box size={24} className={cn("mx-auto mb-3", tone === "error" ? "text-err" : "text-fnt")} aria-hidden />
        <p className={cn("text-12", tone === "error" ? "text-err" : "text-fnt")}>{text}</p>
      </div>
    </div>
  );
}

function SectionTitle({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 text-acc">{icon}</span>
      <div>
        <h3 className="text-13 font-semibold text-txt">{title}</h3>
        <p className="mt-0.5 text-11 leading-relaxed text-fnt">{detail}</p>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="font-mono text-10 uppercase tracking-[.08em] text-fnt">{label}</span>
      {children}
    </label>
  );
}

function IdentityEditor({ draft, update, idLocked }: { draft: RuntimeEnvironmentSpec; update: (spec: RuntimeEnvironmentSpec) => void; idLocked: boolean }) {
  return (
    <section className="space-y-3">
      <SectionTitle icon={<Box size={14} />} title="Environment" detail="A reusable, project-scoped runtime contract for Mission attempts." />
      <div className="grid grid-cols-1 gap-3 rounded-xl border border-line bg-card p-3 sm:grid-cols-2">
        <Field label="Display name">
          <input className={inputClass} value={draft.name} onChange={(event) => update({ ...draft, name: event.target.value })} />
        </Field>
        <Field label="Stable ID">
          <input className={inputClass} value={draft.id} disabled={idLocked} title={idLocked ? "Stable after creation" : undefined} onChange={(event) => update({ ...draft, id: event.target.value })} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Database namespace prefix">
            <div className="relative">
              <Database size={12} className="absolute left-2.5 top-2.5 text-fnt" />
              <input
                className={`${inputClass} pl-8`}
                value={draft.databaseNamespacePrefix ?? ""}
                placeholder="swarmz"
                onChange={(event) => update({ ...draft, databaseNamespacePrefix: event.target.value || null })}
              />
            </div>
          </Field>
        </div>
      </div>
    </section>
  );
}

function CommandSection({
  title,
  description,
  commands,
  onChange,
}: {
  title: string;
  description: string;
  commands: RuntimeCommandSpec[];
  onChange: (commands: RuntimeCommandSpec[]) => void;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <SectionTitle icon={<Square size={13} />} title={title} detail={description} />
        <Button variant="secondary" size="sm" onClick={() => onChange([...commands, newCommand(`${title.toLowerCase()}-${commands.length + 1}`)])}>
          <Plus size={12} /> Add
        </Button>
      </div>
      {commands.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-11 text-fnt">No {title.toLowerCase()} commands.</p>
      ) : (
        <div className="space-y-2">
          {commands.map((command, index) => (
            <CommandEditor
              key={`${command.id}:${index}`}
              command={command}
              onChange={(next) => onChange(commands.map((item, itemIndex) => (itemIndex === index ? next : item)))}
              remove={() => onChange(commands.filter((_, itemIndex) => itemIndex !== index))}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function CommandEditor({ command, onChange, remove }: { command: RuntimeCommandSpec; onChange: (command: RuntimeCommandSpec) => void; remove: () => void }) {
  return (
    <div className="rounded-xl border border-line bg-card p-3">
      <div className="mb-3 flex gap-2">
        <input className={inputClass} value={command.id} onChange={(event) => onChange({ ...command, id: event.target.value })} aria-label="Command ID" />
        <button className="focus-ring flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fnt hover:bg-err/10 hover:text-err" onClick={remove} aria-label="Remove command">
          <Trash2 size={12} />
        </button>
      </div>
      <Field label="argv · one argument per line">
        <textarea
          className={textareaClass}
          spellCheck={false}
          value={command.argv.join("\n")}
          onChange={(event) => onChange({ ...command, argv: event.target.value.split("\n") })}
        />
      </Field>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Field label="Relative cwd">
          <input className={inputClass} value={command.cwdRelative} onChange={(event) => onChange({ ...command, cwdRelative: event.target.value })} />
        </Field>
        <Field label="Timeout ms">
          <input className={inputClass} type="number" value={command.timeoutMs} onChange={(event) => onChange({ ...command, timeoutMs: Number(event.target.value) })} />
        </Field>
        <Field label="Output bytes">
          <input className={inputClass} type="number" value={command.maxOutputBytes} onChange={(event) => onChange({ ...command, maxOutputBytes: Number(event.target.value) })} />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-11 text-mut">
          <input type="checkbox" checked={command.continueOnFailure} onChange={(event) => onChange({ ...command, continueOnFailure: event.target.checked })} />
          Continue after failure
        </label>
        <label className="flex items-center gap-2 text-11 text-mut" title="Required for Mission setup and cleanup so crash recovery may safely retry the exact command.">
          <input type="checkbox" checked={command.idempotent === true} onChange={(event) => onChange({ ...command, idempotent: event.target.checked })} />
          Safe to retry after crash
        </label>
      </div>
    </div>
  );
}

function ServicesEditor({ draft, update }: { draft: RuntimeEnvironmentSpec; update: (spec: RuntimeEnvironmentSpec) => void }) {
  const change = (services: RuntimeServiceSpec[]) => update({ ...draft, services });
  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <SectionTitle icon={<Server size={14} />} title="Long-lived services" detail="Each service owns a process group, deterministic ports and an attempt-specific DB namespace." />
        <Button variant="secondary" size="sm" onClick={() => change([...draft.services, newService(draft.services.length + 1)])}>
          <Plus size={12} /> Add service
        </Button>
      </div>
      {draft.services.map((service, index) => (
        <div key={`${service.id}:${index}`} className="rounded-xl border border-line bg-card p-3">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px] gap-2">
            <input aria-label={`Service ${index + 1} label`} className={inputClass} value={service.label} placeholder="API" onChange={(event) => change(draft.services.map((item, i) => (i === index ? { ...service, label: event.target.value } : item)))} />
            <input aria-label={`Service ${index + 1} stable ID`} className={inputClass} value={service.id} placeholder="api" onChange={(event) => change(draft.services.map((item, i) => (i === index ? { ...service, id: event.target.value } : item)))} />
            <button aria-label={`Remove service ${service.label || index + 1}`} className="focus-ring flex h-8 w-8 items-center justify-center rounded-md text-fnt hover:bg-err/10 hover:text-err" onClick={() => change(draft.services.filter((_, i) => i !== index))}>
              <Trash2 size={12} />
            </button>
          </div>
          <div className="mt-3">
            <CommandEditor
              command={service.command}
              onChange={(command) => change(draft.services.map((item, i) => (i === index ? { ...service, command } : item)))}
              remove={() => change(draft.services.filter((_, i) => i !== index))}
            />
          </div>
          <div className="mt-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-mono text-10 uppercase tracking-[.08em] text-fnt">Owned ports</span>
              <button
                className="focus-ring flex items-center gap-1 rounded-md px-1.5 py-1 font-mono text-10 text-fnt hover:bg-line hover:text-txt"
                onClick={() => change(draft.services.map((item, i) => (i === index ? { ...service, ports: [...service.ports, { env: `PORT_${service.ports.length + 1}`, preferred: null }] } : item)))}
              >
                <Plus size={10} /> port
              </button>
            </div>
            {service.ports.map((port, portIndex) => (
              <div key={`${port.env}:${portIndex}`} className="grid grid-cols-[1fr_1fr_32px] gap-2">
                <input
                  aria-label={`Port ${portIndex + 1} environment variable`}
                  className={inputClass}
                  value={port.env}
                  placeholder="API_PORT"
                  onChange={(event) => change(draft.services.map((item, i) => i === index ? { ...service, ports: service.ports.map((entry, j) => j === portIndex ? { ...entry, env: event.target.value } : entry) } : item))}
                />
                <input
                  aria-label={`Port ${portIndex + 1} preferred port`}
                  className={inputClass}
                  type="number"
                  value={port.preferred ?? ""}
                  placeholder="automatic"
                  onChange={(event) => change(draft.services.map((item, i) => i === index ? { ...service, ports: service.ports.map((entry, j) => j === portIndex ? { ...entry, preferred: event.target.value ? Number(event.target.value) : null } : entry) } : item))}
                />
                <button
                  className="focus-ring flex h-8 w-8 items-center justify-center rounded-md text-fnt hover:bg-err/10 hover:text-err"
                  onClick={() => change(draft.services.map((item, i) => i === index ? { ...service, ports: service.ports.filter((_, j) => j !== portIndex) } : item))}
                  aria-label="Remove port"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-3">
            <Field label="Local health check">
              <input className={inputClass} value={service.healthcheckUrl ?? ""} placeholder="http://127.0.0.1:${API_PORT}/health" onChange={(event) => change(draft.services.map((item, i) => (i === index ? { ...service, healthcheckUrl: event.target.value || null } : item)))} />
            </Field>
          </div>
        </div>
      ))}
      {draft.services.length === 0 && <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-11 text-fnt">No services. Setup-only environments are supported.</p>}
    </section>
  );
}

function SecretsEditor({ draft, update }: { draft: RuntimeEnvironmentSpec; update: (spec: RuntimeEnvironmentSpec) => void }) {
  const change = (secrets: RuntimeSecretBinding[]) => update({ ...draft, secrets });
  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <SectionTitle icon={<KeyRound size={14} />} title="Secret references" detail="Only host environment names or Keychain service references are saved. Values never enter Mission state." />
        <Button variant="secondary" size="sm" onClick={() => change([...draft.secrets, { targetEnv: "API_TOKEN", source: "host_env", sourceKey: "HOST_API_TOKEN", required: true }])}>
          <Plus size={12} /> Add reference
        </Button>
      </div>
      {draft.secrets.map((secret, index) => (
        <div key={`${secret.targetEnv}:${index}`} className="grid grid-cols-[minmax(0,1fr)_32px] gap-2 rounded-xl border border-line bg-card p-3 sm:grid-cols-[1fr_120px_1.4fr_32px]">
          <input aria-label={`Secret ${index + 1} target environment variable`} className={inputClass} value={secret.targetEnv} placeholder="TARGET_ENV" onChange={(event) => change(draft.secrets.map((item, i) => (i === index ? { ...secret, targetEnv: event.target.value } : item)))} />
          <select aria-label={`Secret ${index + 1} source type`} className={`${inputClass} max-sm:col-start-1`} value={secret.source} onChange={(event) => change(draft.secrets.map((item, i) => (i === index ? { ...secret, source: event.target.value as RuntimeSecretBinding["source"] } : item)))}>
            <option value="host_env">Host env</option>
            <option value="keychain">Keychain</option>
          </select>
          <input aria-label={`Secret ${index + 1} source key`} className={`${inputClass} max-sm:col-start-1`} value={secret.sourceKey} placeholder={secret.source === "host_env" ? "HOST_API_TOKEN" : "swarmz/api-token"} onChange={(event) => change(draft.secrets.map((item, i) => (i === index ? { ...secret, sourceKey: event.target.value } : item)))} />
          <button aria-label={`Remove secret reference ${secret.targetEnv || index + 1}`} className="focus-ring flex h-8 w-8 max-sm:col-start-2 max-sm:row-start-1 items-center justify-center rounded-md text-fnt hover:bg-err/10 hover:text-err" onClick={() => change(draft.secrets.filter((_, i) => i !== index))}>
            <Trash2 size={12} />
          </button>
          <label className="col-span-2 flex items-center gap-2 text-11 text-mut sm:col-span-4">
            <input type="checkbox" checked={secret.required} onChange={(event) => change(draft.secrets.map((item, i) => (i === index ? { ...secret, required: event.target.checked } : item)))} />
            Required before runtime start
          </label>
        </div>
      ))}
      {draft.secrets.length === 0 && <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-11 text-fnt">No secret references. Runtime children still start with a cleared environment.</p>}
    </section>
  );
}

function LiveServices({ services, refreshing, refresh, stop }: { services: RuntimeServiceSnapshot[]; refreshing: boolean; refresh: () => void; stop: (service: RuntimeServiceSnapshot) => Promise<void> }) {
  return (
    <div className="flex min-h-0 flex-col">
      <div className="mb-2 flex shrink-0 items-center gap-1.5">
        <span className="font-mono text-10 uppercase tracking-[.08em] text-fnt">Live services</span>
        <span
          className="rounded-sm border border-line2 bg-card px-1.5 py-0.5 font-mono text-10 tabular-nums text-mut"
          aria-label={`${services.length} live ${services.length === 1 ? "service" : "services"}`}
        >
          {services.length}
        </span>
        <button
          type="button"
          className="focus-ring ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fnt hover:bg-card hover:text-txt disabled:cursor-wait disabled:opacity-50"
          onClick={refresh}
          disabled={refreshing}
          aria-label={refreshing ? "Refreshing live services" : "Refresh live services"}
        >
          <RefreshCw size={11} className={refreshing ? "animate-spin" : ""} aria-hidden />
        </button>
      </div>
      <div className="min-h-0 max-h-24 overflow-y-auto pr-1 sm:max-h-48">
        {services.length === 0 ? (
          <p className="text-10 leading-relaxed text-fnt">No owned service processes.</p>
        ) : (
          <div className="space-y-1.5">
            {services.map((service) => (
              <div key={`${service.instanceId}:${service.serviceId}`} className="rounded-md border border-line bg-card p-2">
                <div className="flex items-center gap-1.5">
                  <span className={cn("h-1.5 w-1.5 rounded-full", service.state === "running" ? "bg-ok" : service.state === "orphaned" ? "bg-warn" : "bg-fnt")} aria-hidden />
                  <span className="sr-only">{service.state}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-10 text-mut">{service.serviceId}</span>
                  <button
                    type="button"
                    className="focus-ring flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fnt hover:bg-err/10 hover:text-err"
                    onClick={() => void stop(service)}
                    aria-label={`Stop live service ${service.serviceId}`}
                  >
                    <Square size={10} aria-hidden />
                  </button>
                </div>
                <div className="mt-1 truncate font-mono text-10 text-fnt">
                  {Object.entries(service.ports).map(([name, port]) => `${name}=${port}`).join(" · ") || service.state}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
