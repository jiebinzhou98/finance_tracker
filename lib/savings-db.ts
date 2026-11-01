import { db, type SyncStatus } from "@/lib/finance-db";

export interface SavingsBase {
  id: string;
  user_id?: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  syncStatus: SyncStatus;
}
export interface SavingsGoal extends SavingsBase {
  name: string;
  target_amount: number;
  currency: string;
  target_date: string | null;
  icon: string;
}
export interface SavingsDeposit extends SavingsBase {
  goal_id: string;
  amount: number;
  deposit_date: string;
  note: string;
}
export type GoalInput = Pick<SavingsGoal, "name" | "target_amount" | "currency" | "target_date" | "icon">;
export type DepositInput = Pick<SavingsDeposit, "goal_id" | "amount" | "deposit_date" | "note">;
export const goalIcons = ["🌱", "✈️", "🏠", "💻", "🛟", "🎁"];
export function savingsTotal(goalId: string, deposits: SavingsDeposit[]) {
  return deposits.filter((item) => item.goal_id === goalId && !item.deleted_at).reduce((sum, item) => sum + item.amount, 0);
}
export function savingsMoney(amount: number, currency: string) {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency, maximumFractionDigits: 2 }).format(amount / 100);
}
export function savingsProgress(saved: number, target: number) { return target > 0 ? Math.min(100, Math.max(0, saved / target * 100)) : 0; }
function positiveAmount(amount: number) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("请输入有效金额，最多保留两位小数");
}
function dateValid(value: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00`)); }
function nextTimestamp(previous?: string) { return new Date(Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0)).toISOString(); }
export async function getSavings() {
  const [goals, deposits] = await Promise.all([db.savingsGoals.toArray(), db.savingsDeposits.toArray()]);
  return { goals, deposits };
}
export async function savingsPendingCount() {
  const counts = await Promise.all([db.savingsGoals.where("syncStatus").anyOf("pending", "error").count(), db.savingsDeposits.where("syncStatus").anyOf("pending", "error").count()]);
  return counts.reduce((sum, count) => sum + count, 0);
}
export async function saveSavingsGoal(input: GoalInput, id?: string) {
  positiveAmount(input.target_amount);
  const name = input.name.trim();
  if (!name || name.length > 60) throw new Error("目标名称请填写 1–60 个字");
  if (!["CAD", "USD", "CNY", "EUR", "HKD"].includes(input.currency)) throw new Error("请选择支持的货币");
  if (input.target_date && !dateValid(input.target_date)) throw new Error("请选择有效日期");
  return db.transaction("rw", db.savingsGoals, db.savingsDeposits, async () => {
    const current = id ? await db.savingsGoals.get(id) : undefined;
    if (id && (!current || current.deleted_at)) throw new Error("找不到这个目标");
    if (current && current.currency !== input.currency && await db.savingsDeposits.where("goal_id").equals(current.id).count()) throw new Error("已有存款记录的目标不能更改货币");
    const now = nextTimestamp(current?.updated_at);
    const goal: SavingsGoal = { ...current, ...input, name, id: current?.id ?? crypto.randomUUID(), created_at: current?.created_at ?? now, updated_at: now, deleted_at: null, syncStatus: "pending" };
    await db.savingsGoals.put(goal);
    return goal;
  });
}
export async function saveSavingsDeposit(input: DepositInput, id?: string) {
  positiveAmount(input.amount);
  if (!dateValid(input.deposit_date)) throw new Error("请选择有效日期");
  return db.transaction("rw", db.savingsGoals, db.savingsDeposits, async () => {
    const goal = await db.savingsGoals.get(input.goal_id);
    if (!goal || goal.deleted_at) throw new Error("找不到这个目标");
    const current = id ? await db.savingsDeposits.get(id) : undefined;
    if (id && (!current || current.deleted_at || current.goal_id !== input.goal_id)) throw new Error("找不到这笔存款");
    const now = nextTimestamp(current?.updated_at);
    const note = input.note.trim();
    if (!id) {
      const cutoff = new Date(Date.now() - 60_000).toISOString();
      const recent = await db.savingsDeposits.where("goal_id").equals(input.goal_id).toArray();
      if (recent.some((item) => !item.deleted_at && item.created_at >= cutoff && item.amount === input.amount && item.deposit_date === input.deposit_date && item.note === note)) throw new Error("这笔存款已经保存过了，请勿重复提交");
    }
    const record: SavingsDeposit = { ...current, ...input, note, user_id: current?.user_id ?? goal.user_id, id: current?.id ?? crypto.randomUUID(), created_at: current?.created_at ?? now, updated_at: now, deleted_at: null, syncStatus: "pending" };
    await db.savingsDeposits.put(record);
    return record;
  });
}
export async function deleteSavingsGoal(id: string) {
  await db.transaction("rw", db.savingsGoals, async () => {
    const current = await db.savingsGoals.get(id);
    if (!current) return;
    const now = nextTimestamp(current.updated_at);
    await db.savingsGoals.update(id, { deleted_at: now, updated_at: now, syncStatus: "pending" });
  });
}
export async function deleteSavingsDeposit(id: string) {
  await db.transaction("rw", db.savingsDeposits, async () => {
    const current = await db.savingsDeposits.get(id);
    if (!current) return;
    const now = nextTimestamp(current.updated_at);
    await db.savingsDeposits.update(id, { deleted_at: now, updated_at: now, syncStatus: "pending" });
  });
}
