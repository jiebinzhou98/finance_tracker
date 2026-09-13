import Dexie, { type EntityTable } from "dexie";

export type TransactionType = "income" | "expense";
export type SyncStatus = "pending" | "synced" | "error";

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
