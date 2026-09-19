/** Shapes shared by the DB worker and the UI. All amounts are integer cents. */

export interface Category {
  id: number;
  name: string;
  color: string;
}

export interface RuleRow {
  id: number;
  keyword: string;
  direction: 'any' | 'in' | 'out';
  categoryId: number;
  categoryName: string;
}

export interface TxnRow {
  id: number;
  receipt: string;
  completedAt: string;
  details: string;
  status: string;
  paidIn: number;
  withdrawn: number;
  balance: number | null;
  type: string;
  counterparty: string;
  categoryId: number | null;
  categorySource: 'rule' | 'manual' | null;
  categoryName: string | null;
  categoryColor: string | null;
}

export interface TxnFilter {
  /** "YYYY-MM"; omit for all time. */
  month?: string;
  search?: string;
  /** A category id, 'none' for uncategorised, or undefined for all. */
  category?: number | 'none';
  limit?: number;
  offset?: number;
}

export interface ImportResult {
  added: number;
  duplicates: number;
  categorised: number;
}

export interface CategoryTotal {
  categoryId: number | null;
  name: string;
  color: string;
  total: number;
  count: number;
}

export interface Summary {
  totalIn: number;
  totalOut: number;
  spending: CategoryTotal[];
  income: CategoryTotal[];
  topCounterparties: Array<{ name: string; total: number; count: number }>;
  monthly: Array<{ month: string; totalIn: number; totalOut: number }>;
}

export interface DbInfo {
  /** False when OPFS is unavailable and data lives in memory only. */
  persistent: boolean;
  transactionCount: number;
  uncategorised: number;
  months: string[];
}
