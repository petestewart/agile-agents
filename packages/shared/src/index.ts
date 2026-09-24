/**
 * @agile-agents/shared
 *
 * Shared zod schemas and inferred types for Agile Agents, imported by every
 * other package. Every entity in design/agile-agents-design.md §4–§5, plus
 * fields it carries from §6–§7, §10, §11, §16.
 */

export const PACKAGE_NAME = '@agile-agents/shared';

export * from './ids';
export * from './effort';
export * from './stream';
export * from './rule';
export * from './agents';
export * from './policy';
export * from './vendors';
export * from './agent-message';
export * from './event';
export * from './hil';
export * from './question';
export * from './inbox';
export * from './repos';
export * from './home-config';
export * from './verbs';
export * from './session-defaults';
export * from './project';
