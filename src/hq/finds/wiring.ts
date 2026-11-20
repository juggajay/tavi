import { db } from "../../store/db.js";
import type { Hq } from "../hq.js";
import { createFinds } from "./service.js";
import { installFinds } from "./tools.js";
import { queueNotification, deliverDue } from "../../proactive/notify.js";
import { startOfDay } from "../../time.js";
import { recoverLooks } from "./ledger.js";

export const voiceOn = () => (db.prepare("SELECT event FROM audit_log WHERE event IN ('call.start','call.end') ORDER BY id DESC LIMIT 1").get() as { event: string } | undefined)?.event === "call.start";
export function wireFinds(hq: Hq, level: () => string = () => hq.guard.level()) {
  recoverLooks();
  const service = createFinds({
    lead: () => hq.members().find((b) => b.lead), level, voice: voiceOn, dev: process.env.LH_DEV === "1",
    idle: () => hq.members().every((b) => { const live = hq.turns.live(b.id); return live.state === "idle" && !live.queued && !live.work?.length; }),
    available: (bot) => hq.quietTurns.available(bot),
    turn: (bot, request) => hq.quietTurns.run(bot, request),
    alerts: (at) => (db.prepare("SELECT COUNT(*) n FROM notifications WHERE delivered_at>=? AND priority IN ('normal','urgent')").get(startOfDay(at).toISOString()) as { n: number }).n,
    send: async (bot, text, id) => {
      hq.turns.post(bot.id, { kind: "message", from: "bot", text, via: "routine" });
      queueNotification({ title: "Something useful", spoken: text, priority: "normal", source: `find:${id}` });
      await deliverDue();
    },
  });
  const off = installFinds(service);
  const timer = setInterval(() => { void service.tick().catch(() => undefined); }, 30000);
  timer.unref();
  return async () => { clearInterval(timer); off(); await service.close(); };
}
