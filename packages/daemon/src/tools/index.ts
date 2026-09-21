/**
 * What is left of the tool framework after T130: `test_run` (its output
 * contract survives, cockpit design §4.1) and the in-process MCP server
 * over the eight verbs. The registry, the cache, the runner tiers, the
 * generated input schemas, `read_summary` and the `tool.*` RPC family are
 * deleted with the framework they belonged to.
 */

export {
  type TestFailure,
  type TestRunInput,
  type TestRunOutput,
  TestRunDeniedError,
  isAllowedTestCommand,
  runTestRun,
} from './test-run';
export {
  createVerbMcpServer,
  toCallToolResult,
  verbInputShape,
  type CreateVerbMcpServerOptions,
} from './mcp-server';
