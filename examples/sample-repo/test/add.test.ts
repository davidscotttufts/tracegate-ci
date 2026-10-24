import { expect, it } from 'vitest';
import { add } from '../src/math';

it('adds and rounds', () => {
  expect(add(0.1, 0.2)).toBe(0.3);
});
