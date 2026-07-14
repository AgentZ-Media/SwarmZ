export const RUNTIME_COMMAND_TIMEOUT_MAX_MS = 15 * 60_000;
export const RUNTIME_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
export const RUNTIME_SERVICE_CAP = 16;
export const RUNTIME_COMMAND_CAP = 32;

export interface RuntimeCommandSpec {
  id: string;
  /** Direct executable + arguments. Never parsed or joined into a shell string. */
  argv: string[];
  cwdRelative: string;
  timeoutMs: number;
  maxOutputBytes: number;
  continueOnFailure: boolean;
  /** Human assertion required before Mission Control may safely retry it. */
  idempotent?: boolean;
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

export interface PersistedRuntimeEnvironments {
  version: 1;
  byProject: Record<string, RuntimeEnvironmentSpec[]>;
  selectedByProject: Record<string, string | null>;
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

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableJsonValue(entry)]),
    );
  }
  return value;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Small synchronous SHA-256 used for durable, browser-independent spec identity. */
export function sha256Hex(value: string): string {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const bitLength = BigInt(input.length) * 8n;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Number((bitLength >> 32n) & 0xffffffffn));
  view.setUint32(paddedLength - 4, Number(bitLength & 0xffffffffn));
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index++) {
      const left = words[index - 15];
      const right = words[index - 2];
      const s0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const s1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index++) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const first = (h + sigma1 + choose + SHA256_K[index] + words[index]) >>> 0;
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (sigma0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + first) >>> 0;
      d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    for (const [index, value] of [a, b, c, d, e, f, g, h].entries()) {
      state[index] = (state[index] + value) >>> 0;
    }
  }
  return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
}

/** Secret references are hashed, while secret values never enter the spec. */
export function runtimeSpecFingerprint(spec: RuntimeEnvironmentSpec): string {
  const validation = validateRuntimeEnvironment(spec);
  if (!validation.valid) throw new Error(validation.errors.join("; "));
  return `sha256:${sha256Hex(JSON.stringify(stableJsonValue(spec)))}`;
}

function validId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value);
}

function validEnvName(value: string): boolean {
  return /^[A-Z_][A-Z0-9_]{0,79}$/.test(value);
}

function validateCommand(command: RuntimeCommandSpec, prefix: string, errors: string[]) {
  if (!validId(command.id)) errors.push(`${prefix}.id is invalid`);
  if (
    command.argv.length < 1 ||
    command.argv.length > 128 ||
    command.argv.some((argument) => !argument || argument.length > 4_096) ||
    command.argv.reduce((total, argument) => total + argument.length, 0) > 32_768
  )
    errors.push(`${prefix}.argv must contain 1–128 bounded arguments (32 KiB total)`);
  const executableParts = command.argv[0]?.split(/[\\/]/) ?? [];
  const executable = executableParts[executableParts.length - 1]?.toLowerCase();
  if (
    ["sh", "bash", "zsh", "fish", "dash", "cmd", "cmd.exe", "powershell", "pwsh"].includes(
      executable ?? "",
    )
  )
    errors.push(`${prefix}.argv must not invoke a shell`);
  if (
    command.cwdRelative.startsWith("/") ||
    command.cwdRelative.split(/[\\/]/).some((part) => part === "..")
  )
    errors.push(`${prefix}.cwdRelative must stay inside the runtime root`);
  if (command.timeoutMs < 1_000 || command.timeoutMs > RUNTIME_COMMAND_TIMEOUT_MAX_MS)
    errors.push(`${prefix}.timeoutMs must be between 1000 and ${RUNTIME_COMMAND_TIMEOUT_MAX_MS}`);
  if (command.maxOutputBytes < 1_024 || command.maxOutputBytes > RUNTIME_OUTPUT_MAX_BYTES)
    errors.push(`${prefix}.maxOutputBytes must be between 1024 and ${RUNTIME_OUTPUT_MAX_BYTES}`);
  if (command.idempotent !== undefined && typeof command.idempotent !== "boolean")
    errors.push(`${prefix}.idempotent must be a boolean`);
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
  if (spec.secrets.length > 32) errors.push("secret reference cap is 32");
  const commandIds = new Set<string>();
  spec.setup.forEach((command, index) =>
    validateCommand(command, `setup[${index}]`, errors),
  );
  spec.cleanup.forEach((command, index) =>
    validateCommand(command, `cleanup[${index}]`, errors),
  );
  for (const [group, commands] of [
    ["setup", spec.setup],
    ["cleanup", spec.cleanup],
  ] as const) {
    for (const [index, command] of commands.entries()) {
      if (commandIds.has(command.id)) errors.push(`${group}[${index}].id is duplicated`);
      commandIds.add(command.id);
    }
  }
  if (
    spec.databaseNamespacePrefix !== null &&
    (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(spec.databaseNamespacePrefix))
  )
    errors.push("databaseNamespacePrefix is invalid");

  const serviceIds = new Set<string>();
  const requestedPorts = new Set<number>();
  for (const [index, service] of spec.services.entries()) {
    const prefix = `services[${index}]`;
    if (!validId(service.id)) errors.push(`${prefix}.id is invalid`);
    if (!service.label.trim() || service.label.length > 120)
      errors.push(`${prefix}.label must contain 1–120 characters`);
    if (serviceIds.has(service.id)) errors.push(`${prefix}.id is duplicated`);
    serviceIds.add(service.id);
    validateCommand(service.command, `${prefix}.command`, errors);
    if (commandIds.has(service.command.id)) errors.push(`${prefix}.command.id is duplicated`);
    commandIds.add(service.command.id);
    const portNames = new Set<string>();
    for (const [portIndex, port] of service.ports.entries()) {
      if (!validEnvName(port.env))
        errors.push(`${prefix}.ports[${portIndex}].env is invalid`);
      if (portNames.has(port.env))
        errors.push(`${prefix}.ports[${portIndex}].env is duplicated`);
      portNames.add(port.env);
      if (port.preferred !== null) {
        if (port.preferred < 1_024 || port.preferred > 65_535)
          errors.push(`${prefix}.ports[${portIndex}].preferred is outside 1024–65535`);
        if (requestedPorts.has(port.preferred))
          errors.push(`${prefix}.ports[${portIndex}].preferred is duplicated`);
        requestedPorts.add(port.preferred);
      }
    }
    if (service.healthcheckUrl !== null) {
      const match = service.healthcheckUrl.match(
        /^http:\/\/(?:127\.0\.0\.1|localhost):\$\{([A-Z_][A-Z0-9_]*)\}(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?$/,
      );
      if (!match || !portNames.has(match[1]))
        errors.push(
          `${prefix}.healthcheckUrl must use http://127.0.0.1 or localhost with a declared port placeholder`,
        );
    }
  }

  const secretTargets = new Set<string>();
  for (const [index, secret] of spec.secrets.entries()) {
    const prefix = `secrets[${index}]`;
    if (!validEnvName(secret.targetEnv)) errors.push(`${prefix}.targetEnv is invalid`);
    if (!secret.sourceKey.trim() || secret.sourceKey.length > 256)
      errors.push(`${prefix}.sourceKey must contain 1–256 characters`);
    if (secret.source === "host_env" && !validEnvName(secret.sourceKey))
      errors.push(`${prefix}.sourceKey must name a host environment variable`);
    if (
      secret.source === "keychain" &&
      (!/^[a-zA-Z0-9][a-zA-Z0-9._/:-]{0,255}$/.test(secret.sourceKey) ||
        !secret.sourceKey.includes("/"))
    )
      errors.push(`${prefix}.sourceKey must be an opaque Keychain service reference`);
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
