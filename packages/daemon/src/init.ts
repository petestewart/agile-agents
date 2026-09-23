/**
 * `agile init`: creates the state home (`$AGILE_HOME`, default `~/.agile/`)
 * and its layout if missing (D9). Nothing is ever created inside a repo.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type Policy,
  type VendorsConfig,
  validatePolicy,
  validateVendorsConfig,
} from '@agile-agents/shared';
import { stringify as stringifyYaml } from 'yaml';

/** Default `policy.yaml`: every gate is the human's. */
function defaultPolicy(): Policy {
  return validatePolicy({
    gates: {
      land: 'human',
      rule_accept: 'human',
      classifier_review: 'human',
    },
    breaker_signals: [],
  });
}

/** Default `vendors.yaml`: a Claude subscription login. */
function defaultVendorsConfig(): VendorsConfig {
  return validateVendorsConfig({
    claude: {
      accounts: [{ id: 'default', auth: 'subscription' }],
    },
  });
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Every file the layout needs at init; an empty dir gets a `.gitkeep`. */
function layoutFiles(stateRoot: string): Array<[string, string]> {
  const p = (...parts: string[]) => join(stateRoot, ...parts);
  return [
    [p('gates', '.gitkeep'), ''],
    [p('streams', '.gitkeep'), ''],
    [p('threads', '.gitkeep'), ''],
    [p('questions', '.gitkeep'), ''],
    [p('policy.yaml'), stringifyYaml(defaultPolicy())],
    [p('vendors.yaml'), stringifyYaml(defaultVendorsConfig())],
    // The repos this daemon serves; empty until `agile repo add`.
    [p('repos.yaml'), '{}\n'],
    [p('rules', '.gitkeep'), ''],
    // Each attached session's logs (§7.2).
    [p('sessions', '.gitkeep'), ''],
    [p('log', 'events.jsonl'), ''],
    [p('bus', 'inbox', '.gitkeep'), ''],
    [p('bus', 'agents', '.gitkeep'), ''],
  ];
}

export interface InitResult {
  /** The state home that was created (or already existed). */
  home: string;
  /** Alias for `home`. */
  stateRoot: string;
  filesWritten: string[];
}

/** Creates the home and any missing layout file; an existing file is kept, so a rerun writes nothing. */
export function runInit(home: string): InitResult {
  mkdirSync(home, { recursive: true });

  const filesWritten: string[] = [];
  for (const [path, content] of layoutFiles(home)) {
    if (existsSync(path)) continue;
    writeFile(path, content);
    filesWritten.push(path);
  }

  return { home, stateRoot: home, filesWritten };
}
