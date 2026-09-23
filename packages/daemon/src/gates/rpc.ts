/**
 * `gate.*` RPC methods over a `GateService` (design §18 "JSON-RPC over unix
 * socket for hooks/adapters"; T018 scope: "CLI `approve`/`breaker
 * clear`; implement these as daemon RPC methods `gate.approve`,
 * `gate.breaker_clear` (+ `gate.list`, `gate.resolve`, `gate.note`); the
 * CLI verbs land with T008, not here."
 *
 * Not wired into `rpc.ts`'s method table by this ticket (rpc.ts is out of
 * scope for T018 — see the pipeline report's wiring instructions for the
 * manager): `daemon.ts` should pass this object as part of
 * `RpcServerOptions.extraMethods` alongside `buildStateRpcMethods`.
 *
 * T018 review fix (finding 5): every handler validates its params at the
 * boundary — reusing shared's own zod schemas (`HilIdSchema`,
 * `HilDecisionSchema`, `BreakerSignalSchema`) via `.safeParse` rather than
 * bare-casting — and throws a typed `RpcError` subclass (`RpcParamError`
 * -32602 for invalid params, `-32001`-range codes for domain errors) instead
 * of letting a destructuring `TypeError` reach `dispatch()`.
 *
 * KNOWN LIMITATION (documented, not fixed — `rpc.ts`'s `dispatch()` is out
 * of this ticket's file ownership): `dispatch()` currently wraps every
 * thrown error the same way, `{ code: INTERNAL_ERROR_CODE (-32603), message:
 * err.message }`, regardless of any `.code` the error carries (see
 * `rpc.ts`'s catch block). So today a JSON-RPC client sees -32603 for every
 * failure from this module, not the specific code named on the error class
 * below. The `.code`/`.data` are still attached for the moment `dispatch()`
 * is extended with one line (`code: err instanceof RpcError ? err.code :
 * INTERNAL_ERROR_CODE`) — flagged for the manager in `.pipeline-report.md`.
 * Every negative-path test therefore asserts on `error.message` (which
 * already carries the specific, correct detail), not `error.code`.
 */

import {
  BREAKER_SIGNALS,
  BreakerSignalSchema,
  HilDecisionSchema,
  HilIdSchema,
  HilNoteSchema,
  MESSAGE_BODY_MAX_CHARS,
  UlidSchema,
} from '@agile-agents/shared';
import type { BreakerSignal, HilDecision, HilId } from '@agile-agents/shared';
import type { RpcMethodHandler } from '../rpc';
import type { GateService } from './service';

const INVALID_PARAMS_CODE = -32602;

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export class RpcParamError extends RpcError {
  constructor(message: string, data?: unknown) {
    super(INVALID_PARAMS_CODE, message, data);
    this.name = 'RpcParamError';
  }
}

/** Shared param checks for every RPC family: failures are `RpcParamError` (-32602). */
export function requireObject(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new RpcParamError('params must be an object', { params });
  }
  return params as Record<string, unknown>;
}

export function requireStreamId(value: unknown, field = 'stream'): string {
  const result = UlidSchema.safeParse(value);
  if (!result.success) {
    throw new RpcParamError(`invalid "${field}": must be a 26-character Crockford-base32 ULID`, {
      [field]: value,
    });
  }
  return result.data;
}

export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcParamError(`invalid "${field}": must be a non-empty string`, { [field]: value });
  }
  return value;
}

function requireHilId(value: unknown): HilId {
  const result = HilIdSchema.safeParse(value);
  if (!result.success) {
    throw new RpcParamError(`invalid "id": must look like HIL-<ulid>`, { id: value });
  }
  return result.data;
}

function requireBy(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcParamError('"by" must be a non-empty string', { by: value });
  }
  return value;
}

/** Optional free text typed with a decision (T039) — validated against the shared cap here so a malformed note is `-32602`, not a schema throw from the store. */
function optionalNote(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new RpcParamError('"note" must be a string', { note: value });
  }
  const result = HilNoteSchema.safeParse(value.trim());
  if (!result.success) {
    throw new RpcParamError(`invalid "note": must be 1-${MESSAGE_BODY_MAX_CHARS} characters`, {
      note: value,
    });
  }
  return result.data;
}

function requireNote(value: unknown): string {
  const note = optionalNote(value);
  if (note === undefined) {
    throw new RpcParamError('"note" is required', { note: value });
  }
  return note;
}

function requireDecision(value: unknown): HilDecision {
  const result = HilDecisionSchema.safeParse(value);
  if (!result.success) {
    throw new RpcParamError('invalid "decision": must be "approve" or "deny"', {
      decision: value,
    });
  }
  return result.data;
}

function requireBreakerSignal(value: unknown): BreakerSignal {
  const result = BreakerSignalSchema.safeParse(value);
  if (!result.success) {
    throw new RpcParamError(`invalid "signal": must be one of ${BREAKER_SIGNALS.join(', ')}`, {
      signal: value,
    });
  }
  return result.data;
}

export function buildGateRpcMethods(service: GateService): Record<string, RpcMethodHandler> {
  return {
    'gate.list': () => service.list(),
    'gate.approve': (params) => {
      const p = requireObject(params);
      const id = requireHilId(p.id);
      const by = requireBy(p.by);
      return service.respond(id, 'approve', by, optionalNote(p.note));
    },
    'gate.deny': (params) => {
      const p = requireObject(params);
      const id = requireHilId(p.id);
      const by = requireBy(p.by);
      return service.respond(id, 'deny', by, optionalNote(p.note));
    },
    'gate.resolve': (params) => {
      const p = requireObject(params);
      const id = requireHilId(p.id);
      const decision = requireDecision(p.decision);
      const by = requireBy(p.by);
      return service.respond(id, decision, by, optionalNote(p.note));
    },
    // T039: a typed answer with no button press. Stores the note on the
    // still-pending request — never resolves the gate itself.
    'gate.note': (params) => {
      const p = requireObject(params);
      const id = requireHilId(p.id);
      const note = requireNote(p.note);
      const by = requireBy(p.by);
      return service.addNote(id, note, by);
    },
    'gate.breaker_clear': (params) => {
      const p = requireObject(params);
      const signal = requireBreakerSignal(p.signal);
      return service.clear(signal);
    },
  };
}
