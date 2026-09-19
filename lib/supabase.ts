import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { db, ensureMonthlyRecurringTransactions, getStoredFinancePlan, storeFinancePlan, type FinancePlan, type FinanceTransaction, type RecurringRule } from "@/lib/finance-db";

let client: SupabaseClient | null | undefined;
let syncInFlight: Promise<SyncResult> | null = null;

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  pending: number;
  planChanged: boolean;
  syncedAt: string;
}

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

const timestamp = (value: string) => Date.parse(value) || 0;

const toRemotePlan = (plan: FinancePlan, userId: string) => ({
  user_id: userId,
  monthly_budget: plan.monthlyBudget,
  monthly_savings_target: plan.monthlySavingsTarget,
  recurring_rules: plan.recurringRules,
  updated_at: plan.updatedAt,
});

const fromRemotePlan = (item: Record<string, unknown>): FinancePlan => ({
  monthlyBudget: Number(item.monthly_budget) || 0,
  monthlySavingsTarget: Number(item.monthly_savings_target) || 0,
  recurringRules: Array.isArray(item.recurring_rules) ? item.recurring_rules as RecurringRule[] : [],
  updatedAt: String(item.updated_at ?? ""),
  syncStatus: "synced",
});

async function syncFinancePlan(supabase: SupabaseClient, userId: string) {
  const local = await getStoredFinancePlan();
  const { data, error } = await supabase
    .from("finance_profiles")
    .select("user_id, monthly_budget, monthly_savings_target, recurring_rules, updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;

  const remote = data ? fromRemotePlan(data) : null;
  let current = local;
  let changed = false;

  if (remote && (!local || timestamp(remote.updatedAt) > timestamp(local.updatedAt))) {
    current = await storeFinancePlan(remote);
    changed = true;
  } else if (local && (!remote || timestamp(local.updatedAt) > timestamp(remote.updatedAt))) {
    const { error: uploadError } = await supabase
      .from("finance_profiles")
      .upsert(toRemotePlan(local, userId), { onConflict: "user_id" });
    if (uploadError) {
      await storeFinancePlan({ ...local, syncStatus: "error" });
      throw uploadError;
    }
    current = await storeFinancePlan({ ...local, syncStatus: "synced" });
    changed = true;
  } else if (local) {
    current = await storeFinancePlan({ ...local, syncStatus: "synced" });
  }

  if (current) await ensureMonthlyRecurringTransactions(current);
  return changed;
}

async function markUploadResult(items: FinanceTransaction[], userId: string, syncStatus: "synced" | "error") {
  await db.transaction("rw", db.transactions, async () => {
    for (const uploaded of items) {
      const current = await db.transactions.get(uploaded.id);
      if (!current || current.updatedAt !== uploaded.updatedAt) continue;
      await db.transactions.update(uploaded.id, { syncStatus, userId });
    }
  });
}

async function performSync(): Promise<SyncResult> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("尚未配置云同步");

  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  const user = authData.user;
  if (!user) throw new Error("请先登录后再同步");

  const planChanged = await syncFinancePlan(supabase, user.id);

  // Pull first so an older offline copy can never overwrite a newer cloud copy.
  const { data, error: downloadError } = await supabase
    .from("transactions")
    .select("*")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: true });
  if (downloadError) throw downloadError;

  const remoteRecords = (data ?? []).map(fromRemote);
  const remoteById = new Map(remoteRecords.map((item) => [item.id, item]));
  const localRecords = await db.transactions.toArray();
  const uploads: FinanceTransaction[] = [];
  const downloads: FinanceTransaction[] = [];
  const alreadySynced: FinanceTransaction[] = [];

  for (const local of localRecords) {
    // Never move data that is already bound to a different account.
    if (local.userId && local.userId !== user.id) continue;
    const remote = remoteById.get(local.id);
    if (!remote) {
      uploads.push(local);
      continue;
    }

    remoteById.delete(local.id);
    if (timestamp(remote.updatedAt) > timestamp(local.updatedAt)) downloads.push(remote);
    else if (timestamp(local.updatedAt) > timestamp(remote.updatedAt)) uploads.push(local);
    else alreadySynced.push(local);
  }

  // Anything left only exists in the cloud, such as records restored on a new phone.
  downloads.push(...remoteById.values());
  if (downloads.length) await db.transactions.bulkPut(downloads);
  if (alreadySynced.length) await markUploadResult(alreadySynced, user.id, "synced");

  if (uploads.length) {
    const { error: uploadError } = await supabase
      .from("transactions")
      .upsert(uploads.map((item) => toRemote(item, user.id)), { onConflict: "id" });
    if (uploadError) {
      await markUploadResult(uploads, user.id, "error");
      throw uploadError;
    }
    // Do not mark a row synced if it changed locally while the request was running.
    await markUploadResult(uploads, user.id, "synced");
  }

  const syncedAt = new Date().toISOString();
  await db.settings.put({ key: "lastSync", value: syncedAt });
  const pending = await db.transactions.where("syncStatus").anyOf("pending", "error").count();
  return { uploaded: uploads.length, downloaded: downloads.length, pending, planChanged, syncedAt };
}

export function syncTransactions() {
  if (!syncInFlight) {
    syncInFlight = performSync().finally(() => {
      syncInFlight = null;
    });
  }
  return syncInFlight;
}
