import type { OrganizationPermission } from "../api";

// Labels and grouping for the organisation roles page.

type PermissionInfo = { label: string; description?: string };

// Every permission the backend can grant, with the text the roles page shows. The Record type keeps
// it in step with the web type; tests/organisation-permissions.test.ts keeps both in step with the
// backend list.
export const permissionInfo: Record<OrganizationPermission, PermissionInfo> = {
  "evidence.view": { label: "View evidence" },
  "evidence.download": { label: "Download evidence" },
  "evidence.comment": { label: "Comment" },
  "evidence.create": { label: "Create sessions" },
  "evidence.update.own": { label: "Edit own evidence" },
  "evidence.delete.own": { label: "Delete own evidence" },
  "evidence.move.own": { label: "Move own evidence" },
  "evidence.update.any": { label: "Edit all evidence" },
  "evidence.delete.any": { label: "Delete all evidence" },
  "evidence.move.any": { label: "Move all evidence" },
  "evidence.tags.manage": { label: "Manage evidence tags" },
  "invitations.create": { label: "Create invitation links" },
  "invitations.disable": { label: "Disable invitation links" },
  "join_requests.manage": { label: "Review join requests" },
  "roles.manage": { label: "Manage roles" },
  "members.assign_role": { label: "Assign roles" },
  "members.kick": { label: "Remove members" },
  "activity.view": { label: "View activity" },
  "storage.manage": {
    label: "Manage storage",
    description: "Add your own S3 storage, choose where evidence is saved and transfer existing files."
  },
  "test_case.view": { label: "View test cases", description: "Open cases, their steps and scripts." },
  "test_case.create": { label: "Create test cases", description: "New cases, imports and duplicates." },
  "test_case.update": { label: "Edit test cases", description: "Steps, details, tags and bulk edits." },
  "test_case.approve": { label: "Approve test cases", description: "Move reviewed cases from the review queue to active." },
  "test_case.delete": { label: "Archive test cases" },
  "test_run.create": { label: "Run test cases" },
  "test_run.cancel": { label: "Cancel own runs" },
  "test_run.cancel_any": { label: "Cancel any run" },
  "test_run.view": { label: "View test runs", description: "Run results, recordings and costs." },
  "test_config.manage": {
    label: "Manage testing settings",
    description: "Environments, variables, credentials, actions, AI model, runner pools, run limits, notifications and webhooks."
  },
  "test_config.use": { label: "Use testing settings", description: "Pick environments and credentials when running cases." }
};

const permissionGroups: { label: string; match: (permission: OrganizationPermission) => boolean }[] = [
  { label: "Evidence", match: (permission) => permission.startsWith("evidence.") },
  { label: "Testing", match: (permission) => permission.startsWith("test_") },
  { label: "Members and access", match: () => true }
];

export function groupPermissions(permissions: readonly OrganizationPermission[]): { label: string; permissions: OrganizationPermission[] }[] {
  const remaining = new Set(permissions);
  return permissionGroups
    .map((group) => {
      const picked = permissions.filter((permission) => remaining.has(permission) && group.match(permission));
      for (const permission of picked) remaining.delete(permission);
      return { label: group.label, permissions: picked };
    })
    .filter((group) => group.permissions.length > 0);
}
