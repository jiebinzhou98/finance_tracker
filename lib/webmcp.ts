import { addTransaction, getTransactions, type TransactionType } from "@/lib/finance-db";

type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: object;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute(input: unknown): unknown | Promise<unknown>;
};

declare global {
  interface Document {
    modelContext?: {
      registerTool(tool: ToolDefinition, options?: { signal?: AbortSignal }): void | Promise<void>;
    };
  }
}

export function registerFinanceTools(currency: string, onChanged: () => Promise<void>) {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();

  void Promise.resolve(context.registerTool({
    name: "get_finance_summary",
    title: "查看收支摘要",
    description: "读取本机当前月份的收入、支出和结余汇总，不会修改数据。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    async execute() {
      const month = new Date().toISOString().slice(0, 7);
      const records = (await getTransactions()).filter((item) => !item.deletedAt && item.transactionDate.startsWith(month));
      const income = records.filter((item) => item.type === "income").reduce((sum, item) => sum + item.amount, 0);
      const expense = records.filter((item) => item.type === "expense").reduce((sum, item) => sum + item.amount, 0);
      return { currency, incomeInMinorUnits: income, expenseInMinorUnits: expense, balanceInMinorUnits: income - expense };
    },
  }, { signal: lifecycle.signal })).catch(() => undefined);

  void Promise.resolve(context.registerTool({
    name: "create_transaction",
    title: "新增收支记录",
    description: "在本机新增一笔收入或支出记录，并更新可见的收支界面。金额使用货币单位，例如 12.50。",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["income", "expense"] },
        amount: { type: "number", exclusiveMinimum: 0 },
        category: { type: "string", minLength: 1 },
        note: { type: "string" },
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      },
      required: ["type", "amount", "category", "date"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute(input) {
      const value = input as Record<string, unknown>;
      if ((value.type !== "income" && value.type !== "expense") || typeof value.amount !== "number" || value.amount <= 0 || typeof value.category !== "string" || !value.category || typeof value.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) throw new Error("无效的收支记录");
      const record = await addTransaction({ type: value.type as TransactionType, amount: Math.round(value.amount * 100), currency, category: value.category, note: typeof value.note === "string" ? value.note : "", transactionDate: value.date });
      await onChanged();
      return { id: record.id, status: "saved-locally" };
    },
  }, { signal: lifecycle.signal })).catch(() => undefined);

  return () => lifecycle.abort();
}
