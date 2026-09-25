/**
 * T324 (projects-design §10, §14.10): Node → tracker, off until the
 * project's `tracker.push_status` is on.
 *
 * On each stream update, a linked node whose phase moved forward (in
 * progress → in review → done) has its issue moved to the status the
 * project's `status_map` names for that phase; a phase with no mapping is
 * skipped. The PR link is added as a web link when a PR first appears.
 *
 * The only calls are `transitionStatus` and `addLink`: the app never
 * closes an issue or edits its text.
 */

import type { Project, Stream, TrackerSystem } from '@agile-agents/shared';
import type { TrackerPort } from './port';

export type PushPhase = 'in_progress' | 'in_review' | 'done';
const RANK: Record<PushPhase | 'none', number> = { none: 0, in_progress: 1, in_review: 2, done: 3 };

/** Where a node is, as the tracker sees it. */
export function pushPhase(s: Stream): PushPhase | 'none' {
  const delivery = s.delivery_state?.status;
  if (s.human.status === 'landed' || delivery === 'merged') return 'done';
  if (delivery === 'pr_open') return 'in_review';
  if (s.agent.status !== 'idle' || (delivery !== undefined && delivery !== 'not_started')) {
    return 'in_progress';
  }
  return 'none';
}

export interface TrackerStatusPushOptions {
  project: (id: string) => Project | undefined;
  tracker: (system: TrackerSystem) => TrackerPort;
}

export class TrackerStatusPush {
  constructor(private readonly options: TrackerStatusPushOptions) {}

  /** The `onUpdated` hook. Never throws: a tracker failure is logged, not a failed update. */
  async onUpdated(before: Stream, after: Stream): Promise<void> {
    try {
      await this.push(before, after);
    } catch (err) {
      const key = after.external_link?.key ?? '?';
      console.error(`tracker push ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async push(before: Stream, after: Stream): Promise<void> {
    const link = after.external_link;
    if (link === undefined || after.project === undefined) return;
    const settings = this.options.project(after.project)?.tracker;
    if (settings?.push_status !== true || settings.system !== link.system) return;
    const port = this.options.tracker(link.system);

    const from = pushPhase(before);
    const to = pushPhase(after);
    const status = to === 'none' ? undefined : settings.status_map?.[to];
    if (RANK[to] > RANK[from] && status !== undefined) {
      await port.transitionStatus(link.key, status);
    }

    const pr = after.delivery_state?.pr;
    if (pr !== undefined && pr.url !== before.delivery_state?.pr?.url) {
      await port.addLink(link.key, { url: pr.url, title: `PR #${pr.number}: ${after.title}` });
    }
  }
}
