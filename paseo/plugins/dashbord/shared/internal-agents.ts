/** Keep metadata helpers and archived helpers from older releases out of ordinary work queues. */
export function isInternalAgent(agent: { labels?: Record<string, string> } | null | undefined): boolean {
  const role = agent?.labels?.["observatory.role"];
  return role === "title" || role === "insight";
}
