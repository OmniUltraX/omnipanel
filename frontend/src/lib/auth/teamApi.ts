import { commands, type TeamCreated, type TeamInvite, type TeamMember, type TeamSummary } from "../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../ipc/result";

export type { TeamCreated, TeamInvite, TeamMember, TeamSummary };

export function isPersonalTeam(team: { kind?: string } | null | undefined): boolean {
  return (team?.kind ?? "").trim().toLowerCase() === "personal";
}

export async function fetchTeams(
  token: string,
  options?: { quiet?: boolean },
): Promise<TeamSummary[]> {
  return unwrapCommand(commands.teamList(token), {
    quiet: options?.quiet,
    logLabel: "[teams]",
  });
}

export async function createTeam(token: string, name: string): Promise<TeamCreated> {
  return unwrapCommand(commands.teamCreate(token, name));
}

export async function dissolveTeam(token: string, teamId: number): Promise<void> {
  await unwrapCommand(commands.teamDissolve(token, teamId));
}

export async function fetchTeamMembers(
  token: string,
  teamId: number,
  options?: { quiet?: boolean },
): Promise<TeamMember[]> {
  return unwrapCommand(commands.teamListMembers(token, teamId), {
    quiet: options?.quiet,
    logLabel: "[teams]",
  });
}

export async function addTeamMember(
  token: string,
  teamId: number,
  input: {
    email: string;
    roleCode?: string | null;
    userTeamName?: string | null;
  },
): Promise<TeamMember> {
  return unwrapCommand(
    commands.teamAddMember(
      token,
      teamId,
      input.email,
      input.roleCode ?? null,
      input.userTeamName ?? null,
    ),
  );
}

export async function updateTeamMember(
  token: string,
  teamId: number,
  email: string,
  input: {
    roleCode?: string | null;
    userTeamName?: string | null;
  },
): Promise<TeamMember> {
  return unwrapCommand(
    commands.teamUpdateMember(
      token,
      teamId,
      email,
      input.roleCode ?? null,
      input.userTeamName ?? null,
    ),
  );
}

export async function removeTeamMember(
  token: string,
  teamId: number,
  email: string,
): Promise<void> {
  await unwrapCommand(commands.teamRemoveMember(token, teamId, email));
}

export async function createTeamInvite(token: string, teamId: number): Promise<TeamInvite> {
  return unwrapCommand(commands.teamCreateInvite(token, teamId));
}

export async function joinTeamByInvite(token: string, code: string): Promise<TeamSummary> {
  return unwrapCommand(commands.teamJoinByInvite(token, code));
}

export function formatTeamError(error: unknown): string {
  return error instanceof Error ? error.message : formatIpcError(error as never);
}
