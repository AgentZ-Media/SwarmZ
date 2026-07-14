export const RUNTIME_COMMAND_TIMEOUT_MAX_MS = 15 * 60_000;
export const RUNTIME_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
export const RUNTIME_SERVICE_CAP = 16;
export const RUNTIME_COMMAND_CAP = 32;

export interface RuntimeCommandSpec {
  id: string;
  command: string;
  cwdRelative: string;
  timeoutMs: number;
  maxOutputBytes: number;
  continueOnFailure: boolean;
}

export interface RuntimePortSpec {
  env: string;
  preferred: number | null;
}

export interface RuntimeServiceSpec {
  id: string;
  label: string;
  command: RuntimeCommandSpec;
  ports: RuntimePortSpec[];
  healthcheckUrl: string | null;
}

export interface RuntimeSecretBinding {
  targetEnv: string;
  source: "host_env" | "keychain";
  sourceKey: string;
  required: boolean;
}

export interface RuntimeEnvironmentSpec {
  id: string;
  name: string;
  setup: RuntimeCommandSpec[];
  cleanup: RuntimeCommandSpec[];
  services: RuntimeServiceSpec[];
  secrets: RuntimeSecretBinding[];
  databaseNamespacePrefix: string | null;
}

export interface RuntimeExecutionPlan {
  environmentId: string;
  missionId: string;
  attemptId: string;
  setup: RuntimeCommandSpec[];
  cleanup: RuntimeCommandSpec[];
  services: Array<RuntimeServiceSpec & { assignedPorts: Record<string, number> }>;
  /** References only. Secret values are never part of durable Mission state. */
  secretBindings: RuntimeSecretBinding[];
  injectedEnv: Record<string, string>;
  databaseNamespace: string;
}

export interface RuntimeValidation {
  valid: boolean;
  errors: string[];
}

function validId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value);
}

function validEnvName(value: string): boolean {
  return /^[A-Z_][A-Z0-9_]{0,79}$/.test(value);
}

function validateCommand(command: RuntimeCommandSpec, prefix: string, errors: string[]) {
  if (!validId(command.id)) errors.push(`${prefix}.id is invalid`);
  if (!command.command.trim() || command.command.length > 8_000)
    errors.push(`${prefix}.command must contain 1–8000 characters`);
  if (
    command.cwdRelative.startsWith("/") ||
    command.cwdRelative.split(/[\\/]/).some((part) => part === "..")
  )
    errors.push(`${prefix}.cwdRelative must stay inside the runtime root`);
  if (command.timeoutMs < 1_000 || command.timeoutMs > RUNTIME_COMMAND_TIMEOUT_MAX_MS)
    errors.push(`${prefix}.timeoutMs must be between 1000 and ${RUNTIME_COMMAND_TIMEOUT_MAX_MS}`);
  if (command.maxOutputBytes < 1_024 || command.maxOutputBytes > RUNTIME_OUTPUT_MAX_BYTES)
    errors.push(`${prefix}.maxOutputBytes must be between 1024 and ${RUNTIME_OUTPUT_MAX_BYTES}`);
}

export function validateRuntimeEnvironment(
  spec: RuntimeEnvironmentSpec,
): RuntimeValidation {
  const errors: string[] = [];
  if (!validId(spec.id)) errors.push("environment id is invalid");
  if (!spec.name.trim() || spec.name.length > 120)
    errors.push("environment name must contain 1–120 characters");
  if (spec.setup.length > RUNTIME_COMMAND_CAP)
    errors.push(`setup command cap is ${RUNTIME_COMMAND_CAP}`);
  if (spec.cleanup.length > RUNTIME_COMMAND_CAP)
    errors.push(`cleanup command cap is ${RUNTIME_COMMAND_CAP}`);
  if (spec.services.length > RUNTIME_SERVICE_CAP)
    errors.push(`service cap is ${RUNTIME_SERVICE_CAP}`);
  spec.setup.forEach((command, index) =>
    validateCommand(command, `setup[${index}]`, errors),
  );
  spec.cleanup.forEach((command, index) =>
    validateCommand(command, `cleanup[${index}]`, errors),
  );

  const serviceIds = new Set<string>();
  const requestedPorts = new Set<number>();
  for (const [index, service] of spec.services.entries()) {
    const prefix = `services[${index}]`;
    if (!validId(service.id)) errors.push(`${prefix}.id is invalid`);
    if (serviceIds.has(service.id)) errors.push(`${prefix}.id is duplicated`);
    serviceIds.add(service.id);
    validateCommand(service.command, `${prefix}.command`, errors);
    for (const [portIndex, port] of service.ports.entries()) {
      if (!validEnvName(port.env))
        errors.push(`${prefix}.ports[${portIndex}].env is invalid`);
      if (port.preferred !== null) {
        if (port.preferred < 1_024 || port.preferred > 65_535)
          errors.push(`${prefix}.ports[${portIndex}].preferred is outside 1024–65535`);
        if (requestedPorts.has(port.preferred))
          errors.push(`${prefix}.ports[${portIndex}].preferred is duplicated`);
        requestedPorts.add(port.preferred);
      }
    }
  }

  const secretTargets = new Set<string>();
  for (const [index, secret] of spec.secrets.entries()) {
    const prefix = `secrets[${index}]`;
    if (!validEnvName(secret.targetEnv)) errors.push(`${prefix}.targetEnv is invalid`);
    if (!secret.sourceKey.trim() || secret.sourceKey.length > 256)
      errors.push(`${prefix}.sourceKey must contain 1–256 characters`);
    if (secretTargets.has(secret.targetEnv)) errors.push(`${prefix}.targetEnv is duplicated`);
    secretTargets.add(secret.targetEnv);
    // Durable specs contain references, never inline values. URI-like and
    // multiline source keys are a strong signal that a value was pasted.
    if (/\r|\n|:\/\//.test(secret.sourceKey))
      errors.push(`${prefix}.sourceKey looks like a secret value, not a reference`);
  }
  return { valid: errors.length === 0, errors };
}

function hash(input: string): number {
  let value = 2166136261;
  for (let index = 0; index < input.length; index++) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/** Deterministic allocation keeps retries reproducible while respecting live leases. */
export function allocateRuntimePort(
  leaseKey: string,
  usedPorts: ReadonlySet<number>,
  preferred: number | null,
): number {
  if (preferred !== null && !usedPorts.has(preferred)) return preferred;
  const min = 41_000;
  const count = 9_000;
  const start = hash(leaseKey) % count;
  for (let offset = 0; offset < count; offset++) {
    const candidate = min + ((start + offset) % count);
    if (!usedPorts.has(candidate)) return candidate;
  }
  throw new Error("no runtime ports available in the bounded allocation range");
}

export function buildRuntimeExecutionPlan(
  spec: RuntimeEnvironmentSpec,
  context: { missionId: string; attemptId: string },
  existingPorts: ReadonlySet<number>,
): RuntimeExecutionPlan {
  const validation = validateRuntimeEnvironment(spec);
  if (!validation.valid) throw new Error(validation.errors.join("; "));
  const leased = new Set(existingPorts);
  const injectedEnv: Record<string, string> = {};
  const services = spec.services.map((service) => {
    const assignedPorts: Record<string, number> = {};
    for (const port of service.ports) {
      const assigned = allocateRuntimePort(
        `${context.missionId}:${context.attemptId}:${service.id}:${port.env}`,
        leased,
        port.preferred,
      );
      leased.add(assigned);
      assignedPorts[port.env] = assigned;
      injectedEnv[port.env] = String(assigned);
    }
    return { ...service, assignedPorts };
  });
  const prefix = slug(spec.databaseNamespacePrefix ?? "swarmz") || "swarmz";
  const databaseNamespace = `${prefix}_${slug(context.missionId)}_${slug(context.attemptId)}`.slice(
    0,
    63,
  );
  injectedEnv.SWARMZ_DB_NAMESPACE = databaseNamespace;
  return {
    environmentId: spec.id,
    missionId: context.missionId,
    attemptId: context.attemptId,
    setup: spec.setup,
    cleanup: spec.cleanup,
    services,
    secretBindings: spec.secrets,
    injectedEnv,
    databaseNamespace,
  };
}
