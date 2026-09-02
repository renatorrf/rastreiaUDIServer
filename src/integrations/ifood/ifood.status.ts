const statuses: Record<string, string> = { PLC: 'PLACED', PLACED: 'PLACED', CFM: 'CONFIRMED', CONFIRMED: 'CONFIRMED',
  PRP: 'PREPARATION_STARTED', PREPARATION_STARTED: 'PREPARATION_STARTED', DSP: 'DISPATCHED', DISPATCHED: 'DISPATCHED',
  CON: 'CONCLUDED', CONCLUDED: 'CONCLUDED', CAN: 'CANCELLED', CANCELLED: 'CANCELLED' };
export function externalStatus(code: string, fullCode: string): string | null { return statuses[fullCode] ?? statuses[code] ?? null; }
export function advancesExternalStatus(previous: string, next: string): boolean {
  if (previous === 'CANCELLED') return false;
  if (previous === 'CONCLUDED') return next === 'CANCELLED';
  const rank: Record<string, number> = { PLACED: 0, CONFIRMED: 1, PREPARATION_STARTED: 2, DISPATCHED: 3, CONCLUDED: 4, CANCELLED: 5 };
  return (rank[next] ?? -1) >= (rank[previous] ?? -1);
}
