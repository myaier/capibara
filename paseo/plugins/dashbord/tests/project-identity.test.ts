import assert from "node:assert/strict";
import test from "node:test";
import { buildProjectIdentities, createProjectViewKey, deriveIdentityColorName, identityColor, identityForeground, resolveProjectIdentity } from "../shared/project-identity";

test("the identity hash and colors match Paseo's own palette", () => {
  // Vectors computed with Paseo's `hashIdentityKey` (packages/app/src/styles/identity-colors.ts).
  assert.equal(deriveIdentityColorName("demo-trading-app"), "blue");
  assert.equal(deriveIdentityColorName("zephyr-notes"), "pink");
  assert.equal(deriveIdentityColorName("garden-planner"), "violet");
  assert.equal(identityColor("amber"), "#8f7838");
  assert.equal(identityForeground("amber", "dark"), "#b29d64");
  assert.equal(identityForeground("amber", "light"), "#716239");
});

test("view keys: a project key unique on the host wins; anything else falls back to placement", () => {
  const { byId, byKey } = buildProjectIdentities("srv_demo1", [
    { projectId: "p1", projectKey: "zephyr-notes" },
    { projectId: "p2", projectKey: "shared" },
    { projectId: "p3", projectKey: "shared" },
    { projectId: "p4" },
  ]);
  assert.equal(byId.get("p1")!.viewKey, "zephyr-notes");
  assert.equal(byId.get("p2")!.viewKey, JSON.stringify(["srv_demo1", "p2"]));
  assert.equal(byId.get("p3")!.viewKey, JSON.stringify(["srv_demo1", "p3"]));
  assert.equal(byId.get("p4")!.viewKey, JSON.stringify(["srv_demo1", "p4"]));
  // The shared key identifies no single project; agents carrying it resolve by id only.
  assert.equal(byKey.has("shared"), false);
  assert.equal(byKey.get("zephyr-notes")!.projectId, "p1");
  assert.equal(createProjectViewKey({ kind: "equivalence", projectKey: "k" }), "k");
});

test("a placement key that collides with a project key gets a suffix, as in Paseo", () => {
  const { byId } = buildProjectIdentities("srv_demo1", [
    { projectId: "p1", projectKey: JSON.stringify(["srv_demo1", "p2"]) },
    { projectId: "p2" },
  ]);
  assert.equal(byId.get("p2")!.viewKey, JSON.stringify(["placement", "srv_demo1", "p2", 0]));
});

test("resolution accepts a project key or a project id; unknown references fall back", () => {
  const identities = buildProjectIdentities("srv_demo1", [{ projectId: "p1", projectKey: "zephyr-notes", projectIconRevision: "r7", projectRootPath: "/opt/demo/repo" }]);
  assert.equal(resolveProjectIdentity(identities, "zephyr-notes")!.color, "#b05c80");
  assert.equal(resolveProjectIdentity(identities, "p1")!.iconRevision, "r7");
  assert.equal(resolveProjectIdentity(identities, "p1")!.iconWorkingDir, "/opt/demo/repo");
  assert.equal(resolveProjectIdentity(identities, "elsewhere"), null);
  assert.equal(resolveProjectIdentity(null, "p1"), null);
  assert.equal(resolveProjectIdentity(identities, null), null);
});
