/**
 * Paseo's project identity, mirrored so a project wears the same color and mark here as in Paseo's own lists
 * (packages/app/src/styles/identity-colors.ts and packages/app/src/projects/workspace-structure.ts): the same ten
 * colors, the same `*31` hash and the same view keys. The order of IDENTITY_COLOR_NAMES is load-bearing — the hash
 * indexes into it, so reordering silently recolors every project on both sides.
 */
export const IDENTITY_COLOR_NAMES = ["violet", "sky", "emerald", "orange", "pink", "indigo", "teal", "red", "amber", "blue"] as const;
export type IdentityColorName = (typeof IDENTITY_COLOR_NAMES)[number];

/** Muted fills behind the white initial of a project mark; identical hexes to Paseo, valid on light and dark. */
const IDENTITY_COLORS: Record<IdentityColorName, string> = {
  violet: "#7a6aa8", sky: "#3d7ea6", emerald: "#388068", orange: "#a4673a", pink: "#b05c80",
  indigo: "#6a70b8", teal: "#368080", red: "#b06260", amber: "#8f7838", blue: "#5179b0",
};
/** The same hues as foreground (a dot or label painted directly on a row): one set per scheme, as in Paseo. */
const IDENTITY_FOREGROUND: Record<"light" | "dark", Record<IdentityColorName, string>> = {
  light: {
    violet: "#6d49b5", sky: "#3d6985", emerald: "#3e6e5d", orange: "#845838", pink: "#974168",
    indigo: "#5251c2", teal: "#3e6d6c", red: "#9c4243", amber: "#716239", blue: "#39649e",
  },
  dark: {
    violet: "#a392d5", sky: "#6aa6ce", emerald: "#6cae96", orange: "#cc8f64", pink: "#d87da3",
    indigo: "#9299d5", teal: "#6cacab", red: "#d88381", amber: "#b29d64", blue: "#7ba1d5",
  },
};

export function identityColor(name: IdentityColorName): string {
  return IDENTITY_COLORS[name];
}
export function identityForeground(name: IdentityColorName, scheme: "light" | "dark"): string {
  return IDENTITY_FOREGROUND[scheme][name];
}

function hashIdentityKey(key: string): number {
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash;
}
export function deriveIdentityColorName(key: string): IdentityColorName {
  return IDENTITY_COLOR_NAMES[hashIdentityKey(key) % IDENTITY_COLOR_NAMES.length]!;
}

export type ProjectViewIdentity = { kind: "equivalence"; projectKey: string } | { kind: "placement"; serverId: string; projectId: string };
/** The key Paseo hashes for a project's color: its shared project key, else its host-local placement. */
export function createProjectViewKey(identity: ProjectViewIdentity): string {
  return identity.kind === "equivalence" ? identity.projectKey : JSON.stringify([identity.serverId, identity.projectId]);
}

/** The project descriptors the identity resolution needs (a subset of the daemon's project.list response). */
export interface ProjectIdentitySource {
  projectId: string;
  projectKey?: string | null;
  projectIconRevision?: string | null;
  projectCustomIconRevision?: string | null;
  projectRootPath?: string | null;
}
export interface ProjectIdentity {
  projectId: string;
  viewKey: string;
  colorName: IdentityColorName;
  /** Fill hex of the project mark (white initial on top). */
  color: string;
  /** The icon changes whenever this revision does; null when Paseo has no icon for the project. */
  iconRevision: string | null;
  /** Where the daemon's legacy icon lookup scans for a favicon / logo. */
  iconWorkingDir: string | null;
}

/**
 * Paseo's allocation: a project key shared by exactly one project on the host is the view key; anything else gets the
 * `[serverId, projectId]` placement key (with a suffix when that collides with a project key). Agents reference a
 * project by its key when the placement metadata has one and by its id otherwise, so lookups go through both indexes;
 * a key shared by several projects identifies no single project and is only indexed per id.
 */
export function buildProjectIdentities(serverId: string, projects: readonly ProjectIdentitySource[]): { byId: Map<string, ProjectIdentity>; byKey: Map<string, ProjectIdentity> } {
  const keyCounts = new Map<string, number>();
  for (const project of projects) if (project.projectKey) keyCounts.set(project.projectKey, (keyCounts.get(project.projectKey) ?? 0) + 1);
  const allocated = new Set(projects.flatMap(project => project.projectKey ? [project.projectKey] : []));
  const byId = new Map<string, ProjectIdentity>(), byKey = new Map<string, ProjectIdentity>();
  for (const project of projects) {
    const sharedKey = project.projectKey ?? null, unique = sharedKey !== null && keyCounts.get(sharedKey) === 1;
    let viewKey: string;
    if (unique) viewKey = createProjectViewKey({ kind: "equivalence", projectKey: sharedKey });
    else {
      viewKey = createProjectViewKey({ kind: "placement", serverId, projectId: project.projectId });
      for (let suffix = 0; allocated.has(viewKey); suffix++) viewKey = JSON.stringify(["placement", serverId, project.projectId, suffix]);
      allocated.add(viewKey);
    }
    const colorName = deriveIdentityColorName(viewKey);
    const identity: ProjectIdentity = {
      projectId: project.projectId, viewKey, colorName, color: identityColor(colorName),
      iconRevision: project.projectCustomIconRevision ?? project.projectIconRevision ?? null,
      iconWorkingDir: project.projectRootPath ?? null,
    };
    byId.set(project.projectId, identity);
    if (unique) byKey.set(sharedKey, identity);
  }
  return { byId, byKey };
}

/** An agent's `projectId` is its project key when the placement metadata has one, else the host-local project id. */
export function resolveProjectIdentity(identities: { byId: Map<string, ProjectIdentity>; byKey: Map<string, ProjectIdentity> } | null, projectRef: string | null | undefined): ProjectIdentity | null {
  if (!identities || !projectRef) return null;
  return identities.byKey.get(projectRef) ?? identities.byId.get(projectRef) ?? null;
}
