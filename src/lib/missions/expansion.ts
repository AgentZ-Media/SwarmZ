export const MULTI_ROOT_SCHEMA_VERSION = 1 as const;
export const MAX_MISSION_ROOTS = 16;
export const MAX_EXPANSION_TASKS = 500;

export interface MissionRootSpec {
  id: string;
  projectId: string;
  path: string;
  repository: string;
  defaultBranch: string;
}

export interface ApiContractRef {
  name: string;
  /** Exact semantic version. Ranges are deliberately unsupported. */
  version: string;
  mode: "publish" | "consume";
}

export interface MultiRootTaskSpec {
  id: string;
  rootId: string;
  title: string;
  kind: "implementation" | "api_contract";
  dependencyIds: string[];
  contracts: ApiContractRef[];
}

export interface MultiRootMissionSpecV1 {
  schemaVersion: typeof MULTI_ROOT_SCHEMA_VERSION;
  roots: MissionRootSpec[];
  tasks: MultiRootTaskSpec[];
}

export interface CrossRepoDependency {
  taskId: string;
  taskRootId: string;
  dependsOnTaskId: string;
  dependsOnRootId: string;
  reason: "declared" | "api_contract";
}

export interface CoordinatedPrStep {
  position: number;
  wave: number;
  taskId: string;
  rootId: string;
  repository: string;
  dependsOnTaskIds: string[];
  contractKeys: string[];
}

export interface MultiRootMissionPlan {
  roots: MissionRootSpec[];
  tasks: MultiRootTaskSpec[];
  crossRepoDependencies: CrossRepoDependency[];
  prOrder: CoordinatedPrStep[];
}

export class MissionExpansionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionExpansionError";
  }
}

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

function safeText(label: string, value: unknown, max: number): string {
  if (typeof value !== "string") throw new MissionExpansionError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new MissionExpansionError(`${label} must be 1..${max} characters`);
  return normalized;
}

function contractKey(contract: Pick<ApiContractRef, "name" | "version">): string {
  return `${contract.name}@${contract.version}`;
}

function validateRoot(root: MissionRootSpec): void {
  if (!root || typeof root !== "object") throw new MissionExpansionError("mission contains an invalid root");
  if (!ID.test(root.id)) throw new MissionExpansionError(`invalid root id: ${root.id}`);
  safeText(`root ${root.id} projectId`, root.projectId, 120);
  const path = safeText(`root ${root.id} path`, root.path, 1_000);
  const components = path.split("/");
  if (
    !path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    components.some((component) => component === "." || component === "..")
  ) {
    throw new MissionExpansionError(`root ${root.id} path must be normalized and absolute`);
  }
  safeText(`root ${root.id} repository`, root.repository, 300);
  const branch = safeText(`root ${root.id} defaultBranch`, root.defaultBranch, 200);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.endsWith(".lock")
  ) {
    throw new MissionExpansionError(`root ${root.id} defaultBranch is invalid`);
  }
}

function validateContract(task: MultiRootTaskSpec, contract: ApiContractRef): void {
  if (!contract || typeof contract !== "object") throw new MissionExpansionError(`task ${task.id} has an invalid contract`);
  if (!/^[a-zA-Z][a-zA-Z0-9._/-]{0,119}$/.test(contract.name)) {
    throw new MissionExpansionError(`task ${task.id} has invalid contract name`);
  }
  if (!SEMVER.test(contract.version)) {
    throw new MissionExpansionError(`task ${task.id} contract ${contract.name} needs an exact semantic version`);
  }
  if (contract.mode !== "publish" && contract.mode !== "consume") {
    throw new MissionExpansionError(`task ${task.id} contract ${contract.name} has an invalid mode`);
  }
  if (task.kind !== "api_contract" && contract.mode === "publish") {
    throw new MissionExpansionError(`only api_contract tasks may publish ${contractKey(contract)}`);
  }
}

/** Validate roots/contracts and produce a deterministic global PR sequence. */
export function planMultiRootMission(spec: MultiRootMissionSpecV1): MultiRootMissionPlan {
  if (!spec || typeof spec !== "object") throw new MissionExpansionError("multi-root mission is invalid");
  if (spec.schemaVersion !== MULTI_ROOT_SCHEMA_VERSION) throw new MissionExpansionError("unsupported multi-root schema version");
  if (!Array.isArray(spec.roots)) throw new MissionExpansionError("mission roots must be an array");
  if (spec.roots.length < 1 || spec.roots.length > MAX_MISSION_ROOTS) {
    throw new MissionExpansionError(`mission must contain 1..${MAX_MISSION_ROOTS} roots`);
  }
  if (!Array.isArray(spec.tasks)) throw new MissionExpansionError("mission tasks must be an array");
  if (spec.tasks.length < 1 || spec.tasks.length > MAX_EXPANSION_TASKS) {
    throw new MissionExpansionError(`mission must contain 1..${MAX_EXPANSION_TASKS} tasks`);
  }
  const roots = new Map<string, MissionRootSpec>();
  const paths = new Set<string>();
  for (const root of spec.roots) {
    validateRoot(root);
    if (roots.has(root.id)) throw new MissionExpansionError(`duplicate root id: ${root.id}`);
    if (paths.has(root.path)) throw new MissionExpansionError(`duplicate root path: ${root.path}`);
    roots.set(root.id, root);
    paths.add(root.path);
  }

  const tasks = new Map<string, MultiRootTaskSpec>();
  for (const task of spec.tasks) {
    if (!task || typeof task !== "object") throw new MissionExpansionError("mission contains an invalid task");
    if (!ID.test(task.id)) throw new MissionExpansionError(`invalid task id: ${task.id}`);
    if (tasks.has(task.id)) throw new MissionExpansionError(`duplicate task id: ${task.id}`);
    if (!roots.has(task.rootId)) throw new MissionExpansionError(`task ${task.id} references unknown root ${task.rootId}`);
    safeText(`task ${task.id} title`, task.title, 300);
    if (task.kind !== "implementation" && task.kind !== "api_contract") {
      throw new MissionExpansionError(`task ${task.id} has an invalid kind`);
    }
    if (!Array.isArray(task.dependencyIds)) throw new MissionExpansionError(`task ${task.id} dependencies must be an array`);
    if (task.dependencyIds.length > MAX_EXPANSION_TASKS || new Set(task.dependencyIds).size !== task.dependencyIds.length) {
      throw new MissionExpansionError(`task ${task.id} dependencies are invalid`);
    }
    if (!Array.isArray(task.contracts)) throw new MissionExpansionError(`task ${task.id} contracts must be an array`);
    if (task.contracts.length > 32) throw new MissionExpansionError(`task ${task.id} has too many contracts`);
    task.contracts.forEach((contract) => validateContract(task, contract));
    const contractKeys = task.contracts.map(contractKey);
    if (new Set(contractKeys).size !== contractKeys.length) throw new MissionExpansionError(`task ${task.id} repeats a contract`);
    tasks.set(task.id, {
      ...task,
      title: task.title.trim(),
      dependencyIds: [...task.dependencyIds],
      contracts: task.contracts.map((contract) => ({ ...contract })),
    });
  }
  for (const task of tasks.values()) {
    for (const dependency of task.dependencyIds) {
      if (!tasks.has(dependency) || dependency === task.id) throw new MissionExpansionError(`task ${task.id} has invalid dependency ${dependency}`);
    }
  }

  const publishers = new Map<string, MultiRootTaskSpec>();
  for (const task of tasks.values()) {
    for (const contract of task.contracts) {
      if (contract.mode !== "publish") continue;
      const key = contractKey(contract);
      if (publishers.has(key)) throw new MissionExpansionError(`contract ${key} has multiple publishers`);
      publishers.set(key, task);
    }
  }

  const dependencies = new Map<string, Set<string>>();
  const contractEdges = new Set<string>();
  for (const task of tasks.values()) dependencies.set(task.id, new Set(task.dependencyIds));
  for (const task of tasks.values()) {
    for (const contract of task.contracts) {
      if (contract.mode !== "consume") continue;
      const key = contractKey(contract);
      const publisher = publishers.get(key);
      if (!publisher) throw new MissionExpansionError(`contract ${key} has no publisher`);
      if (publisher.id === task.id) throw new MissionExpansionError(`task ${task.id} cannot consume its own contract`);
      dependencies.get(task.id)!.add(publisher.id);
      contractEdges.add(`${task.id}\u001f${publisher.id}`);
    }
  }

  const remaining = new Set(tasks.keys());
  const completed = new Set<string>();
  const ordered: Array<{ task: MultiRootTaskSpec; wave: number }> = [];
  let wave = 0;
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((id) => [...dependencies.get(id)!].every((dependency) => completed.has(dependency)))
      .sort((a, b) => a.localeCompare(b));
    if (ready.length === 0) throw new MissionExpansionError(`cross-repository dependency cycle: ${[...remaining].sort().join(", ")}`);
    for (const id of ready) {
      remaining.delete(id);
      completed.add(id);
      ordered.push({ task: tasks.get(id)!, wave });
    }
    wave += 1;
  }

  const crossRepoDependencies: CrossRepoDependency[] = [];
  for (const task of tasks.values()) {
    for (const dependencyId of [...dependencies.get(task.id)!].sort()) {
      const dependency = tasks.get(dependencyId)!;
      if (dependency.rootId === task.rootId) continue;
      crossRepoDependencies.push({
        taskId: task.id,
        taskRootId: task.rootId,
        dependsOnTaskId: dependencyId,
        dependsOnRootId: dependency.rootId,
        reason: contractEdges.has(`${task.id}\u001f${dependencyId}`) ? "api_contract" : "declared",
      });
    }
  }
  crossRepoDependencies.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.dependsOnTaskId.localeCompare(b.dependsOnTaskId));

  return {
    roots: [...roots.values()].map((root) => ({ ...root })),
    tasks: [...tasks.values()],
    crossRepoDependencies,
    prOrder: ordered.map(({ task, wave: taskWave }, position) => ({
      position,
      wave: taskWave,
      taskId: task.id,
      rootId: task.rootId,
      repository: roots.get(task.rootId)!.repository,
      dependsOnTaskIds: [...dependencies.get(task.id)!].sort(),
      contractKeys: task.contracts.map(contractKey).sort(),
    })),
  };
}
