/**
 * T482: `policy.*` RPC for `agile policy show|set [--project P | --node N]`,
 * over the same `ModelPolicyService` as the cockpit's routes. The home layer
 * when neither is named. A write is the operator's (`human`).
 */

import {
  ModelPolicyPatchSchema,
  ModelProfilesPatchSchema,
  ProjectIdSchema,
  formatZodError,
} from '@agile-agents/shared';
import { RpcParamError, paramErrors, requireObject, requireStreamId } from '../gates/rpc';
import type { RpcMethodHandler } from '../rpc';
import { NotFoundError } from '../store/store';
import type { ModelPolicyService } from './policy';

const asParamErrors = paramErrors(NotFoundError);

function layerOf(p: Record<string, unknown>): { project?: string; node?: string } {
  if (p.project !== undefined && p.node !== undefined) {
    throw new RpcParamError('name --project or --node, not both');
  }
  if (p.project !== undefined) {
    const id = ProjectIdSchema.safeParse(p.project);
    if (!id.success) throw new RpcParamError('invalid "project": must look like P-<ulid>');
    return { project: id.data };
  }
  if (p.node !== undefined) return { node: requireStreamId(p.node, 'node') };
  return {};
}

export function buildModelPolicyRpcMethods(
  service: ModelPolicyService,
): Record<string, RpcMethodHandler> {
  return {
    /** The layer's own fields, the resolved policy and each field's source (and the home's profiles). */
    'policy.show': (params) => {
      const p = params === undefined ? {} : requireObject(params);
      const layer = layerOf(p);
      return asParamErrors<unknown>(async () =>
        layer.project !== undefined
          ? service.projectView(layer.project)
          : layer.node !== undefined
            ? service.nodeView(layer.node)
            : service.homeView(),
      );
    },

    /** `{patch}` (a field → value, `null` inherits again), or `{profiles}` for the home. */
    'policy.set': async (params) => {
      const p = requireObject(params);
      const layer = layerOf(p);
      if (p.profiles !== undefined) {
        if (layer.project !== undefined || layer.node !== undefined) {
          throw new RpcParamError('model profiles are the home’s alone');
        }
        const profiles = ModelProfilesPatchSchema.safeParse(p.profiles);
        if (!profiles.success) {
          throw new RpcParamError(formatZodError('model profiles', profiles.error));
        }
        return service.setProfiles(profiles.data);
      }
      const patch = ModelPolicyPatchSchema.safeParse(p.patch);
      if (!patch.success) throw new RpcParamError(formatZodError('model policy', patch.error));
      return asParamErrors<unknown>(() =>
        layer.project !== undefined
          ? service.setProject(layer.project, patch.data)
          : layer.node !== undefined
            ? service.setNode(layer.node, patch.data)
            : service.setHome(patch.data),
      );
    },

    /** "Let the policy choose again" for a node. */
    'policy.choose_again': async (params) => {
      const node = requireStreamId(requireObject(params).node, 'node');
      return asParamErrors(() => service.chooseAgain(node));
    },
  };
}
