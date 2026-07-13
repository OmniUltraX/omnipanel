import { hasSidebarTreeSearch, sidebarTreeSearchMatches } from "../../lib/sidebarTreeSearch";
import { getAppDisplayName } from "./panel/appCard";
import { certificateRowLabel, websiteRowLabel } from "./panel/serverResourceLabels";
import type { ServerEntry } from "./panel/serverConnection";
import type { ServerInstalledApp } from "./panel/serverApp";

export function serverEntryMatchesSearch(
  query: string,
  server: ServerEntry,
  serviceTypeLabel: string,
): boolean {
  return sidebarTreeSearchMatches(query, server.name, serviceTypeLabel);
}

export function serverAppMatchesSearch(query: string, app: ServerInstalledApp): boolean {
  return sidebarTreeSearchMatches(
    query,
    getAppDisplayName(app),
    app.appName,
    app.name,
    app.appKey,
  );
}

export function serverWebsiteMatchesSearch(query: string, row: Record<string, unknown>): boolean {
  return sidebarTreeSearchMatches(query, websiteRowLabel(row));
}

export function serverCertificateMatchesSearch(query: string, row: Record<string, unknown>): boolean {
  return sidebarTreeSearchMatches(query, certificateRowLabel(row));
}

export function serverSubtreeMatchesSearch(
  query: string,
  server: ServerEntry,
  serviceTypeLabel: string,
  categoryLabels: { apps: string; websites: string; certificates: string },
  resources: {
    apps: ServerInstalledApp[];
    websites: Record<string, unknown>[];
    certificates: Record<string, unknown>[];
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
  if (resources.apps.some((app) => serverAppMatchesSearch(query, app))) {
    return true;
  }
  if (resources.websites.some((row) => serverWebsiteMatchesSearch(query, row))) {
    return true;
  }
  if (resources.certificates.some((row) => serverCertificateMatchesSearch(query, row))) {
    return true;
  }
  return false;
}
