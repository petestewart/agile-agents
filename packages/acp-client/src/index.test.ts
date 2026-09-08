import { expect, test } from 'bun:test';
import { PACKAGE_NAME } from './index';

test('PACKAGE_NAME identifies the package', () => {
  expect(PACKAGE_NAME).toBe('@agile-agents/acp-client');
});
