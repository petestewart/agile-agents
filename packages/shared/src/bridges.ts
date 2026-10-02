/**
 * T500: an ACP server the daemon downloads into the home (Antigravity's
 * `agy_acp_server`), not one on PATH or behind `npx`. Each install is one
 * folder, `<home>/bridges/<name>/<version>/`, holding the archive as it was
 * downloaded, what it unpacked to, and `manifest.yaml`
 * (`BRIDGE_MANIFEST_FILE`, validated by `BridgeManifestSchema`): where the
 * archive came from, its SHA-256 and size, and when it was installed. The
 * manifest is written last, so a folder without one is not an install.
 *
 * The version and the per-platform URLs are pinned in code
 * (`@agile-agents/acp-client`'s `ANTIGRAVITY_BRIDGE`); the daemon's side is
 * `packages/daemon/src/bridges/`.
 */

import { z } from 'zod';
import { formatZodError } from './ids';
import { SessionVendorSchema } from './session-defaults';

/** The home folder every downloaded bridge lives under (Pete, T500). */
export const BRIDGES_DIR = 'bridges';

/** The install record, beside what it records. */
export const BRIDGE_MANIFEST_FILE = 'manifest.yaml';

/** A host as an ACP registry binary distribution names it. */
export const BRIDGE_PLATFORMS = [
  'darwin-aarch64',
  'darwin-x86_64',
  'linux-aarch64',
  'linux-x86_64',
  'windows-aarch64',
  'windows-x86_64',
] as const;
export const BridgePlatformSchema = z.enum(BRIDGE_PLATFORMS);
export type BridgePlatform = z.infer<typeof BridgePlatformSchema>;

/** A plain file name: no folder, no `..`, nothing hidden. */
const fileName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be a plain file name');

export const BridgeManifestSchema = z
  .object({
    vendor: SessionVendorSchema,
    /** The ACP registry entry (`antigravity-acp`). */
    registry_id: z.string().min(1).max(100),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, 'must be a version like 1.2.1')
      .max(64),
    platform: BridgePlatformSchema,
    /** The pinned URL it was downloaded from: HTTPS only. */
    url: z
      .string()
      .max(500)
      .url()
      .refine((u) => u.startsWith('https://'), 'must be an https:// URL'),
    /** The archive as downloaded, kept in the folder. */
    archive: fileName,
    /** The archive's SHA-256, lowercase hex. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a SHA-256 in lowercase hex'),
    /** The archive's size in bytes. */
    size: z.number().int().positive(),
    /** The server it unpacked, in the folder (`agy_acp_server.par`). */
    command: fileName,
    installed_at: z.string().datetime(),
    /** Who asked: the operator, from Settings or `agile vendors install`. */
    by: z.enum(['human']),
  })
  .strict();
export type BridgeManifest = z.infer<typeof BridgeManifestSchema>;

export function validateBridgeManifest(input: unknown): BridgeManifest {
  const result = BridgeManifestSchema.safeParse(input);
  if (!result.success) throw new Error(formatZodError('BridgeManifest', result.error));
  return result.data;
}

/** `POST /api/settings/vendor-checks/install` and `vendors.install`: install one vendor's bridge. */
export const VendorInstallInputSchema = z.object({ vendor: SessionVendorSchema }).strict();
export type VendorInstallInput = z.infer<typeof VendorInstallInputSchema>;

/** One vendor's downloaded bridge, as Settings → Agents → Vendors and `agile vendors` show it. */
export interface VendorInstallView {
  /** The pinned version an install fetches. */
  version: string;
  /** This host as the registry names it; absent when there's no build for it. */
  platform?: BridgePlatform;
  /** The install's record, once installed. */
  manifest?: BridgeManifest;
  /** An install runs now. */
  installing: boolean;
  /** Why the last install failed, in words. */
  error?: string;
}
