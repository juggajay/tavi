export async function onboardingRequest<T>(path = "", body?: unknown): Promise<T> {
  const response = await fetch(`/api/hq/onboarding${path}`, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : "Could not finish that step. Please try again.");
  return value;
}
