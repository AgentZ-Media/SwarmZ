import { useId, useMemo } from "react";
import {
  Activity,
  Clock3,
  Coins,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import {
  calculateMissionInsights,
  type EstimateRange,
  type InsightConfidence,
  type InsightTaskStatus,
  type MissionInsights,
  type MissionTaskObservation,
} from "@/lib/missions/insights";
import { useMissions } from "@/lib/missions/store";
import type {
  MissionProjection,
  MissionTask,
  QualityGate,
  TaskAttempt,
  TaskStatus,
} from "@/lib/missions/types";
import { cn, formatTokens, formatUsd } from "@/lib/utils";
import { useSwarm } from "@/store";
import type { UsageHistoryEntry } from "@/types";

export interface MissionInsightsPanelProps {
  missionId: string;
  className?: string;
}

export interface MissionInsightsSnapshot {
  missionTitle: string;
  insights: MissionInsights;
  remainingTasks: number;
  referencedUsageSessions: number;
  trackedUsageSessions: number;
  dataWarnings: string[];
}

const FAILURE_FINGERPRINT = /^[a-z0-9][a-z0-9._:/-]{0,119}$/;

/**
 * Pure adapter from durable mission projections and persisted Codex accounting.
 * It never derives failure categories from prose and never attributes one
 * shared session to multiple tasks.
 */
export function buildMissionInsightsSnapshot(
  missionId: string,
  projection: MissionProjection,
  usageHistory: Readonly<Record<string, UsageHistoryEntry>>,
): MissionInsightsSnapshot | null {
  const mission = projection.missions[missionId];
  if (!mission) return null;
  const tasks = Object.values(projection.tasks)
    .filter((task) => task.missionId === missionId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const attemptsByTask = new Map<string, TaskAttempt[]>();
  const sessionOwners = new Map<string, Set<string>>();
  const referencedSessions = new Set<string>();

  for (const task of tasks) {
    const attempts = task.attemptIds
      .map((attemptId) => projection.attempts[attemptId])
      .filter((attempt): attempt is TaskAttempt => Boolean(attempt));
    attemptsByTask.set(task.id, attempts);
    for (const attempt of attempts) {
      if (!attempt.sessionId) continue;
      referencedSessions.add(attempt.sessionId);
      const owners = sessionOwners.get(attempt.sessionId) ?? new Set<string>();
      owners.add(task.id);
      sessionOwners.set(attempt.sessionId, owners);
    }
  }

  const usageBySession = new Map<string, UsageHistoryEntry>();
  for (const entry of Object.values(usageHistory)) {
    if ((entry.runtime ?? "claude") !== "codex") continue;
    const current = usageBySession.get(entry.session_id);
    if (!current || current.last_updated < entry.last_updated) {
      usageBySession.set(entry.session_id, entry);
    }
  }

  const trackedSessions = new Set<string>();
  const sharedSessions = new Set<string>();
  const observations: MissionTaskObservation[] = tasks.map((task) => {
    const attempts = attemptsByTask.get(task.id) ?? [];
    const sessionIds = new Set(
      attempts
        .map((attempt) => attempt.sessionId)
        .filter((sessionId): sessionId is string => Boolean(sessionId)),
    );
    let tokensUsed = 0;
    let costUsd = 0;
    let hasUsage = false;
    for (const sessionId of sessionIds) {
      if ((sessionOwners.get(sessionId)?.size ?? 0) > 1) {
        sharedSessions.add(sessionId);
        continue;
      }
      const usage = usageBySession.get(sessionId);
      if (!usage) continue;
      hasUsage = true;
      trackedSessions.add(sessionId);
      tokensUsed +=
        usage.input_tokens +
        usage.output_tokens +
        usage.cache_creation_tokens +
        usage.cache_read_tokens;
      costUsd += usage.cost_usd;
    }

    const completedDurations = attempts
      .map((attempt) =>
        attempt.startedAt !== null &&
        attempt.finishedAt !== null &&
        attempt.finishedAt >= attempt.startedAt
          ? attempt.finishedAt - attempt.startedAt
          : null,
      )
      .filter((duration): duration is number => duration !== null);
    const failure = explicitFailure(task, attempts, projection.qualityGates);
    return {
      taskId: task.id,
      role: task.role || "unassigned",
      status: insightStatus(task.status),
      attemptCount: attempts.length,
      activeDurationMs:
        completedDurations.length > 0
          ? completedDurations.reduce((sum, duration) => sum + duration, 0)
          : null,
      tokensUsed: hasUsage ? tokensUsed : null,
      costUsd: hasUsage ? costUsd : null,
      failureFingerprint: failure.fingerprint,
      retryable: failure.retryable,
    };
  });

  const dataWarnings: string[] = [];
  if (sharedSessions.size > 0) {
    dataWarnings.push(
      `${sharedSessions.size} shared worker session${sharedSessions.size === 1 ? " was" : "s were"} excluded because its usage cannot be assigned to one task safely.`,
    );
  }
  const missingUsage = [...referencedSessions].filter(
    (sessionId) => !usageBySession.has(sessionId),
  ).length;
  if (missingUsage > 0) {
    dataWarnings.push(
      `${missingUsage} worker session${missingUsage === 1 ? " has" : "s have"} no recorded token history yet. Usage totals are partial.`,
    );
  }

  return {
    missionTitle: mission.title,
    insights: calculateMissionInsights(
      observations,
      Math.max(1, mission.policy.maxParallelAttempts),
    ),
    remainingTasks: observations.filter((observation) =>
      ["pending", "running", "blocked"].includes(observation.status),
    ).length,
    referencedUsageSessions: referencedSessions.size,
    trackedUsageSessions: trackedSessions.size,
    dataWarnings,
  };
}

export function MissionInsightsPanel({
  missionId,
  className,
}: MissionInsightsPanelProps) {
  const titleId = useId();
  const missionSignature = useMissions((state) =>
    missionInsightSignature(state.projection, missionId),
  );
  const usageSignature = useSwarm((state) =>
    Object.values(state.usageHistory)
      .filter((entry) => (entry.runtime ?? "claude") === "codex")
      .sort((a, b) => a.session_id.localeCompare(b.session_id))
      .map(
        (entry) =>
          `${entry.session_id}:${entry.last_updated}:${entry.input_tokens}:${entry.output_tokens}:${entry.cache_creation_tokens}:${entry.cache_read_tokens}:${entry.cost_usd}`,
      )
      .join("|"),
  );
  const hydrateStatus = useMissions((state) => state.hydrateStatus);
  const hydrateError = useMissions((state) => state.hydrateError);

  const computed = useMemo(() => {
    try {
      return {
        snapshot: buildMissionInsightsSnapshot(
          missionId,
          useMissions.getState().projection,
          useSwarm.getState().usageHistory,
        ),
        error: null,
      };
    } catch (error) {
      return {
        snapshot: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [missionId, missionSignature, usageSignature]);

  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-card",
        className,
      )}
    >
      <header className="flex min-h-12 flex-wrap items-center gap-3 border-b border-line px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Activity size={15} className="text-acc" aria-hidden />
            <h2
              id={titleId}
              className="text-14 font-semibold tracking-[-0.01em] text-txt"
            >
              Mission insights
            </h2>
          </div>
          <p className="mt-0.5 truncate text-11 text-mut">
            {computed.snapshot?.missionTitle ?? "Evidence-based mission telemetry"}
          </p>
        </div>
        {computed.snapshot && (
          <span className="rounded-sm border border-line2 bg-panel px-2 py-1 font-mono text-10 tabular-nums text-mut">
            {computed.snapshot.insights.actual.completedTasks}/
            {computed.snapshot.insights.actual.taskCount} complete
          </span>
        )}
      </header>

      {hydrateStatus === "pending" ? (
        <LoadingState />
      ) : hydrateStatus === "failed" || computed.error ? (
        <ErrorState
          message={
            hydrateError ||
            computed.error ||
            "Mission telemetry could not be calculated safely."
          }
        />
      ) : !computed.snapshot ? (
        <div className="flex min-h-40 flex-1 flex-col items-center justify-center px-6 py-8 text-center">
          <Activity size={20} className="text-fnt" aria-hidden />
          <p className="mt-2 text-13 font-medium text-txt">Mission unavailable</p>
          <p className="mt-1 max-w-[48ch] text-11 leading-normal text-mut">
            This mission is no longer present in the durable projection.
          </p>
        </div>
      ) : (
        <InsightsBody snapshot={computed.snapshot} />
      )}
    </section>
  );
}

function InsightsBody({ snapshot }: { snapshot: MissionInsightsSnapshot }) {
  const { actual, etaMs, projectedAdditionalCostUsd, failureClusters, warnings } =
    snapshot.insights;
  const allWarnings = [...warnings, ...snapshot.dataWarnings];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div
        className="grid min-w-0 gap-px bg-line"
        style={{
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(100%, 11rem), 1fr))",
        }}
      >
        <ActualMetric
          icon={<Activity size={13} />}
          label="Outcomes"
          value={`${actual.completedTasks} passed · ${actual.failedTasks} failed`}
          detail={`${actual.taskCount} total tasks`}
        />
        <ActualMetric
          icon={<RotateCcw size={13} />}
          label="Attempts"
          value={`${actual.attempts} runs · ${actual.retries} retries`}
          detail={actual.retries === 0 ? "No repeated attempts" : "Observed, not estimated"}
        />
        <ActualMetric
          icon={<Activity size={13} />}
          label="Tracked tokens"
          value={formatTokens(actual.tokensUsed)}
          detail={usageCoverage(snapshot)}
        />
        <ActualMetric
          icon={<Coins size={13} />}
          label="Tracked cost"
          value={formatUsd(actual.costUsd)}
          detail="Reported session accounting"
        />
      </div>

      <div className="border-t border-line p-4">
        <SectionHeading title="Conservative forecast" detail={`${snapshot.remainingTasks} tasks remain`} />
        <div className="mt-3 divide-y divide-line rounded-lg border border-line bg-panel">
          <ForecastRow
            icon={<Clock3 size={14} />}
            label="Estimated active time"
            estimate={etaMs}
            format={formatDuration}
            complete={snapshot.remainingTasks === 0}
          />
          <ForecastRow
            icon={<Coins size={14} />}
            label="Additional tracked cost"
            estimate={projectedAdditionalCostUsd}
            format={formatUsd}
            complete={snapshot.remainingTasks === 0}
          />
        </div>
      </div>

      <div className="border-t border-line p-4">
        <SectionHeading
          title="Failure clusters"
          detail={`${failureClusters.length} explicit fingerprints`}
        />
        {failureClusters.length === 0 ? (
          <p className="mt-3 rounded-lg border border-line bg-panel px-3 py-3 text-11 leading-normal text-mut">
            No stable gate or runtime failure fingerprints have been recorded.
            Free-form error prose is deliberately not clustered.
          </p>
        ) : (
          <div className="mt-2 divide-y divide-line">
            {failureClusters.map((cluster) => (
              <div
                key={cluster.fingerprint}
                className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2.5"
              >
                <span className="min-w-0 flex-1 break-all font-mono text-11 text-txt">
                  {cluster.fingerprint}
                </span>
                <span className="font-mono text-10 tabular-nums text-err">
                  {cluster.count} task{cluster.count === 1 ? "" : "s"}
                </span>
                <span className="w-full font-mono text-10 tabular-nums text-fnt">
                  {cluster.retryableCount} retryable · {cluster.nonRetryableCount} non-retryable · {cluster.unknownRetryabilityCount} unknown
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {allWarnings.length > 0 && (
        <div className="border-t border-line bg-warn/[0.04] p-4">
          <div className="flex items-center gap-2 text-11 font-medium text-warn">
            <TriangleAlert size={14} aria-hidden /> Evidence limits
          </div>
          <ul className="mt-2 space-y-1.5">
            {allWarnings.map((warning) => (
              <li
                key={warning}
                className="flex gap-2 text-11 leading-normal text-mut"
              >
                <span aria-hidden className="font-mono text-warn">·</span>
                <span className="break-words">{warning}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ActualMetric({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <dl className="min-w-0 bg-card px-4 py-3">
      <dt className="flex items-center gap-1.5 font-mono text-10 text-fnt">
        <span aria-hidden>{icon}</span>
        {label}
      </dt>
      <dd className="mt-1 truncate font-mono text-13 font-medium tabular-nums text-txt" title={value}>
        {value}
      </dd>
      <dd className="mt-0.5 truncate text-10 text-mut" title={detail}>{detail}</dd>
    </dl>
  );
}

function ForecastRow({
  icon,
  label,
  estimate,
  format,
  complete,
}: {
  icon: React.ReactNode;
  label: string;
  estimate: EstimateRange | null;
  format: (value: number) => string;
  complete: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3 px-3 py-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line2 text-fnt" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-11 font-medium text-txt">{label}</span>
          {estimate && <ConfidenceChip confidence={estimate.confidence} />}
        </div>
        {estimate ? (
          <p className="mt-0.5 font-mono text-11 tabular-nums text-mut">
            {format(estimate.point)} · range {format(estimate.low)}–{format(estimate.high)}
          </p>
        ) : (
          <p className="mt-0.5 text-11 text-fnt">
            {complete ? "Complete — no remaining work to project." : "Withheld — insufficient role-matched evidence."}
          </p>
        )}
      </div>
      {estimate && (
        <span className="shrink-0 font-mono text-10 tabular-nums text-fnt">
          n={estimate.sampleSize}
        </span>
      )}
    </div>
  );
}

function ConfidenceChip({ confidence }: { confidence: InsightConfidence }) {
  return (
    <span
      title={
        confidence === "medium"
          ? "At least eight completed samples for each remaining role"
          : "Three to seven completed samples for at least one remaining role"
      }
      className={cn(
        "rounded-sm border px-1.5 py-0.5 font-mono text-10",
        confidence === "medium"
          ? "border-ok/30 bg-ok/10 text-ok"
          : "border-warn/30 bg-warn/10 text-warn",
      )}
    >
      {confidence} confidence
    </span>
  );
}

function SectionHeading({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-12 font-semibold text-txt">{title}</h3>
      <span className="font-mono text-10 tabular-nums text-fnt">{detail}</span>
    </div>
  );
}

function LoadingState() {
  return (
    <div role="status" aria-live="polite" className="space-y-px bg-line">
      {[0, 1, 2].map((item) => (
        <div key={item} className="bg-card px-4 py-4">
          <span className="block h-2 w-24 animate-pulse rounded-full bg-line2" />
          <span className="mt-2 block h-3 w-40 animate-pulse rounded-full bg-line" />
        </div>
      ))}
      <span className="sr-only">Loading mission insights</span>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div role="alert" className="m-3 rounded-lg border border-err/40 bg-err/10 px-3 py-3">
      <div className="flex items-center gap-2 text-12 font-medium text-err">
        <TriangleAlert size={14} aria-hidden /> Insights unavailable
      </div>
      <p className="mt-1 break-words text-11 leading-normal text-mut">{message}</p>
    </div>
  );
}

function explicitFailure(
  task: MissionTask,
  attempts: readonly TaskAttempt[],
  gates: Readonly<Record<string, QualityGate>>,
): { fingerprint: string | null; retryable: boolean | null } {
  if (task.status !== "failed" && task.status !== "blocked" && task.status !== "needs_human") {
    return { fingerprint: null, retryable: null };
  }
  const failedGate = task.qualityGateIds
    .map((gateId) => gates[gateId])
    .filter((gate): gate is QualityGate => gate?.status === "failed")
    .sort((a, b) => Number(b.required) - Number(a.required) || b.updatedAt - a.updatedAt)[0];
  if (failedGate) return { fingerprint: `gate:${failedGate.kind}`, retryable: null };

  for (const attempt of [...attempts].reverse()) {
    const report = attempt.report;
    if (!report) continue;
    const raw = report.failure_fingerprint ?? report.failureFingerprint;
    if (typeof raw !== "string") continue;
    const fingerprint = raw.trim().toLowerCase();
    if (!FAILURE_FINGERPRINT.test(fingerprint)) continue;
    return {
      fingerprint,
      retryable: typeof report.retryable === "boolean" ? report.retryable : null,
    };
  }
  return { fingerprint: null, retryable: null };
}

function insightStatus(status: TaskStatus): InsightTaskStatus {
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "blocked" || status === "needs_human") return "blocked";
  if (status === "running") return "running";
  if (status === "cancelled" || status === "archived") return "cancelled";
  return "pending";
}

function missionInsightSignature(
  projection: MissionProjection,
  missionId: string,
): string {
  const mission = projection.missions[missionId];
  if (!mission) return "missing";
  const parts = [
    `${mission.id}:${mission.revision}:${mission.status}:${mission.policy.maxParallelAttempts}`,
  ];
  for (const task of Object.values(projection.tasks)) {
    if (task.missionId !== missionId) continue;
    parts.push(
      `t:${task.id}:${task.status}:${task.role}:${task.updatedAt}:${task.attemptIds.join(",")}:${task.qualityGateIds.join(",")}`,
    );
    for (const attemptId of task.attemptIds) {
      const attempt = projection.attempts[attemptId];
      if (!attempt) continue;
      parts.push(
        `a:${attempt.id}:${attempt.status}:${attempt.sessionId ?? ""}:${attempt.startedAt ?? ""}:${attempt.finishedAt ?? ""}:${String(attempt.report?.failure_fingerprint ?? attempt.report?.failureFingerprint ?? "")}:${String(attempt.report?.retryable ?? "")}`,
      );
    }
    for (const gateId of task.qualityGateIds) {
      const gate = projection.qualityGates[gateId];
      if (gate) parts.push(`g:${gate.id}:${gate.kind}:${gate.status}:${gate.required}:${gate.updatedAt}`);
    }
  }
  return parts.join("|");
}

function usageCoverage(snapshot: MissionInsightsSnapshot): string {
  if (snapshot.referencedUsageSessions === 0) return "No worker usage linked";
  return `${snapshot.trackedUsageSessions}/${snapshot.referencedUsageSessions} sessions attributed`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 60_000) return `${Math.max(0, Math.round(milliseconds / 1_000))}s`;
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h`;
  const days = hours / 24;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)}d`;
}
