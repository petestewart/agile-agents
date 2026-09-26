/**
 * `agile tracker status|set|clear` (T326, D31): Jira and Linear settings in
 * the home `config.yaml`, over the daemon's `tracker.*` RPC (the same write
 * as Settings → Trackers). A token is never an argument, which would land in
 * shell history and `ps`: it is read from stdin when piped, else from a
 * prompt that does not echo. Nothing here prints a token.
 */

import type { TrackerSettingsStatus, TrackerSystem } from '@agile-agents/shared';
import { type ParsedArgs, hasFlag, optionalString, readStdin } from '../args';
import { callRpc } from '../client';
import { printJson } from '../format';

export interface TrackerCliIo {
  /** The token, from stdin or a no-echo prompt. Injectable for tests. */
  readToken?: (system: TrackerSystem) => Promise<string>;
}

function systemArg(args: ParsedArgs, verb: string): TrackerSystem {
  const system = args.positionals[0];
  if (system !== 'jira' && system !== 'linear') {
    throw new Error(`agile tracker ${verb} needs a tracker: jira or linear`);
  }
  return system;
}

/** Reads one line from a TTY with echo off; resolves on Enter, rejects on Ctrl-C. */
function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(question);
  return new Promise((resolve, reject) => {
    let value = '';
    const done = (err?: Error) => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('agile tracker set: cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function defaultReadToken(system: TrackerSystem): Promise<string> {
  if (process.stdin.isTTY) return promptHidden(`${system} token (not echoed): `);
  return readStdin();
}

function statusText(s: TrackerSettingsStatus): string {
  const jira = [
    `jira: token ${s.jira.token_set ? 'set' : 'not set'}`,
    s.jira.base_url ? `base URL ${s.jira.base_url}` : 'no base URL',
    ...(s.jira.email ? [`email ${s.jira.email}`] : []),
  ].join(' · ');
  return `${jira}\nlinear: token ${s.linear.token_set ? 'set' : 'not set'}`;
}

export async function runTrackerStatus(socketPath: string, json: boolean): Promise<number> {
  const out = await callRpc<TrackerSettingsStatus>(socketPath, 'tracker.status', {});
  if (json) printJson(out);
  else console.log(statusText(out));
  return 0;
}

/**
 * `agile tracker set jira|linear [--base-url <url>] [--email <addr>|--no-email] [--no-token]`:
 * reads the token unless `--no-token` (to change only Jira's base URL or email).
 */
export async function runTrackerSet(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
  io: TrackerCliIo = {},
): Promise<number> {
  const system = systemArg(args, 'set');
  if (args.positionals.length > 1) {
    throw new Error(
      'agile tracker set takes no token argument: pipe it on stdin or type it at the prompt',
    );
  }
  const params: Record<string, unknown> = { system };
  const baseUrl = optionalString(args.options, 'base-url');
  if (baseUrl !== undefined) params.base_url = baseUrl;
  const email = optionalString(args.options, 'email');
  if (email !== undefined) params.email = email;
  if (hasFlag(args.options, 'no-email')) params.email = null;
  if (!hasFlag(args.options, 'no-token')) {
    const token = (await (io.readToken ?? defaultReadToken)(system)).trim();
    if (token === '')
      throw new Error(`agile tracker set: no ${system} token given; nothing written`);
    params.token = token;
  }
  const out = await callRpc<TrackerSettingsStatus>(socketPath, 'tracker.set', params);
  if (json) printJson(out);
  else console.log(`agile tracker set: ${system} saved\n${statusText(out)}`);
  return 0;
}

/** `agile tracker clear jira|linear`: removes the token (Jira's base URL and email stay). */
export async function runTrackerClear(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const system = systemArg(args, 'clear');
  const out = await callRpc<TrackerSettingsStatus>(socketPath, 'tracker.set', {
    system,
    token: null,
  });
  if (json) printJson(out);
  else console.log(`agile tracker clear: ${system} token removed\n${statusText(out)}`);
  return 0;
}
