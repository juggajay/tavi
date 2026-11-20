// A bot's question must never count as the owner's request to change looking.
const owners = new Map<string, boolean>();
export const noteRequester = (id: string, owner: boolean) => { owners.set(id, owner); };
export const forgetRequester = (id: string) => { owners.delete(id); };
export const ownerRequested = (id: string | null) => id ? owners.get(id) : undefined;
