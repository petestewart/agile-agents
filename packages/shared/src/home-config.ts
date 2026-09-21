/**
 * `<home>/config.yaml` — the state home's own config (PLAN.md §5, D9;
 * design/cockpit-design.md §7.1/§7.2: "started once (`agile daemon start`,
 * detached, pidfile and port in `config.yaml`)").
 *
 * T112: this is the *home* config, not the per-repo `agile.config.yaml`.
 * The daemon is one long-lived process for every registered repo, so the
 * things a client needs to find it — the HTTP port and the unix socket —
 * live here, where a client with no repo cwd can still read them.
 *
 * Unknown keys are refused (`.strict()`), same rule as every other schema
 * in this package: a hand-editable file must fail loudly on a typo rather
 * than silently ignore it.
 */

import { z } from 'zod';
import { EffortSchema } from './effort';
import { formatZodError } from './ids';

/** Built-in default HTTP port for the cockpit/API when `config.yaml` names none. */
export const DEFAULT_DAEMON_PORT = 4600;

export const HomeConfigSchema = z
  .object({
    /** HTTP port for the localhost cockpit/API. `0` lets the OS pick. */
    port: z.number().int().min(0).max(65535).optional(),
    /** Unix socket path for the JSON-RPC API. Defaults to `<home>/agiled.sock`. */
    socketPath: z.string().min(1).optional(),
    /**
     * T130 (**D12**): home-wide session defaults — the third step of the
     * resolution order (`--flag` → the stream's repo entry in `repos.yaml`
     * → here → the provider's own default).
     */
    default_vendor: z.string().min(1).optional(),
    default_model: z.string().min(1).optional(),
    default_effort: EffortSchema.optional(),
  })
  .strict();

export type HomeConfig = z.infer<typeof HomeConfigSchema>;

export function validateHomeConfig(input: unknown): HomeConfig {
  const result = HomeConfigSchema.safeParse(input ?? {});
  if (!result.success) {
    throw new Error(formatZodError('home config', result.error));
  }
  return result.data;
}
