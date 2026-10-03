import { describe, expect, it } from "bun:test";

import { allOrganizationPermissions } from "../apps/backend/src/services/organization-permissions";
import { groupPermissions, permissionInfo } from "../apps/evidence-web/src/pages/organisation-permissions";

describe("organisation roles page", () => {
  it("has a label for every permission the backend can grant", () => {
    expect(Object.keys(permissionInfo).sort()).toEqual([...allOrganizationPermissions].sort());
  });

  it("groups test permissions under Testing", () => {
    const groups = groupPermissions([...allOrganizationPermissions]);
    expect(groups.map((group) => group.label)).toEqual(["Evidence", "Testing", "Members and access"]);
    expect(groups.find((group) => group.label === "Testing")?.permissions).toContain("test_config.manage");
    expect(groups.flatMap((group) => group.permissions).length).toBe(allOrganizationPermissions.length);
  });
});
