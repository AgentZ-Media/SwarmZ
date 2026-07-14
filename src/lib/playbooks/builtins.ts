import {
  PLAYBOOK_SCHEMA_VERSION,
  type MissionPlaybookV1,
} from "./core";

export const BUILTIN_PLAYBOOK_PACKAGE_VERSION = "1.0.0";

const source = {
  kind: "app",
  packageVersion: BUILTIN_PLAYBOOK_PACKAGE_VERSION,
} as const;

export const RELEASE_HARDENING_PLAYBOOK: MissionPlaybookV1 = {
  schemaVersion: PLAYBOOK_SCHEMA_VERSION,
  id: "release_hardening",
  version: 1,
  title: "Release hardening",
  description:
    "Freeze a release candidate, inspect its risk, run independent verification, and record release evidence.",
  source,
  parameters: [
    {
      name: "release_name",
      type: "string",
      required: true,
      minLength: 2,
      maxLength: 80,
    },
    {
      name: "root",
      type: "string",
      required: true,
      minLength: 1,
      maxLength: 500,
    },
    {
      name: "verification_command",
      type: "string",
      required: true,
      minLength: 2,
      maxLength: 300,
    },
    {
      name: "risk_level",
      type: "enum",
      required: false,
      values: ["normal", "high", "critical"],
      default: "high",
    },
  ],
  tasks: [
    {
      key: "map_release_risk",
      title: "Map {{release_name}} release risk",
      description:
        "Define the release surface, likely regressions, and the evidence needed for a go/no-go decision.",
      role: "architect",
      briefing:
        "Inspect {{root}} for the {{release_name}} candidate. Risk policy is {{risk_level}}. Produce a bounded release map and explicit verification checklist; do not implement changes.",
      dependsOn: [],
      acceptanceCriteria: [
        "Changed surfaces and their release impact are enumerated.",
        "Required checks and rollback conditions are explicit.",
        "Every high-risk surface has an evidence requirement.",
      ],
      rootRef: "{{root}}",
    },
    {
      key: "stabilize_candidate",
      title: "Stabilize {{release_name}} candidate",
      description:
        "Resolve release-blocking defects within the mapped scope while preserving unrelated behavior.",
      role: "implementer",
      briefing:
        "Work in {{root}} from the approved release map. Make only evidence-backed fixes required to stabilize {{release_name}} and report every changed file.",
      dependsOn: ["map_release_risk"],
      acceptanceCriteria: [
        "All mapped release blockers are fixed or explicitly escalated.",
        "Unrelated product behavior and public contracts remain unchanged.",
        "The resulting diff is reviewable and scoped to the candidate.",
      ],
      rootRef: "{{root}}",
    },
    {
      key: "verify_candidate",
      title: "Verify {{release_name}} independently",
      description:
        "Run the release verification from a clean understanding of the acceptance criteria.",
      role: "tester",
      briefing:
        "In {{root}}, run `{{verification_command}}` and the mapped regression checks. Record exact commands, outcomes, and artifact references. Do not waive failures.",
      dependsOn: ["stabilize_candidate"],
      acceptanceCriteria: [
        "The command `{{verification_command}}` passes with recorded output.",
        "Mapped regression checks have explicit pass/fail evidence.",
        "Any flaky or skipped check is surfaced as a release risk.",
      ],
      rootRef: "{{root}}",
    },
    {
      key: "security_release_review",
      title: "Review {{release_name}} security exposure",
      description:
        "Check the final candidate for security regressions in changed trust boundaries.",
      role: "security",
      briefing:
        "Review the stabilized diff and release map in {{root}}. Focus on changed authentication, authorization, secrets, filesystem, process, and network boundaries. Report evidence, not a reusable identity.",
      dependsOn: ["stabilize_candidate"],
      acceptanceCriteria: [
        "Changed trust boundaries are reviewed or explicitly marked not applicable.",
        "No unresolved critical security finding remains.",
        "Findings reference concrete files, checks, or artifacts.",
      ],
      rootRef: "{{root}}",
    },
  ],
};

export const FEATURE_ACROSS_LAYERS_PLAYBOOK: MissionPlaybookV1 = {
  schemaVersion: PLAYBOOK_SCHEMA_VERSION,
  id: "feature_across_layers",
  version: 1,
  title: "Feature across layers",
  description:
    "Turn one feature outcome into a contract-first implementation spanning backend, frontend, verification, and security review.",
  source,
  parameters: [
    {
      name: "feature_name",
      type: "string",
      required: true,
      minLength: 2,
      maxLength: 100,
    },
    {
      name: "root",
      type: "string",
      required: true,
      minLength: 1,
      maxLength: 500,
    },
    {
      name: "contract_surface",
      type: "enum",
      required: false,
      values: ["internal", "public_api", "local_native"],
      default: "internal",
    },
    {
      name: "quality_command",
      type: "string",
      required: true,
      minLength: 2,
      maxLength: 300,
    },
  ],
  tasks: [
    {
      key: "define_feature_contract",
      title: "Define the {{feature_name}} contract",
      description:
        "Resolve scope, data flow, edge cases, and layer ownership before parallel implementation begins.",
      role: "architect",
      briefing:
        "Inspect {{root}} and define the {{contract_surface}} contract for {{feature_name}}. Specify inputs, outputs, errors, migrations, and acceptance evidence without editing implementation files.",
      dependsOn: [],
      acceptanceCriteria: [
        "The feature contract names every affected layer and owner.",
        "Error, empty, loading, cancellation, and compatibility behavior are explicit.",
        "Backend and frontend work can proceed without guessing shared types.",
      ],
      rootRef: "{{root}}",
    },
    {
      key: "implement_service_layer",
      title: "Implement {{feature_name}} service behavior",
      description:
        "Build the data, domain, persistence, or native behavior behind the agreed contract.",
      role: "implementer",
      briefing:
        "Implement the non-UI portion of {{feature_name}} in {{root}} exactly against the approved {{contract_surface}} contract. Add focused tests and report contract deviations immediately.",
      dependsOn: ["define_feature_contract"],
      acceptanceCriteria: [
        "Service behavior matches the approved contract.",
        "Failure and cancellation paths are bounded and tested.",
        "No unrelated public surface is changed.",
      ],
      rootRef: "{{root}}",
    },
    {
      key: "implement_product_surface",
      title: "Implement the {{feature_name}} product surface",
      description:
        "Build the user-facing flow against the stable contract, including real empty and error states.",
      role: "implementer",
      briefing:
        "Implement the UI/product layer for {{feature_name}} in {{root}} against the approved contract. Use the existing design system, real data paths, accessible states, and responsive behavior.",
      dependsOn: ["define_feature_contract"],
      acceptanceCriteria: [
        "The complete happy path is usable with real application state.",
        "Loading, empty, error, disabled, and narrow-layout states are implemented.",
        "Keyboard and screen-reader affordances follow existing product conventions.",
      ],
      rootRef: "{{root}}",
    },
    {
      key: "verify_feature_flow",
      title: "Verify {{feature_name}} end to end",
      description:
        "Exercise the integrated contract and independently verify acceptance behavior.",
      role: "tester",
      briefing:
        "After both implementation tasks land, run `{{quality_command}}` in {{root}} and verify the contract across layers. Record commands, failures, and artifacts; do not infer passes.",
      dependsOn: ["implement_service_layer", "implement_product_surface"],
      acceptanceCriteria: [
        "The command `{{quality_command}}` passes with recorded evidence.",
        "Contract success and failure paths are verified across layer boundaries.",
        "Regressions, skips, and remaining uncertainty are explicit.",
      ],
      rootRef: "{{root}}",
    },
    {
      key: "review_feature_security",
      title: "Review {{feature_name}} trust boundaries",
      description:
        "Review the integrated feature where it accepts, stores, executes, or transmits untrusted data.",
      role: "security",
      briefing:
        "Review the final {{feature_name}} implementation in {{root}} against the {{contract_surface}} contract. Trace untrusted input through every changed trust boundary and record concrete evidence.",
      dependsOn: ["implement_service_layer", "implement_product_surface"],
      acceptanceCriteria: [
        "Changed trust boundaries have explicit findings or not-applicable evidence.",
        "Authorization and data-containment assumptions are verified.",
        "No unresolved critical finding remains before integration.",
      ],
      rootRef: "{{root}}",
    },
  ],
};

export const BUG_BACKLOG_CLEANUP_PLAYBOOK: MissionPlaybookV1 = {
  schemaVersion: PLAYBOOK_SCHEMA_VERSION,
  id: "bug_backlog_cleanup",
  version: 1,
  title: "Bug backlog cleanup",
  description:
    "Normalize a bounded bug batch, cluster shared causes, repair independent lanes, and verify the resulting regression surface.",
  source,
  parameters: [
    {
      name: "backlog_name",
      type: "string",
      required: true,
      minLength: 2,
      maxLength: 100,
    },
    {
      name: "root",
      type: "string",
      required: true,
      minLength: 1,
      maxLength: 500,
    },
    {
      name: "batch_size",
      type: "integer",
      required: false,
      default: 20,
      min: 1,
      max: 50,
    },
    {
      name: "quality_command",
      type: "string",
      required: true,
      minLength: 2,
      maxLength: 300,
    },
  ],
  tasks: [
    {
      key: "triage_backlog",
      title: "Triage {{backlog_name}}",
      description:
        "Validate, deduplicate, cluster, and order a bounded backlog batch before code changes begin.",
      role: "architect",
      briefing:
        "Inspect up to {{batch_size}} items from {{backlog_name}} against {{root}}. Reject duplicates and non-reproducible claims, cluster shared root causes, and define independent repair lanes with acceptance evidence.",
      dependsOn: [],
      acceptanceCriteria: [
        "Every admitted bug has a reproducible symptom or explicit evidence gap.",
        "Duplicates and shared root causes are clustered instead of scheduled twice.",
        "Repair lanes have non-overlapping scope or declared ordering.",
      ],
      rootRef: "{{root}}",
    },
    {
      key: "repair_primary_clusters",
      title: "Repair primary {{backlog_name}} clusters",
      description:
        "Fix the highest-impact independent root-cause clusters from the triage map.",
      role: "implementer",
      briefing:
        "In {{root}}, repair the high-priority clusters admitted by triage. Work from root causes, add regression coverage, and leave unrelated clusters untouched for the parallel lane.",
      dependsOn: ["triage_backlog"],
      acceptanceCriteria: [
        "Each assigned cluster is fixed at its root cause or explicitly blocked.",
        "Every fix has focused regression evidence.",
        "The diff remains within the lane scope defined by triage.",
      ],
      rootRef: "{{root}}",
    },
    {
      key: "repair_secondary_clusters",
      title: "Repair remaining {{backlog_name}} clusters",
      description:
        "Fix the remaining independent root-cause clusters without overlapping the primary lane.",
      role: "implementer",
      briefing:
        "In {{root}}, repair the remaining independent clusters admitted by triage. Respect lane ownership, add regression coverage, and escalate any newly discovered overlap before editing shared files.",
      dependsOn: ["triage_backlog"],
      acceptanceCriteria: [
        "Each assigned cluster is fixed at its root cause or explicitly blocked.",
        "No file-ownership conflict with the primary repair lane remains unresolved.",
        "Regression evidence is attached to every completed cluster.",
      ],
      rootRef: "{{root}}",
    },
    {
      key: "verify_backlog_batch",
      title: "Verify the {{backlog_name}} repair batch",
      description:
        "Run the full quality command and independently replay the admitted bug evidence.",
      role: "tester",
      briefing:
        "After both repair lanes complete, run `{{quality_command}}` in {{root}} and replay the admitted reproduction evidence. Record exact outcomes and do not silently drop unfixed items.",
      dependsOn: ["repair_primary_clusters", "repair_secondary_clusters"],
      acceptanceCriteria: [
        "The command `{{quality_command}}` passes with recorded output.",
        "Every admitted bug is verified fixed, blocked, or needs human input.",
        "No regression failure is waived without an explicit decision.",
      ],
      rootRef: "{{root}}",
    },
    {
      key: "review_backlog_security",
      title: "Review security-sensitive bug repairs",
      description:
        "Check repaired clusters for security regressions and unsafe symptom-only fixes.",
      role: "security",
      briefing:
        "Review the combined {{backlog_name}} repair diff in {{root}}. Prioritize clusters touching untrusted input, authorization, secrets, paths, subprocesses, and network behavior.",
      dependsOn: ["repair_primary_clusters", "repair_secondary_clusters"],
      acceptanceCriteria: [
        "Security-sensitive repair clusters have concrete review evidence.",
        "No symptom-only patch leaves an exploitable root cause unresolved.",
        "No unresolved critical finding remains.",
      ],
      rootRef: "{{root}}",
    },
  ],
};

/** Stable application catalog. Callers may combine it with validated repo templates. */
export const BUILTIN_PLAYBOOKS: readonly MissionPlaybookV1[] = [
  RELEASE_HARDENING_PLAYBOOK,
  FEATURE_ACROSS_LAYERS_PLAYBOOK,
  BUG_BACKLOG_CLEANUP_PLAYBOOK,
];
