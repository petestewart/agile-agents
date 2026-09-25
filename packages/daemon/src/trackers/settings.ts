/**
 * T326 (D31): the write path for tracker settings, shared by Settings
 * (`/api/settings/trackers`) and `agile tracker` (`tracker.*` RPC). Both go
 * through `store.setTrackerSettings`; trackers read `config.yaml` per call,
 * so a save is live at once. Nothing here returns, logs or echoes a token:
 * a bad input gets a fixed message, never zod's.
 */

import {
  type TrackerSettingsInput,
  TrackerSettingsInputSchema,
  type TrackerSettingsStatus,
  trackerSettingsStatus,
} from '@agile-agents/shared';
import { RpcParamError } from '../gates/rpc';
import type { RpcMethodHandler } from '../rpc';
import type { StateStore } from '../store/store';

export const TRACKER_INPUT_ERROR =
  'invalid tracker settings: send {system: "jira"|"linear", base_url?, email?, token?} (base_url and email are jira only; null removes)';

export function readTrackerSettings(store: StateStore): TrackerSettingsStatus {
  return trackerSettingsStatus(store.getHomeConfig().trackers);
}

/** Parses without ever quoting the input; `undefined` when it is not a valid write. */
export function parseTrackerSettings(input: unknown): TrackerSettingsInput | undefined {
  const parsed = TrackerSettingsInputSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const { system, base_url, email } = parsed.data;
  if (system === 'linear' && (base_url !== undefined || email !== undefined)) return undefined;
  return parsed.data;
}

export async function applyTrackerSettings(
  store: StateStore,
  input: TrackerSettingsInput,
  by: string,
): Promise<TrackerSettingsStatus> {
  const { system, ...patch } = input;
  await store.setTrackerSettings(system, patch, { by });
  return readTrackerSettings(store);
}

/** `tracker.status` / `tracker.set` for `agile tracker`; the CLI is the human's. */
export function buildTrackerRpcMethods(store: StateStore): Record<string, RpcMethodHandler> {
  return {
    'tracker.status': () => readTrackerSettings(store),
    'tracker.set': async (params) => {
      const input = parseTrackerSettings(params);
      if (!input) throw new RpcParamError(TRACKER_INPUT_ERROR);
      return applyTrackerSettings(store, input, 'human');
    },
  };
}
