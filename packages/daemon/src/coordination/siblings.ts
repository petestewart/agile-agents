/**
 * Ask sibling (projects-design §9.5, T286): two children of the same
 * parent settle a detail between themselves. The exchange is a line on
 * both threads and a routed event (`sibling_ask` / `sibling_reply`) to the
 * other sibling, with a copy to the parent. A reply is also the record
 * that the sibling agreed: a joint `propose_contract` needs one.
 */

import type { RoutedEvent } from '@agile-agents/shared';
import type { EmitRouted } from '../events/producers';
import type { StreamService } from '../streams/service';

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

  async reply(from: string, askId: string, body: string): Promise<{ reply: string }> {
    const ask = this.options.events.get(askId);
    if (ask?.type !== 'sibling_ask' || ask.payload.sibling !== from || ask.subject === undefined) {
      throw new Error(`reply_sibling: ${askId} is not a question to you`);
    }
    const to = ask.subject;
    this.assertSiblings(from, to, 'reply_sibling');
    const event = await this.options.emit({
      type: 'sibling_reply',
      subject: from,
      payload: { sibling: to, body },
      siblings: [to],
      ref: askId,
      by: 'daemon',
    });
    if (event === undefined) throw new Error('reply_sibling: the reply could not be sent');
    await this.line(
      [from, to],
      `${this.title(from)} replies to ${this.title(to)} (${askId}): ${body}`.slice(0, 800),
    );
    return { reply: event.id };
  }

  /** Whether `cosigner` has answered a question from `proposer` (the joint-proposal check). */
  agreed(proposer: string, cosigner: string): boolean {
    return this.options.events
      .activityFor(proposer)
      .some(
        ({ event }) =>
          event.type === 'sibling_reply' &&
          event.subject === cosigner &&
          event.payload.sibling === proposer,
      );
  }
}
