import { useState, useSyncExternalStore } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import {
  persistenceHealthRevision,
  persistenceIssues,
  retryPersistenceWrites,
  subscribePersistenceHealth,
} from "@/lib/persistence/coordinator";
import { cn } from "@/lib/utils";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

/** Persistent fail-closed state must never look like a successful mutation. */
export function PersistenceHealthBanner() {
  useSyncExternalStore(
    subscribePersistenceHealth,
    persistenceHealthRevision,
    persistenceHealthRevision,
  );
  const issues = persistenceIssues();
  const [retrying, setRetrying] = useState(false);
  if (issues.length === 0) return null;

  const readFailed = issues.some((issue) => issue.health.hydration === "failed");
  const names = issues.map((issue) => issue.name).join(", ");
  const detail = issues
    .map((issue) => `${issue.name}: ${errorText(issue.health.error)}`)
    .join("\n");

  return (
    <div
      role="alert"
      title={detail}
      className="flex min-h-10 shrink-0 items-center gap-2 border-b border-err/35 bg-err/10 px-4 text-12 text-err"
    >
      <AlertTriangle size={14} className="shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        {readFailed
          ? `Local data could not be read (${names}). Writes are paused to protect it; restart after resolving the storage error.`
          : `Local changes could not be saved (${names}). SwarmZ is retry-safe and will not report them as durable.`}
      </span>
      {!readFailed && (
        <button
          type="button"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            void retryPersistenceWrites().finally(() => setRetrying(false));
          }}
          className={cn(
            "focus-ring flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-err/40 px-2 font-mono text-11 hover:bg-err/10",
            retrying && "opacity-60",
          )}
        >
          <RefreshCw size={11} className={retrying ? "animate-spin" : ""} />
          Retry save
        </button>
      )}
    </div>
  );
}
