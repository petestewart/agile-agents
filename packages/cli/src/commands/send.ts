/**
 * `agile send` — `bus.send` (T008 scope: "`send`: `bus.send` with `--from
 * --to --kind --priority --body --ticket`"). `bus.send` validates a full
 * `Message` (`packages/daemon/src/bus/bus.ts` -> `validateMessage`), so this
 * mints the two fields a human sender doesn't supply (`id`, `ts`) and passes
 * everything else straight through; `MessageSchema`'s own `.superRefine`
 * rejects a `hil_request` without `--hil-kind`/`--deadline` or an `answer`
 * without `--promote-to` the same way it would for any other bus producer.
 */

import type { SendResult } from '@agile-agents/daemon';
import { ulid } from '@agile-agents/shared';
import type { ParsedArgs } from '../args';
import { optionalString, requireOption } from '../args';
import { callRpc } from '../client';
import { printFields, printJson } from '../format';

export function buildSendMessage(args: ParsedArgs): Record<string, unknown> {
  const from = requireOption(args.options, 'from');
  const toRaw = requireOption(args.options, 'to');
  const kind = requireOption(args.options, 'kind');
  const priority = optionalString(args.options, 'priority') ?? 'normal';
  const body = requireOption(args.options, 'body');

  const message: Record<string, unknown> = {
    id: ulid(),
    ts: new Date().toISOString(),
    from,
    to: toRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    kind,
    priority,
    body,
    refs: [],
    requires_ack: args.options['requires-ack'] !== undefined,
  };

  const ticket = optionalString(args.options, 'ticket');
  if (ticket) message.ticket = ticket;
  const hilKind = optionalString(args.options, 'hil-kind');
  if (hilKind) message.hil_kind = hilKind;
  const promoteTo = optionalString(args.options, 'promote-to');
  if (promoteTo) message.promote_to = promoteTo;
  const deadline = optionalString(args.options, 'deadline');
  if (deadline) message.deadline = deadline;
  const replyTo = optionalString(args.options, 'reply-to');
  if (replyTo) message.reply_to = replyTo;

  return message;
}

export async function runSend(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const message = buildSendMessage(args);
  const result = await callRpc<SendResult>(socketPath, 'bus.send', { message });

  if (json) {
    printJson(result);
  } else if (result.ok) {
    printFields([
      ['sent', String(message.id)],
      ['to', String(message.to)],
    ]);
  } else {
    console.error(`send refused: ${result.reason}`);
  }
  return result.ok ? 0 : 1;
}
