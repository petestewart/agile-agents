import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type FakeLinear, startFakeLinear } from './fake-linear';
import { createLinear } from './linear';
import type { TrackerPort } from './port';

let fake: FakeLinear;
let linear: TrackerPort;

beforeEach(async () => {
  fake = await startFakeLinear({ pageSize: 2 });
  linear = createLinear({ api_url: fake.apiUrl, token: fake.token });
  fake.addIssue({ key: 'SHOP-1', title: 'Checkout', description: 'The epic' });
  fake.addIssue({ title: 'Cart', parent: 'SHOP-1' });
  fake.addIssue({ title: 'Pay', parent: 'SHOP-1', state: 'In Progress' });
  fake.addIssue({ title: 'Receipt', parent: 'SHOP-1' });
});
afterEach(() => fake.stop());

describe('Linear adapter (T320) against the fake', () => {
  test('get issue: an issue with children is the epic', async () => {
    expect(await linear.getIssue('SHOP-1')).toMatchObject({
      key: 'SHOP-1',
      title: 'Checkout',
      description: 'The epic',
      status: 'Todo',
      kind: 'epic',
    });
    expect(await linear.getIssue('SHOP-2')).toMatchObject({ kind: 'issue', parent: 'SHOP-1' });
  });

  test('list epic children follows pages', async () => {
    const kids = await linear.listEpicChildren('SHOP-1');
    expect(kids.map((k) => k.title)).toEqual(['Cart', 'Pay', 'Receipt']);
    expect(fake.requests.filter((r) => r.operation === 'EpicChildren')).toHaveLength(2);
  });

  test('add comment and add link', async () => {
    const c = await linear.addComment('SHOP-2', 'Started');
    expect(c.id).not.toBe('');
    await linear.addLink('SHOP-2', { url: 'https://example.com/pr/1', title: 'PR #1' });
    const issue = fake.issues.find((i) => i.key === 'SHOP-2');
    expect(issue?.comments.map((x) => x.body)).toEqual(['Started']);
    expect(issue?.links).toEqual([{ url: 'https://example.com/pr/1', title: 'PR #1' }]);
  });

  test('transition status by state name; unknown is a validation error', async () => {
    await linear.transitionStatus('SHOP-2', 'done');
    expect((await linear.getIssue('SHOP-2')).status).toBe('Done');
    await expect(linear.transitionStatus('SHOP-2', 'Shipped')).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  test('create issue under a parent in a team', async () => {
    const i = await linear.createIssue({ project: 'SHOP', title: 'Refunds', parent: 'SHOP-1' });
    expect(i).toMatchObject({ key: 'SHOP-5', title: 'Refunds', parent: 'SHOP-1' });
    await expect(linear.createIssue({ project: 'NOPE', title: 'x' })).rejects.toMatchObject({
      kind: 'not_found',
    });
  });

  test('errors map to kinds: not found, rate limited, auth', async () => {
    await expect(linear.getIssue('SHOP-99')).rejects.toMatchObject({ kind: 'not_found' });
    fake.rateLimit();
    await expect(linear.getIssue('SHOP-1')).rejects.toMatchObject({ kind: 'rate_limited' });
    const bad = createLinear({ api_url: fake.apiUrl, token: 'wrong' });
    await expect(bad.getIssue('SHOP-1')).rejects.toMatchObject({ kind: 'auth' });
  });

  test('refuses a non-https, non-loopback api_url', () => {
    expect(() => createLinear({ api_url: 'http://linear.example.com', token: 't' })).toThrow(
      /https/,
    );
  });
});
