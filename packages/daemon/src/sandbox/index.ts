/**
 * Tier-0 sandbox module (T026 — design §6, §14). Public surface: build a
 * profile from role + worktree, detect what this host can enforce, render
 * and wrap a command for that backend. See `wrap.ts` for the one function
 * `runner/session.ts` actually calls.
 */

export {
  DEFAULT_REGISTRY_ALLOWLIST,
  VENDOR_LOGIN_ENV,
  VENDOR_LOGIN_PATHS,
  buildSandboxProfile,
} from './profile';
export {
  SANDBOX_BACKENDS,
  type SandboxBackend,
  type SandboxProfile,
  type SandboxProfileOptions,
  type WrappedCommand,
} from './types';
export { defaultDetectBackendDeps, detectBackend, type DetectBackendDeps } from './backend';
export {
  buildSandboxExecCommand,
  renderSandboxExecProfile,
  type SandboxExecCommand,
} from './sandbox-exec';
export {
  DEFAULT_CONTAINER_HOME,
  DEFAULT_SANDBOX_IMAGE,
  buildContainerCommand,
  type ContainerCommand,
  type ContainerCommandOptions,
} from './container';
export {
  resolveWorktreeGitPaths,
  type GitPathsDeps,
  type WorktreeGitPaths,
} from './git-paths';
export {
  SandboxRequiredError,
  wrapAgentCommand,
  type WrapAgentCommandDeps,
  type WrapAgentCommandFn,
  type WrapAgentCommandInput,
} from './wrap';
