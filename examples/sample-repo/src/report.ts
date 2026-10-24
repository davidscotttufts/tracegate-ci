import fs from 'node:fs';
import { add } from './math';
import { shout } from './strings';

export function formatTotal(label: string, a: number, b: number): string {
  return `${shout(label)} ${add(a, b)}`;
}

/** Reads a data file at call time: Tracegate records the read as an input. */
export function rate(name: string): number {
  const rates = JSON.parse(fs.readFileSync(new URL('../data/rates.json', import.meta.url), 'utf8')) as Record<string, number>;
  return rates[name] ?? 0;
}
