/** `inbox.list`: the one RPC behind §3's list. No params (oldest first, globally, §3.3); returns `{ items }`. */

import type { InboxItem } from '@agile-agents/shared';
import type { RpcMethodHandler } from '../rpc';
import type { InboxService } from './service';

export function buildInboxRpcMethods(service: InboxService): Record<string, RpcMethodHandler> {
  return {
    'inbox.list': (): { items: InboxItem[] } => ({ items: service.list() }),
  };
}
