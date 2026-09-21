/**
 * `question.*` RPC methods over a `QuestionService` (T121; cockpit design
 * §1.4, §3). Mirrors `gates/rpc.ts` and `streams/rpc.ts`: every handler
 * validates its params at the boundary with shared's own zod schemas and
 * throws `RpcParamError` (-32602) rather than letting a destructuring
 * `TypeError` reach `dispatch()`.
 *
 * T121 re-keyed the params: `stream` (a ULID) replaced `ticket`, and
 * `resolved_as` is `reply` or absent — `decision` and `ticket` resolutions
 * went with the oracle and the ticket model.
 */

import {
  AgentIdSchema,
  QuestionIdSchema,
  QuestionTextSchema,
  UlidSchema,
} from '@agile-agents/shared';
import type { AgentId, QuestionId } from '@agile-agents/shared';
import { RpcParamError } from '../gates/rpc';
import type { RpcMethodHandler } from '../rpc';
import type { AnswerQuestionInput, QuestionService } from './service';

function requireObject(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new RpcParamError('params must be an object', { params });
  }
  return params as Record<string, unknown>;
}

function requireQuestionId(value: unknown): QuestionId {
  const result = QuestionIdSchema.safeParse(value);
  if (!result.success) {
    throw new RpcParamError('invalid "id": must look like Q-<ulid>', { id: value });
  }
  return result.data;
}

function requireStreamId(value: unknown): string {
  const result = UlidSchema.safeParse(value);
  if (!result.success) {
    throw new RpcParamError('invalid "stream": must be a 26-character Crockford-base32 ULID', {
      stream: value,
    });
  }
  return result.data;
}

function requireText(value: unknown, field: 'text' | 'answer'): string {
  const result = QuestionTextSchema.safeParse(typeof value === 'string' ? value.trim() : value);
  if (!result.success) {
    throw new RpcParamError(`invalid "${field}": must be 1-800 characters`, { [field]: value });
  }
  return result.data;
}

function requireAgentId(value: unknown, field: string): AgentId {
  const result = AgentIdSchema.safeParse(value);
  if (!result.success) {
    throw new RpcParamError(`invalid "${field}": must be a valid agent id`, { [field]: value });
  }
  return result.data as AgentId;
}

function optionalSession(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const result = UlidSchema.safeParse(value);
  if (!result.success) {
    throw new RpcParamError('invalid "session": must be a 26-character Crockford-base32 ULID', {
      session: value,
    });
  }
  return result.data;
}

function optionalOptions(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((o) => typeof o !== 'string' || o.length === 0)) {
    throw new RpcParamError('"options" must be an array of non-empty strings', { options: value });
  }
  return value as string[];
}

function requireBy(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcParamError('"by" must be a non-empty string', { by: value });
  }
  return value;
}

/** `{answer, by, resolved_as?}` -> the service's input (the one place the wire shape is mapped). */
export function parseAnswerParams(params: unknown): AnswerQuestionInput {
  const p = requireObject(params);
  const answer = requireText(p.answer, 'answer');
  const by = requireBy(p.by);
  const resolvedAs = p.resolved_as ?? 'reply';
  if (resolvedAs !== 'reply') {
    throw new RpcParamError('invalid "resolved_as": the only resolution is "reply"', {
      resolved_as: resolvedAs,
    });
  }
  return { resolved_as: 'reply', answer, by };
}

export function buildQuestionRpcMethods(
  service: QuestionService,
): Record<string, RpcMethodHandler> {
  return {
    'question.list': (params) => {
      const p = params === undefined || params === null ? {} : requireObject(params);
      return p.open === true ? service.listOpen() : service.list();
    },
    'question.get': (params) => service.get(requireQuestionId(requireObject(params).id)),
    'question.raise': (params) => {
      const p = requireObject(params);
      const options = optionalOptions(p.options);
      const session = optionalSession(p.session);
      return service.raise({
        stream: requireStreamId(p.stream),
        raised_by: requireAgentId(p.raised_by, 'raised_by'),
        text: requireText(p.text, 'text'),
        ...(session !== undefined ? { session } : {}),
        ...(options !== undefined ? { options } : {}),
      });
    },
    'question.answer': (params) => {
      const p = requireObject(params);
      return service.answer(requireQuestionId(p.id), parseAnswerParams(p));
    },
  };
}
