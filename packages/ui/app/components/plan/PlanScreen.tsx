/**
 * Plan screen (§17 "Control room v2": "Plan screen = the documents + the EM
 * chat. Left rail, one entry per artifact family ..."). T042 fills this in;
 * T043 owns only the chrome around it, so this is the placeholder body the
 * shell routes to, and the whole of `components/plan/` is T042's.
 *
 * The one thing it already does is read the shell's rail state, which T043
 * persists and the tool row's left-hand button toggles — so the rail T042
 * builds slots into a collapse that already works.
 */

import { useShell } from '../../lib/shell';

export function PlanScreen(): JSX.Element {
  const { railCollapsed } = useShell();
  return (
    <section
      className={`cr-plan${railCollapsed ? ' mini' : ''}`}
      data-testid="plan-screen"
      data-rail={railCollapsed ? 'collapsed' : 'expanded'}
    >
      <p style={{ color: 'var(--text-dim)' }}>
        The plan — brief, rules, questions, decisions, tickets, sprints, knowledge — lands here
        (T042). The rail is currently {railCollapsed ? 'collapsed' : 'expanded'}.
      </p>
    </section>
  );
}
