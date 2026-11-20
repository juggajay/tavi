// Adapted from Bot HQ (MIT), github.com/nickvasilescu/bot-hq
import { useState } from "react";
import type { Approval } from "../../../../../src/shared/protocol";
import type { Row } from "../../types";
import { useStore, sendSocket } from "../../store";
type Card = Extract<Row["body"], { kind: "card" }>;
function revisedApproval(original: Approval, itemId?: string) {
  let stop: () => void;
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<Approval>((resolve, reject) => {
    stop = useStore.subscribe(s => {
      const next = Object.values(s.approvals).find(a => (itemId && a.item_id === itemId && a.id !== original.id) || (a.id === original.id && a.nonce !== original.nonce));
      if (next) { stop(); clearTimeout(timer); resolve(next); }
    });
    timer = setTimeout(() => { stop(); reject(new Error("Couldn't save the changes. Nothing was sent.")); }, 5000);
  });
  return { promise, cancel: () => { stop(); clearTimeout(timer); } };
}
export function ApprovalCard({ card }: { card: Card }) {
  const approvals = useStore(s => s.approvals);
  const items = useStore(s => s.items);
  const direct = approvals[card.ref];
  const approval = direct ?? Object.values(approvals).find(a => a.item_id === card.ref);
  const item = items[card.ref] ?? Object.values(items).find(it => it.kind === "draft" && it.payload.approval_id === card.ref);
  const payload = item?.kind === "draft" ? item.payload : undefined;
  const [subject, setSubject] = useState<string | null>(null), [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [detailsOpen, showDetails] = useState(false);
  const waiting = (!card.state || card.state === "waiting") && !!approval && Date.parse(approval.expires_at) > Date.now();
  const email = approval?.kind === "email" || payload?.operation === "email.send";
  const subjectValue = subject ?? approval?.subject ?? payload?.subject ?? "";
  const bodyValue = body ?? approval?.body ?? payload?.body ?? "";
  const decide = async (decision: "approve" | "reject") => {
    if (!approval) return;
    setBusy(true); setError(null);
    try {
      let current: Approval = approval;
      if (decision === "approve" && email && (subjectValue !== approval.subject || bodyValue !== approval.body)) {
        const next = revisedApproval(approval, approval.item_id ?? item?.id);
        try { sendSocket({ type: "revise", id: approval.id, nonce: approval.nonce, subject: subjectValue, body: bodyValue }); current = await next.promise; }
        finally { next.cancel(); }
      }
      sendSocket({ type: "decide", id: current.id, nonce: current.nonce, decision });
    } catch (err) { setError(err instanceof Error ? err.message : "Nothing was sent. Please try again."); }
    finally { setBusy(false); }
  };
  return <section className="approval-card" aria-label={card.title}>
    <b>{card.title}</b>
    {email && <p className="approval-summary">Send “{subjectValue}” to {(approval?.to ?? payload?.to ?? []).join(", ")}.</p>}
    {waiting ? <div className="button-row"><button className="btn btn--primary" disabled={busy} onClick={() => void decide("approve")}>Approve</button><button className="btn btn--secondary" disabled={busy} onClick={() => void decide("reject")}>Don't</button></div> : <p role="status">{card.state === "approved" ? "Approved" : card.state === "declined" ? "Not approved" : "This one is no longer waiting for your OK."}</p>}
    <button className="link-btn approval-details-toggle" aria-expanded={detailsOpen} onClick={() => showDetails(!detailsOpen)}>{detailsOpen ? "Hide details" : "Show details"}</button>
    {detailsOpen && <div className="approval-details">{email && <><label>Subject<input className="text-input" value={subjectValue} disabled={!waiting || busy} onChange={e => setSubject(e.target.value)} /></label><label>Email text<textarea value={bodyValue} disabled={!waiting || busy} onChange={e => setBody(e.target.value)} /></label></>}{approval?.rows?.map(row => <p key={row.label}><b>{row.label}: </b>{row.value}</p>)}<p className="quiet">Nothing goes out until you approve.</p></div>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
