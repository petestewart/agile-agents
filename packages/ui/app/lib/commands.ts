/**
 * T461: slash commands in the composer. A node's live agent advertises the
 * commands its vendor runs (`GET /api/streams/:id/commands`); a line that
 * starts with one goes to the vendor as typed. Typing `/` opens a menu of
 * them. A command the cockpit can't run (`/login` needs a terminal) is held
 * with what to do instead; any other `/word` goes as a message, and the
 * hint says so first.
 */

import { type AgentCommand, slashCommandOf, vendorLoginHow } from '@agile-agents/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getStreamCommands } from './api';
import { vendorLabel } from './chat';

/** What the composer knows about the node's agent and its commands. */
export interface SlashContext {
  /** An agent is live on the node (its commands are what it advertised). */
  running: boolean;
  /** The live agent's vendor, or the one Send would start. */
  vendor?: string;
  commands: readonly AgentCommand[];
}

/** At most this many rows in the menu; typing narrows it. */
export const MENU_MAX = 8;

/**
 * The menu for a draft that is a command being typed (`/`, `/com`, no
 * space yet): names starting with what's typed first, then names or
 * descriptions containing it. `undefined` when the draft isn't one.
 */
export function commandMenu(
  draft: string,
  commands: readonly AgentCommand[],
): AgentCommand[] | undefined {
  const typed = /^\/([\w:.-]*)$/.exec(draft)?.[1];
  if (typed === undefined) return undefined;
  const q = typed.toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  const contains = commands.filter(
    (c) =>
      !starts.includes(c) &&
      q !== '' &&
      (c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)),
  );
  return [...starts, ...contains].slice(0, MENU_MAX);
}

/** Interactive commands a vendor's terminal runs that a headless agent can't. */
const LOGIN_COMMANDS = new Set(['login', 'logout']);

/**
 * Why a command line isn't sent, with what to do instead, or `undefined`
 * when it goes (an advertised command, or any other line). Only what the
 * vendor doesn't advertise is held: if it lists `/login`, it runs.
 */
export function heldCommand(draft: string, ctx: SlashContext): string | undefined {
  const name = slashCommandOf(draft);
  if (name === undefined || ctx.commands.some((c) => c.name === name)) return undefined;
  const vendor = ctx.vendor ?? 'claude';
  const label = vendorLabel(vendor);
  if (LOGIN_COMMANDS.has(name)) {
    return `/${name} can’t run here: the cockpit runs ${label} without a terminal. Log in from a terminal instead (${vendorLoginHow(vendor, label)}), then send a message.`;
  }
  if (name === 'model') {
    return '/model can’t run here. Pick the model with the model chip under the box; your next message uses it.';
  }
  return undefined;
}

/** The hint under the box while the draft is a command; `undefined` otherwise. */
export function commandHint(draft: string, ctx: SlashContext): string | undefined {
  const name = slashCommandOf(draft) ?? /^\/([\w:.-]+)$/.exec(draft.trim())?.[1];
  if (name === undefined) return undefined;
  const label = vendorLabel(ctx.vendor ?? 'claude');
  if (ctx.commands.some((c) => c.name === name)) return `Runs /${name} on ${label}.`;
  if (heldCommand(draft, ctx) !== undefined) return undefined;
  if (!ctx.running) {
    return `Commands work once the agent is running. This goes to ${label} as a message.`;
  }
  return `${label} doesn’t offer /${name} here, so this goes as a message.`;
}

/**
 * The commands of node `node`'s live agent (`session`, its id): read when
 * it changes, and again on `refresh` (a line started with `/`), since a
 * vendor lists them only after its session opens. Only the latest read lands.
 */
export function useAgentCommands(
  node: string,
  session: string | undefined,
): { running: boolean; vendor?: string; commands: AgentCommand[]; refresh: () => void } {
  const [state, setState] = useState<{
    running: boolean;
    vendor?: string;
    commands: AgentCommand[];
  }>({ running: false, commands: [] });
  const seq = useRef(0);
  const refresh = useCallback(() => {
    const at = ++seq.current;
    if (session === undefined) {
      setState({ running: false, commands: [] });
      return;
    }
    getStreamCommands(node)
      .then((next) => {
        if (at === seq.current) setState(next);
      })
      .catch(() => {
        // Offline or gone: the last list stands, and a `/` line still sends.
      });
  }, [node, session]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { ...state, refresh };
}
