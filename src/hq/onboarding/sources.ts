const starts = new Map<string, number>(), materials = new Map<string, number>();
function contains(all: Map<string, number>, id: string | null) {
  for (const [key, until] of all) if (until < Date.now()) all.delete(key);
  return !!id && all.has(id);
}
export const conversationStart = (id: string) => starts.set(id, Date.now() + 30 * 60_000);
export const materialTurn = (id: string) => materials.set(id, Date.now() + 30 * 60_000);
export const isConversationStart = (id: string | null) => contains(starts, id);
export const isMaterialTurn = (id: string | null) => contains(materials, id);
