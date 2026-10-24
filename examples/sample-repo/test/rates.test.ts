import { expect, it } from 'vitest';
import { rate } from '../src/report';

it('reads the standard rate from the data file', () => {
  expect(rate('standard')).toBe(0.2);
});
