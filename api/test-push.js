import webpush from "web-push";
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).end();
  const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) return res.status(401).end();
  try {
    const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
    const { data } = await client.auth.getUser(token);
    if (!data.user) return res.status(401).end();
    if (req.body?.action === "new-key") return res.json(webpush.generateVAPIDKeys());
    const { subscription, keys } = req.body ?? {};
    const endpoint = new URL(subscription?.endpoint);
    if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".push.apple.com") ||
        endpoint.username || endpoint.password || endpoint.port) return res.status(400).end();
    await new Promise((resolve) => setTimeout(resolve, 8000));
    await webpush.sendNotification(subscription, JSON.stringify({
      title: "Morrow 测试通知", body: "你的 iPhone 已收到 Morrow 推送。",
    }), { TTL: 120, timeout: 5000, vapidDetails: {
      subject: "https://finance-tracker-sage-nu.vercel.app",
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    } });
    return res.status(204).end();
  } catch {
    return res.status(502).end();
  }
}
