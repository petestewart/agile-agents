/**
 * `question.*` RPC methods over a `QuestionService` (T040, §17 "Control room
 * v2" → "Questions vs Decisions"). Mirrors `gates/rpc.ts` exactly: every
 * handler validates its params at the boundary with shared's own zod schemas
 * and throws `RpcParamError` (-32602) rather than letting a destructuring
 * `TypeError` reach `dispatch()`.
 *
 * `RpcError`/`RpcParamError` are re-used from `gates/rpc.ts` rather than
 * redefined — same JSON-RPC error contract, and `rpc.ts`'s `dispatch()`
 * still flattens every code to -32603 (documented there), so negative-path
 * tests assert on the message.
 *
 * Namespace note: `question` is not one of `rpc.ts`'s `STUB_NAMESPACES`
 * (`bus | state | hook | gate`), so an *unwired* `question.*` call is
 * "unknown method" rather than "not implemented yet". Every method below is
 * really implemented and wired in `daemon.ts`, so that only affects a daemon
 * started without a store.
 */

import {
  AgentIdSchema,
  QuestionIdSchema,
  QuestionTextSchema,
  TicketIdSchema,
} from '@agile-agents/shared';
import type { AgentId, QuestionId, TicketId } from '@agile-agents/shared';
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

function optionalTicket(value: unknown): TicketId | undefined {
  if (value === undefined || value === null) return undefined;
  const result = TicketIdSchema.safeParse(value);
  if (!result.success) {
    throw new RpcParamError('invalid "ticket": must look like TKT-0231', { ticket: value });
  }
  return result.data as TicketId;
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

/** `{answer, resolved_as, ...}` -> the service's tagged input (the one place the wire shape is mapped). */
export function parseAnswerParams(params: unknown): AnswerQuestionInput {
  const p = requireObject(params);
  const answer = requireText(p.answer, 'answer');
  const by = requireBy(p.by);
  const resolvedAs = p.resolved_as ?? 'reply';
  if (resolvedAs === 'reply') return { resolved_as: 'reply', answer, by };
  if (resolvedAs === 'decision') {
    if (p.title !== undefined && (typeof p.title !== 'string' || p.title.length === 0)) {
      throw new RpcParamError('"title" must be a non-empty string', { title: p.title });
    }
    return {
      resolved_as: 'decision',
      answer,
      by,
      ...(typeof p.title === 'string' ? { title: p.title } : {}),
    };
  }
  if (resolvedAs === 'ticket') {
    const edit = p.edit;
    if (typeof edit !== 'object' || edit === null || Array.isArray(edit)) {
      throw new RpcParamError('"edit" must be an object when resolved_as is "ticket"', { edit });
    }
    return {
      resolved_as: 'ticket',
      answer,
      by,
      ...(p.ticket !== undefined ? { ticket: optionalTicket(p.ticket) as TicketId } : {}),
      edit: edit as Record<string, unknown>,
    };
  }
  throw new RpcParamError('invalid "resolved_as": must be "reply", "decision" or "ticket"', {
    resolved_as: resolvedAs,
  });
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
      return service.raise({
        raised_by: requireAgentId(p.raised_by, 'raised_by'),
        text: requireText(p.text, 'text'),
        ...(p.ticket !== undefined ? { ticket: optionalTicket(p.ticket) as TicketId } : {}),
        ...(optionalOptions(p.options) !== undefined
          ? { options: optionalOptions(p.options) as string[] }
          : {}),
      });
    },
    'question.answer': (params) => {
      const p = requireObject(params);
      return service.answer(requireQuestionId(p.id), parseAnswerParams(p));
    },
  };
}
