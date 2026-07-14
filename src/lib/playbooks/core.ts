export const PLAYBOOK_SCHEMA_VERSION = 1 as const;
export const MAX_PLAYBOOK_TASKS = 50;
export const MAX_PLAYBOOK_PARAMETERS = 32;

export type TemporaryTaskRole =
  | "architect"
  | "implementer"
  | "tester"
  | "security";

export type PlaybookSource =
  | { kind: "app"; packageVersion: string }
  | { kind: "repo"; relativePath: string; contentHash: string };

export type PlaybookParameter =
  | {
      name: string;
      type: "string";
      required: boolean;
      default?: string;
      minLength?: number;
      maxLength?: number;
    }
  | {
      name: string;
      type: "integer";
      required: boolean;
      default?: number;
      min?: number;
      max?: number;
    }
  | {
      name: string;
      type: "boolean";
      required: boolean;
      default?: boolean;
    }
  | {
      name: string;
      type: "enum";
      required: boolean;
      values: string[];
      default?: string;
    };

export interface PlaybookTaskTemplate {
  key: string;
  title: string;
  description: string;
  role: TemporaryTaskRole;
  /** Assignment briefing only. It must not define identity or memory. */
  briefing: string;
  dependsOn: string[];
  acceptanceCriteria: string[];
  rootRef: string;
}

export interface MissionPlaybookV1 {
  schemaVersion: typeof PLAYBOOK_SCHEMA_VERSION;
  id: string;
  version: number;
  title: string;
  description: string;
  source: PlaybookSource;
  parameters: PlaybookParameter[];
  tasks: PlaybookTaskTemplate[];
}

export interface ExpandedPlaybookTask {
  id: string;
  key: string;
  title: string;
  description: string;
  role: TemporaryTaskRole;
  briefing: string;
  dependencyIds: string[];
  acceptanceCriteria: string[];
  rootRef: string;
}

export interface ExpandedPlaybook {
  playbookId: string;
  playbookVersion: number;
  source: PlaybookSource;
  parameters: Record<string, string | number | boolean>;
  tasks: ExpandedPlaybookTask[];
}

export class PlaybookValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaybookValidationError";
  }
}

const ID = /^[a-z][a-z0-9_-]{0,79}$/;
const PARAM = /^[a-z][a-z0-9_]{0,39}$/;
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;
const FORBIDDEN_FIELDS = new Set([
  "persona",
  "personality",
  "memory",
  "systemPrompt",
  "developerInstructions",
]);

function assertString(label: string, value: unknown, max: number): string {
  if (typeof value !== "string") throw new PlaybookValidationError(`${label} must be a string`);
  const clean = value.trim();
  if (!clean || clean.length > max) {
    throw new PlaybookValidationError(`${label} must be 1..${max} characters`);
  }
  return clean;
}

function assertNoIdentityFields(value: unknown, path: string): void {
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (FORBIDDEN_FIELDS.has(key)) {
      throw new PlaybookValidationError(`${path}.${key} is forbidden; temporary roles receive briefings only`);
    }
  }
}

function validateSource(source: PlaybookSource): void {
  if (!source || typeof source !== "object") throw new PlaybookValidationError("playbook source is invalid");
  assertNoIdentityFields(source, "source");
  if (source.kind === "app") {
    assertString("source.packageVersion", source.packageVersion, 80);
    return;
  }
  if (source.kind !== "repo") throw new PlaybookValidationError("playbook source kind is invalid");
  const path = assertString("source.relativePath", source.relativePath, 240);
  if (path.startsWith("/") || path.includes("..") || path.includes("\\")) {
    throw new PlaybookValidationError("repo playbook path must be safe and relative");
  }
  if (!/^[a-f0-9]{16,128}$/i.test(source.contentHash)) {
    throw new PlaybookValidationError("repo playbook contentHash is invalid");
  }
}

function validateParameter(parameter: PlaybookParameter): void {
  assertNoIdentityFields(parameter, `parameter ${parameter.name}`);
  if (!PARAM.test(parameter.name)) throw new PlaybookValidationError(`invalid parameter name: ${parameter.name}`);
  if (parameter.type === "string") {
    const min = parameter.minLength ?? 0;
    const max = parameter.maxLength ?? 500;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min || max > 4_000) {
      throw new PlaybookValidationError(`invalid string bounds for ${parameter.name}`);
    }
    if (parameter.default !== undefined && (parameter.default.length < min || parameter.default.length > max)) {
      throw new PlaybookValidationError(`default for ${parameter.name} violates its bounds`);
    }
  } else if (parameter.type === "integer") {
    const min = parameter.min ?? -1_000_000;
    const max = parameter.max ?? 1_000_000;
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
      throw new PlaybookValidationError(`invalid integer bounds for ${parameter.name}`);
    }
    if (parameter.default !== undefined && (!Number.isSafeInteger(parameter.default) || parameter.default < min || parameter.default > max)) {
      throw new PlaybookValidationError(`default for ${parameter.name} violates its bounds`);
    }
  } else if (parameter.type === "enum") {
    if (!Array.isArray(parameter.values) || parameter.values.length < 1 || parameter.values.length > 50) {
      throw new PlaybookValidationError(`enum ${parameter.name} needs 1..50 values`);
    }
    const values = parameter.values.map((value) => assertString(`enum ${parameter.name} value`, value, 100));
    if (new Set(values).size !== values.length) throw new PlaybookValidationError(`enum ${parameter.name} has duplicates`);
    if (parameter.default !== undefined && !values.includes(parameter.default)) {
      throw new PlaybookValidationError(`default for ${parameter.name} is not an allowed value`);
    }
  }
}

function assertAcyclic(tasks: readonly PlaybookTaskTemplate[]): void {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string) => {
    if (visited.has(key)) return;
    if (visiting.has(key)) throw new PlaybookValidationError(`playbook task cycle includes ${key}`);
    visiting.add(key);
    const task = byKey.get(key)!;
    for (const dependency of task.dependsOn) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const task of tasks) visit(task.key);
}

export function validatePlaybook(playbook: MissionPlaybookV1): void {
  if (!playbook || typeof playbook !== "object") throw new PlaybookValidationError("playbook is invalid");
  assertNoIdentityFields(playbook, "playbook");
  if (playbook.schemaVersion !== PLAYBOOK_SCHEMA_VERSION) throw new PlaybookValidationError("unsupported playbook schema version");
  if (!ID.test(playbook.id)) throw new PlaybookValidationError("playbook id is invalid");
  if (!Number.isInteger(playbook.version) || playbook.version < 1 || playbook.version > 1_000_000) {
    throw new PlaybookValidationError("playbook version is invalid");
  }
  assertString("playbook title", playbook.title, 200);
  assertString("playbook description", playbook.description, 2_000);
  validateSource(playbook.source);
  if (!Array.isArray(playbook.parameters)) throw new PlaybookValidationError("playbook parameters must be an array");
  if (playbook.parameters.length > MAX_PLAYBOOK_PARAMETERS) throw new PlaybookValidationError(`playbook exceeds ${MAX_PLAYBOOK_PARAMETERS} parameters`);
  const parameterNames = new Set<string>();
  for (const parameter of playbook.parameters) {
    validateParameter(parameter);
    if (parameterNames.has(parameter.name)) throw new PlaybookValidationError(`duplicate parameter: ${parameter.name}`);
    parameterNames.add(parameter.name);
  }
  if (!Array.isArray(playbook.tasks)) throw new PlaybookValidationError("playbook tasks must be an array");
  if (playbook.tasks.length < 1 || playbook.tasks.length > MAX_PLAYBOOK_TASKS) {
    throw new PlaybookValidationError(`playbook must contain 1..${MAX_PLAYBOOK_TASKS} tasks`);
  }
  const keys = new Set<string>();
  for (const task of playbook.tasks) {
    if (!task || typeof task !== "object") throw new PlaybookValidationError("playbook contains an invalid task");
    assertNoIdentityFields(task, `task ${task.key}`);
    if (!ID.test(task.key)) throw new PlaybookValidationError(`invalid task key: ${task.key}`);
    if (keys.has(task.key)) throw new PlaybookValidationError(`duplicate task key: ${task.key}`);
    keys.add(task.key);
    assertString(`task ${task.key} title`, task.title, 300);
    assertString(`task ${task.key} description`, task.description, 4_000);
    assertString(`task ${task.key} briefing`, task.briefing, 4_000);
    assertString(`task ${task.key} rootRef`, task.rootRef, 80);
    if (!(["architect", "implementer", "tester", "security"] as string[]).includes(task.role)) {
      throw new PlaybookValidationError(`task ${task.key} has an unsupported temporary role`);
    }
    if (!Array.isArray(task.dependsOn)) throw new PlaybookValidationError(`task ${task.key} dependencies must be an array`);
    if (task.dependsOn.length > MAX_PLAYBOOK_TASKS || new Set(task.dependsOn).size !== task.dependsOn.length) {
      throw new PlaybookValidationError(`task ${task.key} dependencies are invalid`);
    }
    if (!Array.isArray(task.acceptanceCriteria)) throw new PlaybookValidationError(`task ${task.key} acceptance criteria must be an array`);
    if (task.acceptanceCriteria.length < 1 || task.acceptanceCriteria.length > 30) {
      throw new PlaybookValidationError(`task ${task.key} needs 1..30 acceptance criteria`);
    }
    task.acceptanceCriteria.forEach((criterion) => assertString(`task ${task.key} acceptance criterion`, criterion, 500));
  }
  for (const task of playbook.tasks) {
    for (const dependency of task.dependsOn) {
      if (!keys.has(dependency) || dependency === task.key) {
        throw new PlaybookValidationError(`task ${task.key} has unknown dependency ${dependency}`);
      }
    }
  }
  assertAcyclic(playbook.tasks);
}

function normalizeParameters(
  definitions: readonly PlaybookParameter[],
  input: Readonly<Record<string, unknown>>,
): Record<string, string | number | boolean> {
  const known = new Set(definitions.map((definition) => definition.name));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) throw new PlaybookValidationError(`unknown playbook parameter: ${key}`);
  }
  const output: Record<string, string | number | boolean> = {};
  for (const definition of definitions) {
    const supplied = input[definition.name];
    const value = supplied === undefined ? definition.default : supplied;
    if (value === undefined) {
      if (definition.required) throw new PlaybookValidationError(`missing required parameter: ${definition.name}`);
      continue;
    }
    if (definition.type === "string") {
      if (typeof value !== "string") throw new PlaybookValidationError(`${definition.name} must be a string`);
      const normalized = value.trim();
      const min = definition.minLength ?? 0;
      const max = definition.maxLength ?? 500;
      if (normalized.length < min || normalized.length > max) throw new PlaybookValidationError(`${definition.name} violates its length bounds`);
      output[definition.name] = normalized;
    } else if (definition.type === "integer") {
      if (!Number.isSafeInteger(value)) throw new PlaybookValidationError(`${definition.name} must be an integer`);
      const numeric = value as number;
      if (numeric < (definition.min ?? -1_000_000) || numeric > (definition.max ?? 1_000_000)) {
        throw new PlaybookValidationError(`${definition.name} violates its numeric bounds`);
      }
      output[definition.name] = numeric;
    } else if (definition.type === "boolean") {
      if (typeof value !== "boolean") throw new PlaybookValidationError(`${definition.name} must be boolean`);
      output[definition.name] = value;
    } else {
      if (typeof value !== "string" || !definition.values.includes(value)) {
        throw new PlaybookValidationError(`${definition.name} is not an allowed enum value`);
      }
      output[definition.name] = value;
    }
  }
  return output;
}

function render(template: string, parameters: Readonly<Record<string, string | number | boolean>>): string {
  const rendered = template.replace(PLACEHOLDER, (_match, name: string) => {
    if (!(name in parameters)) throw new PlaybookValidationError(`template references unset parameter: ${name}`);
    return String(parameters[name]);
  });
  if (/\{\{/.test(rendered) || rendered.length > 20_000) throw new PlaybookValidationError("template expansion is invalid or too large");
  return rendered;
}

export function expandPlaybook(
  playbook: MissionPlaybookV1,
  input: Readonly<Record<string, unknown>>,
): ExpandedPlaybook {
  validatePlaybook(playbook);
  const parameters = normalizeParameters(playbook.parameters, input);
  const idByKey = new Map(playbook.tasks.map((task) => [task.key, `${playbook.id}:${playbook.version}:${task.key}`]));
  return {
    playbookId: playbook.id,
    playbookVersion: playbook.version,
    source: { ...playbook.source },
    parameters,
    tasks: playbook.tasks.map((task) => ({
      id: idByKey.get(task.key)!,
      key: task.key,
      title: render(task.title, parameters),
      description: render(task.description, parameters),
      role: task.role,
      briefing: render(task.briefing, parameters),
      dependencyIds: task.dependsOn.map((key) => idByKey.get(key)!),
      acceptanceCriteria: task.acceptanceCriteria.map((criterion) => render(criterion, parameters)),
      rootRef: render(task.rootRef, parameters),
    })),
  };
}

/** Deterministic catalog; same id+version from two sources is rejected. */
export function buildPlaybookCatalog(
  appTemplates: readonly MissionPlaybookV1[],
  repoTemplates: readonly MissionPlaybookV1[],
): MissionPlaybookV1[] {
  const catalog = new Map<string, MissionPlaybookV1>();
  for (const [expected, templates] of [["app", appTemplates], ["repo", repoTemplates]] as const) {
    for (const template of templates) {
      validatePlaybook(template);
      if (template.source.kind !== expected) throw new PlaybookValidationError(`template ${template.id} has the wrong source`);
      const key = `${template.id}@${template.version}`;
      if (catalog.has(key)) throw new PlaybookValidationError(`duplicate playbook release: ${key}`);
      catalog.set(key, template);
    }
  }
  return [...catalog.values()].sort((a, b) => a.id.localeCompare(b.id) || b.version - a.version || a.source.kind.localeCompare(b.source.kind));
}
