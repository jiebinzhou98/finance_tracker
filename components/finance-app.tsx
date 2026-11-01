"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowDownLeft, ArrowUpRight, BarChart3, CalendarClock, Check, ChevronLeft, ChevronRight, Cloud, CloudOff, Download, Home, Landmark, Loader2, LogOut, Pencil, PiggyBank, Plus, ReceiptText, RefreshCw, Search, SearchX, Settings, Target, Trash2, WalletCards, WifiOff } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { PwaRegister } from "@/components/pwa-register";
import { addTransaction, emptyFinancePlan, ensureMonthlyRecurringTransactions, exportData, getCurrency, getFinancePlan, getTransactions, saveFinancePlan, setCurrency as saveCurrency, softDeleteTransaction, updateTransaction, type FinancePlan, type FinanceTransaction, type RecurringRule, type TransactionType } from "@/lib/finance-db";
import { currencyLabels, displayAmount, ensureTransactionRates, getExchangeRatesForDate, supportedCurrencies } from "@/lib/exchange-rates";
import { getSupabase, isCloudConfigured, syncTransactions } from "@/lib/supabase";
import { registerFinanceTools } from "@/lib/webmcp";

type View = "overview" | "transactions" | "insights" | "summary" | "settings";
const expenseCategories = ["餐饮", "糖分", "交通", "住房", "购物", "娱乐", "健康", "其他"];
const incomeCategories = ["工资", "奖金", "副业", "投资", "退款", "其他"];
const sugarSubcategories = ["奶茶", "蛋糕"];
const navItems: { id: View; label: string; icon: typeof Home }[] = [
  { id: "overview", label: "概览", icon: Home },
  { id: "transactions", label: "明细", icon: ReceiptText },
  { id: "insights", label: "分析", icon: BarChart3 },
  { id: "summary", label: "总结", icon: CalendarClock },
  { id: "settings", label: "设置", icon: Settings },
];
const categoryColors: Record<string, string> = { 餐饮: "#e8a18b", 糖分: "#f59eaa", 交通: "#a6b6a1", 住房: "#b9adc1", 购物: "#d8b568", 娱乐: "#9cbdb0", 健康: "#89a083", 工资: "#22c55e", 奖金: "#16a34a", 其他: "#aaa99c" };
const categoryEmoji: Record<string, string> = { 餐饮: "🍜", 糖分: "🍰", 交通: "🚇", 住房: "🏠", 购物: "🛍️", 娱乐: "🎬", 健康: "💊", 工资: "💼", 奖金: "✨", 副业: "💻", 投资: "📈", 退款: "↩️", 其他: "•" };
const retryDelays = [5_000, 15_000, 60_000];

function today() { return new Date().toISOString().slice(0, 10); }
function monthKey(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`; }
function monthDate(month: string) { const [year, monthNumber] = month.split("-").map(Number); return new Date(year, monthNumber - 1, 1, 12); }
function shiftMonth(month: string, amount: number) { const date = monthDate(month); date.setMonth(date.getMonth() + amount); return monthKey(date); }
function formatMonth(month: string) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(monthDate(month)); }
function defaultDateForMonth(month: string) { const now = new Date(); const [year, monthNumber] = month.split("-").map(Number); const day = Math.min(now.getDate(), new Date(year, monthNumber, 0).getDate()); return `${month}-${String(day).padStart(2, "0")}`; }

export default function FinanceApp() {
  const [view, setView] = useState<View>("overview");
  const [selectedMonth, setSelectedMonth] = useState(monthKey());
  const [transactionDateFilter, setTransactionDateFilter] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<FinanceTransaction[]>([]);
  const [currency, setCurrency] = useState("CAD");
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<FinanceTransaction | null>(null);
  const [transactionError, setTransactionError] = useState("");
  const [addingTransaction, setAddingTransaction] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [signedInEmail, setSignedInEmail] = useState("");
  const [financePlan, setFinancePlan] = useState<FinancePlan>(() => emptyFinancePlan());
  const [savingPlan, setSavingPlan] = useState(false);
  const signedInRef = useRef("");
  const syncingRef = useRef(false);
  const syncQueuedRef = useRef(false);
  const retryAttemptRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const addingTransactionRef = useRef(false);

  const load = useCallback(async () => {
    const [savedCurrency, savedPlan] = await Promise.all([getCurrency(), getFinancePlan()]);
    await ensureMonthlyRecurringTransactions(savedPlan);
    let items = await getTransactions();
    try {
      if (await ensureTransactionRates(items, savedCurrency)) items = await getTransactions();
    } catch { /* Keep the app usable offline; missing rates will be filled next time it is online. */ }
    setTransactions(items); setCurrency(savedCurrency); setFinancePlan(savedPlan); setLoading(false);
  }, []);

  useEffect(() => registerFinanceTools(currency, load), [currency, load]);

  const activeTransactions = useMemo(() => transactions.filter((item) => !item.deletedAt), [transactions]);
  const monthTransactions = useMemo(() => activeTransactions.filter((item) => item.transactionDate.startsWith(selectedMonth)), [activeTransactions, selectedMonth]);
  const previousMonthTransactions = useMemo(() => {
    const previousMonth = shiftMonth(selectedMonth, -1);
    return activeTransactions.filter((item) => item.transactionDate.startsWith(previousMonth));
  }, [activeTransactions, selectedMonth]);
  const amountInDisplayCurrency = useCallback((item: FinanceTransaction) => displayAmount(item, currency), [currency]);
  const income = monthTransactions.filter((item) => item.type === "income").reduce((sum, item) => sum + amountInDisplayCurrency(item), 0);
  const expense = monthTransactions.filter((item) => item.type === "expense").reduce((sum, item) => sum + amountInDisplayCurrency(item), 0);
  const previousExpense = previousMonthTransactions.filter((item) => item.type === "expense").reduce((sum, item) => sum + amountInDisplayCurrency(item), 0);
  const balance = income - expense;
  const pendingCount = transactions.filter((item) => item.syncStatus !== "synced").length;
  const money = useCallback((cents: number) => new Intl.NumberFormat("zh-CN", { style: "currency", currency, maximumFractionDigits: 2 }).format(cents / 100), [currency]);
  const chartData = useMemo(() => Array.from({ length: 6 }, (_, index) => {
    const date = monthDate(selectedMonth); date.setMonth(date.getMonth() - (5 - index)); const key = monthKey(date);
    const values = activeTransactions.filter((item) => item.transactionDate.startsWith(key));
    return { month: `${date.getMonth() + 1}月`, income: values.filter((item) => item.type === "income").reduce((sum, item) => sum + amountInDisplayCurrency(item) / 100, 0), expense: values.filter((item) => item.type === "expense").reduce((sum, item) => sum + amountInDisplayCurrency(item) / 100, 0) };
  }), [activeTransactions, amountInDisplayCurrency, selectedMonth]);
  const expenseBreakdown = useMemo(() => {
    const sums = new Map<string, number>();
    monthTransactions.filter((item) => item.type === "expense").forEach((item) => sums.set(item.category, (sums.get(item.category) ?? 0) + amountInDisplayCurrency(item)));
    return [...sums.entries()].sort((a, b) => b[1] - a[1]);
  }, [amountInDisplayCurrency, monthTransactions]);
  const previousExpenseBreakdown = useMemo(() => {
    const sums = new Map<string, number>();
    previousMonthTransactions.filter((item) => item.type === "expense").forEach((item) => sums.set(item.category, (sums.get(item.category) ?? 0) + amountInDisplayCurrency(item)));
    return [...sums.entries()].sort((a, b) => b[1] - a[1]);
  }, [amountInDisplayCurrency, previousMonthTransactions]);

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
      if (event === "PASSWORD_RECOVERY") {
        setPasswordRecovery(true);
        setView("settings");
        setSyncMessage("恢复链接已验证，请设置新密码");
      }
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
    event.preventDefault();
    if (addingTransactionRef.current) {
      setTransactionError("正在保存这笔记录，请勿重复点击");
      return;
    }
    const form = new FormData(event.currentTarget); const amount = Math.round(Number(form.get("amount")) * 100);
    if (!amount || amount < 1) return;
    const transactionCurrency = String(form.get("currency"));
    const transactionDate = String(form.get("date"));
    addingTransactionRef.current = true;
    setAddingTransaction(true);
    setTransactionError("");
    try {
      const snapshot = transactionCurrency === currency ? undefined : await getExchangeRatesForDate(transactionDate);
      const category = String(form.get("category"));
      await addTransaction({ type: form.get("type") as TransactionType, amount, currency: transactionCurrency, exchangeRates: snapshot?.rates, exchangeRateDate: snapshot?.date, category, subcategory: category === "糖分" ? String(form.get("subcategory") ?? "") || undefined : undefined, note: String(form.get("note") ?? ""), transactionDate });
      setDialogOpen(false); setTransactionError(""); await load(); if (navigator.onLine && signedInRef.current) void handleSync(true);
    } catch (error) {
      setTransactionError(error instanceof Error ? error.message : "无法保存这笔记录");
    } finally {
      addingTransactionRef.current = false;
      setAddingTransaction(false);
    }
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
    const transactionCurrency = String(form.get("currency"));
    const transactionDate = String(form.get("date"));
    try {
      const snapshot = transactionCurrency === currency ? undefined : await getExchangeRatesForDate(transactionDate);
      await updateTransaction(editingTransaction.id, {
        type: form.get("type") as TransactionType, amount, currency: transactionCurrency,
        exchangeRates: snapshot?.rates, exchangeRateDate: snapshot?.date,
        category: String(form.get("category")), subcategory: String(form.get("category")) === "糖分" ? String(form.get("subcategory") ?? "") || undefined : undefined, note: String(form.get("note") ?? ""), transactionDate,
      });
      setEditingTransaction(null); setTransactionError(""); await load();
      if (navigator.onLine && signedInRef.current) void handleSync(true);
    } catch (error) { setTransactionError(error instanceof Error ? error.message : "无法保存修改"); }
  }
  async function handleAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const supabase = getSupabase(); if (!supabase) return setSyncMessage("请先在 Vercel 配置 Supabase 环境变量");
    setAuthError("");
    setSyncing(true); const signIn = await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword });
    if (signIn.error) {
      if (signIn.error.code === "email_not_confirmed") {
        setSyncMessage("邮箱尚未验证，请先打开验证邮件完成确认");
      } else if (signIn.error.code !== "invalid_credentials") {
        setSyncMessage(`登录失败：${signIn.error.message}`);
      } else {
        const signUp = await supabase.auth.signUp({ email: authEmail, password: authPassword });
        const existingAccount = signUp.error?.code === "user_already_exists" || signUp.error?.code === "email_exists" ||
          /already (registered|exists)/i.test(signUp.error?.message ?? "") || signUp.data.user?.identities?.length === 0;
        if (existingAccount) {
          setSyncMessage("");
          setAuthError("邮箱或密码错误，请重试或使用“忘记密码”");
          window.setTimeout(() => document.getElementById("password")?.focus(), 0);
        } else if (signUp.error) {
          setSyncMessage(`无法创建账号：${signUp.error.message}`);
        } else {
          setSyncMessage(signUp.data.session ? "账号已建立" : "请检查邮箱完成验证");
          const email = signUp.data.session?.user.email ?? "";
          signedInRef.current = email;
          setSignedInEmail(email);
        }
      }
    } else {
      const email = signIn.data.user.email ?? "";
      signedInRef.current = email;
      setSignedInEmail(email);
      setSyncMessage("登录成功，正在恢复云端记录…");
      window.setTimeout(() => void handleSync(true), 0);
    }
    if (!syncingRef.current) setSyncing(false);
  }
  async function handleForgotPassword() {
    const email = authEmail.trim();
    if (!email) return setSyncMessage("请先输入注册邮箱");
    setAuthError("");
    const supabase = getSupabase();
    if (!supabase) return setSyncMessage("请先在 Vercel 配置 Supabase 环境变量");
    setSyncing(true);
    setSyncMessage("正在发送密码恢复邮件…");
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/` });
    setSyncing(false);
    setSyncMessage(error ? `无法发送恢复邮件：${error.message}` : "如果该邮箱已注册，你会收到一封密码恢复邮件");
  }
  async function handleUpdatePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newPassword.length < 8) return setSyncMessage("新密码至少需要 8 位");
    if (newPassword !== confirmPassword) return setSyncMessage("两次输入的密码不一致");
    const supabase = getSupabase();
    if (!supabase) return setSyncMessage("尚未配置 Supabase");
    setSyncing(true);
    setSyncMessage("正在更新密码…");
    const { data, error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
      setSyncing(false);
      return setSyncMessage(`密码更新失败：${error.message}`);
    }
    const email = data.user.email ?? signedInRef.current;
    signedInRef.current = email;
    setSignedInEmail(email);
    setPasswordRecovery(false);
    setNewPassword("");
    setConfirmPassword("");
    setAuthPassword("");
    window.history.replaceState({}, document.title, window.location.pathname);
    setSyncMessage("密码已更新。若恢复邮件在 Safari 打开，请回到主屏幕上的 Morrow，用新密码登录并同步");
    setSyncing(false);
    if (navigator.onLine) window.setTimeout(() => void handleSync(true), 0);
  }
  async function handleSignOut() {
    const supabase = getSupabase();
    if (!supabase) return setSyncMessage("尚未配置 Supabase");
    if (syncingRef.current) return setSyncMessage("同步正在进行，请稍后再退出");

    syncingRef.current = true;
    setSyncing(true);
    try {
      const hasPendingCloudData = pendingCount > 0 || financePlan.syncStatus !== "synced";
      if (hasPendingCloudData) {
        if (!navigator.onLine) {
          setSyncMessage("仍有本地数据待同步，请联网同步后再退出");
          return;
        }
        setSyncMessage("退出前正在同步本地数据…");
        const result = await syncTransactions();
        await load();
        if (result.pending > 0) {
          setSyncMessage(`仍有 ${result.pending} 条记录未同步，暂未退出账号`);
          return;
        }
      }

      const currentEmail = signedInRef.current;
      const { error } = await supabase.auth.signOut({ scope: "local" });
      if (error) throw error;
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
      retryAttemptRef.current = 0;
      signedInRef.current = "";
      setSignedInEmail("");
      setPasswordRecovery(false);
      setAuthError("");
      setAuthEmail(currentEmail);
      setAuthPassword("");
      setSyncMessage("已退出这部设备的云端账号，本机记录仍然保留");
    } catch (error) {
      setSyncMessage(error instanceof Error ? `退出失败：${error.message}` : "暂时无法退出账号");
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }
  async function downloadBackup() {
    const content = await exportData(); const url = URL.createObjectURL(new Blob([content], { type: "application/json" })); const link = document.createElement("a");
    link.href = url; link.download = `morrow-backup-${today()}.json`; link.click(); URL.revokeObjectURL(url);
  }
  async function changeCurrency(next: string) {
    try {
      await ensureTransactionRates(transactions, next);
      await saveCurrency(next); setCurrency(next); setSyncMessage(`默认显示货币已切换为 ${next}`); await load();
      if (navigator.onLine && signedInRef.current) void handleSync(true);
    } catch (error) { setSyncMessage(error instanceof Error ? `切换失败：${error.message}` : "无法切换显示货币"); }
  }
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
  const cloudStatusTone = !online ? "bg-[#fff0f1] text-[#b64251]" : pendingCount ? "bg-[#fff5dc] text-[#936700]" : "bg-[#edf2e8] text-[#536f4f]";
  const changeView = (nextView: View) => {
    setTransactionDateFilter(null);
    setView(nextView);
  };
  const openTransactionsForDate = (date: string) => {
    setTransactionDateFilter(date);
    setView("transactions");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return <div className="morrow-app min-h-screen bg-[#faf7f2] text-[#29312a]">
    <PwaRegister />
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col border-r border-white/10 bg-[#303d31] px-5 py-7 text-white lg:flex">
      <Brand /><nav className="mt-12 space-y-2" aria-label="主要导航">{navItems.map((item) => <NavButton key={item.id} {...item} active={view === item.id} onClick={() => changeView(item.id)} />)}</nav>
      <div className="mt-auto rounded-2xl border border-white/10 bg-white/[0.06] p-4"><div className="flex items-center gap-2 text-sm font-medium">{online ? <Cloud className="size-4 text-[#65d9a6]" /> : <CloudOff className="size-4 text-[#ff8b96]" />}{signedInEmail ? "云端备份已连接" : "本地模式"}</div><p className="mt-2 text-xs leading-5 text-slate-400">{pendingCount ? `${pendingCount} 条记录等待同步` : "本机记录均已保存"}</p></div>
    </aside>
    <main className="mx-auto min-h-screen max-w-[1480px] pb-28 lg:ml-[248px] lg:pb-8">
      <header className="sticky top-0 z-20 flex h-[calc(74px+env(safe-area-inset-top))] items-center justify-between border-b border-[#e7e5dc] bg-[#faf7f2]/90 px-5 pt-[env(safe-area-inset-top)] backdrop-blur-xl md:px-8 lg:h-[74px] lg:px-10 lg:pt-0"><div className="lg:hidden"><Brand compact /></div><p className="hidden text-sm text-[#72796e] lg:block">{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date())}</p><div className="flex items-center gap-3"><span className={`hidden items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium sm:flex ${cloudStatusTone}`}>{syncing ? <Loader2 className="size-3.5 animate-spin" /> : online ? <Check className="size-3.5" /> : <WifiOff className="size-3.5" />}{cloudStatus}</span><Button onClick={() => setDialogOpen(true)} className="h-11 rounded-xl bg-[#637f60] px-4 text-white shadow-[0_8px_24px_rgba(99,127,96,.22)] hover:bg-[#4d684a]"><Plus className="size-4" />新增记录</Button></div></header>
      <div className="px-4 py-5 md:px-8 lg:px-10 lg:py-9">
        {view === "overview" && <Overview loading={loading} month={selectedMonth} onMonthChange={setSelectedMonth} balance={balance} income={income} expense={expense} money={money} transactions={monthTransactions} amountFor={amountInDisplayCurrency} displayCurrency={currency} chartData={chartData} financePlan={financePlan} onEdit={setEditingTransaction} onDelete={handleDelete} onAdd={() => setDialogOpen(true)} />}
        {view === "transactions" && <TransactionsView transactions={activeTransactions} money={money} amountFor={amountInDisplayCurrency} displayCurrency={currency} dateFilter={transactionDateFilter} onClearDateFilter={() => setTransactionDateFilter(null)} onEdit={setEditingTransaction} onDelete={handleDelete} onAdd={() => setDialogOpen(true)} />}
        {view === "insights" && <InsightsView expense={expense} money={money} breakdown={expenseBreakdown} chartData={chartData} transactions={monthTransactions.map((item) => ({ ...item, amount: amountInDisplayCurrency(item) }))} month={selectedMonth} onMonthChange={setSelectedMonth} onViewDate={openTransactionsForDate} />}
        {view === "summary" && <SummaryView expense={expense} previousExpense={previousExpense} money={money} breakdown={expenseBreakdown} previousBreakdown={previousExpenseBreakdown} month={selectedMonth} onMonthChange={setSelectedMonth} />}
        {view === "settings" && <SettingsViewWithPlan currency={currency} financePlan={financePlan} savingPlan={savingPlan} onSavePlan={handleSavePlan} onCurrencyChange={changeCurrency} configured={isCloudConfigured()} signedInEmail={signedInEmail} syncing={syncing} syncMessage={syncMessage} email={authEmail} password={authPassword} authError={authError} passwordRecovery={passwordRecovery} newPassword={newPassword} confirmPassword={confirmPassword} onEmail={(value) => { setAuthEmail(value); setAuthError(""); }} onPassword={(value) => { setAuthPassword(value); setAuthError(""); }} onNewPassword={setNewPassword} onConfirmPassword={setConfirmPassword} onAuth={handleAuth} onForgotPassword={() => void handleForgotPassword()} onUpdatePassword={handleUpdatePassword} onSync={() => void handleSync(false)} onSignOut={() => void handleSignOut()} onExport={downloadBackup} />}
      </div>
    </main>
    <nav className="mobile-navigation fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-[#e7e5dc] bg-[#faf7f2]/95 px-3 pt-2 pb-[calc(.5rem+env(safe-area-inset-bottom))] backdrop-blur-xl lg:hidden" aria-label="移动端导航">{navItems.map((item) => { const Icon = item.icon; return <button key={item.id} onClick={() => changeView(item.id)} className={`flex min-h-12 min-w-0 flex-col items-center justify-center gap-1 rounded-2xl text-xs transition ${view === item.id ? "bg-[#e6eddf] text-[#4d684a]" : "text-[#737d6e]"}`}><Icon className="size-[18px]" />{item.label}</button>; })}</nav>
    <AddDialog key={defaultDateForMonth(selectedMonth)} open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setTransactionError(""); }} currency={currency} defaultDate={defaultDateForMonth(selectedMonth)} error={transactionError} saving={addingTransaction} onSubmit={handleAdd} />
    {editingTransaction && <EditDialog key={editingTransaction.id} transaction={editingTransaction} displayCurrency={currency} error={transactionError} open onOpenChange={(open) => { if (!open) { setEditingTransaction(null); setTransactionError(""); } }} onSubmit={handleEdit} />}
  </div>;
}

function Brand({ compact = false }: { compact?: boolean }) { return <div className="flex items-center gap-3"><span className={`${compact ? "size-9" : "size-10"} grid place-items-center rounded-[14px] bg-[#637f60] text-white shadow-[0_8px_22px_rgba(99,127,96,.35)]`}><Landmark className="size-5" /></span><div><div className="text-[17px] font-bold tracking-[-.03em]">Morrow</div>{!compact && <div className="text-xs text-slate-400">每日收支</div>}</div></div>; }
function NavButton({ label, icon: Icon, active, onClick }: { label: string; icon: typeof Home; active: boolean; onClick: () => void }) { return <button onClick={onClick} className={`flex h-12 w-full items-center gap-3 rounded-xl px-4 text-sm font-medium transition ${active ? "bg-[#637f60] text-white shadow-[0_10px_28px_rgba(99,127,96,.25)]" : "text-slate-400 hover:bg-white/[0.06] hover:text-white"}`}><Icon className="size-[18px]" />{label}</button>; }

function MonthNavigator({ month, onChange }: { month: string; onChange: (month: string) => void }) {
  const isCurrentMonth = month === monthKey();
  return <div className="flex flex-wrap items-center gap-2" aria-label="选择查看月份">
    <div className="flex items-center rounded-2xl border border-[#e7e5dc] bg-white p-1 shadow-[0_6px_20px_rgba(40,57,91,.06)]">
      <button type="button" onClick={() => onChange(shiftMonth(month, -1))} className="grid size-10 place-items-center rounded-xl text-[#66715f] transition hover:bg-[#edf2e8] hover:text-[#637f60]" aria-label="查看上一个月"><ChevronLeft className="size-5" /></button>
      <label className="relative flex h-10 min-w-[138px] cursor-pointer items-center justify-center gap-2 rounded-xl px-3 text-sm font-bold text-[#30392f] transition hover:bg-[#f7f5ef] focus-within:outline-2 focus-within:outline-[#637f60]"><CalendarClock className="size-4 text-[#637f60]" /><span>{formatMonth(month)}</span><input type="month" value={month} onChange={(event) => event.target.value && onChange(event.target.value)} className="absolute inset-0 cursor-pointer opacity-0" aria-label="直接选择月份" /></label>
      <button type="button" onClick={() => onChange(shiftMonth(month, 1))} className="grid size-10 place-items-center rounded-xl text-[#66715f] transition hover:bg-[#edf2e8] hover:text-[#637f60]" aria-label="查看下一个月"><ChevronRight className="size-5" /></button>
    </div>
    {!isCurrentMonth && <button type="button" onClick={() => onChange(monthKey())} className="h-10 rounded-xl px-3 text-sm font-semibold text-[#637f60] transition hover:bg-[#edf2e8]">回到本月</button>}
  </div>;
}

function Overview({ loading, month, onMonthChange, balance, income, expense, money, transactions, amountFor, displayCurrency, chartData, financePlan, onEdit, onDelete, onAdd }: { loading: boolean; month: string; onMonthChange: (month: string) => void; balance: number; income: number; expense: number; money: (n: number) => string; transactions: FinanceTransaction[]; amountFor: (transaction: FinanceTransaction) => number; displayCurrency: string; chartData: { month: string; income: number; expense: number }[]; financePlan: FinancePlan; onEdit: (transaction: FinanceTransaction) => void; onDelete: (id: string) => void; onAdd: () => void }) {
  const budgetProgress = financePlan.monthlyBudget ? Math.min(100, expense / financePlan.monthlyBudget * 100) : 0;
  const availableToSave = Math.max(0, balance);
  const savingsProgress = financePlan.monthlySavingsTarget ? Math.min(100, availableToSave / financePlan.monthlySavingsTarget * 100) : 0;
  return <>
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><p className="text-sm font-semibold uppercase tracking-[.12em] text-[#637f60]">{formatMonth(month)}概览</p><h1 className="mt-1 text-[clamp(1.8rem,4vw,2.6rem)] font-bold tracking-[-.045em] text-[#273329]">把日子记得清楚一点。</h1></div><MonthNavigator month={month} onChange={onMonthChange} /></div>
    <section className="overview-totals grid grid-cols-2 gap-3 md:grid-cols-3"><SummaryCard title="当月结余" value={balance} money={money} icon={WalletCards} tone="blue" period={formatMonth(month)} /><SummaryCard title="当月收入" value={income} money={money} icon={ArrowDownLeft} tone="green" period={formatMonth(month)} /><SummaryCard title="当月支出" value={expense} money={money} icon={ArrowUpRight} tone="rose" period={formatMonth(month)} /></section>
    {(financePlan.monthlyBudget > 0 || financePlan.monthlySavingsTarget > 0) && <section className="mt-5 grid gap-4 md:grid-cols-2">
      {financePlan.monthlyBudget > 0 && <PlanProgressCard icon={Target} title="月度预算" value={expense > financePlan.monthlyBudget ? `已超出 ${money(expense - financePlan.monthlyBudget)}` : `还可使用 ${money(financePlan.monthlyBudget - expense)}`} detail={`${money(expense)} / ${money(financePlan.monthlyBudget)}`} progress={budgetProgress} tone="blue" />}
      {financePlan.monthlySavingsTarget > 0 && <PlanProgressCard icon={PiggyBank} title="本月储蓄" value={availableToSave >= financePlan.monthlySavingsTarget ? "本月目标已达成" : `还差 ${money(financePlan.monthlySavingsTarget - availableToSave)}`} detail={`${money(availableToSave)} / ${money(financePlan.monthlySavingsTarget)}`} progress={savingsProgress} tone="green" />}
    </section>}
    <section className="mt-5 grid gap-5 xl:grid-cols-[1.35fr_.85fr]"><div className="surface-card p-5 md:p-6"><div className="mb-5 flex items-center justify-between"><div><h2 className="section-title">收支走势</h2><p className="section-subtitle">截至所选月份的六个月</p></div><span className="rounded-full bg-[#edf2e8] px-3 py-1.5 text-xs font-semibold text-[#637f60]">月度</span></div><div className="h-[245px]"><ResponsiveContainer width="100%" height="100%"><AreaChart data={chartData} margin={{ left: -25, right: 4, top: 10 }}><defs><linearGradient id="expenseFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#637f60" stopOpacity={0.25}/><stop offset="100%" stopColor="#637f60" stopOpacity={0}/></linearGradient></defs><CartesianGrid vertical={false} stroke="#f1eee7"/><XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fill: "#7e8176", fontSize: 12 }}/><Tooltip formatter={(value) => money(Number(value) * 100)} contentStyle={{ border: 0, borderRadius: 14, boxShadow: "0 14px 40px rgba(20,33,61,.12)" }}/><Area type="monotone" dataKey="expense" name="支出" stroke="#637f60" strokeWidth={3} fill="url(#expenseFill)" /></AreaChart></ResponsiveContainer></div></div><div className="surface-card overflow-hidden"><div className="flex items-center justify-between border-b border-[#f1eee7] px-5 py-5 md:px-6"><div><h2 className="section-title">当月记录</h2><p className="section-subtitle">按日期排序</p></div></div>{loading ? <div className="grid min-h-[250px] place-items-center"><Loader2 className="size-6 animate-spin text-[#637f60]" /></div> : <TransactionList transactions={transactions.slice(0, 5)} money={money} amountFor={amountFor} displayCurrency={displayCurrency} onEdit={onEdit} onDelete={onDelete} emptyAction={onAdd} />}</div></section>
  </>;
}

function PlanProgressCard({ icon: Icon, title, value, detail, progress, tone }: { icon: typeof Target; title: string; value: string; detail: string; progress: number; tone: "blue" | "green" }) {
  const colors = tone === "blue" ? { icon: "bg-[#fae9df] text-[#a85f45]", bar: "bg-[#dc9b80]" } : { icon: "bg-[#edf2e8] text-[#536f4f]", bar: "bg-[#718b70]" };
  return <div className="surface-card p-5 md:p-6"><div className="flex items-start justify-between gap-4"><div className="flex items-center gap-3"><span className={`grid size-10 place-items-center rounded-xl ${colors.icon}`}><Icon className="size-5" /></span><div><p className="text-sm font-semibold text-[#30392f]">{title}</p><p className="mt-0.5 text-xs text-[#7e8176]">{detail}</p></div></div><span className="text-xs font-semibold text-[#66715f]">{Math.round(progress)}%</span></div><p className="mt-5 text-lg font-bold tracking-[-.03em] text-[#30392f]">{value}</p><div className="mt-3 h-3 overflow-hidden rounded-full bg-[#f1eee7]"><div className={`h-full rounded-full transition-[width] ${colors.bar}`} style={{ width: `${progress}%` }} /></div></div>;
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

function SummaryCard({ title, value, money, icon: Icon, tone, period }: { title: string; value: number; money: (value: number) => string; icon: typeof WalletCards; tone: "blue" | "green" | "rose"; period: string }) { const colors = { blue: "bg-white text-[#30392f] border border-[#ece9e1] shadow-sm", green: "bg-white text-[#30392f]", rose: "bg-white text-[#30392f]" }; const iconColors = { blue: "bg-[#edf2e8] text-[#536f4f]", green: "bg-[#edf2e8] text-[#536f4f]", rose: "bg-[#fff0f2] text-[#d64b5e]" }; return <div className={`summary-tile summary-tile-${tone} rounded-[22px] p-5 md:p-6 ${colors[tone]} ${tone !== "blue" ? "border border-[#e9e7de] shadow-[0_10px_30px_rgba(40,57,91,.06)]" : ""}`}><div className="flex items-center justify-between"><span className={`grid size-10 place-items-center rounded-xl ${iconColors[tone]}`}><Icon className="size-5" /></span><span className={`text-xs font-medium ${tone === "blue" ? "text-[#737d6e]" : "text-[#7c8576]"}`}>{period}</span></div><p className={`mt-6 text-sm ${tone === "blue" ? "text-[#737d6e]" : "text-[#737d6e]"}`}>{title}</p><p className="mt-1 text-[clamp(1.45rem,3vw,2rem)] font-bold tracking-[-.04em]"><AnimatedCurrency value={value} money={money} /></p></div>; }

function TransactionsView({ transactions, money, amountFor, displayCurrency, dateFilter, onClearDateFilter, onEdit, onDelete, onAdd }: { transactions: FinanceTransaction[]; money: (n: number) => string; amountFor: (transaction: FinanceTransaction) => number; displayCurrency: string; dateFilter: string | null; onClearDateFilter: () => void; onEdit: (transaction: FinanceTransaction) => void; onDelete: (id: string) => void; onAdd: () => void }) {
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | TransactionType>("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [monthFilter, setMonthFilter] = useState("all");
  const categories = useMemo(() => [...new Set(transactions.map((item) => item.category))].sort((a, b) => a.localeCompare(b, "zh-CN")), [transactions]);
  const months = useMemo(() => [...new Set(transactions.map((item) => item.transactionDate.slice(0, 7)))].sort((a, b) => b.localeCompare(a)), [transactions]);
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visible = useMemo(() => transactions.filter((item) => {
    if (dateFilter && item.transactionDate !== dateFilter) return false;
    if (typeFilter !== "all" && item.type !== typeFilter) return false;
    if (categoryFilter !== "all" && item.category !== categoryFilter) return false;
    if (monthFilter !== "all" && !item.transactionDate.startsWith(monthFilter)) return false;
    if (!normalizedQuery) return true;
    const searchable = `${item.note} ${item.category} ${item.subcategory ?? ""} ${item.amount / 100}`.toLocaleLowerCase("zh-CN");
    return searchable.includes(normalizedQuery);
  }), [transactions, dateFilter, typeFilter, categoryFilter, monthFilter, normalizedQuery]);
  const hasFilters = Boolean(dateFilter || normalizedQuery || typeFilter !== "all" || categoryFilter !== "all" || monthFilter !== "all");
  const dateFilterLabel = dateFilter ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(new Date(`${dateFilter}T12:00:00`)) : "";
  function clearFilters() {
    onClearDateFilter();
    setQuery("");
    setTypeFilter("all");
    setCategoryFilter("all");
    setMonthFilter("all");
  }
  return <div className="mx-auto max-w-4xl">
    <div className="mb-6"><p className="eyebrow">交易明细</p><h1 className="page-title">明细</h1></div>
    <section className="surface-card mb-5 p-4 md:p-5" aria-label="搜索与筛选记录">
      {dateFilter && <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-[#faf4ee] px-4 py-3 text-sm"><div><span className="font-semibold text-[#9a4d08]">{dateFilterLabel}</span><span className="ml-2 text-[#9b6b3c]">当天的全部收支</span></div><button type="button" onClick={onClearDateFilter} className="rounded-lg px-3 py-1.5 font-semibold text-[#b45309] transition hover:bg-[#f8e5d9]">查看全部日期</button></div>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-[minmax(220px,1fr)_140px_150px_160px]">
        <div className="relative col-span-2 md:col-span-1"><Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[#7e8176]" /><Label htmlFor="transaction-search" className="sr-only">搜索记录</Label><Input id="transaction-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索备注、分类、子分类或金额" className="h-11 rounded-xl bg-white pl-10" /></div>
        <NativeSelect aria-label="按收支类型筛选" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as typeof typeFilter)} className="h-11 rounded-xl bg-white"><NativeSelectOption value="all">全部类型</NativeSelectOption><NativeSelectOption value="expense">支出</NativeSelectOption><NativeSelectOption value="income">收入</NativeSelectOption></NativeSelect>
        <NativeSelect aria-label="按分类筛选" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)} className="h-11 rounded-xl bg-white"><NativeSelectOption value="all">全部分类</NativeSelectOption>{categories.map((category) => <NativeSelectOption key={category} value={category}>{category}</NativeSelectOption>)}</NativeSelect>
        <NativeSelect aria-label="按月份筛选" value={monthFilter} onChange={(event) => setMonthFilter(event.target.value)} className="col-span-2 h-11 rounded-xl bg-white md:col-span-1"><NativeSelectOption value="all">全部月份</NativeSelectOption>{months.map((month) => <NativeSelectOption key={month} value={month}>{new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(new Date(`${month}-01T12:00:00`))}</NativeSelectOption>)}</NativeSelect>
      </div>
      <div className="mt-3 flex min-h-8 items-center justify-between gap-3"><p className="text-sm text-[#72796e]">{hasFilters ? `找到 ${visible.length} 条记录` : `共 ${transactions.length} 条记录`}</p>{hasFilters && <button type="button" onClick={clearFilters} className="rounded-lg px-3 py-1.5 text-sm font-semibold text-[#637f60] transition hover:bg-[#edf2e8]">清除筛选</button>}</div>
    </section>
    <div className="surface-card overflow-hidden">{visible.length || !transactions.length ? <TransactionList transactions={visible} money={money} amountFor={amountFor} displayCurrency={displayCurrency} onEdit={onEdit} onDelete={onDelete} emptyAction={onAdd} /> : <div className="grid min-h-[300px] place-items-center px-6 text-center"><div><span className="mx-auto grid size-14 place-items-center rounded-2xl bg-[#edf2e8] text-[#637f60]"><SearchX className="size-6" /></span><h3 className="mt-4 font-semibold">没有找到符合条件的记录</h3><p className="mt-1 text-sm text-[#76816e]">试试其他关键词或筛选条件。</p><Button onClick={clearFilters} variant="outline" className="mt-5 rounded-xl bg-white">清除筛选</Button></div></div>}</div>
  </div>;
}
function TransactionList({ transactions, money, amountFor, displayCurrency, onEdit, onDelete, emptyAction }: { transactions: FinanceTransaction[]; money: (n: number) => string; amountFor: (transaction: FinanceTransaction) => number; displayCurrency: string; onEdit: (transaction: FinanceTransaction) => void; onDelete: (id: string) => void; emptyAction: () => void }) { if (!transactions.length) return <div className="grid min-h-[320px] place-items-center px-6 text-center"><div><span className="mx-auto grid size-14 place-items-center rounded-2xl bg-[#edf2e8] text-[#637f60]"><ReceiptText className="size-6" /></span><h3 className="mt-4 font-semibold">还没有记录</h3><p className="mt-1 text-sm text-[#76816e]">从今天的第一笔收支开始。</p><Button onClick={emptyAction} className="mt-5 rounded-xl bg-[#637f60]">添加第一笔</Button></div></div>; return <div className="divide-y divide-[#f1eee7]">{transactions.map((item) => <div key={item.id} className="group flex items-center gap-2 px-4 py-4 transition hover:bg-[#faf8f3] md:gap-3 md:px-6"><span className="grid size-11 shrink-0 place-items-center rounded-[14px] text-lg" style={{ backgroundColor: `${categoryColors[item.category] ?? "#aaa99c"}18` }}>{categoryEmoji[item.category] ?? "•"}</span><div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold text-[#30392f]">{item.note || item.subcategory || item.category}</div><div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#81877b]"><span>{item.category}{item.subcategory ? ` · ${item.subcategory}` : ""}</span><span>·</span><time>{new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(`${item.transactionDate}T12:00:00`))}</time>{item.currency !== displayCurrency && <span>{item.currency} {(item.amount / 100).toFixed(2)}</span>}{item.syncStatus !== "synced" && <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${item.syncStatus === "error" ? "bg-[#fff0f1] text-[#b64251]" : "bg-[#fff5dc] text-[#9b6b00]"}`}>{item.syncStatus === "error" ? "同步失败" : "待同步"}</span>}</div></div><div className={`text-sm font-bold tabular-nums ${item.type === "income" ? "text-[#536f4f]" : "text-[#30392f]"}`}>{item.type === "income" ? "+" : "−"}{money(amountFor(item))}</div><div className="flex shrink-0"><button onClick={() => onEdit(item)} className="grid size-9 place-items-center rounded-lg text-[#7c8576] transition hover:bg-[#edf2e8] hover:text-[#637f60] md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100" aria-label={`编辑${item.note || item.category}`}><Pencil className="size-4" /></button><button onClick={() => onDelete(item.id)} className="grid size-9 place-items-center rounded-lg text-[#949b8c] transition hover:bg-[#fff0f2] hover:text-[#d64b5e] md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100" aria-label={`删除${item.note || item.category}`}><Trash2 className="size-4" /></button></div></div>)}</div>; }

function ExpenseHeatmap({ transactions, month, money, onViewDate }: { transactions: FinanceTransaction[]; month: string; money: (value: number) => string; onViewDate: (date: string) => void }) {
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
  const colors = ["#faf4ee", "#f8e5d9", "#efc3b0", "#df9a7e", "#ad6349"];

  return <section className="surface-card p-5 md:p-6" aria-labelledby="expense-calendar-title">
    <div className="flex items-start justify-between gap-4"><div><h2 id="expense-calendar-title" className="section-title">消费日历</h2><p className="section-subtitle">颜色越深，当天支出越高</p></div><span className="rounded-full bg-[#fff3df] px-3 py-1.5 text-xs font-semibold text-[#b45309]">{monthLabel}</span></div>
    <div className="mt-6 grid grid-cols-7 gap-1.5 text-center text-xs text-[#7e8176]" aria-hidden="true">{["日", "一", "二", "三", "四", "五", "六"].map((day) => <span key={day}>{day}</span>)}</div>
    <div className="mt-2 grid grid-cols-7 gap-1.5" role="group" aria-label={`${monthLabel}每日支出`}>
      {Array.from({ length: firstWeekday }, (_, index) => <span key={`blank-${index}`} aria-hidden="true" />)}
      {dailyTotals.map((total, index) => {
        const day = index + 1;
        const level = total === 0 || maximum === 0 ? 0 : Math.min(4, Math.ceil(total / maximum * 4));
        const selected = activeDay === day;
        return <button key={day} type="button" onClick={() => setSelectedDay(day)} aria-label={`${monthNumber}月${day}日，支出${money(total)}`} aria-pressed={selected} className={`aspect-square min-w-0 rounded-[9px] text-xs font-semibold transition hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ad6349] ${level >= 4 ? "text-white" : "text-[#68421f]"} ${selected ? "ring-2 ring-[#ad6349] ring-offset-2" : ""}`} style={{ backgroundColor: colors[level] }}>{day}</button>;
      })}
    </div>
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm"><div><p className="font-semibold text-[#30392f]" aria-live="polite">{activeDay ? `${monthNumber}月${activeDay}日 · 支出 ${money(dailyTotals[activeDay - 1])}` : "本月还没有支出记录"}</p>{activeDay && <button type="button" onClick={() => onViewDate(`${month}-${String(activeDay).padStart(2, "0")}`)} className="mt-2 inline-flex min-h-10 items-center gap-1 rounded-xl bg-[#fff3df] px-3.5 py-2 text-sm font-semibold text-[#a6530a] transition hover:bg-[#ffead0] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ad6349]">查看当天明细<ChevronRight className="size-4" /></button>}</div><div className="flex items-center gap-1.5 text-xs text-[#7e8176]"><span>少</span>{[0, 2, 4].map((level) => <span key={level} className="size-4 rounded-[5px]" style={{ backgroundColor: colors[level] }} />)}<span>多</span></div></div>
  </section>;
}

function MonthlySummary({ month, expense, previousExpense, breakdown, previousBreakdown, money }: { month: string; expense: number; previousExpense: number; breakdown: [string, number][]; previousBreakdown: [string, number][]; money: (value: number) => string }) {
  const delta = expense - previousExpense;
  const percentage = previousExpense > 0 ? Math.round(Math.abs(delta) / previousExpense * 100) : null;
  const topCategory = breakdown[0];
  const currentByCategory = new Map(breakdown);
  const previousByCategory = new Map(previousBreakdown);
  const categoryComparison = [...new Set([...currentByCategory.keys(), ...previousByCategory.keys()])]
    .map((category) => ({ category, current: currentByCategory.get(category) ?? 0, previous: previousByCategory.get(category) ?? 0 }))
    .sort((a, b) => b.current - a.current || b.previous - a.previous);
  const comparisonTitle = delta > 0 ? `比上月多花 ${money(delta)}` : delta < 0 ? `比上月少花 ${money(Math.abs(delta))}` : expense ? "与上月支出持平" : "当月还没有支出";
  const comparisonDetail = previousExpense === 0 ? (expense ? "上月没有支出记录" : "上月也没有支出记录") : delta === 0 ? `上月同样支出 ${money(previousExpense)}` : `${delta > 0 ? "增加" : "减少"} ${percentage}%`;

  return <section className="surface-card overflow-hidden" aria-labelledby="monthly-summary-title">
    <div className="summary-hero bg-[#f8e7de] p-5 text-[#30392f] md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[.14em] text-[#8e6553]">月度总结</p><h2 id="monthly-summary-title" className="mt-1 text-xl font-bold tracking-[-.03em]">{formatMonth(month)}消费表现</h2></div><span className={`rounded-full px-3 py-1.5 text-xs font-semibold ${delta > 0 ? "bg-[#fff0f2] text-[#c74458]" : delta < 0 ? "bg-[#edf2e8] text-[#536f4f]" : "bg-white/60 text-[#66715f]"}`}>{comparisonTitle}</span></div>
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div><p className="text-sm text-[#72796e]">当月支出</p><p className="mt-1 text-2xl font-bold tracking-[-.04em]"><AnimatedCurrency value={expense} money={money} /></p></div>
        <div><p className="text-sm text-[#72796e]">较上月</p><p className={`mt-1 text-lg font-bold ${delta > 0 ? "text-[#aa5844]" : delta < 0 ? "text-[#536f4f]" : "text-white"}`}>{delta === 0 ? "没有变化" : `${delta > 0 ? "+" : "−"}${money(Math.abs(delta))}`}</p><p className="mt-1 text-xs text-slate-400">{comparisonDetail}</p></div>
        <div><p className="text-sm text-[#72796e]">最大消费分类</p><p className="mt-1 text-lg font-bold">{topCategory ? `${categoryEmoji[topCategory[0]] ?? "•"} ${topCategory[0]}` : "暂无记录"}</p><p className="mt-1 text-xs text-slate-400">{topCategory ? `${money(topCategory[1])} · 占 ${Math.round(topCategory[1] / expense * 100)}%` : `上月支出 ${money(previousExpense)}`}</p></div>
      </div>
    </div>
    <div className="p-5 md:p-6"><div className="flex items-end justify-between gap-3"><div><h3 className="section-title">钱花在哪里</h3><p className="section-subtitle">各分类与 {formatMonth(shiftMonth(month, -1))} 对比</p></div></div>
      {categoryComparison.length ? <div className="mt-5 grid gap-3 md:grid-cols-2">{categoryComparison.map(({ category, current, previous }) => {
        const categoryDelta = current - previous;
        const changeLabel = previous === 0 && current > 0 ? "本月新增" : categoryDelta > 0 ? `较上月多 ${money(categoryDelta)}` : categoryDelta < 0 ? `较上月少 ${money(Math.abs(categoryDelta))}` : "与上月相同";
        return <div key={category} className="rounded-2xl border border-[#e9e6dc] bg-[#faf9f5] p-4"><div className="flex items-center gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-xl text-lg" style={{ backgroundColor: `${categoryColors[category] ?? "#aaa99c"}18` }}>{categoryEmoji[category] ?? "•"}</span><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-3"><p className="font-semibold text-[#30392f]">{category}</p><p className="shrink-0 font-bold tabular-nums text-[#30392f]">{money(current)}</p></div><p className={`mt-1 text-xs font-medium ${categoryDelta > 0 ? "text-[#c74458]" : categoryDelta < 0 ? "text-[#536f4f]" : "text-[#7e8176]"}`}>{changeLabel}</p></div></div><div className="mt-4 space-y-2">{[{ label: "上月", amount: previous, color: "#d5d3c9" }, { label: "本月", amount: current, color: "#dc9b80" }].map((bar) => <div key={bar.label} className="flex items-center gap-2 text-[11px] text-[#66715f]"><span className="w-6 shrink-0">{bar.label}</span><div className="h-2 flex-1 overflow-hidden rounded-full bg-[#f1eee7]"><div className="h-full rounded-full" style={{ width: `${Math.max(current, previous) ? bar.amount / Math.max(current, previous) * 100 : 0}%`, backgroundColor: bar.color }} /></div><span className="w-20 shrink-0 text-right tabular-nums">{money(bar.amount)}</span></div>)}</div></div>;
      })}</div> : <p className="py-10 text-center text-sm text-[#81877b]">这个月和上个月都还没有支出记录。</p>}
    </div>
  </section>;
}

function SummaryView({ expense, previousExpense, money, breakdown, previousBreakdown, month, onMonthChange }: { expense: number; previousExpense: number; money: (n: number) => string; breakdown: [string, number][]; previousBreakdown: [string, number][]; month: string; onMonthChange: (month: string) => void }) {
  return <div className="mx-auto max-w-5xl"><div className="mb-6 flex flex-wrap items-end justify-between gap-4"><div><p className="eyebrow">月度回顾</p><h1 className="page-title">总结</h1></div><MonthNavigator month={month} onChange={onMonthChange} /></div><MonthlySummary month={month} expense={expense} previousExpense={previousExpense} breakdown={breakdown} previousBreakdown={previousBreakdown} money={money} /></div>;
}

function InsightsView({ expense, money, breakdown, chartData, transactions, month, onMonthChange, onViewDate }: { expense: number; money: (n: number) => string; breakdown: [string, number][]; chartData: { month: string; income: number; expense: number }[]; transactions: FinanceTransaction[]; month: string; onMonthChange: (month: string) => void; onViewDate: (date: string) => void }) {
  return <div className="mx-auto max-w-5xl"><div className="mb-6 flex flex-wrap items-end justify-between gap-4"><div><p className="eyebrow">{formatMonth(month)}支出分析</p><h1 className="page-title">分析</h1></div><MonthNavigator month={month} onChange={onMonthChange} /></div><ExpenseHeatmap key={month} transactions={transactions} month={month} money={money} onViewDate={onViewDate} /><div className="mt-5 grid gap-5 md:grid-cols-[.8fr_1.2fr]"><div className="surface-card p-6"><p className="section-subtitle">当月总支出</p><p className="mt-2 text-3xl font-bold tracking-[-.04em]"><AnimatedCurrency value={expense} money={money} /></p><h2 className="section-title mt-5">钱花在哪里</h2><div className="mt-4 flex h-4 overflow-hidden rounded-full bg-[#f1eee7]" aria-label="分类支出占比">{breakdown.map(([category, value]) => <span key={category} title={`${category} ${Math.round(value / expense * 100)}%`} style={{ width: `${expense ? value / expense * 100 : 0}%`, backgroundColor: categoryColors[category] ?? "#aaa99c" }} />)}</div><div className="mt-6 space-y-5">{breakdown.length ? breakdown.map(([category, value]) => <div key={category}><div className="mb-2 flex items-center justify-between text-sm"><span className="font-medium">{category}</span><span className="text-[#737d6e]">{money(value)}</span></div><div className="h-2 overflow-hidden rounded-full bg-[#f1eee7]"><div className="h-full rounded-full" style={{ width: `${expense ? Math.max(6, value / expense * 100) : 0}%`, backgroundColor: categoryColors[category] ?? "#aaa99c" }} /></div></div>) : <p className="py-16 text-center text-sm text-[#81877b]">添加支出后，这里会显示分类占比。</p>}</div></div><div className="surface-card p-6"><h2 className="section-title">收入与支出</h2><p className="section-subtitle">截至所选月份的六个月</p><div className="mt-6 h-[330px]"><ResponsiveContainer width="100%" height="100%"><AreaChart data={chartData} margin={{ left: -20, right: 5 }}><CartesianGrid vertical={false} stroke="#f1eee7"/><XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fill: "#7e8176", fontSize: 12 }}/><Tooltip contentStyle={{ border: 0, borderRadius: 14, boxShadow: "0 14px 40px rgba(20,33,61,.12)" }}/><Area type="monotone" dataKey="income" name="收入" stroke="#718b70" fill="#718b7014" strokeWidth={2.5}/><Area type="monotone" dataKey="expense" name="支出" stroke="#637f60" fill="#637f6014" strokeWidth={2.5}/></AreaChart></ResponsiveContainer></div></div></div></div>;
}

function SettingsView(props: SettingsViewWithPlanProps) { const { currency, onCurrencyChange, configured, syncMessage, onExport } = props; return <div className="mx-auto max-w-3xl"><div className="mb-6"><p className="eyebrow">偏好与备份</p><h1 className="page-title">设置</h1></div><div className="space-y-5"><section className="surface-card p-5 md:p-6"><div className="flex items-center justify-between gap-5"><div><h2 className="section-title">默认显示货币</h2><p className="section-subtitle">概览、分析与总结会统一换算为此货币</p></div><NativeSelect value={currency} onChange={(e) => onCurrencyChange(e.target.value)} className="w-32"><CurrencyOptions /></NativeSelect></div></section><section className="surface-card p-5 md:p-6"><div className="mb-5 flex items-start justify-between gap-4"><div><h2 className="section-title">云端同步</h2><p className="section-subtitle">本地记录优先，登录后备份至 Supabase</p></div><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${configured ? "bg-[#edf2e8] text-[#536f4f]" : "bg-[#fff5dc] text-[#936700]"}`}>{configured ? "已配置" : "待配置"}</span></div><AuthSettings {...props} />{syncMessage && <p aria-live="polite" className="mt-4 text-sm text-[#66715f]">{syncMessage}</p>}</section><section className="surface-card p-5 md:p-6"><div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="section-title">本地备份</h2><p className="section-subtitle">下载包含所有记录的 JSON 文件</p></div><Button onClick={onExport} variant="outline" className="rounded-xl"><Download />导出备份</Button></div></section></div></div>; }

type AuthSettingsProps = Pick<SettingsViewWithPlanProps, "configured" | "signedInEmail" | "syncing" | "email" | "password" | "authError" | "passwordRecovery" | "newPassword" | "confirmPassword" | "onEmail" | "onPassword" | "onNewPassword" | "onConfirmPassword" | "onAuth" | "onForgotPassword" | "onUpdatePassword" | "onSync" | "onSignOut">;

function AuthSettings({ configured, signedInEmail, syncing, email, password, authError, passwordRecovery, newPassword, confirmPassword, onEmail, onPassword, onNewPassword, onConfirmPassword, onAuth, onForgotPassword, onUpdatePassword, onSync, onSignOut }: AuthSettingsProps) {
  if (passwordRecovery) return <form onSubmit={onUpdatePassword} className="grid gap-4 md:grid-cols-2"><div className="rounded-2xl bg-[#edf2e8] p-4 md:col-span-2"><p className="text-sm font-semibold text-[#4d684a]">设置新密码</p><p className="mt-1 text-xs leading-5 text-[#66715f]">恢复链接已验证。更新密码不会删除这部手机里的任何本地记录。</p></div><div className="space-y-2"><Label htmlFor="new-password">新密码</Label><Input id="new-password" type="password" minLength={8} value={newPassword} onChange={(event) => onNewPassword(event.target.value)} autoComplete="new-password" placeholder="至少 8 位" required /></div><div className="space-y-2"><Label htmlFor="confirm-password">确认新密码</Label><Input id="confirm-password" type="password" minLength={8} value={confirmPassword} onChange={(event) => onConfirmPassword(event.target.value)} autoComplete="new-password" placeholder="再次输入新密码" required /></div><Button type="submit" disabled={syncing || !configured} className="rounded-xl bg-[#637f60] md:col-span-2">{syncing ? <Loader2 className="animate-spin" /> : <Cloud />}保存新密码</Button></form>;
  if (signedInEmail) return <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-[#f5f4ed] p-4"><div className="min-w-0"><p className="truncate text-sm font-semibold">{signedInEmail}</p><p className="mt-1 text-xs leading-5 text-[#76816e]">账号已连接 · 退出不会删除本机记录</p></div><div className="flex w-full flex-wrap gap-2 sm:w-auto"><Button onClick={onSync} disabled={syncing} variant="outline" className="flex-1 rounded-xl bg-white sm:flex-none">{syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}立即同步</Button><Button onClick={onSignOut} disabled={syncing} variant="ghost" className="flex-1 rounded-xl text-[#76816e] hover:bg-[#fff0f2] hover:text-[#c64b5d] sm:flex-none"><LogOut />退出账号</Button></div></div>;
  return <form onSubmit={onAuth} className="grid gap-4 md:grid-cols-2"><div className="space-y-2"><Label htmlFor="email">邮箱</Label><Input id="email" type="email" value={email} onChange={(event) => onEmail(event.target.value)} autoComplete="email" placeholder="name@example.com" required /></div><div className="space-y-2"><Label htmlFor="password">密码</Label><Input id="password" type="password" minLength={8} value={password} onChange={(event) => onPassword(event.target.value)} autoComplete="current-password" placeholder="至少 8 位" required aria-invalid={Boolean(authError)} aria-describedby={authError ? "auth-password-error" : undefined} className={authError ? "border-[#d84f62] focus-visible:border-[#d84f62] focus-visible:ring-[#d84f62]/20" : ""} />{authError && <p id="auth-password-error" role="alert" className="text-xs font-medium leading-5 text-[#c74458]">{authError}</p>}</div><div className="-mt-1 flex justify-end md:col-span-2"><button type="button" onClick={onForgotPassword} disabled={syncing || !configured} className="text-sm font-semibold text-[#637f60] transition hover:text-[#4d684a] disabled:cursor-not-allowed disabled:opacity-50">忘记密码？</button></div><Button type="submit" disabled={syncing || !configured} className="rounded-xl bg-[#637f60] md:col-span-2">{syncing ? <Loader2 className="animate-spin" /> : <Cloud />}登录或创建账号</Button></form>;
}

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
  authError: string;
  passwordRecovery: boolean;
  newPassword: string;
  confirmPassword: string;
  onEmail: (value: string) => void;
  onPassword: (value: string) => void;
  onNewPassword: (value: string) => void;
  onConfirmPassword: (value: string) => void;
  onAuth: (event: FormEvent<HTMLFormElement>) => void;
  onForgotPassword: () => void;
  onUpdatePassword: (event: FormEvent<HTMLFormElement>) => void;
  onSync: () => void;
  onSignOut: () => void;
  onExport: () => void;
};

function SettingsViewWithPlan({ financePlan, savingPlan, onSavePlan, ...settingsProps }: SettingsViewWithPlanProps) {
  return <>
    <SettingsView {...settingsProps} financePlan={financePlan} savingPlan={savingPlan} onSavePlan={onSavePlan} />
    <details className="surface-card mx-auto mt-5 max-w-3xl"><summary className="cursor-pointer px-5 py-5 font-semibold text-[#30392f]">月度预算、储蓄与固定收支 <span className="ml-2 text-xs font-normal text-[#66715f]">点击展开设置</span></summary><PlanSettings key={financePlan.updatedAt || "empty"} plan={financePlan} currency={settingsProps.currency} saving={savingPlan} onSave={onSavePlan} /></details>
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
    <div className="border-b border-[#f1eee7] px-5 py-5 md:px-6"><div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-[#edf2e8] text-[#637f60]"><CalendarClock className="size-5" /></span><div><h2 className="section-title">月度计划与固定收支</h2><p className="section-subtitle">到达设定日期时，固定项目会自动记入当月</p></div></div></div>
    <form onSubmit={submitPlan} className="space-y-6 p-5 md:p-6">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2"><Label htmlFor="monthly-budget">每月预算</Label><div className="relative"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-[#76816e]">{currency}</span><Input id="monthly-budget" value={budget} onChange={(event) => setBudget(event.target.value)} type="number" inputMode="decimal" step="0.01" min="0" placeholder="0.00" className="h-11 rounded-xl pl-12" /></div></div>
        <div className="space-y-2"><Label htmlFor="monthly-savings">每月储蓄目标</Label><div className="relative"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-[#76816e]">{currency}</span><Input id="monthly-savings" value={savings} onChange={(event) => setSavings(event.target.value)} type="number" inputMode="decimal" step="0.01" min="0" placeholder="0.00" className="h-11 rounded-xl pl-12" /></div><p className="text-xs leading-5 text-[#7e8176]">储蓄目标用于追踪，不会被记为支出。</p></div>
      </div>

      <div className="rounded-2xl bg-[#f5f4ed] p-4 md:p-5">
        <div className="mb-4"><h3 className="text-sm font-semibold text-[#30392f]">添加固定项目</h3><p className="mt-1 text-xs text-[#7e8176]">例如每月工资、房租、保险或订阅。</p></div>
        <div className="grid gap-3 md:grid-cols-2">
          <NativeSelect value={ruleType} onChange={(event) => changeRuleType(event.target.value as TransactionType)} className="h-11 rounded-xl bg-white"><NativeSelectOption value="expense">固定支出</NativeSelectOption><NativeSelectOption value="income">固定收入</NativeSelectOption></NativeSelect>
          <div className="relative"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-[#76816e]">{currency}</span><Input value={ruleAmount} onChange={(event) => setRuleAmount(event.target.value)} type="number" inputMode="decimal" step="0.01" min="0.01" placeholder="金额" className="h-11 rounded-xl bg-white pl-12" /></div>
          <NativeSelect value={ruleCategory} onChange={(event) => setRuleCategory(event.target.value)} className="h-11 rounded-xl bg-white">{categories.map((category) => <NativeSelectOption key={category} value={category}>{category}</NativeSelectOption>)}</NativeSelect>
          <Input value={ruleNote} onChange={(event) => setRuleNote(event.target.value)} placeholder="名称，例如房租" className="h-11 rounded-xl bg-white" />
          <div className="flex items-center gap-3"><Label htmlFor="recurring-day" className="shrink-0">每月</Label><Input id="recurring-day" value={ruleDay} onChange={(event) => setRuleDay(event.target.value)} type="number" inputMode="numeric" min="1" max="31" className="h-11 rounded-xl bg-white" /><span className="shrink-0 text-sm text-[#66715f]">日</span></div>
          <Button type="button" onClick={addRule} variant="outline" className="h-11 rounded-xl bg-white"><Plus />加入固定项目</Button>
        </div>
      </div>

      {rules.length > 0 && <div className="space-y-2">{rules.map((rule) => <div key={rule.id} className="flex items-center gap-3 rounded-2xl border border-[#e9e7de] p-3"><span className={`grid size-10 shrink-0 place-items-center rounded-xl ${rule.type === "income" ? "bg-[#edf2e8] text-[#536f4f]" : "bg-[#fff0f2] text-[#d64b5e]"}`}>{rule.type === "income" ? <ArrowDownLeft className="size-5" /> : <ArrowUpRight className="size-5" />}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-[#30392f]">{rule.note}</p><p className="mt-0.5 text-xs text-[#7e8176]">每月 {rule.day} 日 · {rule.category}</p></div><p className={`shrink-0 text-sm font-bold ${rule.type === "income" ? "text-[#536f4f]" : "text-[#30392f]"}`}>{rule.type === "income" ? "+" : "−"}{new Intl.NumberFormat("zh-CN", { style: "currency", currency: rule.currency }).format(rule.amount / 100)}</p><button type="button" onClick={() => setRules((current) => current.filter((item) => item.id !== rule.id))} className="grid size-9 shrink-0 place-items-center rounded-lg text-[#949b8c] hover:bg-[#fff0f2] hover:text-[#d64b5e]" aria-label={`删除固定项目${rule.note}`}><Trash2 className="size-4" /></button></div>)}</div>}

      <Button type="submit" disabled={saving} className="h-11 w-full rounded-xl bg-[#637f60]">{saving ? <Loader2 className="animate-spin" /> : <PiggyBank />}保存月度计划</Button>
    </form>
  </section>;
}

function CurrencyOptions() { return <>{supportedCurrencies.map((code) => <NativeSelectOption key={code} value={code}>{currencyLabels[code]}</NativeSelectOption>)}</>; }

function EditDialog({ transaction, displayCurrency, error, open, onOpenChange, onSubmit }: { transaction: FinanceTransaction; displayCurrency: string; error: string; open: boolean; onOpenChange: (open: boolean) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const [type, setType] = useState<TransactionType>(transaction.type);
  const [category, setCategory] = useState(transaction.category);
  const [subcategory, setSubcategory] = useState(transaction.subcategory ?? sugarSubcategories[0]);
  const categories = type === "expense" ? expenseCategories : incomeCategories;
  function changeType(next: TransactionType) {
    setType(next);
    const nextCategories = next === "expense" ? expenseCategories : incomeCategories;
    if (!nextCategories.includes(category)) {
      setCategory(nextCategories[0]);
      setSubcategory(sugarSubcategories[0]);
    }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-[24px] border-0 p-0 shadow-[0_28px_90px_rgba(13,25,48,.28)] sm:max-w-[470px]"><form onSubmit={onSubmit}><DialogHeader className="border-b border-[#f1eee7] px-5 py-5 text-left sm:px-6"><DialogTitle className="text-xl tracking-[-.03em]">编辑记录</DialogTitle><DialogDescription>修改后会立即更新本机数据，并在联网后同步。</DialogDescription></DialogHeader><div className="space-y-4 px-5 py-5 sm:px-6"><div className="grid grid-cols-2 rounded-xl bg-[#eef2f8] p-1"><button type="button" onClick={() => changeType("expense")} className={`h-10 rounded-lg text-sm font-semibold transition ${type === "expense" ? "bg-white text-[#30392f] shadow-sm" : "text-[#7a879b]"}`}>支出</button><button type="button" onClick={() => changeType("income")} className={`h-10 rounded-lg text-sm font-semibold transition ${type === "income" ? "bg-white text-[#536f4f] shadow-sm" : "text-[#7a879b]"}`}>收入</button></div><input type="hidden" name="type" value={type}/><div className="grid grid-cols-[130px_minmax(0,1fr)] gap-3"><div className="min-w-0 space-y-2"><Label htmlFor="edit-currency">货币</Label><NativeSelect id="edit-currency" name="currency" defaultValue={transaction.currency} className="h-14 w-full rounded-xl"><CurrencyOptions /></NativeSelect></div><div className="min-w-0 space-y-2"><Label htmlFor="edit-amount">金额</Label><Input id="edit-amount" name="amount" type="number" inputMode="decimal" step="0.01" min="0.01" required defaultValue={transaction.amount / 100} className="h-14 min-w-0 rounded-xl text-xl font-bold" autoFocus /></div></div><p className="-mt-2 text-xs leading-5 text-[#7e8176]">与 {displayCurrency} 不同时，会按记录日期的汇率自动换算。</p><div className={`grid gap-4 ${category === "糖分" ? "grid-cols-2" : "sm:grid-cols-2"}`}><div className="min-w-0 space-y-2"><Label htmlFor="edit-category">分类</Label><NativeSelect id="edit-category" name="category" value={category} onChange={(event) => { setCategory(event.target.value); if (event.target.value !== "糖分") setSubcategory(sugarSubcategories[0]); }} className="h-11 w-full rounded-xl">{categories.map((item) => <NativeSelectOption key={item} value={item}>{item}</NativeSelectOption>)}</NativeSelect></div>{category === "糖分" && <div className="min-w-0 space-y-2"><Label htmlFor="edit-subcategory">糖分类型</Label><NativeSelect id="edit-subcategory" name="subcategory" value={subcategory} onChange={(event) => setSubcategory(event.target.value)} required className="h-11 w-full rounded-xl">{sugarSubcategories.map((item) => <NativeSelectOption key={item} value={item}>{item}</NativeSelectOption>)}</NativeSelect></div>}<div className={`min-w-0 space-y-2 ${category === "糖分" ? "col-span-2" : ""}`}><Label htmlFor="edit-date">日期</Label><Input id="edit-date" name="date" type="date" defaultValue={transaction.transactionDate} required className="block h-11 w-full min-w-0 rounded-xl" /></div></div><div className="space-y-2"><Label htmlFor="edit-note">备注</Label><Input id="edit-note" name="note" defaultValue={transaction.note} placeholder={type === "expense" ? "例如：午餐" : "例如：九月工资"} className="h-11 rounded-xl" /></div>{error && <p role="alert" className="rounded-xl bg-[#fff0f1] px-3 py-2 text-sm text-[#b64251]">{error}</p>}</div><DialogFooter className="grid grid-cols-2 gap-3 border-t border-[#f1eee7] px-5 py-4 sm:flex sm:px-6"><Button type="button" variant="ghost" onClick={() => onOpenChange(false)} className="h-11 rounded-xl">取消</Button><Button type="submit" className="h-11 rounded-xl bg-[#637f60] px-7"><Pencil />保存修改</Button></DialogFooter></form></DialogContent></Dialog>;
}

function AddDialog({ open, onOpenChange, currency, defaultDate, error, saving, onSubmit }: { open: boolean; onOpenChange: (open: boolean) => void; currency: string; defaultDate: string; error: string; saving: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const [type, setType] = useState<TransactionType>("expense");
  const [category, setCategory] = useState(expenseCategories[0]);
  const [subcategory, setSubcategory] = useState(sugarSubcategories[0]);
  const categories = type === "expense" ? expenseCategories : incomeCategories;
  function changeType(next: TransactionType) {
    setType(next);
    setCategory((next === "expense" ? expenseCategories : incomeCategories)[0]);
    setSubcategory(sugarSubcategories[0]);
  }
  return <Dialog open={open} onOpenChange={(nextOpen) => { if (!saving) onOpenChange(nextOpen); }}><DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-[24px] border-0 p-0 shadow-[0_28px_90px_rgba(13,25,48,.28)] sm:max-w-[470px]"><form onSubmit={onSubmit} aria-busy={saving}><DialogHeader className="border-b border-[#f1eee7] px-5 py-5 text-left sm:px-6"><DialogTitle className="text-xl tracking-[-.03em]">添加一笔记录</DialogTitle><DialogDescription>保留原始货币，并按记录日期自动换算为 {currency}。</DialogDescription></DialogHeader><div className="space-y-4 px-5 py-5 sm:px-6"><div className="grid grid-cols-2 rounded-xl bg-[#eef2f8] p-1"><button type="button" onClick={() => changeType("expense")} className={`h-10 rounded-lg text-sm font-semibold transition ${type === "expense" ? "bg-white text-[#30392f] shadow-sm" : "text-[#7a879b]"}`}>支出</button><button type="button" onClick={() => changeType("income")} className={`h-10 rounded-lg text-sm font-semibold transition ${type === "income" ? "bg-white text-[#536f4f] shadow-sm" : "text-[#7a879b]"}`}>收入</button></div><input type="hidden" name="type" value={type}/><div className="grid grid-cols-[130px_minmax(0,1fr)] gap-3"><div className="min-w-0 space-y-2"><Label htmlFor="currency">货币</Label><NativeSelect id="currency" name="currency" defaultValue={currency} className="h-14 w-full rounded-xl"><CurrencyOptions /></NativeSelect></div><div className="min-w-0 space-y-2"><Label htmlFor="amount">金额</Label><Input id="amount" name="amount" type="number" inputMode="decimal" step="0.01" min="0.01" required placeholder="0.00" className="h-14 min-w-0 rounded-xl text-xl font-bold" autoFocus /></div></div><div className={`grid gap-4 ${category === "糖分" ? "grid-cols-2" : "sm:grid-cols-2"}`}><div className="min-w-0 space-y-2"><Label htmlFor="category">分类</Label><NativeSelect id="category" name="category" value={category} onChange={(event) => { setCategory(event.target.value); if (event.target.value !== "糖分") setSubcategory(sugarSubcategories[0]); }} className="h-11 w-full rounded-xl">{categories.map((item) => <NativeSelectOption key={item} value={item}>{item}</NativeSelectOption>)}</NativeSelect></div>{category === "糖分" && <div className="min-w-0 space-y-2"><Label htmlFor="subcategory">糖分类型</Label><NativeSelect id="subcategory" name="subcategory" value={subcategory} onChange={(event) => setSubcategory(event.target.value)} required className="h-11 w-full rounded-xl">{sugarSubcategories.map((item) => <NativeSelectOption key={item} value={item}>{item}</NativeSelectOption>)}</NativeSelect></div>}<div className={`min-w-0 space-y-2 ${category === "糖分" ? "col-span-2" : ""}`}><Label htmlFor="date">日期</Label><Input id="date" name="date" type="date" defaultValue={defaultDate} required className="block h-11 w-full min-w-0 rounded-xl" /></div></div><div className="space-y-2"><Label htmlFor="note">备注</Label><Input id="note" name="note" placeholder={type === "expense" ? "例如：午餐" : "例如：九月工资"} className="h-11 rounded-xl" /></div>{error && <p role="alert" className="rounded-xl bg-[#fff0f1] px-3 py-2 text-sm text-[#b64251]">{error}</p>}</div><DialogFooter className="grid grid-cols-2 gap-3 border-t border-[#f1eee7] px-5 py-4 sm:flex sm:px-6"><Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving} className="h-11 rounded-xl">取消</Button><Button type="submit" disabled={saving} className="h-11 rounded-xl bg-[#637f60] px-7">{saving ? <><Loader2 className="animate-spin" />保存中…</> : "保存记录"}</Button></DialogFooter></form></DialogContent></Dialog>;
}
