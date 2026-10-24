export const PRECISION = 2;

export function add(a: number, b: number): number {
  return round(a + b);
}

export function multiply(a: number, b: number): number {
  return round(a * b);
}

function round(x: number): number {
  const f = 10 ** PRECISION;
  return Math.round(x * f) / f;
}
