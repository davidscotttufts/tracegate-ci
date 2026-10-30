import fs from 'node:fs';
import path from 'node:path';
import { add } from './math';
import { shout } from './strings';

export function formatTotal(label: string, a: number, b: number): string {
  return `${shout(label)} ${add(a, b)}`;
}

/** Reads a data file at call time: Tracegate records the read as an input. */
export function rate(name: string): number {
  const rates = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/rates.json'), 'utf8')) as Record<string, number>;
  return rates[name] ?? 0;
}
