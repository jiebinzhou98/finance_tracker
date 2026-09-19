import Dexie, { type EntityTable } from "dexie";

export type TransactionType = "income" | "expense";
export type SyncStatus = "pending" | "synced" | "error";

export interface RecurringRule {
  id: string;
  type: TransactionType;
  amount: number;
  currency: string;
  category: string;
  note: string;
  day: number;
}

export interface FinancePlan {
  monthlyBudget: number;
  monthlySavingsTarget: number;
  recurringRules: RecurringRule[];
  updatedAt: string;
  syncStatus: SyncStatus;
}

export interface FinanceTransaction {
  id: string;
  userId?: string;
  type: TransactionType;
  amount: number;
  currency: string;
  category: string;
  note: string;
  transactionDate: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  syncStatus: SyncStatus;
}

export interface AppSetting { key: string; value: string }

class FinanceDatabase extends Dexie {
  transactions!: EntityTable<FinanceTransaction, "id">;
  settings!: EntityTable<AppSetting, "key">;

  constructor() {
    super("morrow-finance");
    this.version(1).stores({
      transactions: "id, type, category, transactionDate, updatedAt, syncStatus, deletedAt",
      settings: "key",
    });
  }
}

export const db = new FinanceDatabase();

export async function getCurrency() {
  return (await db.settings.get("currency"))?.value ?? "CAD";
}

export async function setCurrency(currency: string) {
  await db.settings.put({ key: "currency", value: currency });
}

export function emptyFinancePlan(): FinancePlan {
  return { monthlyBudget: 0, monthlySavingsTarget: 0, recurringRules: [], updatedAt: "", syncStatus: "synced" };
}

function normalizeFinancePlan(value: Partial<FinancePlan>): FinancePlan {
  const recurringRules = Array.isArray(value.recurringRules)
    ? value.recurringRules.filter((rule): rule is RecurringRule => Boolean(
      rule && typeof rule.id === "string" && (rule.type === "income" || rule.type === "expense") &&
      Number.isFinite(rule.amount) && rule.amount > 0,
    )).map((rule) => ({
      ...rule,
      amount: Math.round(rule.amount),
      day: Math.min(31, Math.max(1, Math.round(Number(rule.day) || 1))),
      currency: String(rule.currency || "CAD").toUpperCase(),
      category: String(rule.category || "其他"),
      note: String(rule.note || "固定收支"),
    }))
    : [];

  return {
    monthlyBudget: Math.max(0, Math.round(Number(value.monthlyBudget) || 0)),
    monthlySavingsTarget: Math.max(0, Math.round(Number(value.monthlySavingsTarget) || 0)),
    recurringRules,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    syncStatus: value.syncStatus === "pending" || value.syncStatus === "error" ? value.syncStatus : "synced",
  };
}

export async function getStoredFinancePlan() {
  const stored = await db.settings.get("financePlan");
  if (!stored) return null;
  try { return normalizeFinancePlan(JSON.parse(stored.value) as Partial<FinancePlan>); }
  catch { return null; }
}

export async function getFinancePlan() {
  return (await getStoredFinancePlan()) ?? emptyFinancePlan();
}

export async function storeFinancePlan(plan: FinancePlan) {
  const normalized = normalizeFinancePlan(plan);
  await db.settings.put({ key: "financePlan", value: JSON.stringify(normalized) });
  return normalized;
}

export async function saveFinancePlan(plan: Pick<FinancePlan, "monthlyBudget" | "monthlySavingsTarget" | "recurringRules">) {
  return storeFinancePlan({ ...plan, updatedAt: new Date().toISOString(), syncStatus: "pending" });
}

async function recurringTransactionId(ruleId: string, month: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`morrow:${ruleId}:${month}`));
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function localDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function ensureMonthlyRecurringTransactions(plan: FinancePlan, now = new Date()) {
  if (!plan.recurringRules.length) return 0;
  const month = localDateKey(now).slice(0, 7);
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const todayKey = localDateKey(now);
  const candidates: FinanceTransaction[] = [];

  for (const rule of plan.recurringRules) {
    const day = Math.min(rule.day, lastDay);
    const transactionDate = `${month}-${String(day).padStart(2, "0")}`;
    if (transactionDate > todayKey) continue;
    const id = await recurringTransactionId(rule.id, month);
    const timestamp = new Date(`${transactionDate}T12:00:00.000Z`).toISOString();
    candidates.push({
      id,
      type: rule.type,
      amount: rule.amount,
      currency: rule.currency,
      category: rule.category,
      note: rule.note,
      transactionDate,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
      syncStatus: "pending",
    });
  }

  if (!candidates.length) return 0;
  return db.transaction("rw", db.transactions, async () => {
    const existing = await db.transactions.bulkGet(candidates.map((item) => item.id));
    const missing = candidates.filter((_, index) => !existing[index]);
    if (missing.length) await db.transactions.bulkAdd(missing);
    return missing.length;
  });
}

export async function getTransactions() {
  return db.transactions.orderBy("transactionDate").reverse().toArray();
}

export async function addTransaction(
  transaction: Pick<FinanceTransaction, "type" | "amount" | "currency" | "category" | "note" | "transactionDate">,
) {
  const now = new Date().toISOString();
  const record: FinanceTransaction = {
    ...transaction,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    syncStatus: "pending",
  };
  await db.transactions.add(record);
  return record;
}

export async function softDeleteTransaction(id: string) {
  const now = new Date().toISOString();
  await db.transactions.update(id, { deletedAt: now, updatedAt: now, syncStatus: "pending" });
}

export async function exportData() {
  const transactions = await db.transactions.toArray();
  const settings = await db.settings.toArray();
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), transactions, settings }, null, 2);
}
