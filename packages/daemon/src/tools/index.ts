/** `test_run`, the one daemon-side tool left (design §4.1). The MCP bridge over the verbs is `agile mcp` in the CLI. */

export {
  type TestFailure,
  type TestRunInput,
  type TestRunOutput,
  TestRunDeniedError,
  isAllowedTestCommand,
  runTestRun,
} from './test-run';
