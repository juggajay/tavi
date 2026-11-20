import { z } from "zod";
import { db } from "../store/db.js";
import { registerOperation, requestOperationApproval } from "../broker/broker.js";

const change = z.object({ by: z.string().min(1), text: z.string().trim().max(1500), why: z.string().trim().min(1).max(2000), base: z.number().int() });
const saved = () => db.prepare("SELECT text, revision FROM about_card WHERE id = 1").get() as { text: string; revision: number };
export const aboutCard = (): string => saved().text;
registerOperation("team.about", {
  account: "Tavi",
  view: (grant) => {
    const g = change.parse(grant);
    return { subject: `About you: proposed by ${g.by}`, rows: [{ label: "New words", value: g.text }, { label: "Why", value: g.why }] };
  },
  declined: "The about card was left as it was.",
  run: async (grant) => {
    const g = change.parse(grant);
    const result = db.prepare("UPDATE about_card SET text = ?, revision = revision + 1 WHERE id = 1 AND revision = ?").run(g.text, g.base);
    return Number(result.changes) === 1 ? { status: "verified", message: "The about card has been updated." } : { status: "refused", message: "The about card changed while this was waiting. Please review a fresh copy." };
  },
});
export function proposeAboutChange(by: string, text: string, why: string) {
  const result = change.safeParse({ by, text, why, base: saved().revision });
  if (!result.success) throw new Error("The about card must be no more than 1,500 characters, with a reason for the change.");
  return requestOperationApproval("team.about", result.data);
}
