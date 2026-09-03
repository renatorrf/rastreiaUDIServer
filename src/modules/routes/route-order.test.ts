import { describe,expect,it } from 'vitest';
import { efficientOrder } from './route-order.js';
describe('efficient open route',()=>{
  it('preserves every destination and never increases original duration on asymmetric matrices',()=>{
    for(let seed=0;seed<40;seed++){
      const matrix=Array.from({length:7},(_,i)=>Array.from({length:7},(_,j)=>({durationS:i===j?0:1+(i*31+j*17+seed*7)%101})));
      const initial=[1,2,3,4,5,6];const result=efficientOrder(matrix,initial);
      const cost=(order:number[])=>order.reduce((sum,n,i)=>sum+matrix[i===0?0:order[i-1]!]![n]!.durationS,0);
      expect([...result].sort()).toEqual(initial);expect(cost(result)).toBeLessThanOrEqual(cost(initial));
    }
  });
  it('rejects unreachable legs instead of displaying a fictitious route',()=>{
    expect(()=>efficientOrder([[{durationS:0},null],[null,{durationS:0}]],[1])).toThrow();
  });
});
