import type { SupabaseClient } from "@supabase/supabase-js";
import type { EntityTable } from "dexie";
import { db } from "@/lib/finance-db";
import { savingsPendingCount, type SavingsBase, type SavingsGoal, type SavingsDeposit } from "@/lib/savings-db";

// Each goal and deposit has its own ID and revision so unrelated offline edits can merge.
async function syncTable<T extends SavingsBase>(client: SupabaseClient, userId: string, remoteTable: string, table: EntityTable<T, "id">) {
  const { data, error } = await client.from(remoteTable).select("*").eq("user_id", userId);
  if (error) throw error;
  const remote = new Map<string, T>((data ?? []).map((item) => [item.id, { ...item, syncStatus: "synced" } as T]));
  const uploads: T[] = [];
  let downloaded = 0;
  await db.transaction("rw", table, async () => {
    for (const item of await table.toArray()) {
      if (item.user_id && item.user_id !== userId) continue;
      const cloud = remote.get(item.id);
      remote.delete(item.id);
      const localTime = Date.parse(item.updated_at);
      const remoteTime = cloud ? Date.parse(cloud.updated_at) : -1;
      if (cloud && remoteTime > localTime) {
        await table.put(cloud);
        downloaded++;
      } else if (!cloud || localTime > remoteTime) uploads.push(item);
      else await table.put({ ...item, user_id: userId, syncStatus: "synced" });
    }
    for (const cloud of remote.values()) { await table.put(cloud); downloaded++; }
  });
  if (uploads.length) {
    const rows = uploads.map((item) => {
      const { syncStatus: _status, ...row } = item;
      void _status;
      return { ...row, user_id: userId };
    });
    const { error: uploadError } = await client.from(remoteTable).upsert(rows, { onConflict: "id" });
    await db.transaction("rw", table, async () => {
      for (const sent of uploads) {
        const current = await table.get({ id: sent.id });
        if (current?.updated_at === sent.updated_at) await table.put({ ...current, user_id: userId, syncStatus: uploadError ? "error" : "synced" });
      }
    });
    if (uploadError) throw uploadError;
  }
  return { uploaded: uploads.length, downloaded };
}

export async function syncSavings(client: SupabaseClient, userId: string) {
  // Parents are uploaded first to satisfy the owner-scoped foreign key.
  const goals = await syncTable<SavingsGoal>(client, userId, "savings_goals", db.savingsGoals);
  const deposits = await syncTable<SavingsDeposit>(client, userId, "savings_deposits", db.savingsDeposits);
  return { uploaded: goals.uploaded + deposits.uploaded, downloaded: goals.downloaded + deposits.downloaded, pending: await savingsPendingCount() };
}
