/**
 * @agile-agents/acp-client
 *
 * ACP (Agent Client Protocol) session client, extracted from Terma in T003
 * (design/agile-agents-design.md §8 "Adapter contract (ACP)"). One public
 * API: `spawnSession`.
 */
export { spawnSession, resolveAgentEnv, AcpRpcError, type SpawnedSession } from './session';

export {
  ACP_PROVIDERS,
  isAcpProviderId,
  resolveAcpProvider,
  type AcpProviderConfig,
  type AcpProviderId,
} from './providers';

export { LineFramer, FramingOverflowError, DEFAULT_MAX_BUFFER_BYTES } from './framing';

export {
  EventLog,
  parseAcpEvent,
  DEFAULT_MAX_EVENT_LOG_ENTRIES,
  DEFAULT_MAX_EVENT_LOG_CHARS,
} from './events';

export {
  turnEndFromStopReason,
  turnEndFromExit,
  turnEndFromError,
  turnEndFromEvent,
  applyFinalMessageEvent,
  replyFromFinalMessage,
  INITIAL_FINAL_MESSAGE,
  type FinalMessageState,
} from './contract';

export {
  createMessageableSession,
  type MessageableSession,
} from './messageable';

export type {
  AcpClientCapabilities,
  AcpEvent,
  AcpJsonRpcMessage,
  AcpRequestId,
  AcpReplay,
  AgentEvent,
  Sequenced,
  SessionReply,
  SessionTurnEnd,
  SessionTurnError,
  SessionTurnStatus,
  SpawnSessionOptions,
  WireAcpEvent,
} from './types';
export {
  ACP_REQUEST_SETTLED_METHOD,
  ACP_SESSION_STATE_METHOD,
  ACP_TURN_ENDED_METHOD,
  AcpClientError,
  AuthRequiredError,
  REPLY_TEXT_MAX_CHARS,
} from './types';
