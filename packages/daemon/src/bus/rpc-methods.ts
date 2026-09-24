/** `bus.poll`, `bus.ack` and `bus.heartbeat` RPC: the Pi extension's delivery and liveness path. Params are trusted, as in `store/rpc-methods.ts`. */

import type { AgentId, AgentRecord, MessagePriority } from '@agile-agents/shared';
import type { RpcMethodHandler } from '../rpc';
import type { Bus } from './bus';

export interface BusPollParams {
  agent: AgentId;
  priority?: MessagePriority;
}

export interface BusAckParams {
  agent: AgentId;
  id: string;
}

export interface BusHeartbeatParams {
  agent: AgentId;
  patch?: Partial<AgentRecord>;
}

export function buildBusRpcMethods(bus: Bus): Record<string, RpcMethodHandler> {
  return {
    'bus.poll': (params) => {
      const { agent, priority } = params as BusPollParams;
      return bus.poll(agent, { priority });
    },
    'bus.ack': (params) => {
      const { agent, id } = params as BusAckParams;
      return bus.ack(agent, id);
    },
    'bus.heartbeat': (params) => {
      const { agent, patch } = params as BusHeartbeatParams;
      return bus.heartbeat(agent, patch ?? {});
    },
  };
}
