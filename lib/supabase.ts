import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { db, type FinanceTransaction } from "@/lib/finance-db";

let client: SupabaseClient | null | undefined;

export function isCloudConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
}

export function getSupabase() {
  if (client !== undefined) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  client = url && key ? createClient(url, key) : null;
  return client;
}

const toRemote = (item: FinanceTransaction, userId: string) => ({
  id: item.id,
  user_id: userId,
  type: item.type,
  amount: item.amount,
  currency: item.currency,
  category: item.category,
  note: item.note,
  transaction_date: item.transactionDate,
  created_at: item.createdAt,
  updated_at: item.updatedAt,
  deleted_at: item.deletedAt ?? null,
});

const fromRemote = (item: Record<string, unknown>): FinanceTransaction => ({
  id: String(item.id),
  userId: String(item.user_id),
  type: item.type as FinanceTransaction["type"],
  amount: Number(item.amount),
  currency: String(item.currency),
  category: String(item.category),
  note: String(item.note ?? ""),
  transactionDate: String(item.transaction_date),
  createdAt: String(item.created_at),
  updatedAt: String(item.updated_at),
  deletedAt: item.deleted_at ? String(item.deleted_at) : null,
  syncStatus: "synced",
});

export async function syncTransactions() {
  const supabase = getSupabase();
  if (!supabase) throw new Error("尚未配置云同步");
  const { data: authData } = await supabase.auth.getUser();
  const user = authData.user;
  if (!user) throw new Error("请先登录后再同步");

  const pending = await db.transactions.where("syncStatus").anyOf("pending", "error").toArray();
  if (pending.length) {
    const { error } = await supabase.from("transactions").upsert(pending.map((item) => toRemote(item, user.id)));
    if (error) {
      await db.transactions.bulkUpdate(pending.map((item) => ({ key: item.id, changes: { syncStatus: "error" as const } })));
      throw error;
    }
    await db.transactions.bulkUpdate(pending.map((item) => ({ key: item.id, changes: { syncStatus: "synced" as const, userId: user.id } })));
  }

  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: true });
  if (error) throw error;
  for (const remote of data ?? []) {
    const remoteRecord = fromRemote(remote);
    const local = await db.transactions.get(remoteRecord.id);
    if (!local || new Date(remoteRecord.updatedAt) > new Date(local.updatedAt)) await db.transactions.put(remoteRecord);
  }
  await db.settings.put({ key: "lastSync", value: new Date().toISOString() });
}
