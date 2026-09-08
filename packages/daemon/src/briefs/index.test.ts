import { describe, expect, test } from 'bun:test';
import {
  FIXTURE_DISCOVERY_STANZA,
  FIXTURE_HALT,
  FIXTURE_KB_FACT,
  FIXTURE_ORACLE_ENTRY,
  FIXTURE_ORACLE_ENTRY_2,
  FIXTURE_POLICY,
  FIXTURE_SPRINT,
  FIXTURE_TICKET,
} from './fixtures';
import {
  CEREMONY_TEMPLATE_TOKEN_CEILING,
  ROLE_BRIEF_TOKEN_CEILING,
  approxTokenCount,
  renderArchitectBrief,
  renderEmBrief,
  renderEngineerBrief,
  renderQaBrief,
  renderReaderBrief,
  renderRefinement,
  renderRetro,
  renderReviewerBrief,
  renderSprintReview,
  renderStandup,
} from './index';

describe('role briefs render against fixture data and stay under the token ceiling', () => {
  test('engineer brief', () => {
    const text = renderEngineerBrief({
      agent: 'eng-3',
      ticket: FIXTURE_TICKET,
      policy: FIXTURE_POLICY,
    });
    expect(text).toContain('TKT-0231');
    expect(text).toContain('eng-3');
    expect(approxTokenCount(text)).toBeLessThanOrEqual(ROLE_BRIEF_TOKEN_CEILING);
    expect(text).toMatchSnapshot();
  });

  test('architect brief', () => {
    const text = renderArchitectBrief({
      agent: 'architect',
      ticket: FIXTURE_TICKET,
      oracleEntries: [FIXTURE_ORACLE_ENTRY, FIXTURE_ORACLE_ENTRY_2],
    });
    expect(text).toContain('DEC-0042');
    expect(approxTokenCount(text)).toBeLessThanOrEqual(ROLE_BRIEF_TOKEN_CEILING);
    expect(text).toMatchSnapshot();
  });

  test('em brief', () => {
    const text = renderEmBrief({
      agent: 'em',
      sprint: FIXTURE_SPRINT,
      policy: FIXTURE_POLICY,
    });
    expect(text).toContain('S-07');
    expect(text).toContain('approve_plan');
    expect(approxTokenCount(text)).toBeLessThanOrEqual(ROLE_BRIEF_TOKEN_CEILING);
    expect(text).toMatchSnapshot();
  });

  test('reviewer brief', () => {
    const text = renderReviewerBrief({
      agent: 'reviewer-1',
      ticket: FIXTURE_TICKET,
      kbFacts: [FIXTURE_KB_FACT],
    });
    expect(text).toContain('approve');
    expect(approxTokenCount(text)).toBeLessThanOrEqual(ROLE_BRIEF_TOKEN_CEILING);
    expect(text).toMatchSnapshot();
  });

  test('qa brief', () => {
    const text = renderQaBrief({
      agent: 'qa-1',
      ticket: FIXTURE_TICKET,
    });
    expect(text).toContain('accept');
    expect(text).toContain('reject');
    expect(approxTokenCount(text)).toBeLessThanOrEqual(ROLE_BRIEF_TOKEN_CEILING);
    expect(text).toMatchSnapshot();
  });

  test('reader brief', () => {
    const text = renderReaderBrief({
      agent: 'reader-1',
      path: 'packages/api/auth/jwt.ts',
      question: 'Does this module already sign JWTs?',
    });
    expect(text).toContain('packages/api/auth/jwt.ts');
    expect(approxTokenCount(text)).toBeLessThanOrEqual(ROLE_BRIEF_TOKEN_CEILING);
    expect(text).toMatchSnapshot();
  });

  test('reader brief renders without the optional question', () => {
    const text = renderReaderBrief({ agent: 'reader-1', path: 'packages/api/auth/jwt.ts' });
    expect(text).not.toContain('Question to answer');
    expect(text).toMatchSnapshot();
  });
});

describe('ceremony templates render against fixture data and stay under the token ceiling', () => {
  test('standup', () => {
    const text = renderStandup({
      sprint: FIXTURE_SPRINT,
      halts: [FIXTURE_HALT],
      discoveries: [FIXTURE_DISCOVERY_STANZA],
    });
    expect(text).toContain('H-12');
    expect(text).toContain('TKT-0231');
    expect(approxTokenCount(text)).toBeLessThanOrEqual(CEREMONY_TEMPLATE_TOKEN_CEILING);
    expect(text).toMatchSnapshot();
  });

  test('refinement', () => {
    const text = renderRefinement({
      sprint: FIXTURE_SPRINT,
      tickets: [FIXTURE_TICKET],
      oracleEntries: [FIXTURE_ORACLE_ENTRY],
    });
    expect(text).toContain('Ambiguity');
    expect(approxTokenCount(text)).toBeLessThanOrEqual(CEREMONY_TEMPLATE_TOKEN_CEILING);
    expect(text).toMatchSnapshot();
  });

  test('sprint review', () => {
    const text = renderSprintReview({
      sprint: FIXTURE_SPRINT,
      policy: FIXTURE_POLICY,
      doneTickets: [FIXTURE_TICKET],
    });
    expect(text).toContain('Auth works end to end');
    expect(approxTokenCount(text)).toBeLessThanOrEqual(CEREMONY_TEMPLATE_TOKEN_CEILING);
    expect(text).toMatchSnapshot();
  });

  test('retro', () => {
    const text = renderRetro({ sprint: FIXTURE_SPRINT });
    expect(text).toContain('TKT-0229');
    expect(approxTokenCount(text)).toBeLessThanOrEqual(CEREMONY_TEMPLATE_TOKEN_CEILING);
    expect(text).toMatchSnapshot();
  });
});

describe('missing fields throw instead of rendering silently', () => {
  test('engineer brief throws when the ticket id is missing', () => {
    const brokenTicket = { ...FIXTURE_TICKET } as Record<string, unknown>;
    brokenTicket.id = undefined;
    expect(() =>
      renderEngineerBrief({
        agent: 'eng-3',
        // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed fixture for the negative test
        ticket: brokenTicket as any,
        policy: FIXTURE_POLICY,
      }),
    ).toThrow(/missing required field/);
  });

  test('engineer brief throws when contract.acceptance is missing', () => {
    const brokenTicket = {
      ...FIXTURE_TICKET,
      contract: { ...FIXTURE_TICKET.contract } as Record<string, unknown>,
    };
    brokenTicket.contract.acceptance = undefined;
    expect(() =>
      renderEngineerBrief({
        agent: 'eng-3',
        // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed fixture for the negative test
        ticket: brokenTicket as any,
        policy: FIXTURE_POLICY,
      }),
    ).toThrow(/missing required list/);
  });

  test('qa brief throws when ticket.contract.env is missing', () => {
    const brokenTicket = {
      ...FIXTURE_TICKET,
      contract: { ...FIXTURE_TICKET.contract } as Record<string, unknown>,
    };
    brokenTicket.contract.env = undefined;
    expect(() =>
      renderQaBrief({
        agent: 'qa-1',
        // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed fixture for the negative test
        ticket: brokenTicket as any,
      }),
    ).toThrow(/missing required field/);
  });

  test('architect brief throws when an oracle entry title is missing', () => {
    const brokenEntry = { ...FIXTURE_ORACLE_ENTRY } as Record<string, unknown>;
    brokenEntry.title = undefined;
    expect(() =>
      renderArchitectBrief({
        agent: 'architect',
        ticket: FIXTURE_TICKET,
        // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed fixture for the negative test
        oracleEntries: [brokenEntry as any],
      }),
    ).toThrow(/missing required field/);
  });

  test('em brief throws when sprint.goal is missing', () => {
    const brokenSprint = { ...FIXTURE_SPRINT } as Record<string, unknown>;
    brokenSprint.goal = undefined;
    expect(() =>
      renderEmBrief({
        agent: 'em',
        // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed fixture for the negative test
        sprint: brokenSprint as any,
        policy: FIXTURE_POLICY,
      }),
    ).toThrow(/missing required field/);
  });

  test('standup throws when a halt is missing its reason', () => {
    const brokenHalt = { ...FIXTURE_HALT } as Record<string, unknown>;
    brokenHalt.reason = undefined;
    expect(() =>
      renderStandup({
        sprint: FIXTURE_SPRINT,
        // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed fixture for the negative test
        halts: [brokenHalt as any],
        discoveries: [],
      }),
    ).toThrow(/missing required field/);
  });

  test('retro throws when sprint.retro is missing entirely', () => {
    const brokenSprint = { ...FIXTURE_SPRINT } as Record<string, unknown>;
    brokenSprint.retro = undefined;
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed fixture for the negative test
      renderRetro({ sprint: brokenSprint as any }),
    ).toThrow(/missing required field|missing required list/);
  });
});
