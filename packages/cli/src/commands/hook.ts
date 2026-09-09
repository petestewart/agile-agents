/**
 * `agile hook <event>` — the single entrypoint vendor hook configs call
 * (design §18 "Technical shape": "the single entrypoint every vendor hook
 * config calls (`agile hook pre-tool-use`), normalizing each vendor's hook
 * payload format"). Forwards stdin JSON to `hook.<event>` (kebab-case CLI
 * event -> snake_case RPC method: `pre-tool-use` -> `hook.pre_tool_use`,
 * `post-tool-use` -> `hook.post_tool_use`, `stop` -> `hook.stop`) and prints
 * the daemon's reply as JSON to stdout.
 *
 * The `hook.*` RPC namespace is still T009's stub (`rpc.ts`'s
 * `STUB_NAMESPACES`, -32001 "not implemented yet"). A vendor hook blocks the
 * tool call it wraps until this process exits, so this ticket's read of the
 * ticket's acceptance line ("a vendor hook never blocks because the daemon
 * isn't ready") is: **fail open by default** — on the stub's -32001, or on
 * any transport failure (daemon not running at all, which is exactly the
 * same "not ready" situation from the hook's point of view), print a
 * permissive pass-through decision `{}` and exit 0, so a half-wired or
 * absent daemon degrades to "allow everything" rather than freezing every
 * vendor tool call.
 *
 * DESIGN-GAP: the design does not specify what a "permissive pass-through
 * decision" looks like on the wire (that's T009's contract to define,
 * alongside the real per-vendor hook JSON shapes named in §6/spike-findings)
 * — `{}` is the smallest value that says nothing ("no decision" reads as
 * "allow" to every hook consumer this ticket could find in the design).
 * `--fail-closed` flips this for T009: any RPC failure (stub or transport)
 * is then a hard failure — the error is printed to stderr and the process
 * exits 1, instead of substituting `{}`.
 */

import { type ParsedArgs, hasFlag, readStdin } from '../args';
import { RpcCallError, callRpc } from '../client';
import { printJson } from '../format';

const NOT_IMPLEMENTED_CODE = -32001;

/** `pre-tool-use` -> `pre_tool_use`, `post-tool-use` -> `post_tool_use`, `stop` -> `stop`. */
export function hookEventToMethod(event: string): string {
  return `hook.${event.replace(/-/g, '_')}`;
}

export interface RunHookOptions {
  socketPath: string;
  event: string;
  failClosed: boolean;
  stdin?: NodeJS.ReadableStream;
}

export async function runHook(options: RunHookOptions): Promise<number> {
  const { socketPath, event, failClosed } = options;
  const raw = await readStdin(options.stdin);

  let payload: unknown;
  try {
    payload = raw.trim().length > 0 ? JSON.parse(raw) : {};
  } catch (err) {
    console.error(
      `agile hook ${event}: invalid JSON on stdin: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const method = hookEventToMethod(event);

  try {
    const result = await callRpc<unknown>(socketPath, method, payload);
    printJson(result);
    return 0;
  } catch (err) {
    const isStub = err instanceof RpcCallError && err.code === NOT_IMPLEMENTED_CODE;
    if (!failClosed) {
      // Fail-open: a stub reply or an unreachable daemon both mean "the
      // daemon has no opinion yet" from the hook's point of view.
      printJson({});
      return 0;
    }
    console.error(
      `agile hook ${event}: ${isStub ? 'hook.* not implemented yet' : 'RPC failed'}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 1;
  }
}

export function parseHookArgs(args: ParsedArgs): { event: string; failClosed: boolean } {
  const event = args.positionals[0];
  if (!event) throw new Error('usage: agile hook <event> (e.g. pre-tool-use)');
  return { event, failClosed: hasFlag(args.options, 'fail-closed') };
}
