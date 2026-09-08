/**
 * A tiny mustache-like renderer for role briefs and ceremony templates
 * (T013 — see PLAN.md "Ticket: T013 Role briefs and ceremony templates").
 *
 * Deliberately minimal: no dependency, no partials, no helpers beyond what
 * the briefs under packages/daemon/briefs/ actually need.
 *
 *   {{field}}            interpolation — throws if the field is missing
 *                         (null/undefined). This is the acceptance-criterion
 *                         guard: "every brief renders against fixture data
 *                         without missing fields."
 *   {{#each list}}...{{/each}}
 *                         repeats the block once per item, with the block's
 *                         field lookups scoped to that item. Throws if the
 *                         list itself is missing or not an array.
 *   {{#if field}}...{{/if}}
 *                         renders the block only when the field is present
 *                         and truthy (empty arrays count as falsy). Missing
 *                         is *not* an error here — this is the escape hatch
 *                         for genuinely optional fields (e.g. Ticket.assignee
 *                         before assignment).
 *
 * Dotted paths (`ticket.contract.env`) are supported; `{{this}}` refers to
 * the current scope (used inside `{{#each}}` over a list of scalars).
 */

type TextNode = { type: 'text'; value: string };
type VarNode = { type: 'var'; path: string };
type EachNode = { type: 'each'; path: string; children: TemplateNode[] };
type IfNode = { type: 'if'; path: string; children: TemplateNode[] };
type TemplateNode = TextNode | VarNode | EachNode | IfNode;

const TOKEN_RE = /\{\{(#each|#if)\s+([\w.]+)\}\}|\{\{(\/each|\/if)\}\}|\{\{([\w.]+)\}\}/g;

/** Parses `template` into a small AST of text / var / each / if nodes. */
function parse(template: string): TemplateNode[] {
  const root: TemplateNode[] = [];
  const stack: (EachNode | IfNode)[] = [];
  const currentChildren = (): TemplateNode[] => {
    const top = stack.at(-1);
    return top === undefined ? root : top.children;
  };

  let lastIndex = 0;
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null = TOKEN_RE.exec(template);
  while (match !== null) {
    const text = template.slice(lastIndex, match.index);
    if (text.length > 0) currentChildren().push({ type: 'text', value: text });
    lastIndex = TOKEN_RE.lastIndex;

    const [, openKind, openPath, closeKind, varPath] = match;
    if (openKind !== undefined && openPath !== undefined) {
      const type = openKind === '#each' ? 'each' : 'if';
      const node: EachNode | IfNode =
        type === 'each'
          ? { type: 'each', path: openPath, children: [] }
          : { type: 'if', path: openPath, children: [] };
      currentChildren().push(node);
      stack.push(node);
    } else if (closeKind !== undefined) {
      const expected = closeKind === '/each' ? 'each' : 'if';
      const top = stack.pop();
      if (top === undefined || top.type !== expected) {
        throw new Error(
          `brief template error: unexpected "{{${closeKind}}}" (no matching open block)`,
        );
      }
    } else if (varPath !== undefined) {
      currentChildren().push({ type: 'var', path: varPath });
    }
    match = TOKEN_RE.exec(template);
  }
  const tail = template.slice(lastIndex);
  if (tail.length > 0) currentChildren().push({ type: 'text', value: tail });

  if (stack.length > 0) {
    throw new Error(
      `brief template error: unclosed "{{#${stack[stack.length - 1]?.type} ${stack[stack.length - 1]?.path}}}"`,
    );
  }
  return root;
}

/** Resolves a dotted path against `scope`. Returns `undefined` if any segment is missing. */
function getPath(scope: unknown, path: string): unknown {
  if (path === 'this' || path === '.') return scope;
  let current: unknown = scope;
  for (const segment of path.split('.')) {
    if (current === undefined || current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function renderNodes(nodes: TemplateNode[], scope: unknown): string {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += node.value;
        break;
      case 'var': {
        const value = getPath(scope, node.path);
        if (value === undefined || value === null) {
          throw new Error(`brief render error: missing required field "${node.path}"`);
        }
        out += String(value);
        break;
      }
      case 'if': {
        const value = getPath(scope, node.path);
        if (isTruthy(value)) out += renderNodes(node.children, scope);
        break;
      }
      case 'each': {
        const value = getPath(scope, node.path);
        if (value === undefined) {
          throw new Error(`brief render error: missing required list "${node.path}"`);
        }
        if (!Array.isArray(value)) {
          throw new Error(
            `brief render error: "${node.path}" must be an array (got ${typeof value})`,
          );
        }
        for (const item of value) {
          out += renderNodes(node.children, item);
        }
        break;
      }
      default: {
        const exhaustive: never = node;
        throw new Error(`brief render error: unknown node ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  return out;
}

/**
 * Renders `template` against `data`. Throws on any `{{field}}` or
 * `{{#each field}}` whose path is missing from `data` — that is the
 * acceptance-criterion guard ("renders ... without missing fields").
 * `{{#if field}}` treats a missing field as false, for optional data.
 */
export function render(template: string, data: unknown): string {
  return renderNodes(parse(template), data);
}

/**
 * Approximate token count (chars/4), used only to guard against brief
 * bloat in tests — not a real tokenizer.
 */
export function approxTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}
