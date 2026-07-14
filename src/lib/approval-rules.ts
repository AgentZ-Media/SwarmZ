import { invoke } from "@tauri-apps/api/core";
import type { ApprovalRule } from "@/types";

export const MAX_APPROVAL_RULES = 64;
export const MAX_APPROVAL_RULE_TOKENS = 24;
export const MAX_APPROVAL_RULE_TOKEN_BYTES = 256;

export function validApprovalPattern(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_APPROVAL_RULE_TOKENS &&
    value.every(
      (token) =>
        typeof token === "string" &&
        token.length > 0 &&
        new TextEncoder().encode(token).length <= MAX_APPROVAL_RULE_TOKEN_BYTES &&
        !/[\u0000-\u001f\u007f]/.test(token),
    )
  );
}

export function approvalPatternFromPayload(
  payload: Record<string, unknown>,
): string[] | null {
  const pattern = payload.proposedExecpolicyAmendment;
  return validApprovalPattern(pattern) ? [...pattern] : null;
}

export function normalizeApprovalRules(value: unknown): ApprovalRule[] {
  if (!Array.isArray(value)) return [];
  const rules: ApprovalRule[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const candidate = raw as Partial<ApprovalRule>;
    if (
      typeof candidate.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(candidate.id) ||
      !validApprovalPattern(candidate.pattern)
    )
      continue;
    const key = JSON.stringify(candidate.pattern);
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push({
      id: candidate.id,
      pattern: [...candidate.pattern],
      createdAt:
        typeof candidate.createdAt === "number" &&
        Number.isFinite(candidate.createdAt)
          ? candidate.createdAt
          : 0,
    });
    if (rules.length >= MAX_APPROVAL_RULES) break;
  }
  return rules;
}

export function syncNativeApprovalRules(rules: ApprovalRule[]): Promise<void> {
  return invoke("vibe_set_approval_rules", {
    rules: normalizeApprovalRules(rules).map((rule) => rule.pattern),
  });
}
