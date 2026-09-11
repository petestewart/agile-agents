/**
 * Review protocol module (T016 — design/agile-agents-design.md §12).
 * See each file's header for the design citation; `builtins.ts`/`rpc.ts`
 * document the exact wiring gap into `tools/**`/`rpc.ts` this ticket cannot
 * close itself (file ownership).
 */

export {
  DiffSummaryError,
  runDiffSummary,
  type DiffFileStatus,
  type DiffFileSummary,
  type DiffHunk,
  type DiffSummaryOutput,
  type RunDiffSummaryOptions,
} from './diff-summary';

export {
  RuleLoadError,
  findRule,
  loadRules,
  type RuleDefinition,
} from './rules';

export {
  findingKey,
  findingWasRaisedBefore,
  sameFinding,
  FINDING_SEVERITIES,
  FindingSchema,
  FindingSeveritySchema,
  REVIEW_PASSES,
  REVIEW_VERDICTS,
  ReviewPassSchema,
  ReviewVerdictKindSchema,
  VerdictSchema,
  validateFinding,
  validateVerdict,
  type Finding,
  type FindingLocation,
  type FindingSeverity,
  type ReviewPass,
  type ReviewVerdictKind,
  type Verdict,
} from './findings';

export { type RejectedFinding, type ReReviewResult, validateReReview } from './rereview';

export {
  type DisputeRecord,
  DisputeRecordSchema,
  disputeRecordRelPath,
  type ReviewRecord,
  ReviewRecordSchema,
  reviewRecordRelPath,
  validateDisputeRecord,
  validateReviewRecord,
} from './types';

export {
  ReReviewViolationError,
  ReviewProtocol,
  requiresSecurityPass,
  type DisputeInput,
  type DisputeOutcome,
  type ReviewProtocolOptions,
  type StartReviewResult,
  type SubmitVerdictInput,
  type SubmitVerdictOutcome,
} from './protocol';

export {
  ReviewToolError,
  REVIEW_BUILTIN_TOOLS,
  registerReviewTools,
  type ReviewToolDeps,
  type ReviewToolInfo,
  type ReviewToolInputFieldSpec,
  type ReviewToolInputSpec,
} from './builtins';

export {
  ReviewVerbError,
  reviewDispute,
  qaGet,
  reviewGet,
  reviewSubmit,
  rulesList,
  type ReviewVerbDeps,
} from './verbs';

export { buildReviewRpcMethods } from './rpc';
