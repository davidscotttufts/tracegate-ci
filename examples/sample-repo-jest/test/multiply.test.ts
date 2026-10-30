import { multiply } from '../src/math';

it('multiplies and rounds', () => {
  expect(multiply(1.25, 3)).toBe(3.75);
});
