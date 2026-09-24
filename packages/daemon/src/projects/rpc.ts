/**
 * `project.*` RPC over a `ProjectService` (T200). Params are validated by
 * the shared schemas; caller-input failures surface as -32602.
 */

import {
  ProjectIdSchema,
  validateProjectCreateInput,
  validateProjectUpdateInput,
} from '@agile-agents/shared';
import { RpcParamError, paramErrors, requireObject } from '../gates/rpc';
import type { RpcMethodHandler } from '../rpc';
import { AlreadyExistsError } from '../store/store';
import { UnknownRepoError } from '../streams/service';
import type { ProjectService } from './service';

function requireProjectId(value: unknown): string {
  const result = ProjectIdSchema.safeParse(value);
  if (!result.success) {
    throw new RpcParamError('invalid "id": must look like P-<ulid>', { id: value });
  }
  return result.data;
}

const asParamErrors = paramErrors(AlreadyExistsError, UnknownRepoError);

/** A shared-schema refusal of the caller's params is -32602, not an internal fault. */
function validInput<T>(validate: (raw: unknown) => T, raw: unknown): T {
  try {
    return validate(raw);
  } catch (err) {
    throw new RpcParamError(err instanceof Error ? err.message : String(err));
  }
}

export function buildProjectRpcMethods(service: ProjectService): Record<string, RpcMethodHandler> {
  return {
    'project.create': async (params) => {
      const input = validInput(validateProjectCreateInput, requireObject(params));
      return asParamErrors(() => service.create(input));
    },

    'project.list': (params) => {
      const p = params === undefined ? {} : requireObject(params);
      if (p.include_archived !== undefined && typeof p.include_archived !== 'boolean') {
        throw new RpcParamError('invalid "include_archived": must be a boolean', {
          include_archived: p.include_archived,
        });
      }
      return { projects: service.list({ include_archived: p.include_archived === true }) };
    },

    'project.get': (params) => service.get(requireProjectId(requireObject(params).id)),

    'project.update': async (params) => {
      const { id, ...patch } = requireObject(params);
      const projectId = requireProjectId(id);
      const input = validInput(validateProjectUpdateInput, patch);
      return asParamErrors(() => service.update(projectId, input));
    },

    'project.archive': async (params) =>
      service.archive(requireProjectId(requireObject(params).id)),
  };
}
