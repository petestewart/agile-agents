import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePolicy, validateReposConfig, validateVendorsConfig } from '@agile-agents/shared';
import { parse as parseYaml } from 'yaml';
import { recommendedVendorEntries, runInit } from './init';

let home: string;
let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'agile-init-'));
  // A path that does not exist yet: `agile init` is "create the home if missing".
  home = join(scratch, 'home');
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});
