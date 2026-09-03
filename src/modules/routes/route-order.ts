/** Open route from fixed origin 0, directed matrix, bounded 2-opt refinement. */
export function efficientOrder(cells: ReadonlyArray<ReadonlyArray<{durationS:number} | null>>, original: number[]): number[] {
  const cost = (order: number[]) => {
    let sum = 0; let previous = 0;
    for (const next of order) {
      const duration = cells[previous]?.[next]?.durationS;
      if (duration === undefined || !Number.isFinite(duration) || duration < 0) return Infinity;
      sum += duration; previous = next;
    }
    return sum;
  };
  if (!Number.isFinite(cost(original))) throw new Error('A matriz contém um destino sem trajeto válido.');
  const remaining = new Set(original); const greedy: number[] = []; let cursor = 0;
  while (remaining.size) {
    const next = [...remaining].sort((a,b) => (cells[cursor]?.[a]?.durationS ?? Infinity)-(cells[cursor]?.[b]?.durationS ?? Infinity))[0]!;
    greedy.push(next); remaining.delete(next); cursor = next;
  }
  let best = cost(greedy) < cost(original) ? greedy : [...original];
  let bestCost = cost(best);
  for (let pass=0; pass<30; pass++) {
    let improved = false;
    for (let i=0;i<best.length-1;i++) for (let j=i+1;j<best.length;j++) {
      const candidate = [...best.slice(0,i),...best.slice(i,j+1).reverse(),...best.slice(j+1)];
      const duration = cost(candidate);
      if (duration < bestCost) { best=candidate; bestCost=duration; improved=true; }
    }
    if (!improved) break;
  }
  return best;
}
