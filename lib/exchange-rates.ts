import { db, type FinanceTransaction } from "@/lib/finance-db";

export const supportedCurrencies = ["CAD", "USD", "CNY", "EUR", "HKD"] as const;
export type SupportedCurrency = typeof supportedCurrencies[number];
export type ExchangeRates = Record<string, number>;

export const currencyLabels: Record<SupportedCurrency, string> = {
  CAD: "CAD · 加元",
  USD: "USD · 美元",
  CNY: "CNY · 人民币",
  EUR: "EUR · 欧元",
  HKD: "HKD · 港币",
};

interface RateResponse { date: string; base: string; quote: string; rate: number }
interface RateSnapshot { date: string; rates: ExchangeRates }

function cacheKey(date: string) { return `exchangeRates:${date}`; }

export function convertAmount(amount: number, source: string, target: string, rates?: ExchangeRates) {
  if (source === target) return amount;
  const sourceRate = rates?.[source];
  const targetRate = rates?.[target];
  if (!sourceRate || !targetRate) return null;
  return Math.round(amount / sourceRate * targetRate);
}

export function displayAmount(transaction: FinanceTransaction, target: string) {
  return convertAmount(transaction.amount, transaction.currency, target, transaction.exchangeRates) ?? transaction.amount;
}

export async function getExchangeRatesForDate(date: string): Promise<RateSnapshot> {
  const cached = await db.settings.get(cacheKey(date));
  if (cached) {
    try { return JSON.parse(cached.value) as RateSnapshot; }
    catch { /* Fetch and replace a malformed cache entry. */ }
  }

  const quotes = supportedCurrencies.filter((currency) => currency !== "EUR").join(",");
  let response: Response;
  try {
    response = await fetch(`https://api.frankfurter.dev/v2/rates?date=${encodeURIComponent(date)}&base=EUR&quotes=${quotes}`);
  } catch {
    throw new Error("无法取得当天汇率，请联网后再试");
  }
  if (!response.ok) throw new Error("汇率服务暂时不可用，请稍后再试");
  const rows = await response.json() as RateResponse[];
  if (!Array.isArray(rows) || !rows.length) throw new Error("当天暂无可用汇率");
  const rates: ExchangeRates = { EUR: 1 };
  for (const row of rows) if (Number.isFinite(row.rate) && row.rate > 0) rates[row.quote] = row.rate;
  if (supportedCurrencies.some((currency) => !rates[currency])) throw new Error("当天汇率数据不完整");
  const snapshot = { date: rows[0].date, rates };
  await db.settings.put({ key: cacheKey(date), value: JSON.stringify(snapshot) });
  return snapshot;
}

export async function ensureTransactionRates(transactions: FinanceTransaction[], target: string) {
  const missing = transactions.filter((item) => !item.deletedAt && item.currency !== target && !convertAmount(item.amount, item.currency, target, item.exchangeRates));
  if (!missing.length) return false;
  const byDate = new Map<string, RateSnapshot>();
  for (const date of new Set(missing.map((item) => item.transactionDate))) byDate.set(date, await getExchangeRatesForDate(date));
  await db.transaction("rw", db.transactions, async () => {
    for (const item of missing) {
      const snapshot = byDate.get(item.transactionDate)!;
      await db.transactions.update(item.id, {
        exchangeRates: snapshot.rates,
        exchangeRateDate: snapshot.date,
        updatedAt: new Date().toISOString(),
        syncStatus: "pending",
      });
    }
  });
  return true;
}
