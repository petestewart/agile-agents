/**
 * T467 (D46): a vendor's model option, read out of its `session/new` (or
 * `session/load`, or `session/set_config_option`) reply: the
 * `configOptions` entry with `category: "model"` when it lists models
 * (Claude, Codex, Cursor and Grok, LIVE-CHECKLIST §12), else ACP's
 * `models.availableModels` (Codex's lists model × effort pairs, so it is
 * only the fallback). Pure: the runner sets a pick with it, the catalog
 * keeps it.
 */

import { VENDOR_MODELS_MAX, type VendorModel, VendorModelSchema } from '@agile-agents/shared';

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** A vendor's model option as its reply carried it. */
export interface VendorModelOption {
  /** The config option's id (`model`): what `session/set_config_option` takes. Absent for a `models` list. */
  configId?: string;
  /** The model the session runs now. */
  current?: string;
  options: VendorModel[];
}

/** One option entry, if it parses (a value, and a name, else the value). */
function modelEntry(value: unknown, name: unknown, description: unknown): VendorModel | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = VendorModelSchema.safeParse({
    value,
    name: typeof name === 'string' && name.trim() !== '' ? name.slice(0, 200) : value.slice(0, 200),
    ...(typeof description === 'string' && description !== ''
      ? { description: description.slice(0, 300) }
      : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

/** A select's options, flattening ACP's grouped form (`{group, name, options: [...]}`). */
function selectOptions(list: unknown): VendorModel[] {
  const out: VendorModel[] = [];
  const seen = new Set<string>();
  const add = (items: unknown): void => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (out.length >= VENDOR_MODELS_MAX) return;
      const o = asRecord(item);
      if (o === null) continue;
      if (Array.isArray(o.options) && o.value === undefined) {
        add(o.options);
        continue;
      }
      const entry = modelEntry(o.value, o.name, o.description);
      if (entry === undefined || seen.has(entry.value)) continue;
      seen.add(entry.value);
      out.push(entry);
    }
  };
  add(list);
  return out;
}

/**
 * The model option of a `session/new`/`session/load` reply (or a saved
 * session-state file): `configOptions`' model entry when it lists models,
 * else ACP's `models`. `undefined` when the reply names no list.
 */
export function vendorModelOption(state: unknown): VendorModelOption | undefined {
  const s = asRecord(state);
  if (s === null) return undefined;
  if (Array.isArray(s.configOptions)) {
    for (const item of s.configOptions) {
      const o = asRecord(item);
      if (o === null || (o.category !== 'model' && o.id !== 'model')) continue;
      const options = selectOptions(o.options);
      if (options.length === 0) continue;
      const current = typeof o.currentValue === 'string' ? o.currentValue : undefined;
      return {
        ...(typeof o.id === 'string' ? { configId: o.id } : {}),
        ...(current !== undefined && current !== '' ? { current } : {}),
        options,
      };
    }
  }
  const models = asRecord(s.models);
  if (models !== null && Array.isArray(models.availableModels)) {
    const options: VendorModel[] = [];
    for (const item of models.availableModels) {
      if (options.length >= VENDOR_MODELS_MAX) break;
      const m = asRecord(item);
      const entry = modelEntry(m?.modelId, m?.name, m?.description);
      if (entry !== undefined && !options.some((o) => o.value === entry.value)) options.push(entry);
    }
    if (options.length > 0) {
      const current =
        typeof models.currentModelId === 'string' && models.currentModelId !== ''
          ? models.currentModelId
          : undefined;
      return { ...(current !== undefined ? { current } : {}), options };
    }
  }
  return undefined;
}

/**
 * The `currentValue` of the config option `configId` in a
 * `session/set_config_option` reply's `configOptions` (it need not repeat
 * the option's list), or `undefined` when the reply doesn't name it.
 */
export function currentValueOf(configOptions: unknown, configId: string): string | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  for (const item of configOptions) {
    const o = asRecord(item);
    if (o?.id === configId && typeof o.currentValue === 'string' && o.currentValue !== '') {
      return o.currentValue;
    }
  }
  return undefined;
}

/** A model's name in its vendor's list, else its id. */
export function modelNameIn(option: VendorModelOption | undefined, value: string): string {
  return option?.options.find((o) => o.value === value)?.name ?? value;
}
