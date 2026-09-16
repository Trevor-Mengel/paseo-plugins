import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, expect, test, vi } from "vitest";
import contribute from "../index.server";
import { resolveListOmpMemory } from "../server/memory";
import { resolveListOmpConfig } from "../server/omp-config";
import { currentOmpEnvironment, ompAgentDir, ompSessionDir, withOmpStore } from "../server/paths";
import { buildStatefulCommandEnv } from "../server/provider-diagnostics";
import { resolveListOmpQuotas } from "../server/quota";
import { resolveListOmpSessions } from "../server/sessions";
import { OmpStoreSchema } from "../shared/omp-store";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), "paseo-profile-store-"));
  temporaryDirectories.push(root);
  await writeFile(join(root, "config.yml"), `theme:\n  dark: ${name}\n`);
  await writeFile(join(root, "settings.json"), JSON.stringify({ sessionDir: `sessions-${name}` }));
  const history = new DatabaseSync(join(root, "history.db"));
  history.exec(
    "CREATE TABLE history (id INTEGER PRIMARY KEY, prompt TEXT, created_at INTEGER, cwd TEXT, session_id TEXT); CREATE TABLE session_titles (session_id TEXT PRIMARY KEY, title TEXT, updated_at INTEGER)",
  );
  history.prepare("INSERT INTO history VALUES (1, ?, 1000, '/workspace', NULL)").run(name);
  history.close();
  const quota = new DatabaseSync(join(root, "agent.db"));
  quota.exec(
    "CREATE TABLE usage_history (id INTEGER, provider TEXT, account_key TEXT, limit_id TEXT, label TEXT, window_label TEXT, used_fraction REAL, status TEXT, resets_at INTEGER, recorded_at INTEGER)",
  );
  quota
    .prepare(
      "INSERT INTO usage_history VALUES (1, ?, 'fixture-account', 'fixture-limit', ?, NULL, 0.25, NULL, NULL, 1000)",
    )
    .run(name, name);
  quota.close();
  const bank = join(root, "memories", "mnemopi", "banks", `workspace-${name}`);
  await mkdir(bank, { recursive: true });
  const memory = new DatabaseSync(join(bank, "mnemopi.db"));
  memory.exec(
    "CREATE TABLE facts (fact_id TEXT, subject TEXT, predicate TEXT, object TEXT, confidence REAL, timestamp TEXT, created_at TEXT)",
  );
  memory
    .prepare(
      "INSERT INTO facts VALUES ('1', 'fixture', 'profile', ?, 1, '2026-01-01', '2026-01-01')",
    )
    .run(name);
  memory.close();
  return root;
}

test("concurrent store scopes isolate config, history, quota, memory and session paths", async () => {
  const roots = await Promise.all([fixture("alpha"), fixture("beta")]);
  vi.stubEnv("PASEO_OMP_AGENT_DIR", "/daemon-default-must-not-be-read");
  vi.stubEnv("OMP_SESSION_DIR", "/daemon-session-must-not-be-read");
  const results = await Promise.all(
    roots.map((agentDir, index) =>
      withOmpStore({ agentDir }, async () => {
        await new Promise((resolve) => setTimeout(resolve, index === 0 ? 8 : 1));
        const config = await resolveListOmpConfig({});
        const history = resolveListOmpSessions({ cwd: "/workspace" });
        const quota = resolveListOmpQuotas({});
        const memory = await resolveListOmpMemory({ cwd: "/workspace" });
        return {
          config: config.config?.theme?.dark,
          history: history.sessions[0]?.prompt,
          quota: quota.quotas[0]?.provider,
          memory: memory.facts[0]?.object,
          sessionRoot: ompSessionDir(),
          root: ompAgentDir(),
        };
      }),
    ),
  );
  for (const [index, name] of ["alpha", "beta"].entries()) {
    expect(results[index]).toEqual({
      config: name,
      history: name,
      quota: name,
      memory: name,
      sessionRoot: join(roots[index] ?? "missing-fixture", `sessions-${name}`),
      root: roots[index],
    });
  }
  expect(ompAgentDir()).toBe("/daemon-default-must-not-be-read");
  expect(ompSessionDir()).toBe(resolve("/daemon-session-must-not-be-read"));
});

test("a selected profile clears conflicting daemon overrides without mutating its environment", () => {
  const source = {
    HOME: "/fixture",
    PI_CONFIG_DIR: ".omp",
    OMP_PROFILE: "wrong",
    PASEO_OMP_AGENT_DIR: "/wrong",
    PI_CODING_AGENT_DIR: "/wrong",
    PI_CONFIG_FILES: "/wrong/config.yml",
    OMP_SESSION_DIR: "/wrong/sessions",
    SECRET_FIXTURE: "never-forward-to-settings",
  };
  withOmpStore({ profile: "cloutdesk" }, () => {
    const selected = currentOmpEnvironment(source);
    expect(ompAgentDir(selected)).toBe(
      resolve("/fixture", ".omp", "profiles", "cloutdesk", "agent"),
    );
    expect(selected.PI_CONFIG_FILES).toBeUndefined();
    expect(selected.OMP_SESSION_DIR).toBeUndefined();
    const command = buildStatefulCommandEnv(selected);
    expect(command.OMP_PROFILE).toBe("cloutdesk");
    expect(command.SECRET_FIXTURE).toBeUndefined();
  });
  expect(source.OMP_PROFILE).toBe("wrong");
});

test("store selection validates ambiguity, traversal and relative directory input", () => {
  expect(OmpStoreSchema.safeParse({ profile: "../other" }).success).toBe(false);
  expect(OmpStoreSchema.safeParse({ profile: "a", agentDir: "/b" }).success).toBe(false);
  expect(() => withOmpStore({ agentDir: "relative" }, () => ompAgentDir())).toThrow("absolute");
  expect(OmpStoreSchema.parse({})).toEqual({});
});

test("registered RPC handlers carry store selection across asynchronous resolver calls", async () => {
  const alpha = await fixture("alpha");
  const beta = await fixture("beta");
  vi.stubEnv("HOME", alpha);
  vi.stubEnv("PI_CONFIG_DIR", ".omp");
  vi.stubEnv("PASEO_OMP_AGENT_DIR", "/incorrect-daemon-default");
  const handlers = new Map<string, (input: unknown) => unknown>();
  const cleanup = contribute({
    handle(contract: { name: string }, handler: (input: unknown) => unknown) {
      handlers.set(contract.name, handler);
    },
    before: () => () => {},
    registerProvider: () => {},
  } as unknown as PluginServerContext);
  expect(typeof cleanup).toBe("function");
  try {
    for (const [agentDir, name] of [
      [alpha, "alpha"],
      [beta, "beta"],
    ]) {
      const input = { store: { agentDir }, cwd: "/workspace" };
      expect(await handlers.get("paseo-omp.list-quotas")?.(input)).toEqual({
        quotas: [expect.objectContaining({ provider: name })],
      });
      expect(await handlers.get("paseo-omp.list-sessions")?.(input)).toEqual({
        sessions: [expect.objectContaining({ prompt: name })],
      });
      expect(await handlers.get("paseo-omp.list-memory")?.(input)).toEqual(
        expect.objectContaining({ facts: [expect.objectContaining({ object: name })] }),
      );
      expect(await handlers.get("paseo-omp.list-config")?.({ store: { agentDir } })).toEqual(
        expect.objectContaining({ config: { theme: { dark: name } } }),
      );
    }
  } finally {
    cleanup();
  }
});
