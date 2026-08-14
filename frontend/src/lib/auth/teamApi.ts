import { commands, type TeamCreated, type TeamMember, type TeamMemberCandidate, type TeamSummary } from "../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../ipc/result";

export type { TeamCreated, TeamMember, TeamMemberCandidate, TeamSummary };

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

export async function searchTeamMemberCandidates(
  token: string,
  teamId: number,
  email: string,
): Promise<TeamMemberCandidate[]> {
  return unwrapCommand(commands.teamSearchMemberCandidates(token, teamId, email));
}

export async function addTeamMember(
  token: string,
  teamId: number,
  input: {
    unionId: string;
    roleCode?: string | null;
    userTeamName?: string | null;
  },
): Promise<TeamMember> {
  return unwrapCommand(
    commands.teamAddMember(
      token,
      teamId,
      input.unionId,
      input.roleCode ?? null,
      input.userTeamName ?? null,
    ),
  );
}

export async function updateTeamMember(
  token: string,
  teamId: number,
  unionId: string,
  input: {
    roleCode?: string | null;
    userTeamName?: string | null;
  },
): Promise<TeamMember> {
  return unwrapCommand(
    commands.teamUpdateMember(
      token,
      teamId,
      unionId,
      input.roleCode ?? null,
      input.userTeamName ?? null,
    ),
  );
}

export async function removeTeamMember(
  token: string,
  teamId: number,
  unionId: string,
): Promise<void> {
  await unwrapCommand(commands.teamRemoveMember(token, teamId, unionId));
}

export function formatTeamError(error: unknown): string {
  return error instanceof Error ? error.message : formatIpcError(error as never);
}
