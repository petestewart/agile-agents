/**
 * T170 (**D17**): the session defaults Settings reads and writes.
 *
 * Reads assemble every step of the resolution order (`resolveSessionDefaults`
 * in shared, the same function attach runs); writes go through the store
 * (`setHomeSessionDefaults`, `setRepoSessionDefaults`) and are stamped with
 * the caller's actor. Nothing is cached: attach reads `config.yaml` and
 * `repos.yaml` per session, so a save applies to the next session without
 * a restart.
 */

import {
  BUILTIN_SESSION_DEFAULTS,
  type HomeConfig,
  KNOWN_MODEL_IDS,
  type RepoEntry,
  type ReposConfig,
  SESSION_VENDORS,
  type SessionDefaultsFields,
  type SessionDefaultsPatch,
  type SessionDefaultsStatus,
  resolveSessionDefaults,
} from '@agile-agents/shared';

export interface SessionDefaultsStore {
  getHomeConfig(): HomeConfig;
  getRepos(): ReposConfig;
  setHomeSessionDefaults(patch: SessionDefaultsPatch, options?: { by?: string }): Promise<unknown>;
  setRepoSessionDefaults(
    name: string,
    patch: SessionDefaultsPatch,
    options?: { by?: string },
  ): Promise<unknown>;
}

function fields(
  vendor?: string,
  model?: string,
  effort?: RepoEntry['effort'],
): SessionDefaultsFields {
  return {
    ...(vendor !== undefined ? { vendor } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };
}

export class SessionDefaultsService {
  constructor(private readonly store: SessionDefaultsStore) {}

  status(): SessionDefaultsStatus {
    const home = this.store.getHomeConfig();
    const repos: SessionDefaultsStatus['repos'] = {};
    for (const [name, entry] of Object.entries(this.store.getRepos())) {
      repos[name] = {
        ...fields(entry.vendor, entry.model, entry.effort),
        resolved: resolveSessionDefaults({ repo: entry, home }),
      };
    }
    return {
      builtin: { ...BUILTIN_SESSION_DEFAULTS },
      home: fields(home.default_vendor, home.default_model, home.default_effort),
      resolved: resolveSessionDefaults({ home }),
      repos,
      vendors: SESSION_VENDORS,
      known_models: KNOWN_MODEL_IDS,
    };
  }

  async setHome(by: string, patch: SessionDefaultsPatch): Promise<SessionDefaultsStatus> {
    await this.store.setHomeSessionDefaults(patch, { by });
    return this.status();
  }

  async setRepo(
    by: string,
    name: string,
    patch: SessionDefaultsPatch,
  ): Promise<SessionDefaultsStatus> {
    await this.store.setRepoSessionDefaults(name, patch, { by });
    return this.status();
  }
}
