import type { PluginClientContext } from "@getpaseo/plugin/client";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("../client/hub-icon", () => ({ OmpIcon: () => null }));
vi.mock("../client/hub-popover", () => ({ HubPopover: () => null }));
vi.mock("../client/mcp-authorization", () => ({ OmpMcpAuthorizationCard: () => null }));
vi.mock("../client/mcp-popover", () => ({ McpPopover: () => null }));
vi.mock("../client/memory-panel", () => ({ OmpMemoryPanel: () => null }));
vi.mock("../client/memory-popover", () => ({ MemoryPopover: () => null }));
vi.mock("../client/omp-config-surface", () => ({
  OmpConfigSurface: () => null,
  OmpWorkspacePanel: () => null,
}));
vi.mock("../client/provider-icon", () => ({ quotaProviderIcon: () => () => null }));
vi.mock("../client/provider-image", () => ({ OmpImageTimeline: () => null }));
vi.mock("../client/quota-popover", () => ({ QuotaPopover: () => null }));
vi.mock("../client/sessions-popover", () => ({ SessionsPopover: () => null }));

import contribute from "../index.client";
import { listOmpQuotas } from "../shared/quota";

afterEach(() => {
  vi.useRealTimers();
});

test("profile aliases receive MCP controls and only their own cached quota results", async () => {
  vi.useFakeTimers();
  const agents = [
    { id: "governor", provider: "omp-plugin-global-dev-governance", model: "omp:model:opaque-a" },
    { id: "cloutdesk", provider: "omp-plugin-cloutdesk", model: "omp:model:opaque-b" },
    { id: "default", provider: "omp", model: "anthropic/claude-fable-5" },
    { id: "codex", provider: "codex", model: "gpt-5.6-sol" },
  ];
  let onAgentsChanged = () => {};
  const buttons: Array<{
    id: string;
    agentId: string;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  }> = [];
  const rpc = vi.fn(async (definition, input) => {
    if (definition !== listOmpQuotas) return { processes: [] };
    const profile = input.store?.profile;
    const fraction =
      profile === "global-dev-governance" ? 0.9 : profile === "cloutdesk" ? 0.2 : 0.5;
    return {
      quotas: [
        {
          provider: "anthropic",
          label: "Five hour",
          windowLabel: "5h",
          usedFraction: fraction,
          status: "ok",
          resetsAt: null,
          recordedAt: 1,
        },
      ],
    };
  });
  const registration = () => () => {};
  const client = {
    paseo: {
      agents: {
        list: async () => ({
          entries: agents.map((agent) => ({
            agent: { ...agent, cwd: "/same-workspace", workspaceId: "workspace", archivedAt: null },
          })),
          pageInfo: { hasMore: false },
        }),
        subscribe: (callback: () => void) => {
          onAgentsChanged = callback;
          return () => {};
        },
      },
    },
    rpc,
    addWorkspacePanel: registration,
    addCommandCenterItem: registration,
    addSurface: registration,
    addSidebarItem: registration,
    addTimelineRenderer: registration,
    addTimelineTransformer: registration,
    addComposerPill: (options: { id: string; agentId: string }) => {
      const button = { ...options, update: vi.fn(), remove: vi.fn() };
      buttons.push(button);
      return button;
    },
  } as unknown as PluginClientContext;
  const dispose = contribute(client);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(buttons.filter((button) => button.id === "mcp").map((button) => button.agentId)).toEqual(
      ["governor", "cloutdesk"],
    );
    const quota = (agentId: string) => {
      const button = buttons.findLast(
        (button) => button.id === "quota" && button.agentId === agentId,
      );
      if (!button) throw new Error(`Missing quota pill for ${agentId}`);
      return button;
    };
    expect(quota("governor").update).toHaveBeenLastCalledWith(
      expect.objectContaining({ visible: true, label: "Quotas · 90%" }),
    );
    expect(quota("cloutdesk").update).toHaveBeenLastCalledWith(
      expect.objectContaining({ visible: true, label: "Quotas · 20%" }),
    );
    expect(quota("default").update).toHaveBeenLastCalledWith(
      expect.objectContaining({ visible: true, label: "Anthropic · 50%" }),
    );
    expect(quota("codex").update).not.toHaveBeenCalled();
    expect(
      rpc.mock.calls
        .filter(([definition]) => definition === listOmpQuotas)
        .map(([, input]) => input.store?.profile),
    ).toEqual(["global-dev-governance", "cloutdesk", undefined]);

    agents[0].provider = "omp-plugin-cloutdesk";
    onAgentsChanged();
    await vi.advanceTimersByTimeAsync(250);
    expect(quota("governor").update).toHaveBeenLastCalledWith(
      expect.objectContaining({ label: "Quotas · 20%" }),
    );
    expect(rpc.mock.calls.filter(([definition]) => definition === listOmpQuotas)).toHaveLength(3);
  } finally {
    dispose();
  }
});
