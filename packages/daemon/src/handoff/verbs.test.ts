import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type HandoffFixture, makeHandoffFixture } from './test-helpers';
import { HANDOFF_TOOLS, HandoffVerbError } from './verbs';

let fx: HandoffFixture;

beforeEach(async () => {
  fx = makeHandoffFixture();
  await fx.store.putVendors({ claude: { accounts: [{ id: 'default', auth: 'subscription' }] } });
});

afterEach(() => fx.cleanup());

function tool(name: string) {
  const found = HANDOFF_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`no such tool: ${name}`);
  return found;
}

describe('cooldown_set verb — em/human policy (round 3 review-fix, N-a)', () => {
  const input = {
    vendor: 'claude',
    account: 'default',
    until: new Date(Date.now() + 3600_000).toISOString(),
  };

  test('em may call it', async () => {
    const result = await tool('cooldown_set').handler({ store: fx.store }, { agent: 'em' }, input);
    expect(result).toMatchObject({ cooldown_until: input.until });
  });

  test("human may call it too — matches rpc.ts's policy, not em-only", async () => {
    const result = await tool('cooldown_set').handler(
      { store: fx.store },
      { agent: 'human' },
      input,
    );
    expect(result).toMatchObject({ cooldown_until: input.until });
  });

  test('an engineer may not', async () => {
    await expect(
      tool('cooldown_set').handler({ store: fx.store }, { agent: 'eng-1' }, input),
    ).rejects.toBeInstanceOf(HandoffVerbError);
  });
});

describe('handoff_status verb — em-only', () => {
  test('em may call it', async () => {
    const result = await tool('handoff_status').handler({ store: fx.store }, { agent: 'em' }, {});
    expect(result).toEqual({ paused: [] });
  });

  test('human may not (unlike cooldown_set)', async () => {
    await expect(
      tool('handoff_status').handler({ store: fx.store }, { agent: 'human' }, {}),
    ).rejects.toBeInstanceOf(HandoffVerbError);
  });
});
