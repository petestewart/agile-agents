/**
 * QA black-box driver for T045 (Jira two-way sync). Run from the QA
 * worktree: `bun run qa-t045-drive.ts`.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startDaemon,
  installShutdownSignals,
  discoverConfig,
} from '@agile-agents/daemon';
import { startFakeJira } from '@agile-agents/daemon';
import { runCli, runCliInit } from '@agile-agents/cli';

function log(...args: unknown[]) {
  console.log(...args);
}

async function main() {
  const results: { name: string; pass: boolean; detail: string }[] = [];
  function record(name: string, pass: boolean, detail: string) {
    results.push({ name, pass, detail });
    log(`[${pass ? 'PASS' : 'FAIL'}] ${name} -- ${detail}`);
  }

  const repo = mkdtempSync(join(tmpdir(), 'qa-t045-'));
  log('temp repo:', repo);
  execSync('git init -q', { cwd: repo });
  execSync('git config user.email qa@example.com', { cwd: repo });
  execSync('git config user.name qa', { cwd: repo });
  execSync('git commit -q --allow-empty -m init', { cwd: repo });

  // agile init (CLI)
  const initResult = runCliInit(repo);
  record('agile init succeeds', !initResult.alreadyInitialised, initResult.message);

  // Start fake Jira
  const fakeJira = startFakeJira();
  log('fake jira baseUrl:', fakeJira.baseUrl);

  const JIRA_EMAIL = 'qa-bot@example.com';
  const JIRA_API_TOKEN = 'super-secret-token-XYZ-12345';
  process.env.JIRA_BASE_URL = fakeJira.baseUrl;
  process.env.JIRA_EMAIL = JIRA_EMAIL;
  process.env.JIRA_API_TOKEN = JIRA_API_TOKEN;
  process.env.JIRA_POLL_INTERVAL_MS = String(60 * 60 * 1000); // huge; we force ticks manually

  const handle = await startDaemon({ cwd: repo });
  installShutdownSignals(handle);
  log('daemon http:', handle.http.port, 'socket:', handle.rpc.socketPath);

  try {
    if (!handle.jiraSync) {
      record('daemon wires jiraSync when env is set', false, 'handle.jiraSync is undefined');
      return finish(results, repo, fakeJira, handle);
    }
    record('daemon wires jiraSync when env is set', true, 'handle.jiraSync present');

    // --- status before link (CLI)
    {
      const out = captureCli(() => runCli(['sync', 'jira', 'status', '--json'], repo));
      const parsed = JSON.parse((await out).stdout);
      record('status before link: linked=false', parsed.linked === false, JSON.stringify(parsed));
    }

    // --- link via CLI
    {
      const out = await captureCli(() => runCli(['sync', 'jira', 'link', 'LED', '--json'], repo));
      const parsed = JSON.parse(out.stdout);
      record('link via CLI', out.code === 0, JSON.stringify(parsed) + ' code=' + out.code);
    }

    // --- status via curl/fetch
    {
      const res = await fetch(`http://127.0.0.1:${handle.http.port}/api/sync/jira`);
      const body = await res.json();
      record(
        'GET /api/sync/jira reports linked project',
        res.status === 200 && body.linked === true && body.project === 'LED',
        JSON.stringify(body),
      );
    }

    // --- (a) issue created in Jira after link -> new local ticket, not-started, external.jira set
    const nowIso = new Date().toISOString();
    fakeJira.put({
      key: 'LED-1',
      summary: 'Fix the flux capacitor',
      description: 'It sparks when reversed.',
      status: 'To Do',
      updated: nowIso,
    });

    const tick1 = await callRpc(handle.rpc.socketPath, 'sync.jira_tick', {});
    record(
      'tick creates a ticket from new Jira issue',
      Array.isArray(tick1.created) && tick1.created.length === 1,
      JSON.stringify(tick1),
    );

    const createdTicketId = tick1.created?.[0];
    let ticket = createdTicketId ? handle.store!.getTicket(createdTicketId) : undefined;
    record(
      'new ticket is not-started (draft) with external.jira=LED-1',
      !!ticket && ticket.status === 'draft' && ticket.external?.jira === 'LED-1',
      JSON.stringify(ticket?.status) + ' ' + JSON.stringify(ticket?.external),
    );
    record(
      'new ticket title/description mirror the Jira issue',
      ticket?.title === 'Fix the flux capacitor' &&
        ticket?.description === 'It sparks when reversed.',
      `title=${ticket?.title} description=${ticket?.description}`,
    );

    if (!ticket) return finish(results, repo, fakeJira, handle);

    // --- (b) local status change -> pushes to Jira status
    ticket = await handle.store!.putTicket(
      { ...ticket, status: 'in_progress', history: [...ticket.history, 'qa: set in_progress'] },
      { by: 'qa' },
    );
    const tick2 = await callRpc(handle.rpc.socketPath, 'sync.jira_tick', {});
    const jiraAfterStatus = fakeJira.issues.get('LED-1');
    record(
      'local status change pushes to Jira (In Progress)',
      jiraAfterStatus?.status === 'In Progress' &&
        Array.isArray(tick2.pushedStatus) &&
        tick2.pushedStatus.includes('LED-1'),
      JSON.stringify({ jiraStatus: jiraAfterStatus?.status, tick2 }),
    );

    // --- (c) title edited in Jira -> local title updates
    fakeJira.put({
      ...fakeJira.issues.get('LED-1')!,
      summary: 'Fix the flux capacitor (rev 2)',
      updated: new Date().toISOString(),
    });
    const tick3 = await callRpc(handle.rpc.socketPath, 'sync.jira_tick', {});
    ticket = handle.store!.getTicket(createdTicketId);
    record(
      'title edited in Jira updates local ticket',
      ticket.title === 'Fix the flux capacitor (rev 2)' &&
        Array.isArray(tick3.pulled) &&
        tick3.pulled.includes(createdTicketId),
      `title=${ticket.title} tick3=${JSON.stringify(tick3)}`,
    );

    // --- (d1) conflict: local edited, then Jira edited "later" (future updated) -> Jira wins
    ticket = await handle.store!.putTicket(
      { ...ticket, title: 'Local edit attempt A' },
      { by: 'qa' },
    );
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    fakeJira.put({
      ...fakeJira.issues.get('LED-1')!,
      summary: 'Jira edit wins A',
      updated: future,
    });
    const tick4 = await callRpc(handle.rpc.socketPath, 'sync.jira_tick', {});
    ticket = handle.store!.getTicket(createdTicketId);
    record(
      'conflict: local edited then Jira edited later -> Jira wins',
      ticket.title === 'Jira edit wins A',
      `local title now=${ticket.title} tick4=${JSON.stringify(tick4)}`,
    );

    // --- (d2) conflict: Jira edited first (past timestamp), then local edited -> local wins
    const past = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    fakeJira.put({
      ...fakeJira.issues.get('LED-1')!,
      summary: 'Jira edit B (should lose)',
      updated: past,
    });
    ticket = await handle.store!.putTicket({ ...ticket, title: 'Local edit wins B' }, { by: 'qa' });
    const tick5 = await callRpc(handle.rpc.socketPath, 'sync.jira_tick', {});
    ticket = handle.store!.getTicket(createdTicketId);
    const jiraAfterB = fakeJira.issues.get('LED-1');
    record(
      'conflict: Jira edited first (past) then local edited -> local wins, pushed to Jira',
      ticket.title === 'Local edit wins B' && jiraAfterB?.summary === 'Local edit wins B',
      `local=${ticket.title} jira=${jiraAfterB?.summary} tick5=${JSON.stringify(tick5)}`,
    );

    // --- (d3) status change in Jira is re-asserted (Agile Agents always wins on status)
    fakeJira.put({
      ...fakeJira.issues.get('LED-1')!,
      status: 'Done',
      updated: new Date().toISOString(),
    });
    const tick6 = await callRpc(handle.rpc.socketPath, 'sync.jira_tick', {});
    ticket = handle.store!.getTicket(createdTicketId);
    const jiraAfterReassert = fakeJira.issues.get('LED-1');
    record(
      'status changed in Jira is re-asserted back to local status',
      ticket.status === 'in_progress' &&
        jiraAfterReassert?.status === 'In Progress' &&
        Array.isArray(tick6.pushedStatus) &&
        tick6.pushedStatus.includes('LED-1'),
      `local=${ticket.status} jira=${jiraAfterReassert?.status} tick6=${JSON.stringify(tick6)}`,
    );

    // --- unlink
    {
      const statusBefore = await callRpc(handle.rpc.socketPath, 'sync.jira_status', {});
      const unlinkOut = await callRpc(handle.rpc.socketPath, 'sync.jira_unlink', {});
      const statusAfter = await callRpc(handle.rpc.socketPath, 'sync.jira_status', {});
      record(
        'unlink reports unlinked and status shows linked=false',
        unlinkOut.unlinked === true && statusAfter.linked === false,
        JSON.stringify({ statusBefore, unlinkOut, statusAfter }),
      );
    }

    // --- after unlink, tick is a no-op (no more polling of the project)
    {
      fakeJira.put({
        key: 'LED-2',
        summary: 'should not be pulled',
        description: '',
        status: 'To Do',
        updated: new Date().toISOString(),
      });
      const tickAfterUnlink = await callRpc(handle.rpc.socketPath, 'sync.jira_tick', {});
      record(
        'tick after unlink is a no-op (empty pass)',
        Array.isArray(tickAfterUnlink.created) && tickAfterUnlink.created.length === 0,
        JSON.stringify(tickAfterUnlink),
      );
    }
  } finally {
    await finish(results, repo, fakeJira, handle);
  }
}

async function finish(
  results: { name: string; pass: boolean; detail: string }[],
  repo: string,
  fakeJira: ReturnType<typeof startFakeJira>,
  handle: Awaited<ReturnType<typeof startDaemon>>,
) {
  // --- security checks: grep .agile/ and agile.config.yaml for token/email
  const agileDir = join(repo, '.agile');
  const configPath = join(repo, 'agile.config.yaml');
  const token = process.env.JIRA_API_TOKEN!;
  const email = process.env.JIRA_EMAIL!;
  const hits: string[] = [];
  function scanDir(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) scanDir(p);
      else {
        const content = readFileSync(p, 'utf8');
        if (content.includes(token)) hits.push(`${p}: contains API token`);
        if (content.includes(email)) hits.push(`${p}: contains email`);
      }
    }
  }
  scanDir(agileDir);
  if (existsSync(configPath)) {
    const content = readFileSync(configPath, 'utf8');
    if (content.includes(token)) hits.push(`${configPath}: contains API token`);
    if (content.includes(email)) hits.push(`${configPath}: contains email`);
  }
  console.log(
    hits.length === 0
      ? '[PASS] security: no credential leakage in .agile/ or agile.config.yaml'
      : '[FAIL] security: credential leakage found: ' + JSON.stringify(hits),
  );

  // list .agile/ layout
  function listAll(dir: string, prefix = ''): string[] {
    if (!existsSync(dir)) return [];
    let out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out = out.concat(listAll(join(dir, entry.name), rel));
      else out.push(rel);
    }
    return out;
  }
  const agileLayout = listAll(agileDir);
  const hasSyncDir = agileLayout.some((p) => p.startsWith('sync/') || p === 'sync');
  console.log(
    hasSyncDir
      ? '[FAIL] .agile/sync/ exists (should not: mapping lives on ticket, link in agile.config.yaml)'
      : '[PASS] no .agile/sync/ directory',
  );
  console.log('agile.config.yaml exists:', existsSync(configPath));
  if (existsSync(configPath)) console.log('agile.config.yaml contents:\n' + readFileSync(configPath, 'utf8'));
  console.log('.agile/ layout:\n' + agileLayout.sort().join('\n'));

  await handle.http.stop();
  await handle.rpc.close();
  fakeJira.stop();

  const failed = results.filter((r) => !r.pass);
  console.log('\n=== SUMMARY ===');
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILED:', failed.map((f) => f.name).join('; '));
  }
  console.log('temp repo left at:', repo);
}

function captureCli(fn: () => Promise<number>): Promise<{ code: number; stdout: string }> {
  const origLog = console.log;
  let buf = '';
  console.log = (...args: unknown[]) => {
    buf += args.map(String).join(' ') + '\n';
  };
  return fn()
    .then((code) => ({ code, stdout: buf }))
    .finally(() => {
      console.log = origLog;
    });
}

async function callRpc(socketPath: string, method: string, params: unknown): Promise<any> {
  const { connect } = await import('node:net');
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const id = Math.floor(Math.random() * 1e9);
    let buf = '';
    socket.on('connect', () => {
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      socket.end();
      try {
        const resp = JSON.parse(line);
        if (resp.error) reject(new Error(JSON.stringify(resp.error)));
        else resolve(resp.result);
      } catch (err) {
        reject(err);
      }
    });
    socket.on('error', reject);
  });
}

main().catch((err) => {
  console.error('QA SCRIPT ERROR:', err);
  process.exit(1);
});
