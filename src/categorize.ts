/**
 * Categorisation rules (pure; used inside the DB worker and unit-tested).
 *
 * A rule says: "if a transaction's Details contain KEYWORD (case-insensitive),
 * and its direction matches, put it in CATEGORY". When several rules match, the
 * LONGEST keyword wins (it is the most specific), then the oldest rule.
 *
 * A transaction the user categorised by hand (category_source = 'manual') is
 * never touched by rules; see docs/ARCHITECTURE.md.
 */

export type Direction = 'any' | 'in' | 'out';

export interface Rule {
  id: number;
  keyword: string;
  direction: Direction;
  categoryId: number;
}

export interface Matchable {
  details: string;
  paidIn: number;
  withdrawn: number;
}

export interface DefaultCategory {
  name: string;
  color: string;
}

/** Seeded on first launch. Users can add and delete categories in the app. */
export const DEFAULT_CATEGORIES: DefaultCategory[] = [
  { name: 'Food & groceries', color: '#e8710a' },
  { name: 'Transport', color: '#1a73e8' },
  { name: 'Airtime & data', color: '#9334e6' },
  { name: 'Bills & utilities', color: '#d93025' },
  { name: 'Rent & housing', color: '#5f6368' },
  { name: 'Savings & investments', color: '#0b8f3c' },
  { name: 'Loans & Fuliza', color: '#a52714' },
  { name: 'Fees & charges', color: '#b06000' },
  { name: 'Cash withdrawal', color: '#188038' },
  { name: 'Health', color: '#c2185b' },
  { name: 'Education', color: '#00838f' },
  { name: 'Entertainment', color: '#f9ab00' },
  { name: 'Shopping', color: '#7b1fa2' },
  { name: 'Income', color: '#137333' },
  { name: 'Family & friends', color: '#3949ab' },
];

/** [keyword, category name, direction]. Starting points; edit freely in the app. */
export const DEFAULT_RULES: Array<[string, string, Direction]> = [
  // fees
  ['transfer fee', 'Fees & charges', 'any'],
  ['charge', 'Fees & charges', 'out'],
  // cash
  ['withdraw', 'Cash withdrawal', 'out'],
  // airtime & data
  ['airtime', 'Airtime & data', 'any'],
  ['bundle', 'Airtime & data', 'out'],
  // loans
  ['fuliza', 'Loans & Fuliza', 'any'],
  ['overdraft', 'Loans & Fuliza', 'any'],
  ['tala', 'Loans & Fuliza', 'any'],
  ['okoa', 'Loans & Fuliza', 'any'],
  // savings
  ['m-shwari', 'Savings & investments', 'any'],
  ['kcb m-pesa', 'Savings & investments', 'any'],
  ['lock savings', 'Savings & investments', 'any'],
  ['ziidi', 'Savings & investments', 'any'],
  ['sacco', 'Savings & investments', 'any'],
  // bills
  ['kplc', 'Bills & utilities', 'out'],
  ['kenya power', 'Bills & utilities', 'out'],
  ['nairobi water', 'Bills & utilities', 'out'],
  ['zuku', 'Bills & utilities', 'out'],
  ['dstv', 'Bills & utilities', 'out'],
  ['gotv', 'Bills & utilities', 'out'],
  ['startimes', 'Bills & utilities', 'out'],
  ['faiba', 'Bills & utilities', 'out'],
  // transport
  ['uber', 'Transport', 'out'],
  ['bolt', 'Transport', 'out'],
  ['shell', 'Transport', 'out'],
  ['rubis', 'Transport', 'out'],
  ['total energies', 'Transport', 'out'],
  ['petrol', 'Transport', 'out'],
  // food
  ['naivas', 'Food & groceries', 'out'],
  ['carrefour', 'Food & groceries', 'out'],
  ['quickmart', 'Food & groceries', 'out'],
  ['chandarana', 'Food & groceries', 'out'],
  ['kfc', 'Food & groceries', 'out'],
  ['java house', 'Food & groceries', 'out'],
  ['glovo', 'Food & groceries', 'out'],
  ['mama mboga', 'Food & groceries', 'out'],
  ['butchery', 'Food & groceries', 'out'],
  ['supermarket', 'Food & groceries', 'out'],
  ['restaurant', 'Food & groceries', 'out'],
  // health / education / fun / shopping
  ['pharmacy', 'Health', 'out'],
  ['hospital', 'Health', 'out'],
  ['school', 'Education', 'out'],
  ['university', 'Education', 'out'],
  ['helb', 'Education', 'out'],
  ['netflix', 'Entertainment', 'out'],
  ['showmax', 'Entertainment', 'out'],
  ['sportpesa', 'Entertainment', 'out'],
  ['betika', 'Entertainment', 'out'],
  ['jumia', 'Shopping', 'out'],
  // income
  ['salary', 'Income', 'in'],
  ['business payment from', 'Income', 'in'],
];

/** Pick the category id for a transaction, or null when no rule matches. */
export function matchRule(rules: Rule[], t: Matchable): number | null {
  const d = t.details.toLowerCase();
  const dir: Direction = t.paidIn > 0 && t.withdrawn === 0 ? 'in' : t.withdrawn > 0 ? 'out' : 'any';
  let best: Rule | null = null;
  for (const r of rules) {
    if (r.direction !== 'any' && r.direction !== dir) continue;
    if (!d.includes(r.keyword.toLowerCase())) continue;
    if (
      !best ||
      r.keyword.length > best.keyword.length ||
      (r.keyword.length === best.keyword.length && r.id < best.id)
    ) {
      best = r;
    }
  }
  return best ? best.categoryId : null;
}
