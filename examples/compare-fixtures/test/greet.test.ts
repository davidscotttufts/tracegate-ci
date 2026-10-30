import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('the CLI greets', () => {
  expect(execFileSync(process.execPath, ['scripts/greet.mjs'], { encoding: 'utf8' }).trim()).toBe('hello');
});
