/**
 * Tool registry — loads `.agile/tools/<name>/tool.yaml` (+ `prompt.md`) into
 * `LoadedTool[]` (T011, design/agile-agents-design.md §7 "Tool framework":
 * "Daemon loads the registry at start").
 *
 * Every directory under `.agile/tools/` that carries a `tool.yaml` is loaded
 * and validated against the shared `ToolDefinitionSchema`; a directory with
 * no `tool.yaml` (e.g. a bare `.gitkeep`) is silently skipped, but an
 * existing `tool.yaml` that fails validation — or whose YAML doesn't even
 * parse — throws immediately, naming the tool directory, rather than
 * dropping a broken tool silently from the registry (the acceptance
 * criterion: "registry loading ... rejects an invalid tool.yaml").
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type ToolDefinition, validateToolDefinition } from '@agile-agents/shared';
import { parse as parseYaml } from 'yaml';
import type { LoadedTool } from './types';

export class ToolRegistryError extends Error {
  constructor(
    public readonly toolName: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolRegistryError';
  }
}

function loadOneTool(toolsDir: string, name: string): LoadedTool | undefined {
  const dir = join(toolsDir, name);
  const yamlPath = join(dir, 'tool.yaml');
  if (!existsSync(yamlPath)) return undefined;

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(yamlPath, 'utf8'));
  } catch (err) {
    throw new ToolRegistryError(
      name,
      `${yamlPath} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let definition: ToolDefinition;
  try {
    definition = validateToolDefinition(raw);
  } catch (err) {
    throw new ToolRegistryError(
      name,
      `${yamlPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (definition.name !== name) {
    throw new ToolRegistryError(
      name,
      `${yamlPath}: tool.yaml's "name" (${JSON.stringify(definition.name)}) must match its directory name (${JSON.stringify(name)})`,
    );
  }

  const promptPath = join(dir, 'prompt.md');
  const prompt = existsSync(promptPath) ? readFileSync(promptPath, 'utf8') : '';

  return { definition, prompt, dir };
}

/**
 * Loads every tool under `<stateRoot>/tools/`. Returns `[]` when the
 * directory doesn't exist yet (pre-`agile init`, or an old state tree from
 * before T011 seeded any tools) — same "empty, not an error" convention as
 * every other `StateStore` list method.
 */
export function loadToolRegistry(stateRoot: string): LoadedTool[] {
  const toolsDir = join(stateRoot, 'tools');
  if (!existsSync(toolsDir)) return [];

  const names = readdirSync(toolsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const tools: LoadedTool[] = [];
  for (const name of names) {
    const loaded = loadOneTool(toolsDir, name);
    if (loaded) tools.push(loaded);
  }
  return tools;
}
