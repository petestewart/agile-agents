/**
 * Tool input schemas, discoverable over MCP (review fix, T011): `tools/list`
 * must publish real per-field properties (`path`/`question` for
 * `read_summary`, `command`/`cwd` for `test_run`, etc.) — a bare
 * `z.record(z.string(), z.unknown())` publishes an empty `properties: {}`,
 * which tells a calling agent nothing about what arguments a tool takes.
 *
 * `ToolInputSpec` is the serializable (RPC-safe: plain strings/booleans, no
 * zod instances) description every tool carries in `tool.list`'s result;
 * `zodShapeFromInputSpec` turns one into the `ZodRawShape` the MCP SDK's
 * `registerTool` wants, so both the in-process factory (`mcp-server.ts`,
 * daemon-side) and the real stdio bridge (`cli/commands/mcp.ts`, a separate
 * process reached only via `tool.list` RPC) build the exact same schema from
 * the exact same source of truth.
 */

import { z } from 'zod';

export type ToolFieldType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'unknown';

export interface ToolInputFieldSpec {
  type: ToolFieldType;
  optional: boolean;
}

/** Field name -> spec. Field order is insertion order, same as `Object.entries`/`Object.fromEntries` everywhere else in this codebase. */
export type ToolInputSpec = Record<string, ToolInputFieldSpec>;

/**
 * `tool.yaml`'s `input` block (§7: "ad hoc type sketches ... not data") into
 * a `ToolInputSpec`. Convention (this module's own, since `ToolIoSchema` is
 * a permissive record with no parser of its own — §7's literal example,
 * `{ path: string, question?: string }`, puts the `?` on the *key*; this
 * repo's seeded `tool.yaml`s put it on the *value* instead, `question:
 * 'string?'` — both are accepted so either style keeps working):
 *
 * - A trailing `?` on the key, the value, or both marks the field optional.
 * - The value (minus any trailing `?`), lowercased: `string`/`number`/
 *   `boolean` map directly; anything starting with `[` is `array`; anything
 *   starting with `{` is `object`; anything else (a non-string value, or a
 *   type name this module doesn't recognize) is `unknown` — still
 *   discoverable as a named property, just untyped.
 */
export function inputSpecFromToolIo(io: Record<string, unknown>): ToolInputSpec {
  const spec: ToolInputSpec = {};
  for (const [rawKey, rawValue] of Object.entries(io)) {
    const keyOptional = rawKey.endsWith('?');
    const key = keyOptional ? rawKey.slice(0, -1) : rawKey;
    const rawStr = typeof rawValue === 'string' ? rawValue.trim() : '';
    const valueOptional = rawStr.endsWith('?');
    const token = (valueOptional ? rawStr.slice(0, -1) : rawStr).trim().toLowerCase();

    let type: ToolFieldType;
    if (token === 'string' || token === 'number' || token === 'boolean') {
      type = token;
    } else if (token.startsWith('[')) {
      type = 'array';
    } else if (token.startsWith('{')) {
      type = 'object';
    } else {
      type = 'unknown';
    }

    spec[key] = { type, optional: keyOptional || valueOptional };
  }
  return spec;
}

function zodForFieldType(type: ToolFieldType): z.ZodTypeAny {
  switch (type) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'array':
      return z.array(z.unknown());
    case 'object':
      return z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
}

/** `ToolInputSpec` -> the `ZodRawShape` the MCP SDK's `registerTool`/`server.tool` accept as `inputSchema`. Every field becomes a named, typed property — never a single opaque catch-all. */
export function zodShapeFromInputSpec(spec: ToolInputSpec): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(spec)) {
    const schema = zodForFieldType(field.type);
    shape[key] = field.optional ? schema.optional() : schema;
  }
  return shape;
}

/**
 * Review round 2 (blocker 2): `registerTool`'s `inputSchema` accepts either
 * a raw shape (`ZodRawShapeCompat`) or a full schema (`AnySchema`) — passing
 * the raw shape lets the SDK build its own `z.object(shape)` internally,
 * which zod defaults to *stripping* unknown keys rather than rejecting them
 * (zod's "strip" mode), so `kb_search`'s own unknown-key check inside the
 * handler never even saw the offending key: the SDK's own validation step
 * had already silently dropped it from `args` before the handler ran.
 * Passing a fully-built `z.object(shape).strict()` instead — still an
 * `AnySchema`, so `registerTool` accepts it exactly the same way — makes an
 * unrecognized key fail the SDK's own input validation, which the SDK
 * reports back as an MCP tool error (`isError: true`) naming the key,
 * before the handler is ever invoked.
 */
export function zodObjectSchemaFromInputSpec(
  spec: ToolInputSpec,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  return z.object(zodShapeFromInputSpec(spec)).strict();
}
