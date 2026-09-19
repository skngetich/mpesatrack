import { describe, expect, it } from 'vitest';
import { matchRule, type Rule } from './categorize';

const rules: Rule[] = [
  { id: 1, keyword: 'charge', direction: 'out', categoryId: 10 },
  { id: 2, keyword: 'pay bill charge', direction: 'any', categoryId: 11 },
  { id: 3, keyword: 'kfc', direction: 'out', categoryId: 20 },
  { id: 4, keyword: 'salary', direction: 'in', categoryId: 30 },
];
const out = (details: string) => ({ details, paidIn: 0, withdrawn: 100 });
const inn = (details: string) => ({ details, paidIn: 100, withdrawn: 0 });

describe('matchRule', () => {
  it('prefers the longest (most specific) keyword', () => {
    expect(matchRule(rules, out('Pay Bill Charge'))).toBe(11);
    expect(matchRule(rules, out('Some Charge'))).toBe(10);
  });
  it('is case-insensitive', () => {
    expect(matchRule(rules, out('Merchant Payment to 1 - KFC WESTLANDS'))).toBe(20);
  });
  it('respects direction', () => {
    expect(matchRule(rules, inn('Salary March'))).toBe(30);
    expect(matchRule(rules, out('Salary March'))).toBeNull();
  });
  it('returns null when nothing matches', () => {
    expect(matchRule(rules, out('Random'))).toBeNull();
  });
});
