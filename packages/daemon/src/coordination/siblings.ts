/**
 * Ask sibling (projects-design §9.5, T286): two children of the same
 * parent settle a detail between themselves. The exchange is a line on
 * both threads and a routed event (`sibling_ask` / `sibling_reply`) to the
 * other sibling, with a copy to the parent. A reply is also the record
 * that the sibling agreed: a joint `propose_contract` needs one.
 */

import { createHash } from 'node:crypto';
import type { RoutedEvent } from '@agile-agents/shared';
import type { EmitRouted } from '../events/producers';
import type { StreamService } from '../streams/service';

/** The agreement fingerprint of a contract body (trimmed, as stored). */
export function bodyHash(body: string): string {
  return createHash('sha256').update(body.trim()).digest('hex');
}

export interface SiblingServiceOptions {
  streams: StreamService;
  emit: EmitRouted;
  events: {
    get(id: string): RoutedEvent | undefined;
    activityFor(node: string): { event: RoutedEvent }[];
  };
}

export class SiblingService {
  constructor(private readonly options: SiblingServiceOptions) {}

  private assertSiblings(a: string, b: string, verb: string): void {
    const { streams } = this.options;
    const parent = streams.get(a).parent;
    if (a === b || parent === undefined || streams.get(b).parent !== parent) {
      throw new Error(`${verb}: ${b} is not a sibling of this node`);
    }
  }

  private async line(nodes: string[], body: string): Promise<void> {
    for (const node of nodes) {
      await this.options.streams.appendThread('daemon', node, { kind: 'event', body });
    }
  }

  private title(id: string): string {
    return this.options.streams.get(id).title;
  }

  async ask(from: string, to: string, question: string): Promise<{ ask: string }> {
    this.assertSiblings(from, to, 'ask_sibling');
    const event = await this.options.emit({
      type: 'sibling_ask',
      subject: from,
      payload: { sibling: to, question },
      siblings: [to],
      by: 'daemon',
    });
    if (event === undefined) throw new Error('ask_sibling: the question could not be sent');
    await this.line(
      [from, to],
      `${this.title(from)} asks ${this.title(to)} (${event.id}): ${question}`.slice(0, 800),
    );
    return { ask: event.id };
  }

  async reply(
    from: string,
    askId: string,
    body: string,
    agree?: { contract: string; body: string },
  ): Promise<{ reply: string }> {
    const ask = this.options.events.get(askId);
    if (ask?.type !== 'sibling_ask' || ask.payload.sibling !== from || ask.subject === undefined) {
      throw new Error(`reply_sibling: ${askId} is not a question to you`);
    }
    const to = ask.subject;
    this.assertSiblings(from, to, 'reply_sibling');
    const event = await this.options.emit({
      type: 'sibling_reply',
      subject: from,
      payload: {
        sibling: to,
        body,
        ...(agree !== undefined
          ? { agree: { contract: agree.contract, body_sha256: bodyHash(agree.body) } }
          : {}),
      },
      siblings: [to],
      ref: askId,
      by: 'daemon',
    });
    if (event === undefined) throw new Error('reply_sibling: the reply could not be sent');
    const agreed = agree === undefined ? '' : ` [agrees to ${agree.contract}: ${agree.body}]`;
    await this.line(
      [from, to],
      `${this.title(from)} replies to ${this.title(to)} (${askId}): ${body}${agreed}`.slice(0, 800),
    );
    return { reply: event.id };
  }

  /**
   * Whether `cosigner` explicitly agreed to `proposer`'s joint proposal:
   * a reply to the proposer's latest ask to it, whose `agree` names this
   * contract and this exact body. A plain reply does not count.
   */
  agreed(proposer: string, cosigner: string, contract: string, body: string): boolean {
    const { events } = this.options;
    const lastAsk = events
      .activityFor(cosigner)
      .map((a) => a.event)
      .find((e) => e.type === 'sibling_ask' && e.subject === proposer);
    if (lastAsk === undefined) return false;
    const hash = bodyHash(body);
    return events
      .activityFor(proposer)
      .map((a) => a.event)
      .some((e) => {
        const agree = e.payload.agree as { contract?: string; body_sha256?: string } | undefined;
        return (
          e.type === 'sibling_reply' &&
          e.subject === cosigner &&
          e.ref === lastAsk.id &&
          agree?.contract === contract &&
          agree.body_sha256 === hash
        );
      });
  }
}
