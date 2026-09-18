/**
 * Team table (T044 — mockup Sprint tab: "finished agents stay listed for
 * the sprint"; ticket AC: "Team rows show a real model id").
 *
 * Rows come from the snapshot's `team`, which the daemon builds from the
 * live agent registry plus the `agent_deleted` events that removed the
 * departed agents' records — so an agent that finished and exited still has
 * a row, with the vendor/model it actually ran on.
 */

import type { FeedTeamMember } from '../../lib/feed-types';

function tokens(n: number): string {
  if (n === 0) return '—';
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

export function TeamTable({ team }: { team: FeedTeamMember[] }): JSX.Element {
  return (
    <section className="cr-section" data-testid="team">
      <div className="cr-section-hd">
        <span className="cr-eyebrow">Team</span>
        <span className="cr-section-note">finished agents stay listed for the sprint</span>
      </div>
      {team.length === 0 ? (
        <p style={{ color: 'var(--text-dim)' }}>No agents have run yet.</p>
      ) : (
        <div className="cr-table-wrap">
          <table className="cr-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Model</th>
                <th>Ticket</th>
                <th>Doing</th>
                <th className="mono">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {team.map((member) => (
                <tr
                  key={member.id}
                  data-testid={`team-row-${member.id}`}
                  data-state={member.state}
                  className={member.state === 'left' ? 'left' : undefined}
                >
                  <td className="mono">{member.id}</td>
                  <td data-testid={`team-model-${member.id}`}>
                    {member.vendor} / {member.model}
                  </td>
                  <td className="mono">{member.ticket ?? '—'}</td>
                  <td>{member.doing}</td>
                  <td className="mono">{tokens(member.tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
