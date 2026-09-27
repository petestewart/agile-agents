/**
 * T457: where a node's permission posture and its project's "Always" read
 * roots come from: the project record, else the home's `config.yaml`, else
 * Ask (`DEFAULT_PERMISSION_POSTURE`, applied by `nodeReadScope`). Read per
 * call, so a Settings change applies to the next tool call.
 */

import type { HilId, HilRequest, HomeConfig, Project, Stream } from '@agile-agents/shared';
import { GateAlreadyResolvedError } from '../gates/service';
import type { ProjectReadSettings } from './policy-tables';

/** The slice of `StateStore` the posture needs. */
export interface PostureSource {
  getHomeConfig(): HomeConfig;
  getProject(id: string): Project;
}

/**
 * `nodeReadScope`'s `settings`. An unreadable home config counts as Ask; an
 * unreadable project record adds no roots and inherits the home's posture.
 */
export function projectReadSettings(
  store: PostureSource,
): (project: string | undefined) => ProjectReadSettings {
  return (projectId) => {
    let home: HomeConfig['permissions'];
    try {
      home = store.getHomeConfig().permissions;
    } catch {
      home = undefined;
    }
    let project: Project | undefined;
    if (projectId !== undefined) {
      try {
        project = store.getProject(projectId);
      } catch {
        project = undefined;
      }
    }
    const posture = project?.permissions ?? home;
    return {
      ...(posture !== undefined ? { posture } : {}),
      ...(project?.read_roots !== undefined ? { readRoots: project.read_roots } : {}),
    };
  };
}

/** What `answerReadAlways` needs: the gate, the node's project, and its thread. */
export interface ReadAlwaysDeps {
  gates: {
    get(id: HilId): HilRequest;
    respond(id: HilId, decision: 'approve', by: string, note?: string): Promise<HilRequest>;
    consume(id: HilId): Promise<HilRequest>;
  };
  streams: {
    get(id: string): Stream;
    appendThread(
      principal: 'daemon',
      id: string,
      input: { kind: 'event'; body: string },
    ): Promise<unknown>;
  };
  projects: { addReadRoot(id: string, root: string): Promise<Project> };
}

/** The gate is not a held Ask read, or its node belongs to no project. */
export class NotAReadGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotAReadGateError';
  }
}

/**
 * T457: the card's third answer, "Always for this project": adds the gate's
 * `read_root` to the node's project (through the store), then approves the
 * gate as Allow once does and spends that approval at once — the retry is
 * inside the project's roots now, and an approval left unspent would read
 * as a routed call still waiting. The node's thread says what was opened.
 */
export async function answerReadAlways(
  deps: ReadAlwaysDeps,
  id: HilId,
  by: string,
  note?: string,
): Promise<HilRequest> {
  const gate = deps.gates.get(id);
  if (gate.status !== 'pending') throw new GateAlreadyResolvedError(id);
  const root = gate.read_root;
  if (root === undefined) {
    throw new NotAReadGateError(`${id} is not a held read: only Allow or Deny answers it`);
  }
  const node = deps.streams.get(gate.stream);
  if (node.project === undefined) {
    throw new NotAReadGateError(`${id}: its node belongs to no project, so there is no "always"`);
  }
  const project = await deps.projects.addReadRoot(node.project, root);
  const resolved = await deps.gates.respond(id, 'approve', by, note);
  try {
    await deps.gates.consume(id);
  } catch {
    // Already spent by a racing retry: the same outcome.
  }
  await deps.streams
    .appendThread('daemon', gate.stream, {
      kind: 'event',
      body: `Every node in ${project.name} may now read ${root} (Always, on ${id}).`.slice(0, 800),
    })
    .catch(() => {
      // The root is saved; the line is a courtesy.
    });
  return resolved;
}
