import { hasSidebarTreeSearch, sidebarTreeSearchMatches } from "../../lib/sidebarTreeSearch";
import { websiteRowLabel } from "./panel/serverResourceLabels";
import type { ServerEntry } from "./panel/serverConnection";

export function serverEntryMatchesSearch(
  query: string,
  server: ServerEntry,
  serviceTypeLabel: string,
): boolean {
  return sidebarTreeSearchMatches(query, server.name, serviceTypeLabel);
}

export function serverWebsiteMatchesSearch(query: string, row: Record<string, unknown>): boolean {
  return sidebarTreeSearchMatches(query, websiteRowLabel(row));
}

export function serverSubtreeMatchesSearch(
  query: string,
  server: ServerEntry,
  serviceTypeLabel: string,
  categoryLabels: { websites: string },
  resources: {
    websites: Record<string, unknown>[];
  },
): boolean {
  if (!hasSidebarTreeSearch(query)) {
    return true;
  }
  if (serverEntryMatchesSearch(query, server, serviceTypeLabel)) {
    return true;
  }
  for (const label of Object.values(categoryLabels)) {
    if (sidebarTreeSearchMatches(query, label)) {
      return true;
    }
  }
  if (resources.websites.some((row) => serverWebsiteMatchesSearch(query, row))) {
    return true;
  }
  return false;
}
