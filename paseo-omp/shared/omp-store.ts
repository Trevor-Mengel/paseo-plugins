import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const OmpProfileNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const OmpStoreSchema = z
  .object({
    profile: OmpProfileNameSchema.optional(),
    agentDir: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes("\0"))
      .optional(),
  })
  .strict()
  .refine(
    (value) => !(value.profile && value.agentDir),
    "Choose a profile or agent directory, not both",
  );
export type OmpStore = z.infer<typeof OmpStoreSchema>;
export const listOmpStores = defineRpc({
  name: "paseo-omp.list-stores",
  input: z.object({}).strict(),
  output: z.object({ profiles: z.array(OmpProfileNameSchema).max(128) }),
});

export function storeForProvider(provider: string | undefined): OmpStore | undefined {
  if (!provider?.startsWith("omp-plugin-")) return;
  const profile = provider.slice("omp-plugin-".length);
  return OmpProfileNameSchema.safeParse(profile).success ? { profile } : undefined;
}
export function storeLabel(store?: OmpStore): string {
  return store?.profile
    ? `Profile: ${store.profile}`
    : store?.agentDir
      ? "Custom agent directory"
      : "Daemon default store";
}
