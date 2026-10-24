import { expect, it } from 'vitest';
import { shout } from '../src/strings';

it('shouts', () => {
  expect(shout('hi')).toBe('HI!');
});
