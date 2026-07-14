import type { IntegrationTrain, MissionArtifact } from "@/lib/missions/types";
import { parseApprovedArgv } from "./controller-core";
import type { IntegrationControllerPorts } from "./controller-ports";
import {
  OUTPUT_RECEIPT_LIMIT,
  clipped,
  errorMessage,
  gateGreen,
  stableId,
} from "./controller-support";
import type { RegressionPlan } from "./types";

interface RegressionContext {
  missionId: string;
  approvalId: string;
  root: string;
  worktreePath: string;
  train: IntegrationTrain;
}

interface RegressionHooks {
  persistArtifact(
    missionId: string,
    artifact: Omit<MissionArtifact, "missionId" | "createdAt"> & { createdAt?: number },
  ): Promise<void>;
  blockTrain(context: RegressionContext, detail: string, taskId?: string): Promise<void>;
}

/** Execute direct-argv acceptance gates only after their durable outbox boundary. */
export async function runRegressionPlan(
  ports: IntegrationControllerPorts,
  hooks: RegressionHooks,
  context: RegressionContext,
  plan: RegressionPlan,
  expectedHead: string,
): Promise<void> {
  for (const step of plan.steps) {
    let argv: string[];
    try {
      argv = parseApprovedArgv(step.command);
    } catch (error) {
      await hooks.blockTrain(context, `Approved regression command is unsafe: ${errorMessage(error)}`);
      return;
    }
    const gateId = step.gateIds[0];
    if (!gateId) {
      await hooks.blockTrain(context, "Regression step has no durable quality-gate identity");
      return;
    }
    const operationId = stableId("gateop", plan.planId, step.stepId);
    const record = await ports.enqueue({
      kind: "gate",
      missionId: context.missionId,
      idempotencyKey: operationId,
      payload: { gateId, planId: plan.planId, command: step.command, expectedHead },
    }, stableId("outbox", operationId));
    if (record.status === "delivered") {
      if (!gateGreen(record)) {
        await hooks.blockTrain(context, `Combined regression failed: ${step.label}`);
        return;
      }
      continue;
    }
    if (record.status === "dead_letter") {
      await hooks.blockTrain(context, record.lastError ?? `Combined regression exhausted retries: ${step.label}`);
      return;
    }
    const claimed = await ports.claim(record.id, "integration-controller", 5 * 60_000);
    if (!claimed?.lease || claimed.command.kind !== "gate") return;
    try {
      const evidence = await ports.gitEvidence(context.worktreePath, null, ports.snapshot().gitBin);
      if (evidence.head_sha !== claimed.command.payload.expectedHead.toLowerCase() ||
        evidence.branch !== context.train.integrationBranch || evidence.dirty) {
        throw new Error("integration HEAD changed before combined regression");
      }
      const result = await ports.runAcceptance({
        runId: stableId("accept", plan.planId, step.stepId),
        approvalId: context.approvalId,
        cwd: context.worktreePath,
        approvedRoots: [context.root],
        argv,
        timeoutMs: 15 * 60_000,
        env: {},
      });
      const receipt = {
        status: result.status,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdout: clipped(result.stdout),
        stderr: clipped(result.stderr),
        stdoutTruncated: result.stdoutTruncated || result.stdout.length > OUTPUT_RECEIPT_LIMIT,
        stderrTruncated: result.stderrTruncated || result.stderr.length > OUTPUT_RECEIPT_LIMIT,
        runId: result.runId,
        head: evidence.head_sha,
        headVerified: true,
      };
      await ports.deliver(claimed.id, claimed.lease.claimId, receipt);
      await hooks.persistArtifact(context.missionId, {
        id: stableId("inttest", plan.planId, step.stepId),
        taskId: null,
        attemptId: null,
        kind: "test_result",
        label: "integration-regression",
        uri: null,
        metadata: {
          trainId: context.train.id,
          planId: plan.planId,
          stepId: step.stepId,
          gateIds: [...step.gateIds],
          command: step.command,
          ...receipt,
        },
      });
      if (result.status !== "completed" || result.exitCode !== 0) {
        await hooks.blockTrain(context, `Combined regression failed: ${step.label}`);
        return;
      }
    } catch (error) {
      await ports.fail(claimed.id, claimed.lease.claimId, errorMessage(error), true);
      return;
    }
  }
}
