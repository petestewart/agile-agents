/**
 * `bus.*` RPC methods — same shape as `store/rpc-methods.ts`
 * (`buildStateRpcMethods`), for wiring into `rpc.ts`'s `extraMethods` table
 * (design/agile-agents-design.md §5 "Comms bus": "Clients ... use a
 * unix-socket API: `bus.send`, `bus.poll`, `bus.ack`, `bus.heartbeat`").
 *
 * Params are trusted to be well-formed objects shaped like the interfaces
 * below; `Bus.send` itself re-validates the message body regardless (a
 * malformed `send` params object surfaces as a normal thrown error, caught
 * by `dispatch`'s try/catch in rpc.ts — same behavior as every other RPC
 * method here and in `store/rpc-methods.ts`).
 */

import type { AgentId, AgentRecord, MessagePriority } from '@agile-agents/shared';
import type { RpcMethodHandler } from '../rpc';
import type { Bus } from './bus';

export interface BusSendParams {
  message: unknown;
}

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
    'bus.send': (params) => bus.send((params as BusSendParams).message),
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
