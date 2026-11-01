"use client";

import { useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Check, ChevronRight, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { currencyLabels, supportedCurrencies } from "@/lib/exchange-rates";
import { deleteSavingsDeposit, deleteSavingsGoal, goalIcons, saveSavingsDeposit, saveSavingsGoal, savingsMoney, savingsProgress, savingsTotal, type SavingsGoal, type SavingsDeposit, type GoalInput, type DepositInput } from "@/lib/savings-db";

type Screen = { kind: "detail"; goalId: string } | { kind: "goal"; goalId?: string } | { kind: "deposit"; goalId: string; depositId?: string };
type DeleteAction = { kind: "goal" | "deposit"; id: string };
const localToday = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
const dateLabel = (date: string) => new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(new Date(`${date}T12:00:00`));

export function SavingsGoals({ goals, deposits, currency, onChanged }: { goals: SavingsGoal[]; deposits: SavingsDeposit[]; currency: string; onChanged: () => Promise<void> }) {
  const [screen, setScreen] = useState<Screen | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [confirmDelete, setConfirmDelete] = useState<DeleteAction | null>(null);
  const active = goals.filter((item) => !item.deleted_at).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const goal = screen?.goalId ? active.find((item) => item.id === screen.goalId) : undefined;
  const selectedDeposit = screen?.kind === "deposit" ? deposits.find((item) => item.id === screen.depositId && !item.deleted_at) : undefined;
  const saved = goal ? savingsTotal(goal.id, deposits) : 0;
  function open(next: Screen | null) { if (busyRef.current) return; setError(""); setConfirmDelete(null); setScreen(next); }
  async function run(action: () => Promise<unknown>, next: Screen | null) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      await action();
      await onChanged();
      setConfirmDelete(null); setScreen(next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法保存，请重试"); }
    finally { busyRef.current = false; setBusy(false); }
  }
  const back = () => open(screen?.kind !== "detail" && goal ? { kind: "detail", goalId: goal.id } : null);
  const title = screen?.kind === "goal" ? goal ? "编辑目标" : "新建储蓄目标" : screen?.kind === "deposit" ? selectedDeposit ? "编辑存款" : "添加存款" : goal?.name ?? "我的目标";
  return <section className="mt-6" aria-labelledby="savings-goals-title">
    <div className="mb-3 flex items-center justify-between gap-3"><div><h2 id="savings-goals-title" className="section-title">我的目标</h2><p className="section-subtitle">为想要的生活，慢慢积累</p></div><Button variant="ghost" onClick={() => open({ kind: "goal" })} className="shrink-0 rounded-full text-[#536f4f]"><Plus className="size-4" />新目标</Button></div>
    {active.length ? <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2" aria-label="储蓄目标列表">{active.map((item) => {
      const total = savingsTotal(item.id, deposits); const progress = savingsProgress(total, item.target_amount);
      return <article key={item.id} className="w-[min(100%,360px)] shrink-0 snap-start rounded-[22px] border border-[#e0e6d8] bg-[#edf2e8] p-5">
        <button onClick={() => open({ kind: "detail", goalId: item.id })} className="block w-full text-left" aria-label={`查看${item.name}目标详情`}>
          <div className="flex items-center gap-3"><span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-white/70 text-2xl" aria-hidden="true">{item.icon}</span><div className="min-w-0 flex-1"><h3 className="truncate font-bold text-[#30392f]">{item.name}</h3><p className="mt-1 text-xs text-[#66715f]">{item.target_date ? `计划 ${dateLabel(item.target_date)}` : "按自己的节奏积累"}</p></div><ChevronRight className="size-4 shrink-0 text-[#637f60]" /></div>
          <p className="mt-4 flex flex-wrap items-baseline gap-x-1.5"><strong className="text-2xl tracking-tight tabular-nums">{savingsMoney(total, item.currency)}</strong><span className="text-xs text-[#66715f]">/ {savingsMoney(item.target_amount, item.currency)}</span></p>
          <ProgressBar value={progress} />
          <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-[#536f4f]"><span>{progress >= 100 ? "目标已达成 🎉" : `已完成 ${Math.floor(progress)}%`}</span><span>{total > item.target_amount ? `超出目标 ${savingsMoney(total - item.target_amount, item.currency)}` : `还差 ${savingsMoney(item.target_amount - total, item.currency)}`}</span></div>
        </button>
        <div className="mt-4 flex items-center justify-between gap-2"><span className="text-[11px] text-[#66715f]">{item.syncStatus === "synced" ? "已同步" : item.syncStatus === "error" ? "同步待重试 · 本机已保存" : "本机已保存 · 待同步"}</span><Button onClick={() => open({ kind: "deposit", goalId: item.id })} className="h-9 rounded-full"><Plus className="size-3.5" />存一笔</Button></div>
      </article>;
    })}</div> : <button onClick={() => open({ kind: "goal" })} className="flex w-full items-center gap-4 rounded-[22px] border border-dashed border-[#becbb5] bg-[#edf2e8]/60 p-5 text-left"><span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-white text-2xl">🌱</span><span className="flex-1"><strong className="block text-sm">给心愿一个目标</strong><span className="mt-1 block text-xs leading-5 text-[#66715f]">旅行、应急金，或一台新电脑。从第一笔开始。</span></span><Plus className="size-5 shrink-0 text-[#637f60]" /></button>}
    {active.length > 1 && <p className="mt-1 text-center text-[11px] text-[#7e8176]">左右滑动查看 · 共 {active.length} 个目标</p>}
    <Dialog open={Boolean(screen)} onOpenChange={(isOpen) => { if (!isOpen) open(null); }}>
      <DialogContent showCloseButton={false} className="savings-dialog block max-h-[90dvh] overflow-y-auto rounded-[24px] border-0 bg-[#faf7f2] p-0 sm:max-w-lg">
        <DialogHeader className="sticky top-0 z-10 border-b border-[#ece9e1] bg-[#faf7f2] px-5 py-4 text-left">
          <div className="flex items-center justify-between gap-2"><button type="button" onClick={back} disabled={busy} className="inline-flex min-h-10 items-center gap-1 text-sm text-[#536f4f]" aria-label="返回"><ArrowLeft className="size-4" />返回</button><DialogTitle className="min-w-0 flex-1 truncate text-center text-base">{title}</DialogTitle><button type="button" onClick={() => open(null)} disabled={busy} className="grid size-10 shrink-0 place-items-center rounded-full text-[#66715f]" aria-label="关闭储蓄目标"><X className="size-4" /></button></div>
          <DialogDescription className="sr-only">跨月储蓄目标与存款记录，独立于日常收支统计。</DialogDescription>
        </DialogHeader>
        <div className="p-5 pb-8">
          {error && <p role="alert" className="mb-4 rounded-xl bg-[#fff0f1] p-3 text-sm text-[#b64251]">{error}</p>}
          {confirmDelete ? <div className="surface-card p-5"><h3 className="font-bold">{confirmDelete.kind === "goal" ? "删除这个目标？" : "删除这笔存款？"}</h3><p className="mt-2 text-sm leading-6 text-[#66715f]">{confirmDelete.kind === "goal" ? "目标将从列表中移除，所属存款将隐藏。你的日常收支不会改变。" : "删除后会重新计算目标进度，你的日常收支不会改变。"}</p><div className="mt-5 flex gap-3"><Button variant="outline" disabled={busy} onClick={() => setConfirmDelete(null)} className="flex-1">取消</Button><Button disabled={busy} className="flex-1 bg-[#b64251] hover:bg-[#963444]" onClick={() => void run(() => confirmDelete.kind === "goal" ? deleteSavingsGoal(confirmDelete.id) : deleteSavingsDeposit(confirmDelete.id), confirmDelete.kind === "goal" ? null : goal ? { kind: "detail", goalId: goal.id } : null)}>{busy ? <Loader2 className="animate-spin" /> : <Trash2 />}确认删除</Button></div></div> : <>
          {screen?.kind === "goal" && <GoalForm key={goal?.id ?? "new"} goal={goal} defaultCurrency={currency} hasDeposits={Boolean(goal && deposits.some((item) => item.goal_id === goal.id))} busy={busy} onSave={(input) => void run(() => saveSavingsGoal(input, goal?.id), goal ? { kind: "detail", goalId: goal.id } : null)} />}
          {screen?.kind === "deposit" && goal && <DepositForm key={selectedDeposit?.id ?? goal.id} goal={goal} deposit={selectedDeposit} saved={saved} busy={busy} onSave={(input) => void run(() => saveSavingsDeposit(input, selectedDeposit?.id), { kind: "detail", goalId: goal.id })} onDelete={selectedDeposit ? () => setConfirmDelete({ kind: "deposit", id: selectedDeposit.id }) : undefined} />}
          {screen?.kind === "detail" && goal && <GoalDetail goal={goal} deposits={deposits} onEdit={() => open({ kind: "goal", goalId: goal.id })} onAdd={() => open({ kind: "deposit", goalId: goal.id })} onEditDeposit={(id) => open({ kind: "deposit", goalId: goal.id, depositId: id })} onDelete={() => setConfirmDelete({ kind: "goal", id: goal.id })} />}
          {screen && screen.kind !== "goal" && !goal && <p className="py-12 text-center text-sm text-[#66715f]">这个目标已被移除，请返回概览。</p>}
          </>}
        </div>
      </DialogContent>
    </Dialog>
  </section>;
}

function ProgressBar({ value }: { value: number }) { return <div role="progressbar" aria-label="储蓄目标进度" aria-valuenow={Math.floor(value)} aria-valuemin={0} aria-valuemax={100} className="mt-3 h-3 overflow-hidden rounded-full bg-[#dbe2d3]"><div className="h-full rounded-full bg-[#637f60] transition-[width] duration-500" style={{ width: `${value}%` }} /></div>; }

function GoalForm({ goal, defaultCurrency, hasDeposits, busy, onSave }: { goal?: SavingsGoal; defaultCurrency: string; hasDeposits: boolean; busy: boolean; onSave: (input: GoalInput) => void }) {
  const [icon, setIcon] = useState(goal?.icon ?? "🌱");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    onSave({ name: String(form.get("name")), target_amount: Math.round(Number(form.get("amount")) * 100), currency: hasDeposits && goal ? goal.currency : String(form.get("currency")), target_date: String(form.get("date") ?? "") || null, icon });
  }
  return <form onSubmit={submit} className="space-y-5" aria-busy={busy}><fieldset disabled={busy} className="space-y-5">
    <div><Label>选一个目标图标</Label><div className="mt-3 flex flex-wrap gap-2">{goalIcons.map((item) => <button key={item} type="button" onClick={() => setIcon(item)} aria-label={`选择图标${item}`} aria-pressed={icon === item} className={`grid size-11 place-items-center rounded-xl text-xl ${icon === item ? "bg-[#e6eddf] ring-2 ring-[#637f60]" : "bg-white"}`}>{item}</button>)}</div></div>
    <div className="space-y-2"><Label htmlFor="goal-name">目标名称</Label><Input id="goal-name" name="name" defaultValue={goal?.name} placeholder="例如：旅行基金" maxLength={60} required className="h-12 rounded-xl" /></div>
    <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-3"><div className="min-w-0 space-y-2"><Label htmlFor="goal-currency">货币</Label><NativeSelect id="goal-currency" name="currency" defaultValue={goal?.currency ?? defaultCurrency} disabled={hasDeposits} className="h-12 w-full rounded-xl">{supportedCurrencies.map((code) => <NativeSelectOption key={code} value={code}>{currencyLabels[code]}</NativeSelectOption>)}</NativeSelect></div><div className="min-w-0 space-y-2"><Label htmlFor="goal-amount">目标金额</Label><Input id="goal-amount" name="amount" type="number" inputMode="decimal" step="0.01" min="0.01" required defaultValue={goal ? goal.target_amount / 100 : undefined} placeholder="2000.00" className="h-12 rounded-xl" /></div></div>
    {hasDeposits && <p className="text-xs leading-5 text-[#66715f]">已有存款记录，目标货币将保持不变。</p>}
    <div className="space-y-2"><Label htmlFor="goal-date">计划完成日期（选填）</Label><Input id="goal-date" name="date" type="date" defaultValue={goal?.target_date ?? ""} className="block h-12 w-full min-w-0 rounded-xl" /></div>
    <p className="rounded-2xl bg-[#edf2e8] p-4 text-xs leading-6 text-[#536f4f]">这是跨月累计的心愿目标，与每月储蓄计划分开。创建后，可以手动添加每一笔目标存款。</p>
    <Button type="submit" className="h-12 w-full rounded-xl" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Check />}{goal ? "保存目标" : "创建目标"}</Button>
  </fieldset></form>;
}

function GoalDetail({ goal, deposits, onEdit, onAdd, onEditDeposit, onDelete }: { goal: SavingsGoal; deposits: SavingsDeposit[]; onEdit: () => void; onAdd: () => void; onEditDeposit: (id: string) => void; onDelete: () => void }) {
  const records = deposits.filter((item) => item.goal_id === goal.id && !item.deleted_at).sort((a, b) => b.deposit_date.localeCompare(a.deposit_date) || b.created_at.localeCompare(a.created_at));
  const saved = savingsTotal(goal.id, deposits); const progress = savingsProgress(saved, goal.target_amount); const remaining = Math.max(0, goal.target_amount - saved);
  const now = new Date(); const deadline = goal.target_date ? new Date(`${goal.target_date}T12:00:00`) : null;
  const months = deadline ? Math.max(1, (deadline.getFullYear() - now.getFullYear()) * 12 + deadline.getMonth() - now.getMonth() + 1) : null;
  const overdue = goal.target_date ? goal.target_date < localToday() && remaining > 0 : false;
  return <div className="space-y-5"><div className="flex justify-end"><Button variant="ghost" onClick={onEdit} className="rounded-full text-[#536f4f]"><Pencil className="size-4" />编辑目标</Button></div>
    <div className="text-center"><span className="text-6xl" aria-hidden="true">{goal.icon}</span><p className="mt-4 text-sm font-medium text-[#66715f]">{progress >= 100 ? "你做到了，心愿更近一步 🎉" : "每一笔积累，都离心愿更近"}</p><p className="mt-3 break-words text-4xl font-bold tracking-tight tabular-nums">{savingsMoney(saved, goal.currency)}</p><p className="mt-2 text-sm text-[#66715f]">目标 {savingsMoney(goal.target_amount, goal.currency)}</p>
    <div className="relative mx-auto my-5 size-44"><svg viewBox="0 0 120 120" className="size-full -rotate-90" aria-hidden="true"><circle cx="60" cy="60" r="50" fill="none" stroke="#e3e7db" strokeWidth="10" /><circle cx="60" cy="60" r="50" fill="none" stroke="#637f60" strokeWidth="10" pathLength="100" strokeDasharray={`${progress} 100`} strokeLinecap="round" /></svg><div className="absolute inset-0 grid place-content-center"><strong className="text-3xl tabular-nums">{Math.floor(progress)}%</strong><span className="mt-1 text-xs text-[#66715f]">已完成</span></div></div><p className="text-sm font-semibold">{remaining ? `还差 ${savingsMoney(remaining, goal.currency)}` : saved > goal.target_amount ? `已超出目标 ${savingsMoney(saved - goal.target_amount, goal.currency)}` : "目标已达成"}</p></div>
    {deadline && <div className="surface-card grid grid-cols-2 gap-3 p-4 text-sm"><div><p className="text-xs text-[#66715f]">{overdue ? "原计划日期" : "计划完成"}</p><p className="mt-1 font-semibold">{dateLabel(goal.target_date!)}</p></div><div><p className="text-xs text-[#66715f]">{overdue ? "可以调整计划" : "建议每月"}</p><p className="mt-1 font-semibold">{overdue ? "按自己的节奏继续" : savingsMoney(months ? Math.ceil(remaining / months) : 0, goal.currency)}</p></div></div>}
    <Button onClick={onAdd} className="h-12 w-full rounded-xl"><Plus />添加存款</Button><p className="text-xs leading-5 text-[#66715f]">存款仅用于目标资金分配，不会实际转账，也不会重复计入收入或支出。</p>
    <div className="surface-card overflow-hidden"><h3 className="border-b border-[#ece9e1] px-4 py-4 font-semibold">存款记录 · {records.length} 笔</h3>{records.length ? records.map((item) => <button key={item.id} onClick={() => onEditDeposit(item.id)} aria-label={`编辑${dateLabel(item.deposit_date)}存款${savingsMoney(item.amount, goal.currency)}`} className="flex w-full items-center gap-3 border-b border-[#f1eee7] px-4 py-4 text-left last:border-0"><div className="min-w-0 flex-1"><p className="text-sm">{dateLabel(item.deposit_date)}</p>{item.note && <p className="mt-1 truncate text-xs text-[#66715f]">{item.note}</p>}<p className="mt-1 text-[10px] text-[#66715f]">{item.syncStatus === "synced" ? "已同步" : item.syncStatus === "error" ? "同步待重试" : "本机已保存 · 待同步"}</p></div><span className="shrink-0 text-sm font-semibold text-[#536f4f]">+{savingsMoney(item.amount, goal.currency)}</span><ChevronRight className="size-4 shrink-0 text-[#7e8176]" /></button>) : <p className="p-6 text-center text-sm text-[#66715f]">还没有存款，存下第一笔吧。</p>}</div>
    <button onClick={onDelete} className="flex min-h-11 w-full items-center justify-center gap-2 text-sm text-[#b64251]"><Trash2 className="size-4" />删除目标</button>
  </div>;
}

function DepositForm({ goal, deposit, saved, busy, onSave, onDelete }: { goal: SavingsGoal; deposit?: SavingsDeposit; saved: number; busy: boolean; onSave: (input: DepositInput) => void; onDelete?: () => void }) {
  const [amount, setAmount] = useState(deposit ? String(deposit.amount / 100) : "");
  const cents = Math.round(Number(amount) * 100); const preview = saved - (deposit?.amount ?? 0) + (Number.isSafeInteger(cents) && cents > 0 ? cents : 0); const progress = savingsProgress(preview, goal.target_amount);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    onSave({ goal_id: goal.id, amount: cents, deposit_date: String(form.get("date")), note: String(form.get("note") ?? "") });
  }
  return <form onSubmit={submit} className="space-y-5" aria-busy={busy}><fieldset disabled={busy} className="space-y-5">
    <div className="surface-card flex items-center gap-3 p-4"><span className="text-3xl">{goal.icon}</span><div className="min-w-0"><p className="truncate font-semibold">存入{goal.name}</p><p className="mt-1 text-xs text-[#66715f]">当前已存 {savingsMoney(saved, goal.currency)}</p></div></div>
    <div className="space-y-2"><Label htmlFor="deposit-amount">金额 · {goal.currency}</Label><Input id="deposit-amount" value={amount} onChange={(event) => setAmount(event.target.value)} type="number" inputMode="decimal" step="0.01" min="0.01" required placeholder="0.00" className="h-16 rounded-xl text-2xl font-bold" /></div>
    <div className="space-y-2"><Label htmlFor="deposit-date">日期</Label><Input id="deposit-date" name="date" type="date" defaultValue={deposit?.deposit_date ?? localToday()} required className="block h-12 w-full min-w-0 rounded-xl" /></div>
    <div className="space-y-2"><Label htmlFor="deposit-note">备注（选填）</Label><Input id="deposit-note" name="note" defaultValue={deposit?.note} placeholder="例如：本月旅行储蓄" maxLength={200} className="h-12 rounded-xl" /></div>
    <div className="rounded-2xl bg-[#edf2e8] p-4"><p className="text-xs font-semibold text-[#536f4f]">{deposit ? "修改后" : "存入后"}</p><p className="mt-2 flex flex-wrap items-baseline gap-1 text-sm text-[#66715f]"><strong className="text-2xl text-[#30392f]">{savingsMoney(preview, goal.currency)}</strong> / {savingsMoney(goal.target_amount, goal.currency)}</p><ProgressBar value={progress} /><div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-[#536f4f]"><span>目标进度 {Math.floor(progress)}%</span><span>{preview >= goal.target_amount ? "目标已达成 🎉" : `还差 ${savingsMoney(goal.target_amount - preview, goal.currency)}`}</span></div></div>
    <p className="text-xs leading-6 text-[#66715f]">这笔存款不会新增收支记录，也不会改变收支统计。请填写你实际分配给这个目标的金额。</p>
    <Button type="submit" disabled={busy} className="h-12 w-full rounded-xl">{busy ? <Loader2 className="animate-spin" /> : <Check />}{deposit ? "保存修改" : "确认存入"}</Button>
    {onDelete && <button type="button" onClick={onDelete} className="flex min-h-11 w-full items-center justify-center gap-2 text-sm text-[#b64251]"><Trash2 className="size-4" />删除这笔存款</button>}
  </fieldset></form>;
}
