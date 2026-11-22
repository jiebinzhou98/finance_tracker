"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { getSupabase } from "@/lib/supabase";

export function PushTest({ signedIn }: { signedIn: boolean }) {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function run(enable: boolean) {
    setBusy(true);
    setMessage("");
    try {
      if (!("Notification" in window) || !("PushManager" in window)) {
        throw new Error("请从 iPhone 主屏幕打开 Morrow，再开启通知。");
      }
      if (enable && await Notification.requestPermission() !== "granted") {
        throw new Error("未取得 iPhone 通知权限。");
      }
      const { data } = await (getSupabase()?.auth.getSession() ?? Promise.resolve({ data: { session: null } }));
      if (!data.session) throw new Error("请先登录 Morrow。");
      const call = (body: object) => fetch("/api/test-push", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` },
        body: JSON.stringify(body),
      });
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration?.active) throw new Error("Morrow 尚未准备好，请重新打开后再试。");
      let subscription = await registration.pushManager.getSubscription();
      const storedKeys = localStorage.getItem("morrow-test-push-keys");
      let keys = storedKeys ? JSON.parse(storedKeys) : null;
      if (enable && !subscription) {
        if (!keys) {
          const response = await call({ action: "new-key" });
          if (!response.ok) throw new Error("无法准备测试推送，请稍后重试。");
          keys = await response.json();
          localStorage.setItem("morrow-test-push-keys", JSON.stringify(keys));
        }
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keys.publicKey });
      }
      if (!subscription || !keys) throw new Error("请先开启测试通知。");
      setReady(true);
      if (enable) {
        setMessage("已开启测试通知。");
      } else {
        setMessage("正在发送，请现在锁屏。");
        const response = await call({ subscription: subscription.toJSON(), keys });
        if (!response.ok) throw new Error("测试推送未送出，请重试。");
        setMessage("测试通知已交给 Apple 推送服务。");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "测试失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  return <section className="surface-card mx-auto mt-5 max-w-3xl p-5" aria-label="通知测试">
    <h2 className="section-title">通知测试</h2>
    <p className="section-subtitle">{signedIn ? "从 iPhone 主屏幕打开 Morrow，授权后即可测试锁屏推送。" : "请先登录 Morrow，再开启测试通知。"}</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <Button disabled={!signedIn || busy} onClick={() => void run(true)}>开启通知</Button>
      <Button variant="outline" disabled={!signedIn || !ready || busy} onClick={() => void run(false)}>发送测试通知</Button>
    </div>
    {message && <p className="mt-3 text-sm" role="status">{message}</p>}
  </section>;
}
