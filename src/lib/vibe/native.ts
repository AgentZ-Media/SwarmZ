import { invoke } from "@tauri-apps/api/core";
import { useSwarm } from "@/store";
import type { VibeAccess } from "@/types";

export interface NativeSessionStartOptions {
  projectDir: string;
  model?: string;
  effort?: string;
  access: VibeAccess;
}

function codexPath(): string {
  return useSwarm.getState().settings.codexPath ?? "";
}

export function startNativeSession(
  sessionId: string,
  options: NativeSessionStartOptions,
): Promise<{ thread_id: string }> {
  return invoke("vibe_session_start", {
    sessionId,
    cwd: options.projectDir,
    model: options.model ?? null,
    effort: options.effort ?? null,
    access: options.access,
    codexPath: codexPath(),
  });
}

export function resumeNativeSession(
  sessionId: string,
  threadId: string,
  options: NativeSessionStartOptions,
): Promise<{ thread_id: string; resumed: boolean }> {
  return invoke("vibe_session_resume", {
    sessionId,
    threadId,
    cwd: options.projectDir,
    model: options.model ?? null,
    effort: options.effort ?? null,
    access: options.access,
    codexPath: codexPath(),
  });
}

export function sendNativeTurn(
  sessionId: string,
  text: string,
  outputSchema?: Record<string, unknown>,
  requireWorkspace?: boolean,
): Promise<{ turn_id: string | null }> {
  return invoke("vibe_session_send", {
    sessionId,
    text,
    outputSchema: outputSchema ?? null,
    requireWorkspace: requireWorkspace ?? false,
  });
}

export function interruptNativeSession(sessionId: string): Promise<void> {
  return invoke("vibe_session_interrupt", { sessionId });
}

export function compactNativeSession(
  sessionId: string,
): Promise<{ status: string }> {
  return invoke("vibe_session_compact", { sessionId });
}

export function respondNativeApproval(
  sessionId: string,
  approvalId: string,
  decision: "accept" | "acceptForSession" | "decline" | "cancel",
  requireRoutine: boolean,
): Promise<void> {
  return invoke("vibe_session_respond_approval", {
    sessionId,
    approvalId,
    decision,
    requireRoutine,
  });
}

export function setNativeSessionAccess(
  sessionId: string,
  access: VibeAccess,
): Promise<void> {
  return invoke("vibe_session_set_access", { sessionId, access });
}

export function setNativeSessionModelEffort(
  sessionId: string,
  model: string | undefined,
  effort: string | undefined,
): Promise<void> {
  return invoke("vibe_session_set_model_effort", {
    sessionId,
    model: model ?? null,
    effort: effort ?? null,
  });
}

export function closeNativeSession(sessionId: string): Promise<void> {
  return invoke("vibe_session_close", { sessionId });
}

export function steerNativeTurn(
  sessionId: string,
  text: string,
  requireWorkspace?: boolean,
): Promise<{ turn_id: string | null; steered: boolean }> {
  return invoke("vibe_session_steer", {
    sessionId,
    text,
    requireWorkspace: requireWorkspace ?? false,
  });
}

export function setNativeSessionCwd(
  sessionId: string,
  cwd: string,
): Promise<void> {
  return invoke("vibe_session_set_cwd", { sessionId, cwd });
}

export function reviewNativeSession(
  sessionId: string,
  target: string,
  requireWorkspace?: boolean,
): Promise<{
  status: string;
  review: string | null;
  review_thread_id: string;
}> {
  return invoke("vibe_session_review", {
    sessionId,
    target,
    requireWorkspace: requireWorkspace ?? false,
  });
}
