// Phone push notifications (Web Push). Works on iPhone when the app is added to the Home Screen.
import webpush from "web-push";
import { db, nowIso } from "../store/db.js";
import { audit } from "../store/log.js";
import { getSecret, putSecret } from "../store/secrets.js";
import { devAllows } from "../dev.js";

type Vapid = { publicKey: string; privateKey: string };
type Sub = { endpoint: string; keys: { p256dh: string; auth: string } };

let subject = "https://tavi.invalid";
export const setPushSubject = (url: string | null) => {
  if (url) subject = url; // Apple requires a real https URL or mailto: subject
};

function vapid(): Vapid {
  let v = getSecret<Vapid>("push.vapid");
  if (!v) {
    v = webpush.generateVAPIDKeys();
    putSecret("push.vapid", v);
  }
  return v;
}

export const vapidPublicKey = () => vapid().publicKey;

export function saveSubscription(sub: Sub) {
  if (typeof sub?.endpoint !== "string" || !sub.endpoint.startsWith("https://") || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw new Error("Not a valid push subscription.");
  }
  db.prepare("INSERT INTO push_subscriptions (endpoint, keys_json, created_at) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET keys_json = excluded.keys_json").run(
    sub.endpoint,
    JSON.stringify(sub.keys),
    nowIso(),
  );
  audit("user", "push.subscribed", null, { service: new URL(sub.endpoint).host });
}

export function pushDeviceCount() {
  return (db.prepare("SELECT COUNT(*) n FROM push_subscriptions").get() as { n: number }).n;
}

export async function pushToAll(title: string, body: string, opts: { urgent?: boolean; tag?: string } = {}) {
  if (!devAllows("PUSH")) {
    console.log(`[push] dev: not sent: ${title}: ${body.slice(0, 120)}`);
    return 0;
  }
  const subs = db.prepare("SELECT endpoint, keys_json FROM push_subscriptions").all() as { endpoint: string; keys_json: string }[];
  if (!subs.length) return 0;
  const v = vapid();
  webpush.setVapidDetails(subject, v.publicKey, v.privateKey);
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys_json) }, JSON.stringify({ title, body, tag: opts.tag, url: "/" }), {
        TTL: 6 * 3600,
        urgency: opts.urgent ? "high" : "normal",
      });
      sent++;
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(s.endpoint); // phone unsubscribed
        audit("system", "push.subscription_removed", null, { status: code });
      } else {
        console.warn("[push] failed:", code ?? "", err instanceof Error ? err.message : err);
      }
    }
  }
  return sent;
}
