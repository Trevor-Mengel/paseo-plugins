import { describe, expect, test, vi } from "vitest";
import {
  createStoreQuotaLoader,
  isOmpPluginProvider,
  isOmpProvider,
  ompStoreKey,
} from "../client/omp-store-state";
import { storeForProvider } from "../shared/omp-store";
import type { OmpQuota } from "../shared/quota";

const quota = (provider: string): OmpQuota => ({
  provider,
  label: provider,
  windowLabel: null,
  usedFraction: 0.25,
  status: "ok",
  resetsAt: null,
  recordedAt: 1,
});

describe("profile store client routing", () => {
  test("separates default, profiles and explicit directories for caches and editor identity", () => {
    expect(ompStoreKey()).toBe(ompStoreKey({}));
    expect(
      new Set([
        ompStoreKey(),
        ompStoreKey({ profile: "cloutdesk" }),
        ompStoreKey({ profile: "global-dev-governance" }),
        ompStoreKey({ agentDir: "cloutdesk" }),
      ]).size,
    ).toBe(4);
    expect(storeForProvider("omp-plugin-cloutdesk")).toEqual({ profile: "cloutdesk" });
    expect(isOmpPluginProvider("omp-plugin-cloutdesk")).toBe(true);
    expect(isOmpPluginProvider("omp-plugin")).toBe(true);
    expect(isOmpProvider("omp")).toBe(true);
    expect(isOmpPluginProvider("omp")).toBe(false);
    expect(isOmpProvider("omp-plugin-../cloutdesk")).toBe(false);
    expect(isOmpProvider("codex")).toBe(false);
  });

  test("deduplicates same-store polling and keeps parallel profile results isolated", async () => {
    let time = 0;
    const load = vi.fn(async ({ store }: { store?: { profile?: string } }) => ({
      quotas: [quota(store?.profile ?? "default")],
    }));
    const cached = createStoreQuotaLoader(load, 30_000, () => time);
    const [a, again, b, fallback] = await Promise.all([
      cached({ profile: "a" }),
      cached({ profile: "a" }),
      cached({ profile: "b" }),
      cached(),
    ]);
    expect(load).toHaveBeenCalledTimes(3);
    expect(a).toBe(again);
    expect(a.quotas[0].provider).toBe("a");
    expect(b.quotas[0].provider).toBe("b");
    expect(fallback.quotas[0].provider).toBe("default");
    expect(await cached({ profile: "a" })).toBe(a);
    time = 30_000;
    await cached({ profile: "a" });
    expect(load).toHaveBeenCalledTimes(4);
  });

  test("a profile failure never returns another profile's cached result", async () => {
    const load = vi.fn(async ({ store }: { store?: { profile?: string } }) => {
      if (store?.profile === "bad") throw new Error("unavailable");
      return { quotas: [quota("default")] };
    });
    const cached = createStoreQuotaLoader(load, 30_000);
    await cached();
    await expect(cached({ profile: "bad" })).rejects.toThrow("unavailable");
    await expect(cached({ profile: "bad" })).rejects.toThrow("unavailable");
    expect(load).toHaveBeenCalledTimes(3);
  });
});
