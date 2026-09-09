/**
 * Architect module (T014) — see `.pipeline-report.md` for the wiring line
 * an owner of `packages/daemon/src/tools/**` and `runner/**` needs to plug
 * `verbs.ts`/`session.ts` into the daemon's real MCP bridge and `Runner`.
 */
export * from './rubric';
export * from './triage';
export * from './refine';
export * from './decision';
export * from './verbs';
export * from './session';
export * from './protocol';
