/**
 * Ticket stories (T044 — §17 "Human UI" and the mockup's Sprint tab: "Each
 * ticket is a story with timestamps, not a card in a column").
 *
 * Pure rendering: every step, its tone and its wording are derived
 * daemon-side (`packages/daemon/src/feed/stories.ts`) and arrive on the
 * snapshot, so the page cannot tell a different story from the board.
 */

import type { StoryStep, TicketStory } from '../../lib/feed-types';

function clockOf(ts: string): string {
  const parsed = new Date(ts);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleTimeString();
}

function Step({ step }: { step: StoryStep }): JSX.Element {
  return (
    <li className={`cr-step ${step.tone}`}>
      <span className="t">{step.tone === 'now' ? 'now' : clockOf(step.ts)}</span>
      <span className="m" />
      <span>
        {step.headline && <b>{step.headline} </b>}
        {step.text}
      </span>
    </li>
  );
}

export function Story({
  story,
  onOpen,
}: {
  story: TicketStory;
  onOpen: (ticket: string) => void;
}): JSX.Element {
  return (
    <article
      className="cr-story"
      data-testid={`ticket-card-${story.ticket}`}
      data-status={story.status}
    >
      <button
        type="button"
        className="cr-story-open"
        data-testid={`story-open-${story.ticket}`}
        title="Open this ticket's contract, diff, review and QA notes"
        onClick={() => onOpen(story.ticket)}
      >
        <span className="id">{story.ticket}</span>
      </button>
      <span className="title">{story.title}</span>
      <div className="stage">
        <span className={`cr-pill ${story.stage.tone}`} data-testid={`story-stage-${story.ticket}`}>
          {story.stage.label}
        </span>
        {story.who && <span className="who">{story.who}</span>}
      </div>
      <ul className="cr-steps" data-testid={`story-steps-${story.ticket}`}>
        {story.steps.map((step, index) => (
          <Step key={`${step.ts}-${step.headline ?? ''}-${index}`} step={step} />
        ))}
        {story.steps.length === 0 && (
          <li className="cr-step plain">
            <span className="t">—</span>
            <span className="m" />
            <span>Nothing has happened on this ticket yet.</span>
          </li>
        )}
      </ul>
    </article>
  );
}

export function Stories({
  stories,
  onOpen,
}: {
  stories: TicketStory[];
  onOpen: (ticket: string) => void;
}): JSX.Element {
  return (
    <section className="cr-section" data-testid="stories">
      <div className="cr-section-hd">
        <span className="cr-eyebrow">Tickets</span>
        <span className="cr-section-note">click a ticket for its diff, review and QA notes</span>
      </div>
      {stories.length === 0 ? (
        <p style={{ color: 'var(--text-dim)' }}>No tickets on the board yet.</p>
      ) : (
        stories.map((story) => <Story key={story.ticket} story={story} onOpen={onOpen} />)
      )}
    </section>
  );
}
