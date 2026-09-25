import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type FakeJira, startFakeJira } from './fake-jira';
import { adfText, createJira } from './jira';
import { TrackerError, type TrackerPort } from './port';

let fake: FakeJira;
let jira: TrackerPort;

beforeEach(async () => {
  fake = await startFakeJira({ pageSize: 2 });
  jira = createJira({ base_url: fake.baseUrl, email: fake.email, token: fake.token });
  fake.addIssue({
    key: 'SHOP-1',
    title: 'Checkout',
    kind: 'epic',
    description: 'Line one\nLine two',
  });
  fake.addIssue({ title: 'Cart', parent: 'SHOP-1' });
  fake.addIssue({ title: 'Pay', parent: 'SHOP-1', status: 'In Progress' });
  fake.addIssue({ title: 'Receipt', parent: 'SHOP-1' });
  fake.addIssue({ title: 'Unrelated' });
});
afterEach(() => fake.stop());

describe('Jira adapter (T320) against the fake', () => {
  test('get issue: title, ADF description as text, status, kind, url', async () => {
    const i = await jira.getIssue('SHOP-1');
    expect(i).toMatchObject({
      key: 'SHOP-1',
      title: 'Checkout',
      description: 'Line one\nLine two',
      status: 'To Do',
      kind: 'epic',
      url: `${fake.baseUrl}/browse/SHOP-1`,
    });
    expect(i.parent).toBeUndefined();
  });

  test('list epic children follows pages', async () => {
    const kids = await jira.listEpicChildren('SHOP-1');
    expect(kids.map((k) => k.title)).toEqual(['Cart', 'Pay', 'Receipt']);
    expect(kids.every((k) => k.parent === 'SHOP-1' && k.kind === 'issue')).toBe(true);
    expect(fake.requests.filter((r) => r.path === '/rest/api/3/search/jql')).toHaveLength(2);
    await expect(jira.listEpicChildren('SHOP-1 OR 1=1')).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  test('add comment and add link', async () => {
    const c = await jira.addComment('SHOP-2', 'Started on stream s-1\nsecond line');
    expect(c.id).not.toBe('');
    await jira.addLink('SHOP-2', { url: 'https://example.com/pr/1', title: 'PR #1' });
    const issue = fake.issues.find((i) => i.key === 'SHOP-2');
    expect(issue?.comments[0]?.body).toBe('Started on stream s-1\nsecond line');
    expect(issue?.links).toEqual([{ url: 'https://example.com/pr/1', title: 'PR #1' }]);
  });

  test('transition status by target name, case-insensitive; unknown is a validation error', async () => {
    await jira.transitionStatus('SHOP-2', 'in review');
    expect((await jira.getIssue('SHOP-2')).status).toBe('In Review');
    await expect(jira.transitionStatus('SHOP-2', 'Shipped')).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  test('create issue under an epic', async () => {
    const i = await jira.createIssue({
      project: 'SHOP',
      title: 'Refunds',
      description: 'Handle refunds',
      parent: 'SHOP-1',
    });
    expect(i).toMatchObject({
      key: 'SHOP-6',
      title: 'Refunds',
      description: 'Handle refunds',
      parent: 'SHOP-1',
    });
  });

  test('errors map to kinds: not found, rate limited, auth (bearer works too)', async () => {
    await expect(jira.getIssue('SHOP-99')).rejects.toMatchObject({ kind: 'not_found' });
    fake.rateLimit();
    await expect(jira.getIssue('SHOP-1')).rejects.toMatchObject({ kind: 'rate_limited' });
    const bad = createJira({ base_url: fake.baseUrl, email: fake.email, token: 'wrong' });
    const err = await bad.getIssue('SHOP-1').catch((e) => e);
    expect(err).toBeInstanceOf(TrackerError);
    expect(err.kind).toBe('auth');
    const bearer = createJira({ base_url: fake.baseUrl, token: fake.token });
    expect((await bearer.getIssue('SHOP-1')).key).toBe('SHOP-1');
  });

  test('refuses a non-https, non-loopback base_url', () => {
    expect(() => createJira({ base_url: 'http://jira.example.com', token: 't' })).toThrow(/https/);
  });

  test('adfText flattens nested ADF', () => {
    expect(
      adfText({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'a' },
              { type: 'text', text: 'b' },
            ],
          },
          { type: 'paragraph', content: [{ type: 'text', text: 'c' }] },
        ],
      }),
    ).toBe('ab\nc');
  });
});
