import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type OmpStore, OmpStoreSchema } from "../shared/omp-store";

const MAX_SETTINGS_BYTES = 64 * 1024;
const storeContext = new AsyncLocalStorage<OmpStore>();

export function withOmpStore<T>(store: OmpStore | undefined, operation: () => T): T {
  return storeContext.run(OmpStoreSchema.parse(store ?? {}), operation);
}

/** Per-request selection, never process.env mutation: concurrent profiles stay isolated. */
export function currentOmpEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const store = storeContext.getStore();
  if (!store?.profile && !store?.agentDir) return source;
  const environment = { ...source };
  for (const name of [
    "PASEO_OMP_AGENT_DIR",
    "OMP_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "OMP_SESSION_DIR",
    "PI_CODING_AGENT_SESSION_DIR",
    "OMP_PROFILE",
    "PI_PROFILE",
    "PI_CONFIG_FILES",
  ])
    delete environment[name];
  if (store.profile) environment.OMP_PROFILE = store.profile;
  else if (store.agentDir) {
    if (!isAbsolute(store.agentDir)) throw new Error("OMP agent directory must be absolute");
    environment.PI_CODING_AGENT_DIR = store.agentDir;
  }
  return environment;
}

/** Root of omp's per-machine agent state (`agent.db`, `history.db`, `memories/`). */
export function ompAgentDir(environment: NodeJS.ProcessEnv = currentOmpEnvironment()): string {
  const home = environment.HOME ?? environment.USERPROFILE ?? homedir();
  const profile = environment.OMP_PROFILE ?? environment.PI_PROFILE;
  if (profile && profile !== "default" && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profile))
    throw new Error("Invalid OMP profile name");
  return (
    environment.PASEO_OMP_AGENT_DIR ??
    environment.OMP_AGENT_DIR ??
    environment.PI_CODING_AGENT_DIR ??
    (profile && profile !== "default"
      ? resolve(home, environment.PI_CONFIG_DIR ?? ".omp", "profiles", profile, "agent")
      : resolve(home, environment.PI_CONFIG_DIR ?? ".omp", "agent"))
  );
}

function configuredSessionDir(agentDir: string): string | undefined {
  for (const settingsPath of [
    join(agentDir, "settings.json"),
    join(agentDir, "..", "settings.json"),
  ]) {
    let descriptor: number;
    try {
      descriptor = openSync(
        settingsPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
    } catch {
      continue;
    }
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) continue;
      const buffer = Buffer.allocUnsafe(stat.size);
      const length = readSync(descriptor, buffer, 0, buffer.length, 0);
      const parsed: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)),
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const value = (parsed as Record<string, unknown>).sessionDir;
      if (
        typeof value !== "string" ||
        !value ||
        value.includes("\0") ||
        Buffer.byteLength(value) > 4_096
      )
        continue;
      return isAbsolute(value) ? value : resolve(dirname(settingsPath), value);
    } catch {
    } finally {
      closeSync(descriptor);
    }
  }
  return;
}

/** OMP's effective session root, honoring its documented environment and settings precedence. */
export function ompSessionDir(environment: NodeJS.ProcessEnv = currentOmpEnvironment()): string {
  const explicit = environment.OMP_SESSION_DIR ?? environment.PI_CODING_AGENT_SESSION_DIR;
  if (explicit) return resolve(explicit);
  const agentDir = ompAgentDir(environment);
  return configuredSessionDir(agentDir) ?? join(agentDir, "sessions");
}
