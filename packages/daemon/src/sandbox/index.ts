/** Tier-0 sandbox (§6, §14): profile, backend detection, rendering and `wrapAgentCommand`. */

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
