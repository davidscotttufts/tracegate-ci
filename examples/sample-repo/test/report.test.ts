import { expect, it } from 'vitest';
import { formatTotal } from '../src/report';

it('formats a total', () => {
  expect(formatTotal('total', 1, 2)).toBe('TOTAL! 3');
});
