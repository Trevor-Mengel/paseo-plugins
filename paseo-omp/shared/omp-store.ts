import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const OMP_PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const WINDOWS_RESERVED_PROFILE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/iu;

export function isOmpProfileName(value: string): boolean {
  return (
    value !== "default" &&
    !value.endsWith(".") &&
    OMP_PROFILE_NAME.test(value) &&
    !WINDOWS_RESERVED_PROFILE.test(value)
  );
}

export const OmpProfileNameSchema = z.string().trim().refine(isOmpProfileName, {
  message: "Invalid named OMP profile",
});
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
  const parsed = OmpProfileNameSchema.safeParse(provider.slice("omp-plugin-".length));
  return parsed.success ? { profile: parsed.data } : undefined;
}
export function storeLabel(store?: OmpStore): string {
  return store?.profile
    ? `Profile: ${store.profile}`
    : store?.agentDir
      ? "Custom agent directory"
      : "Daemon default store";
}
