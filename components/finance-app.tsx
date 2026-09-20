"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowDownLeft, ArrowUpRight, BarChart3, CalendarClock, Check, Cloud, CloudOff, Download, Home, Landmark, Loader2, Pencil, PiggyBank, Plus, ReceiptText, RefreshCw, Search, SearchX, Settings, Target, Trash2, WalletCards, WifiOff } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { PwaRegister } from "@/components/pwa-register";
import { addTransaction, emptyFinancePlan, ensureMonthlyRecurringTransactions, exportData, getCurrency, getFinancePlan, getTransactions, saveFinancePlan, setCurrency as saveCurrency, softDeleteTransaction, updateTransaction, type FinancePlan, type FinanceTransaction, type RecurringRule, type TransactionType } from "@/lib/finance-db";
import { getSupabase, isCloudConfigured, syncTransactions } from "@/lib/supabase";
import { registerFinanceTools } from "@/lib/webmcp";

type View = "overview" | "transactions" | "insights" | "settings";
const expenseCategories = ["餐饮", "交通", "住房", "购物", "娱乐", "健康", "其他"];
const incomeCategories = ["工资", "奖金", "副业", "投资", "退款", "其他"];
const navItems: { id: View; label: string; icon: typeof Home }[] = [
  { id: "overview", label: "概览", icon: Home },
  { id: "transactions", label: "明细", icon: ReceiptText },
  { id: "insights", label: "分析", icon: BarChart3 },
  { id: "settings", label: "设置", icon: Settings },
];
const categoryColors: Record<string, string> = { 餐饮: "#fb7185", 交通: "#60a5fa", 住房: "#a78bfa", 购物: "#f59e0b", 娱乐: "#2dd4bf", 健康: "#34d399", 工资: "#22c55e", 奖金: "#16a34a", 其他: "#94a3b8" };
const categoryEmoji: Record<string, string> = { 餐饮: "🍜", 交通: "🚇", 住房: "🏠", 购物: "🛍️", 娱乐: "🎬", 健康: "💊", 工资: "💼", 奖金: "✨", 副业: "💻", 投资: "📈", 退款: "↩️", 其他: "•" };
const retryDelays = [5_000, 15_000, 60_000];

function today() { return new Date().toISOString().slice(0, 10); }
function monthKey(date = new Date()) { return date.toISOString().slice(0, 7); }

export default function FinanceApp() {
  const [view, setView] = useState<View>("overview");
  const [transactions, setTransactions] = useState<FinanceTransaction[]>([]);
  const [currency, setCurrency] = useState("CAD");
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<FinanceTransaction | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [signedInEmail, setSignedInEmail] = useState("");
  const [financePlan, setFinancePlan] = useState<FinancePlan>(() => emptyFinancePlan());
  const [savingPlan, setSavingPlan] = useState(false);
  const signedInRef = useRef("");
  const syncingRef = useRef(false);
  const syncQueuedRef = useRef(false);
  const retryAttemptRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    const [savedCurrency, savedPlan] = await Promise.all([getCurrency(), getFinancePlan()]);
    await ensureMonthlyRecurringTransactions(savedPlan);
    const items = await getTransactions();
    setTransactions(items); setCurrency(savedCurrency); setFinancePlan(savedPlan); setLoading(false);
  }, []);

  useEffect(() => registerFinanceTools(currency, load), [currency, load]);

  const activeTransactions = useMemo(() => transactions.filter((item) => !item.deletedAt), [transactions]);
  const currentMonth = monthKey();
  const monthTransactions = useMemo(() => activeTransactions.filter((item) => item.transactionDate.startsWith(currentMonth)), [activeTransactions, currentMonth]);
  const income = monthTransactions.filter((item) => item.type === "income").reduce((sum, item) => sum + item.amount, 0);
  const expense = monthTransactions.filter((item) => item.type === "expense").reduce((sum, item) => sum + item.amount, 0);
  const balance = income - expense;
  const pendingCount = transactions.filter((item) => item.syncStatus !== "synced").length;
  const money = useCallback((cents: number) => new Intl.NumberFormat("zh-CN", { style: "currency", currency, maximumFractionDigits: 2 }).format(cents / 100), [currency]);
  const chartData = useMemo(() => Array.from({ length: 6 }, (_, index) => {
    const date = new Date(); date.setMonth(date.getMonth() - (5 - index)); const key = monthKey(date);
    const values = activeTransactions.filter((item) => item.transactionDate.startsWith(key));
    return { month: `${date.getMonth() + 1}月`, income: values.filter((item) => item.type === "income").reduce((sum, item) => sum + item.amount / 100, 0), expense: values.filter((item) => item.type === "expense").reduce((sum, item) => sum + item.amount / 100, 0) };
  }), [activeTransactions]);
  const expenseBreakdown = useMemo(() => {
    const sums = new Map<string, number>();
    monthTransactions.filter((item) => item.type === "expense").forEach((item) => sums.set(item.category, (sums.get(item.category) ?? 0) + item.amount));
    return [...sums.entries()].sort((a, b) => b[1] - a[1]);
  }, [monthTransactions]);

  const handleSync = useCallback(async function runSync(silent = false) {
    if (!navigator.onLine || !signedInRef.current) {
      if (!silent && !navigator.onLine) setSyncMessage("当前离线，联网后会自动同步");
      return;
    }
    if (syncingRef.current) {
      syncQueuedRef.current = true;
      return;
    }

    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    if (!silent) retryAttemptRef.current = 0;
    syncingRef.current = true;
    setSyncing(true);
    if (!silent) setSyncMessage("正在同步…");

    try {
      const result = await syncTransactions();
      retryAttemptRef.current = 0;
      await load();
      const changes = result.uploaded + result.downloaded;
      setSyncMessage(changes || result.planChanged ? `同步完成：上传 ${result.uploaded} 条，恢复 ${result.downloaded} 条` : "所有记录均已同步");
    } catch (error) {
      setSyncMessage(error instanceof Error ? `同步失败：${error.message}` : "同步失败，将自动重试");
      const attempt = retryAttemptRef.current;
      if (attempt < retryDelays.length && navigator.onLine && signedInRef.current) {
        retryAttemptRef.current += 1;
        retryTimerRef.current = window.setTimeout(() => void runSync(true), retryDelays[attempt]);
      }
    } finally {
      syncingRef.current = false;
      setSyncing(false);
      if (syncQueuedRef.current) {
        syncQueuedRef.current = false;
        window.setTimeout(() => void runSync(true), 0);
      }
    }
  }, [load]);

  useEffect(() => {
    setOnline(navigator.onLine);
    void load();
    const supabase = getSupabase();
    const handleOnline = () => {
      setOnline(true);
      if (signedInRef.current) void handleSync(true);
    };
    const handleOffline = () => {
      setOnline(false);
      setSyncMessage("当前离线，新记录会安全保存在本机");
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && navigator.onLine && signedInRef.current) void handleSync(true);
    };
    const interval = window.setInterval(() => {
      if (navigator.onLine && signedInRef.current) void handleSync(true);
    }, 5 * 60_000);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisibility);
    const subscription = supabase?.auth.onAuthStateChange((event, session) => {
      const email = session?.user.email ?? "";
      signedInRef.current = email;
      setSignedInEmail(email);
      if (!session && retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (session && (event === "INITIAL_SESSION" || event === "SIGNED_IN") && navigator.onLine) {
        // Supabase recommends deferring async client calls outside the auth callback.
        window.setTimeout(() => void handleSync(true), 0);
      }
    }).data.subscription;

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.clearInterval(interval);
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      subscription?.unsubscribe();
    };
  }, [handleSync, load]);

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const amount = Math.round(Number(form.get("amount")) * 100);
    if (!amount || amount < 1) return;
    await addTransaction({ type: form.get("type") as TransactionType, amount, currency, category: String(form.get("category")), note: String(form.get("note") ?? ""), transactionDate: String(form.get("date")) });
    setDialogOpen(false); await load(); if (navigator.onLine && signedInRef.current) void handleSync(true);
  }
  async function handleDelete(id: string) {
    await softDeleteTransaction(id);
    await load();
    if (navigator.onLine && signedInRef.current) void handleSync(true);
  }
  async function handleEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingTransaction) return;
    const form = new FormData(event.currentTarget);
    const amount = Math.round(Number(form.get("amount")) * 100);
    if (!amount || amount < 1) return;
    await updateTransaction(editingTransaction.id, {
      type: form.get("type") as TransactionType,
      amount,
      currency: editingTransaction.currency,
      category: String(form.get("category")),
      note: String(form.get("note") ?? ""),
      transactionDate: String(form.get("date")),
    });
    setEditingTransaction(null);
    await load();
    if (navigator.onLine && signedInRef.current) void handleSync(true);
  }
  async function handleAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const supabase = getSupabase(); if (!supabase) return setSyncMessage("请先在 Vercel 配置 Supabase 环境变量");
    setSyncing(true); const signIn = await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword });
    if (signIn.error) {
      const signUp = await supabase.auth.signUp({ email: authEmail, password: authPassword });
      if (signUp.error) setSyncMessage(signUp.error.message); else setSyncMessage(signUp.data.session ? "账号已建立" : "请检查邮箱完成验证");
      const email = signUp.data.session?.user.email ?? "";
      signedInRef.current = email;
      setSignedInEmail(email);
    } else {
      const email = signIn.data.user.email ?? "";
      signedInRef.current = email;
      setSignedInEmail(email);
      setSyncMessage("登录成功，正在恢复云端记录…");
      window.setTimeout(() => void handleSync(true), 0);
    }
    if (!syncingRef.current) setSyncing(false);
  }
  async function downloadBackup() {
    const content = await exportData(); const url = URL.createObjectURL(new Blob([content], { type: "application/json" })); const link = document.createElement("a");
    link.href = url; link.download = `morrow-backup-${today()}.json`; link.click(); URL.revokeObjectURL(url);
  }
  async function changeCurrency(next: string) { setCurrency(next); await saveCurrency(next); }
  async function handleSavePlan(plan: Pick<FinancePlan, "monthlyBudget" | "monthlySavingsTarget" | "recurringRules">) {
    setSavingPlan(true);
    try {
      const saved = await saveFinancePlan(plan);
      await ensureMonthlyRecurringTransactions(saved);
      await load();
      setSyncMessage("月度计划已保存");
      if (navigator.onLine && signedInRef.current) void handleSync(true);
    } finally {
      setSavingPlan(false);
    }
  }

  const cloudStatus = !online ? "离线可用" : syncing ? "同步中" : pendingCount ? `${pendingCount} 条待同步` : signedInEmail ? "已同步" : "在线";
  const cloudStatusTone = !online ? "bg-[#fff0f1] text-[#b64251]" : pendingCount ? "bg-[#fff5dc] text-[#936700]" : "bg-[#e4f8ef] text-[#167250]";

  return <div className="min-h-screen bg-[#f3f6fb] text-[#132039]">
    <PwaRegister />
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col border-r border-white/10 bg-[#0b1220] px-5 py-7 text-white lg:flex">
      <Brand /><nav className="mt-12 space-y-2" aria-label="主要导航">{navItems.map((item) => <NavButton key={item.id} {...item} active={view === item.id} onClick={() => setView(item.id)} />)}</nav>
      <div className="mt-auto rounded-2xl border border-white/10 bg-white/[0.06] p-4"><div className="flex items-center gap-2 text-sm font-medium">{online ? <Cloud className="size-4 text-[#65d9a6]" /> : <CloudOff className="size-4 text-[#ff8b96]" />}{signedInEmail ? "云端备份已连接" : "本地模式"}</div><p className="mt-2 text-xs leading-5 text-slate-400">{pendingCount ? `${pendingCount} 条记录等待同步` : "本机记录均已保存"}</p></div>
    </aside>
    <main className="mx-auto min-h-screen max-w-[1480px] pb-28 lg:ml-[248px] lg:pb-8">
      <header className="sticky top-0 z-20 flex h-[calc(74px+env(safe-area-inset-top))] items-center justify-between border-b border-[#dfe6f1] bg-[#f3f6fb]/90 px-5 pt-[env(safe-area-inset-top)] backdrop-blur-xl md:px-8 lg:h-[74px] lg:px-10 lg:pt-0"><div className="lg:hidden"><Brand compact /></div><p className="hidden text-sm text-[#718096] lg:block">{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date())}</p><div className="flex items-center gap-3"><span className={`hidden items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium sm:flex ${cloudStatusTone}`}>{syncing ? <Loader2 className="size-3.5 animate-spin" /> : online ? <Check className="size-3.5" /> : <WifiOff className="size-3.5" />}{cloudStatus}</span><Button onClick={() => setDialogOpen(true)} className="h-11 rounded-xl bg-[#2864f0] px-4 text-white shadow-[0_8px_24px_rgba(40,100,240,.22)] hover:bg-[#1f55d7]"><Plus className="size-4" />新增记录</Button></div></header>
      <div className="px-5 py-7 md:px-8 lg:px-10 lg:py-9">
        {view === "overview" && <Overview loading={loading} balance={balance} income={income} expense={expense} money={money} transactions={activeTransactions} chartData={chartData} financePlan={financePlan} onEdit={setEditingTransaction} onDelete={handleDelete} onAdd={() => setDialogOpen(true)} />}
        {view === "transactions" && <TransactionsView transactions={activeTransactions} money={money} onEdit={setEditingTransaction} onDelete={handleDelete} onAdd={() => setDialogOpen(true)} />}
        {view === "insights" && <InsightsView expense={expense} money={money} breakdown={expenseBreakdown} chartData={chartData} transactions={monthTransactions} month={currentMonth} />}
        {view === "settings" && <SettingsViewWithPlan currency={currency} financePlan={financePlan} savingPlan={savingPlan} onSavePlan={handleSavePlan} onCurrencyChange={changeCurrency} configured={isCloudConfigured()} signedInEmail={signedInEmail} syncing={syncing} syncMessage={syncMessage} email={authEmail} password={authPassword} onEmail={setAuthEmail} onPassword={setAuthPassword} onAuth={handleAuth} onSync={() => void handleSync(false)} onExport={downloadBackup} />}
      </div>
    </main>
    <nav className="fixed inset-x-3 bottom-[calc(.75rem+env(safe-area-inset-bottom))] z-40 grid grid-cols-4 rounded-[22px] border border-white/70 bg-[#0b1220]/95 p-2 text-white shadow-[0_18px_50px_rgba(11,18,32,.28)] backdrop-blur-xl lg:hidden" aria-label="移动端导航">{navItems.map((item) => { const Icon = item.icon; return <button key={item.id} onClick={() => setView(item.id)} className={`flex min-h-12 flex-col items-center justify-center gap-1 rounded-2xl text-xs transition ${view === item.id ? "bg-white/12 text-white" : "text-slate-400"}`}><Icon className="size-[18px]" />{item.label}</button>; })}</nav>
    <AddDialog open={dialogOpen} onOpenChange={setDialogOpen} currency={currency} onSubmit={handleAdd} />
    {editingTransaction && <EditDialog key={editingTransaction.id} transaction={editingTransaction} open onOpenChange={(open) => { if (!open) setEditingTransaction(null); }} onSubmit={handleEdit} />}
  </div>;
}

function Brand({ compact = false }: { compact?: boolean }) { return <div className="flex items-center gap-3"><span className={`${compact ? "size-9" : "size-10"} grid place-items-center rounded-[14px] bg-[#2864f0] text-white shadow-[0_8px_22px_rgba(40,100,240,.35)]`}><Landmark className="size-5" /></span><div><div className="text-[17px] font-bold tracking-[-.03em]">Morrow</div>{!compact && <div className="text-xs text-slate-400">每日收支</div>}</div></div>; }
function NavButton({ label, icon: Icon, active, onClick }: { label: string; icon: typeof Home; active: boolean; onClick: () => void }) { return <button onClick={onClick} className={`flex h-12 w-full items-center gap-3 rounded-xl px-4 text-sm font-medium transition ${active ? "bg-[#2864f0] text-white shadow-[0_10px_28px_rgba(40,100,240,.25)]" : "text-slate-400 hover:bg-white/[0.06] hover:text-white"}`}><Icon className="size-[18px]" />{label}</button>; }

function Overview({ loading, balance, income, expense, money, transactions, chartData, financePlan, onEdit, onDelete, onAdd }: { loading: boolean; balance: number; income: number; expense: number; money: (n: number) => string; transactions: FinanceTransaction[]; chartData: { month: string; income: number; expense: number }[]; financePlan: FinancePlan; onEdit: (transaction: FinanceTransaction) => void; onDelete: (id: string) => void; onAdd: () => void }) {
  const budgetProgress = financePlan.monthlyBudget ? Math.min(100, expense / financePlan.monthlyBudget * 100) : 0;
  const availableToSave = Math.max(0, balance);
  const savingsProgress = financePlan.monthlySavingsTarget ? Math.min(100, availableToSave / financePlan.monthlySavingsTarget * 100) : 0;
  return <>
    <div className="mb-7"><p className="text-sm font-semibold uppercase tracking-[.12em] text-[#2864f0]">本月概览</p><h1 className="mt-1 text-[clamp(1.8rem,4vw,2.6rem)] font-bold tracking-[-.045em] text-[#0d1930]">钱花得明白，日子过得轻松。</h1></div>
    <section className="grid gap-4 md:grid-cols-3"><SummaryCard title="本月结余" value={balance} money={money} icon={WalletCards} tone="blue" /><SummaryCard title="本月收入" value={income} money={money} icon={ArrowDownLeft} tone="green" /><SummaryCard title="本月支出" value={expense} money={money} icon={ArrowUpRight} tone="rose" /></section>
    {(financePlan.monthlyBudget > 0 || financePlan.monthlySavingsTarget > 0) && <section className="mt-5 grid gap-4 md:grid-cols-2">
      {financePlan.monthlyBudget > 0 && <PlanProgressCard icon={Target} title="月度预算" value={expense > financePlan.monthlyBudget ? `已超出 ${money(expense - financePlan.monthlyBudget)}` : `还可使用 ${money(financePlan.monthlyBudget - expense)}`} detail={`${money(expense)} / ${money(financePlan.monthlyBudget)}`} progress={budgetProgress} tone="blue" />}
      {financePlan.monthlySavingsTarget > 0 && <PlanProgressCard icon={PiggyBank} title="储蓄目标" value={availableToSave >= financePlan.monthlySavingsTarget ? "本月目标已达成" : `还差 ${money(financePlan.monthlySavingsTarget - availableToSave)}`} detail={`${money(availableToSave)} / ${money(financePlan.monthlySavingsTarget)}`} progress={savingsProgress} tone="green" />}
    </section>}
    <section className="mt-5 grid gap-5 xl:grid-cols-[1.35fr_.85fr]"><div className="surface-card p-5 md:p-6"><div className="mb-5 flex items-center justify-between"><div><h2 className="section-title">收支走势</h2><p className="section-subtitle">最近六个月</p></div><span className="rounded-full bg-[#eef3ff] px-3 py-1.5 text-xs font-semibold text-[#2864f0]">月度</span></div><div className="h-[245px]"><ResponsiveContainer width="100%" height="100%"><AreaChart data={chartData} margin={{ left: -25, right: 4, top: 10 }}><defs><linearGradient id="expenseFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#2864f0" stopOpacity={0.25}/><stop offset="100%" stopColor="#2864f0" stopOpacity={0}/></linearGradient></defs><CartesianGrid vertical={false} stroke="#edf1f7"/><XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fill: "#8793a7", fontSize: 12 }}/><Tooltip formatter={(value) => money(Number(value) * 100)} contentStyle={{ border: 0, borderRadius: 14, boxShadow: "0 14px 40px rgba(20,33,61,.12)" }}/><Area type="monotone" dataKey="expense" name="支出" stroke="#2864f0" strokeWidth={3} fill="url(#expenseFill)" /></AreaChart></ResponsiveContainer></div></div><div className="surface-card overflow-hidden"><div className="flex items-center justify-between border-b border-[#edf1f7] px-5 py-5 md:px-6"><div><h2 className="section-title">最近记录</h2><p className="section-subtitle">按日期排序</p></div></div>{loading ? <div className="grid min-h-[250px] place-items-center"><Loader2 className="size-6 animate-spin text-[#2864f0]" /></div> : <TransactionList transactions={transactions.slice(0, 5)} money={money} onEdit={onEdit} onDelete={onDelete} emptyAction={onAdd} />}</div></section>
  </>;
}

function PlanProgressCard({ icon: Icon, title, value, detail, progress, tone }: { icon: typeof Target; title: string; value: string; detail: string; progress: number; tone: "blue" | "green" }) {
  const colors = tone === "blue" ? { icon: "bg-[#eef3ff] text-[#2864f0]", bar: "bg-[#2864f0]" } : { icon: "bg-[#e5f8ef] text-[#16815a]", bar: "bg-[#24a36b]" };
  return <div className="surface-card p-5 md:p-6"><div className="flex items-start justify-between gap-4"><div className="flex items-center gap-3"><span className={`grid size-10 place-items-center rounded-xl ${colors.icon}`}><Icon className="size-5" /></span><div><p className="text-sm font-semibold text-[#17243b]">{title}</p><p className="mt-0.5 text-xs text-[#8793a7]">{detail}</p></div></div><span className="text-xs font-semibold text-[#617087]">{Math.round(progress)}%</span></div><p className="mt-5 text-lg font-bold tracking-[-.03em] text-[#17243b]">{value}</p><div className="mt-3 h-2 overflow-hidden rounded-full bg-[#edf1f7]"><div className={`h-full rounded-full transition-[width] ${colors.bar}`} style={{ width: `${progress}%` }} /></div></div>;
}
function AnimatedCurrency({ value, money }: { value: number; money: (value: number) => string }) {
  const previousValue = useRef(value);
  const animationFrame = useRef<number | null>(null);
  const [displayValue, setDisplayValue] = useState(value);

  useEffect(() => {
    if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current);
    const start = previousValue.current;
    previousValue.current = value;
    if (start === value || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDisplayValue(value);
      return;
    }
    const startedAt = performance.now();
    const duration = 650;
    const animate = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayValue(Math.round(start + (value - start) * eased));
      if (progress < 1) animationFrame.current = requestAnimationFrame(animate);
      else animationFrame.current = null;
    };
    animationFrame.current = requestAnimationFrame(animate);
    return () => {
      if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current);
    };
  }, [value]);

  return <span className="tabular-nums">{money(displayValue)}</span>;
}

function SummaryCard({ title, value, money, icon: Icon, tone }: { title: string; value: number; money: (value: number) => string; icon: typeof WalletCards; tone: "blue" | "green" | "rose" }) { const colors = { blue: "bg-[#2864f0] text-white shadow-[0_18px_45px_rgba(40,100,240,.24)]", green: "bg-white text-[#15213a]", rose: "bg-white text-[#15213a]" }; const iconColors = { blue: "bg-white/15 text-white", green: "bg-[#e5f8ef] text-[#16815a]", rose: "bg-[#fff0f2] text-[#d64b5e]" }; return <div className={`rounded-[22px] p-5 md:p-6 ${colors[tone]} ${tone !== "blue" ? "border border-[#e5eaf2] shadow-[0_10px_30px_rgba(40,57,91,.06)]" : ""}`}><div className="flex items-center justify-between"><span className={`grid size-10 place-items-center rounded-xl ${iconColors[tone]}`}><Icon className="size-5" /></span><span className={`text-xs font-medium ${tone === "blue" ? "text-blue-100" : "text-[#8a96a9]"}`}>本月</span></div><p className={`mt-6 text-sm ${tone === "blue" ? "text-blue-100" : "text-[#77859a]"}`}>{title}</p><p className="mt-1 text-[clamp(1.45rem,3vw,2rem)] font-bold tracking-[-.04em]"><AnimatedCurrency value={value} money={money} /></p></div>; }

function TransactionsView({ transactions, money, onEdit, onDelete, onAdd }: { transactions: FinanceTransaction[]; money: (n: number) => string; onEdit: (transaction: FinanceTransaction) => void; onDelete: (id: string) => void; onAdd: () => void }) {
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | TransactionType>("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [monthFilter, setMonthFilter] = useState("all");
  const categories = useMemo(() => [...new Set(transactions.map((item) => item.category))].sort((a, b) => a.localeCompare(b, "zh-CN")), [transactions]);
  const months = useMemo(() => [...new Set(transactions.map((item) => item.transactionDate.slice(0, 7)))].sort((a, b) => b.localeCompare(a)), [transactions]);
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visible = useMemo(() => transactions.filter((item) => {
    if (typeFilter !== "all" && item.type !== typeFilter) return false;
    if (categoryFilter !== "all" && item.category !== categoryFilter) return false;
    if (monthFilter !== "all" && !item.transactionDate.startsWith(monthFilter)) return false;
    if (!normalizedQuery) return true;
    const searchable = `${item.note} ${item.category} ${item.amount / 100}`.toLocaleLowerCase("zh-CN");
    return searchable.includes(normalizedQuery);
  }), [transactions, typeFilter, categoryFilter, monthFilter, normalizedQuery]);
  const hasFilters = Boolean(normalizedQuery || typeFilter !== "all" || categoryFilter !== "all" || monthFilter !== "all");
  function clearFilters() {
    setQuery("");
    setTypeFilter("all");
    setCategoryFilter("all");
    setMonthFilter("all");
  }
  return <div className="mx-auto max-w-4xl">
    <div className="mb-6"><p className="eyebrow">交易明细</p><h1 className="page-title">每一笔，都有迹可循</h1></div>
    <section className="surface-card mb-5 p-4 md:p-5" aria-label="搜索与筛选记录">
      <div className="grid gap-3 md:grid-cols-[minmax(220px,1fr)_140px_150px_160px]">
        <div className="relative"><Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[#8793a7]" /><Label htmlFor="transaction-search" className="sr-only">搜索记录</Label><Input id="transaction-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索备注、分类或金额" className="h-11 rounded-xl bg-white pl-10" /></div>
        <NativeSelect aria-label="按收支类型筛选" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as typeof typeFilter)} className="h-11 rounded-xl bg-white"><NativeSelectOption value="all">全部类型</NativeSelectOption><NativeSelectOption value="expense">支出</NativeSelectOption><NativeSelectOption value="income">收入</NativeSelectOption></NativeSelect>
        <NativeSelect aria-label="按分类筛选" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)} className="h-11 rounded-xl bg-white"><NativeSelectOption value="all">全部分类</NativeSelectOption>{categories.map((category) => <NativeSelectOption key={category} value={category}>{category}</NativeSelectOption>)}</NativeSelect>
        <NativeSelect aria-label="按月份筛选" value={monthFilter} onChange={(event) => setMonthFilter(event.target.value)} className="h-11 rounded-xl bg-white"><NativeSelectOption value="all">全部月份</NativeSelectOption>{months.map((month) => <NativeSelectOption key={month} value={month}>{new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(new Date(`${month}-01T12:00:00`))}</NativeSelectOption>)}</NativeSelect>
      </div>
      <div className="mt-3 flex min-h-8 items-center justify-between gap-3"><p className="text-sm text-[#718096]">{hasFilters ? `找到 ${visible.length} 条记录` : `共 ${transactions.length} 条记录`}</p>{hasFilters && <button type="button" onClick={clearFilters} className="rounded-lg px-3 py-1.5 text-sm font-semibold text-[#2864f0] transition hover:bg-[#eef3ff]">清除筛选</button>}</div>
    </section>
    <div className="surface-card overflow-hidden">{visible.length || !transactions.length ? <TransactionList transactions={visible} money={money} onEdit={onEdit} onDelete={onDelete} emptyAction={onAdd} /> : <div className="grid min-h-[300px] place-items-center px-6 text-center"><div><span className="mx-auto grid size-14 place-items-center rounded-2xl bg-[#eef3ff] text-[#2864f0]"><SearchX className="size-6" /></span><h3 className="mt-4 font-semibold">没有找到符合条件的记录</h3><p className="mt-1 text-sm text-[#7c899c]">试试其他关键词或筛选条件。</p><Button onClick={clearFilters} variant="outline" className="mt-5 rounded-xl bg-white">清除筛选</Button></div></div>}</div>
  </div>;
}
function TransactionList({ transactions, money, onEdit, onDelete, emptyAction }: { transactions: FinanceTransaction[]; money: (n: number) => string; onEdit: (transaction: FinanceTransaction) => void; onDelete: (id: string) => void; emptyAction: () => void }) { if (!transactions.length) return <div className="grid min-h-[320px] place-items-center px-6 text-center"><div><span className="mx-auto grid size-14 place-items-center rounded-2xl bg-[#eef3ff] text-[#2864f0]"><ReceiptText className="size-6" /></span><h3 className="mt-4 font-semibold">还没有记录</h3><p className="mt-1 text-sm text-[#7c899c]">从今天的第一笔收支开始。</p><Button onClick={emptyAction} className="mt-5 rounded-xl bg-[#2864f0]">添加第一笔</Button></div></div>; return <div className="divide-y divide-[#edf1f7]">{transactions.map((item) => <div key={item.id} className="group flex items-center gap-2 px-4 py-4 transition hover:bg-[#f8faff] md:gap-3 md:px-6"><span className="grid size-11 shrink-0 place-items-center rounded-[14px] text-lg" style={{ backgroundColor: `${categoryColors[item.category] ?? "#94a3b8"}18` }}>{categoryEmoji[item.category] ?? "•"}</span><div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold text-[#17243b]">{item.note || item.category}</div><div className="mt-1 flex items-center gap-2 text-xs text-[#8b97a9]"><span>{item.category}</span><span>·</span><time>{new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(`${item.transactionDate}T12:00:00`))}</time>{item.syncStatus !== "synced" && <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${item.syncStatus === "error" ? "bg-[#fff0f1] text-[#b64251]" : "bg-[#fff5dc] text-[#9b6b00]"}`}>{item.syncStatus === "error" ? "同步失败" : "待同步"}</span>}</div></div><div className={`text-sm font-bold tabular-nums ${item.type === "income" ? "text-[#16815a]" : "text-[#17243b]"}`}>{item.type === "income" ? "+" : "−"}{money(item.amount)}</div><div className="flex shrink-0"><button onClick={() => onEdit(item)} className="grid size-9 place-items-center rounded-lg text-[#8491a5] transition hover:bg-[#eef3ff] hover:text-[#2864f0] md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100" aria-label={`编辑${item.note || item.category}`}><Pencil className="size-4" /></button><button onClick={() => onDelete(item.id)} className="grid size-9 place-items-center rounded-lg text-[#a4adbb] transition hover:bg-[#fff0f2] hover:text-[#d64b5e] md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100" aria-label={`删除${item.note || item.category}`}><Trash2 className="size-4" /></button></div></div>)}</div>; }

function ExpenseHeatmap({ transactions, month, money }: { transactions: FinanceTransaction[]; month: string; money: (value: number) => string }) {
  const [year, monthNumber] = month.split("-").map(Number);
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const firstWeekday = new Date(year, monthNumber - 1, 1).getDay();
  const dailyTotals = Array.from({ length: daysInMonth }, () => 0);
  transactions.filter((item) => item.type === "expense").forEach((item) => {
    const day = Number(item.transactionDate.slice(8, 10));
    if (day >= 1 && day <= daysInMonth) dailyTotals[day - 1] += item.amount;
  });
  const maximum = Math.max(0, ...dailyTotals);
  const defaultDay = maximum ? dailyTotals.indexOf(maximum) + 1 : null;
  const [selectedDay, setSelectedDay] = useState<number | null>(defaultDay);
  const activeDay = selectedDay && selectedDay <= daysInMonth ? selectedDay : defaultDay;
  const monthLabel = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(new Date(year, monthNumber - 1, 1));
  const colors = ["#fff7ed", "#ffedd5", "#fed7aa", "#fb923c", "#d97706"];

  return <section className="surface-card p-5 md:p-6" aria-labelledby="expense-calendar-title">
    <div className="flex items-start justify-between gap-4"><div><h2 id="expense-calendar-title" className="section-title">消费日历</h2><p className="section-subtitle">颜色越深，当天支出越高</p></div><span className="rounded-full bg-[#fff3df] px-3 py-1.5 text-xs font-semibold text-[#b45309]">{monthLabel}</span></div>
    <div className="mt-6 grid grid-cols-7 gap-1.5 text-center text-xs text-[#8793a7]" aria-hidden="true">{["日", "一", "二", "三", "四", "五", "六"].map((day) => <span key={day}>{day}</span>)}</div>
    <div className="mt-2 grid grid-cols-7 gap-1.5" role="group" aria-label={`${monthLabel}每日支出`}>
      {Array.from({ length: firstWeekday }, (_, index) => <span key={`blank-${index}`} aria-hidden="true" />)}
      {dailyTotals.map((total, index) => {
        const day = index + 1;
        const level = total === 0 || maximum === 0 ? 0 : Math.min(4, Math.ceil(total / maximum * 4));
        const selected = activeDay === day;
        return <button key={day} type="button" onClick={() => setSelectedDay(day)} aria-label={`${monthNumber}月${day}日，支出${money(total)}`} aria-pressed={selected} className={`aspect-square min-w-0 rounded-[9px] text-xs font-semibold transition hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d97706] ${level >= 4 ? "text-white" : "text-[#68421f]"} ${selected ? "ring-2 ring-[#d97706] ring-offset-2" : ""}`} style={{ backgroundColor: colors[level] }}>{day}</button>;
      })}
    </div>
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm"><p className="font-semibold text-[#17243b]" aria-live="polite">{activeDay ? `${monthNumber}月${activeDay}日 · 支出 ${money(dailyTotals[activeDay - 1])}` : "本月还没有支出记录"}</p><div className="flex items-center gap-1.5 text-xs text-[#8793a7]"><span>少</span>{[0, 2, 4].map((level) => <span key={level} className="size-4 rounded-[5px]" style={{ backgroundColor: colors[level] }} />)}<span>多</span></div></div>
  </section>;
}

function InsightsView({ expense, money, breakdown, chartData, transactions, month }: { expense: number; money: (n: number) => string; breakdown: [string, number][]; chartData: { month: string; income: number; expense: number }[]; transactions: FinanceTransaction[]; month: string }) {
  return <div className="mx-auto max-w-5xl"><div className="mb-6"><p className="eyebrow">支出分析</p><h1 className="page-title">看见钱去了哪里</h1></div><ExpenseHeatmap transactions={transactions} month={month} money={money} /><div className="mt-5 grid gap-5 md:grid-cols-[.8fr_1.2fr]"><div className="surface-card p-6"><p className="section-subtitle">本月总支出</p><p className="mt-2 text-3xl font-bold tracking-[-.04em]"><AnimatedCurrency value={expense} money={money} /></p><div className="mt-8 space-y-5">{breakdown.length ? breakdown.map(([category, value]) => <div key={category}><div className="mb-2 flex items-center justify-between text-sm"><span className="font-medium">{category}</span><span className="text-[#77859a]">{money(value)}</span></div><div className="h-2 overflow-hidden rounded-full bg-[#edf1f7]"><div className="h-full rounded-full" style={{ width: `${expense ? Math.max(6, value / expense * 100) : 0}%`, backgroundColor: categoryColors[category] ?? "#94a3b8" }} /></div></div>) : <p className="py-16 text-center text-sm text-[#8b97a9]">添加支出后，这里会显示分类占比。</p>}</div></div><div className="surface-card p-6"><h2 className="section-title">收入与支出</h2><p className="section-subtitle">最近六个月对比</p><div className="mt-6 h-[330px]"><ResponsiveContainer width="100%" height="100%"><AreaChart data={chartData} margin={{ left: -20, right: 5 }}><CartesianGrid vertical={false} stroke="#edf1f7"/><XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fill: "#8793a7", fontSize: 12 }}/><Tooltip contentStyle={{ border: 0, borderRadius: 14, boxShadow: "0 14px 40px rgba(20,33,61,.12)" }}/><Area type="monotone" dataKey="income" name="收入" stroke="#24a36b" fill="#24a36b14" strokeWidth={2.5}/><Area type="monotone" dataKey="expense" name="支出" stroke="#2864f0" fill="#2864f014" strokeWidth={2.5}/></AreaChart></ResponsiveContainer></div></div></div></div>;
}

function SettingsView({ currency, onCurrencyChange, configured, signedInEmail, syncing, syncMessage, email, password, onEmail, onPassword, onAuth, onSync, onExport }: { currency: string; onCurrencyChange: (v: string) => void; configured: boolean; signedInEmail: string; syncing: boolean; syncMessage: string; email: string; password: string; onEmail: (v: string) => void; onPassword: (v: string) => void; onAuth: (e: FormEvent<HTMLFormElement>) => void; onSync: () => void; onExport: () => void }) { return <div className="mx-auto max-w-3xl"><div className="mb-6"><p className="eyebrow">偏好与备份</p><h1 className="page-title">设置</h1></div><div className="space-y-5"><section className="surface-card p-5 md:p-6"><div className="flex items-center justify-between gap-5"><div><h2 className="section-title">默认货币</h2><p className="section-subtitle">新记录会使用此货币</p></div><NativeSelect value={currency} onChange={(e) => onCurrencyChange(e.target.value)} className="w-28"><NativeSelectOption value="CAD">CAD</NativeSelectOption><NativeSelectOption value="CNY">CNY</NativeSelectOption><NativeSelectOption value="USD">USD</NativeSelectOption><NativeSelectOption value="EUR">EUR</NativeSelectOption><NativeSelectOption value="HKD">HKD</NativeSelectOption></NativeSelect></div></section><section className="surface-card p-5 md:p-6"><div className="mb-5 flex items-start justify-between gap-4"><div><h2 className="section-title">云端同步</h2><p className="section-subtitle">本地记录优先，登录后备份至 Supabase</p></div><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${configured ? "bg-[#e4f8ef] text-[#167250]" : "bg-[#fff5dc] text-[#936700]"}`}>{configured ? "已配置" : "待配置"}</span></div>{signedInEmail ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-[#f5f8fd] p-4"><div><p className="text-sm font-semibold">{signedInEmail}</p><p className="mt-1 text-xs text-[#7c899c]">账号已连接</p></div><Button onClick={onSync} disabled={syncing} variant="outline" className="rounded-xl bg-white">{syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}立即同步</Button></div> : <form onSubmit={onAuth} className="grid gap-4 md:grid-cols-2"><div className="space-y-2"><Label htmlFor="email">邮箱</Label><Input id="email" type="email" value={email} onChange={(e) => onEmail(e.target.value)} placeholder="name@example.com" required /></div><div className="space-y-2"><Label htmlFor="password">密码</Label><Input id="password" type="password" minLength={8} value={password} onChange={(e) => onPassword(e.target.value)} placeholder="至少 8 位" required /></div><Button type="submit" disabled={syncing || !configured} className="rounded-xl bg-[#2864f0] md:col-span-2">{syncing ? <Loader2 className="animate-spin" /> : <Cloud />}登录或创建账号</Button></form>}{syncMessage && <p aria-live="polite" className="mt-4 text-sm text-[#617087]">{syncMessage}</p>}</section><section className="surface-card p-5 md:p-6"><div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="section-title">本地备份</h2><p className="section-subtitle">下载包含所有记录的 JSON 文件</p></div><Button onClick={onExport} variant="outline" className="rounded-xl"><Download />导出备份</Button></div></section></div></div>; }

type SettingsViewWithPlanProps = {
  currency: string;
  financePlan: FinancePlan;
  savingPlan: boolean;
  onSavePlan: (plan: Pick<FinancePlan, "monthlyBudget" | "monthlySavingsTarget" | "recurringRules">) => Promise<void>;
  onCurrencyChange: (value: string) => void;
  configured: boolean;
  signedInEmail: string;
  syncing: boolean;
  syncMessage: string;
  email: string;
  password: string;
  onEmail: (value: string) => void;
  onPassword: (value: string) => void;
  onAuth: (event: FormEvent<HTMLFormElement>) => void;
  onSync: () => void;
  onExport: () => void;
};

function SettingsViewWithPlan({ financePlan, savingPlan, onSavePlan, ...settingsProps }: SettingsViewWithPlanProps) {
  return <>
    <SettingsView {...settingsProps} />
    <div className="mx-auto mt-5 max-w-3xl"><PlanSettings key={financePlan.updatedAt || "empty"} plan={financePlan} currency={settingsProps.currency} saving={savingPlan} onSave={onSavePlan} /></div>
  </>;
}

function PlanSettings({ plan, currency, saving, onSave }: { plan: FinancePlan; currency: string; saving: boolean; onSave: SettingsViewWithPlanProps["onSavePlan"] }) {
  const [budget, setBudget] = useState(() => plan.monthlyBudget ? String(plan.monthlyBudget / 100) : "");
  const [savings, setSavings] = useState(() => plan.monthlySavingsTarget ? String(plan.monthlySavingsTarget / 100) : "");
  const [rules, setRules] = useState<RecurringRule[]>(() => plan.recurringRules);
  const [ruleType, setRuleType] = useState<TransactionType>("expense");
  const [ruleAmount, setRuleAmount] = useState("");
  const [ruleCategory, setRuleCategory] = useState(expenseCategories[0]);
  const [ruleNote, setRuleNote] = useState("");
  const [ruleDay, setRuleDay] = useState("1");

  function changeRuleType(next: TransactionType) {
    setRuleType(next);
    setRuleCategory((next === "expense" ? expenseCategories : incomeCategories)[0]);
  }

  function addRule() {
    const amount = Math.round(Number(ruleAmount) * 100);
    if (!amount || amount < 1) return;
    setRules((current) => [...current, {
      id: crypto.randomUUID(),
      type: ruleType,
      amount,
      currency,
      category: ruleCategory,
      note: ruleNote.trim() || ruleCategory,
      day: Math.min(31, Math.max(1, Math.round(Number(ruleDay) || 1))),
    }]);
    setRuleAmount("");
    setRuleNote("");
  }

  async function submitPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSave({
      monthlyBudget: Math.max(0, Math.round(Number(budget) * 100) || 0),
      monthlySavingsTarget: Math.max(0, Math.round(Number(savings) * 100) || 0),
      recurringRules: rules,
    });
  }

  const categories = ruleType === "expense" ? expenseCategories : incomeCategories;
  return <section className="surface-card overflow-hidden">
    <div className="border-b border-[#edf1f7] px-5 py-5 md:px-6"><div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-[#eef3ff] text-[#2864f0]"><CalendarClock className="size-5" /></span><div><h2 className="section-title">月度计划与固定收支</h2><p className="section-subtitle">到达设定日期时，固定项目会自动记入当月</p></div></div></div>
    <form onSubmit={submitPlan} className="space-y-6 p-5 md:p-6">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2"><Label htmlFor="monthly-budget">每月预算</Label><div className="relative"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-[#738096]">{currency}</span><Input id="monthly-budget" value={budget} onChange={(event) => setBudget(event.target.value)} type="number" inputMode="decimal" step="0.01" min="0" placeholder="0.00" className="h-11 rounded-xl pl-12" /></div></div>
        <div className="space-y-2"><Label htmlFor="monthly-savings">每月储蓄目标</Label><div className="relative"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-[#738096]">{currency}</span><Input id="monthly-savings" value={savings} onChange={(event) => setSavings(event.target.value)} type="number" inputMode="decimal" step="0.01" min="0" placeholder="0.00" className="h-11 rounded-xl pl-12" /></div><p className="text-xs leading-5 text-[#8793a7]">储蓄目标用于追踪，不会被记为支出。</p></div>
      </div>

      <div className="rounded-2xl bg-[#f5f8fd] p-4 md:p-5">
        <div className="mb-4"><h3 className="text-sm font-semibold text-[#17243b]">添加固定项目</h3><p className="mt-1 text-xs text-[#8793a7]">例如每月工资、房租、保险或订阅。</p></div>
        <div className="grid gap-3 md:grid-cols-2">
          <NativeSelect value={ruleType} onChange={(event) => changeRuleType(event.target.value as TransactionType)} className="h-11 rounded-xl bg-white"><NativeSelectOption value="expense">固定支出</NativeSelectOption><NativeSelectOption value="income">固定收入</NativeSelectOption></NativeSelect>
          <div className="relative"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-[#738096]">{currency}</span><Input value={ruleAmount} onChange={(event) => setRuleAmount(event.target.value)} type="number" inputMode="decimal" step="0.01" min="0.01" placeholder="金额" className="h-11 rounded-xl bg-white pl-12" /></div>
          <NativeSelect value={ruleCategory} onChange={(event) => setRuleCategory(event.target.value)} className="h-11 rounded-xl bg-white">{categories.map((category) => <NativeSelectOption key={category} value={category}>{category}</NativeSelectOption>)}</NativeSelect>
          <Input value={ruleNote} onChange={(event) => setRuleNote(event.target.value)} placeholder="名称，例如房租" className="h-11 rounded-xl bg-white" />
          <div className="flex items-center gap-3"><Label htmlFor="recurring-day" className="shrink-0">每月</Label><Input id="recurring-day" value={ruleDay} onChange={(event) => setRuleDay(event.target.value)} type="number" inputMode="numeric" min="1" max="31" className="h-11 rounded-xl bg-white" /><span className="shrink-0 text-sm text-[#617087]">日</span></div>
          <Button type="button" onClick={addRule} variant="outline" className="h-11 rounded-xl bg-white"><Plus />加入固定项目</Button>
        </div>
      </div>

      {rules.length > 0 && <div className="space-y-2">{rules.map((rule) => <div key={rule.id} className="flex items-center gap-3 rounded-2xl border border-[#e5eaf2] p-3"><span className={`grid size-10 shrink-0 place-items-center rounded-xl ${rule.type === "income" ? "bg-[#e5f8ef] text-[#16815a]" : "bg-[#fff0f2] text-[#d64b5e]"}`}>{rule.type === "income" ? <ArrowDownLeft className="size-5" /> : <ArrowUpRight className="size-5" />}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-[#17243b]">{rule.note}</p><p className="mt-0.5 text-xs text-[#8793a7]">每月 {rule.day} 日 · {rule.category}</p></div><p className={`shrink-0 text-sm font-bold ${rule.type === "income" ? "text-[#16815a]" : "text-[#17243b]"}`}>{rule.type === "income" ? "+" : "−"}{new Intl.NumberFormat("zh-CN", { style: "currency", currency: rule.currency }).format(rule.amount / 100)}</p><button type="button" onClick={() => setRules((current) => current.filter((item) => item.id !== rule.id))} className="grid size-9 shrink-0 place-items-center rounded-lg text-[#a4adbb] hover:bg-[#fff0f2] hover:text-[#d64b5e]" aria-label={`删除固定项目${rule.note}`}><Trash2 className="size-4" /></button></div>)}</div>}

      <Button type="submit" disabled={saving} className="h-11 w-full rounded-xl bg-[#2864f0]">{saving ? <Loader2 className="animate-spin" /> : <PiggyBank />}保存月度计划</Button>
    </form>
  </section>;
}

function EditDialog({ transaction, open, onOpenChange, onSubmit }: { transaction: FinanceTransaction; open: boolean; onOpenChange: (open: boolean) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const [type, setType] = useState<TransactionType>(transaction.type);
  const [category, setCategory] = useState(transaction.category);
  const categories = type === "expense" ? expenseCategories : incomeCategories;
  function changeType(next: TransactionType) {
    setType(next);
    const nextCategories = next === "expense" ? expenseCategories : incomeCategories;
    if (!nextCategories.includes(category)) setCategory(nextCategories[0]);
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="rounded-[24px] border-0 p-0 shadow-[0_28px_90px_rgba(13,25,48,.28)] sm:max-w-[470px]"><form onSubmit={onSubmit}><DialogHeader className="border-b border-[#edf1f7] px-6 py-5 text-left"><DialogTitle className="text-xl tracking-[-.03em]">编辑记录</DialogTitle><DialogDescription>修改后会立即更新本机数据，并在联网后同步。</DialogDescription></DialogHeader><div className="space-y-5 px-6 py-5"><div className="grid grid-cols-2 rounded-xl bg-[#eef2f8] p-1"><button type="button" onClick={() => changeType("expense")} className={`h-10 rounded-lg text-sm font-semibold transition ${type === "expense" ? "bg-white text-[#17243b] shadow-sm" : "text-[#7a879b]"}`}>支出</button><button type="button" onClick={() => changeType("income")} className={`h-10 rounded-lg text-sm font-semibold transition ${type === "income" ? "bg-white text-[#16815a] shadow-sm" : "text-[#7a879b]"}`}>收入</button></div><input type="hidden" name="type" value={type}/><div className="space-y-2"><Label htmlFor="edit-amount">金额</Label><div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm font-semibold text-[#738096]">{transaction.currency}</span><Input id="edit-amount" name="amount" type="number" inputMode="decimal" step="0.01" min="0.01" required defaultValue={transaction.amount / 100} className="h-14 rounded-xl pl-14 text-xl font-bold" autoFocus /></div></div><div className="grid grid-cols-2 gap-4"><div className="space-y-2"><Label htmlFor="edit-category">分类</Label><NativeSelect id="edit-category" name="category" value={category} onChange={(event) => setCategory(event.target.value)} className="h-11 w-full rounded-xl">{categories.map((item) => <NativeSelectOption key={item} value={item}>{item}</NativeSelectOption>)}</NativeSelect></div><div className="space-y-2"><Label htmlFor="edit-date">日期</Label><Input id="edit-date" name="date" type="date" defaultValue={transaction.transactionDate} required className="h-11 rounded-xl" /></div></div><div className="space-y-2"><Label htmlFor="edit-note">备注</Label><Input id="edit-note" name="note" defaultValue={transaction.note} placeholder={type === "expense" ? "例如：午餐" : "例如：九月工资"} className="h-11 rounded-xl" /></div></div><DialogFooter className="border-t border-[#edf1f7] px-6 py-5"><Button type="button" variant="ghost" onClick={() => onOpenChange(false)} className="h-11 rounded-xl">取消</Button><Button type="submit" className="h-11 rounded-xl bg-[#2864f0] px-7"><Pencil />保存修改</Button></DialogFooter></form></DialogContent></Dialog>;
}

function AddDialog({ open, onOpenChange, currency, onSubmit }: { open: boolean; onOpenChange: (open: boolean) => void; currency: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) { const [type, setType] = useState<TransactionType>("expense"); const categories = type === "expense" ? expenseCategories : incomeCategories; return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="rounded-[24px] border-0 p-0 shadow-[0_28px_90px_rgba(13,25,48,.28)] sm:max-w-[470px]"><form onSubmit={onSubmit}><DialogHeader className="border-b border-[#edf1f7] px-6 py-5 text-left"><DialogTitle className="text-xl tracking-[-.03em]">添加一笔记录</DialogTitle><DialogDescription>先保存到本机，联网后自动同步。</DialogDescription></DialogHeader><div className="space-y-5 px-6 py-5"><div className="grid grid-cols-2 rounded-xl bg-[#eef2f8] p-1"><button type="button" onClick={() => setType("expense")} className={`h-10 rounded-lg text-sm font-semibold transition ${type === "expense" ? "bg-white text-[#17243b] shadow-sm" : "text-[#7a879b]"}`}>支出</button><button type="button" onClick={() => setType("income")} className={`h-10 rounded-lg text-sm font-semibold transition ${type === "income" ? "bg-white text-[#16815a] shadow-sm" : "text-[#7a879b]"}`}>收入</button></div><input type="hidden" name="type" value={type}/><div className="space-y-2"><Label htmlFor="amount">金额</Label><div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm font-semibold text-[#738096]">{currency}</span><Input id="amount" name="amount" type="number" inputMode="decimal" step="0.01" min="0.01" required placeholder="0.00" className="h-14 rounded-xl pl-14 text-xl font-bold" autoFocus /></div></div><div className="grid grid-cols-2 gap-4"><div className="space-y-2"><Label htmlFor="category">分类</Label><NativeSelect id="category" name="category" className="h-11 w-full rounded-xl">{categories.map((category) => <NativeSelectOption key={category} value={category}>{category}</NativeSelectOption>)}</NativeSelect></div><div className="space-y-2"><Label htmlFor="date">日期</Label><Input id="date" name="date" type="date" defaultValue={today()} required className="h-11 rounded-xl" /></div></div><div className="space-y-2"><Label htmlFor="note">备注</Label><Input id="note" name="note" placeholder={type === "expense" ? "例如：午餐" : "例如：九月工资"} className="h-11 rounded-xl" /></div></div><DialogFooter className="border-t border-[#edf1f7] px-6 py-5"><Button type="button" variant="ghost" onClick={() => onOpenChange(false)} className="h-11 rounded-xl">取消</Button><Button type="submit" className="h-11 rounded-xl bg-[#2864f0] px-7">保存记录</Button></DialogFooter></form></DialogContent></Dialog>; }
