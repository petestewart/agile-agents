/**
 * `inbox.list` — the one RPC behind §3's list. It takes no params (the
 * inbox is deliberately unfiltered and unsorted by the caller: "oldest
 * first, globally", §3.3) and returns `{ items }`.
 */

import type { InboxItem } from '@agile-agents/shared';
import type { RpcMethodHandler } from '../rpc';
import type { InboxService } from './service';

export function buildInboxRpcMethods(service: InboxService): Record<string, RpcMethodHandler> {
  return {
    'inbox.list': (): { items: InboxItem[] } => ({ items: service.list() }),
  };
}
