/**
 * `gate.*` RPC over a `GateService`, plus the typed RPC errors and param
 * checks every RPC family shares. Params are validated at the boundary
 * with shared's schemas and fail as `RpcParamError` (-32602), which
 * `dispatch()` reports with its own code.
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

/** Free text typed with a decision, capped here so a bad note is -32602, not a store throw. */
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
    // A typed answer with no button press: stored on the pending request, never resolves it.
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
