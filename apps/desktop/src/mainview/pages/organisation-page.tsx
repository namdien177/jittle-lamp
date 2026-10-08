import React, { useEffect, useMemo, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useNavigate, useParams } from "react-router";
import { z } from "zod/v4";
import { Button, Dialog, TextInput, UiSelect } from "@jittle-lamp/ui";

import {
  api,
  type ApiCreatedInvitationCode,
  type ApiInvitation,
  type ApiInvitationCode,
  type ApiMember,
  type ApiMembersResponse,
  type ApiOrgSummary,
  webOrigin
} from "../api";
import { useDesktopAuth } from "../auth-context";
import { useToast } from "../ui/toast";
import { OrganisationStorageSection } from "./organisation-storage";
import { copyToClipboard, formatRelativeTime, getInitials } from "../utils";

type DetailTab = "members" | "invitations" | "storage" | "options";
type SortKey = "name" | "joinedAt" | "role";
type RoleFilter = "all" | "owner" | "moderator" | "member";

const createOrganizationFormSchema = z.object({
  name: z.string().trim().min(1, "Pick a name for the new workspace.").max(100)
});

const acceptInvitationFormSchema = z.object({
  token: z.string().trim().min(1, "Paste the invitation code."),
  password: z.string().optional()
});

const invitationCodeFormSchema = z.object({
  label: z.string().trim().min(1, "Name this invitation code.").max(80),
  role: z.enum(["moderator", "member"]),
  password: z.string().optional(),
  emailDomain: z
    .string()
    .trim()
    .transform((value) => value.replace(/^@/, "").toLowerCase())
    .pipe(z.union([z.literal(""), z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Use a valid domain.")])),
  expiresDays: z.string().regex(/^\d*$/, "Use whole days only."),
  guestDays: z.string()
});

type CreateOrganizationFormValues = z.infer<typeof createOrganizationFormSchema>;
type AcceptInvitationFormValues = z.infer<typeof acceptInvitationFormSchema>;
type InvitationCodeFormValues = z.infer<typeof invitationCodeFormSchema>;

const tabs: Array<{ id: DetailTab; label: string }> = [
  { id: "members", label: "Members" },
  { id: "invitations", label: "Invitations" },
  { id: "storage", label: "Storage" },
  { id: "options", label: "Options" }
];

const sortOptions: Array<{ label: string; value: SortKey }> = [
  { label: "Name", value: "name" },
  { label: "Date joining", value: "joinedAt" },
  { label: "Role", value: "role" }
];

const roleFilterOptions: Array<{ label: string; value: RoleFilter }> = [
  { label: "All roles", value: "all" },
  { label: "Owner", value: "owner" },
  { label: "Moderator", value: "moderator" },
  { label: "Member", value: "member" }
];

const editableRoleOptions: Array<{ label: string; value: "member" | "moderator" }> = [
  { label: "Member", value: "member" },
  { label: "Moderator", value: "moderator" }
];

const guestDayOptions: Array<{ label: string; value: string }> = [
  { label: "Permanent", value: "" },
  { label: "1 day", value: "1" },
  { label: "3 days", value: "3" },
  { label: "7 days", value: "7" },
  { label: "14 days", value: "14" },
  { label: "30 days", value: "30" }
];

function getInviteUrl(token: string): string {
  return `${webOrigin}/join?code=${encodeURIComponent(token)}`;
}

function getMemberPrimaryText(member: ApiMember): string {
  const fullName = [member.firstName, member.lastName].filter(Boolean).join(" ").trim();
  return fullName || member.displayName || member.email || "Unknown user";
}

function roleChipClass(role: string): string {
  if (role === "owner") return "accent";
  if (role === "moderator") return "warning";
  return "neutral";
}

function sortOrganizations(orgs: ApiOrgSummary[], activeOrgId: string | null, sort: SortKey): ApiOrgSummary[] {
  return [...orgs].sort((a, b) => {
    if (a.id === activeOrgId) return -1;
    if (b.id === activeOrgId) return 1;
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "role") return a.role.localeCompare(b.role) || a.name.localeCompare(b.name);
    return a.joinedAt - b.joinedAt;
  });
}

function getTabPath(orgId: string, tab: DetailTab): string {
  if (tab === "members") return `/organisations/${orgId}`;
  return `/organisations/${orgId}/${tab}`;
}

export function OrganisationPage(props: { section?: DetailTab }): React.JSX.Element {
  const { orgId } = useParams();
  return orgId ? <OrganisationDetailPage orgId={orgId} tab={props.section ?? "members"} /> : <OrganisationListPage />;
}

function OrganisationListPage(): React.JSX.Element {
  const auth = useDesktopAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [orgs, setOrgs] = useState<ApiOrgSummary[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("name");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showAcceptInvite, setShowAcceptInvite] = useState(false);

  const reload = async (): Promise<void> => {
    if (auth.state.status !== "signed-in") return;
    setLoading(true);
    setError(null);
    try {
      const [profile, list] = await Promise.all([
        api.fetchAccountProfile(auth.getToken),
        api.listOrganizations(auth.getToken)
      ]);
      setActiveOrgId(profile.activeOrgId);
      setOrgs(list.organizations);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load organisations.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, [auth.state.status]);

  const orderedOrgs = useMemo(() => sortOrganizations(orgs, activeOrgId, sort), [activeOrgId, orgs, sort]);

  return (
    <div className="page org-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Organisations</h1>
          <p className="page-subtitle">Workspaces you belong to, with active workspace kept at the top.</p>
        </div>
        <div className="row">
          <Button variant="ghost" size="sm" type="button" onClick={() => setShowAcceptInvite(true)}>
            Accept invite
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={() => setShowCreate(true)}>
            New organisation
          </Button>
        </div>
      </div>

      <div className="org-list-toolbar">
        <span className="muted">{loading ? "Loading..." : `${orgs.length} organisation${orgs.length === 1 ? "" : "s"}`}</span>
        <label className="org-sort-control">
          <span>Order by</span>
          <UiSelect ariaLabel="Order organisations by" options={sortOptions} value={sort} onValueChange={setSort} />
        </label>
      </div>

      {error ? <div className="auth-error">{error}</div> : null}

      <section className="org-table-shell">
        {orderedOrgs.length === 0 ? (
          <div className="empty-state">
            <h3>{loading ? "Loading organisations..." : "No organisations yet"}</h3>
            <p>Create an organisation, or paste an invitation code someone shared with you.</p>
          </div>
        ) : (
          <table className="table org-list-table">
            <thead>
              <tr>
                <th>Organisation</th>
                <th>Role</th>
                <th>Joined</th>
                <th>Members</th>
                <th>Activity</th>
              </tr>
            </thead>
            <tbody>
              {orderedOrgs.map((org) => (
                <tr key={org.id} data-active={org.id === activeOrgId ? "true" : "false"} tabIndex={0} role="link" onClick={() => navigate(`/organisations/${org.id}`)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); navigate(`/organisations/${org.id}`); } }}>
                  <td>
                    <div className="org-title-cell">
                      <div className="sidebar-account-avatar">{getInitials(org.name)}</div>
                      <div>
                        <strong>{org.name}</strong>
                        <span>{org.isPersonal ? "Personal workspace" : "Organisation workspace"}</span>
                      </div>
                    </div>
                  </td>
                  <td><span className={`chip ${roleChipClass(org.role)}`}>{org.role}</span></td>
                  <td className="muted">{formatRelativeTime(org.joinedAt)}</td>
                  <td className="muted">{org.memberCount}</td>
                  <td className="muted">{org.evidenceCount.toLocaleString()} evidences · {org.commentCount.toLocaleString()} discussions</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {showCreate ? (
        <CreateOrganizationDialog
          onClose={() => setShowCreate(false)}
          onCreated={async (created) => {
            setShowCreate(false);
            await reload();
            await auth.refreshProfile();
            navigate(`/organisations/${created.id}`);
          }}
        />
      ) : null}

      {showAcceptInvite ? (
        <AcceptInvitationDialog
          onClose={() => setShowAcceptInvite(false)}
          onAccepted={async (id) => {
            setShowAcceptInvite(false);
            await reload();
            await auth.refreshProfile();
            navigate(`/organisations/${id}`);
          }}
        />
      ) : null}
    </div>
  );
}

function OrganisationDetailPage(props: { orgId: string; tab: DetailTab }): React.JSX.Element {
  const { orgId, tab } = props;
  const auth = useDesktopAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [orgs, setOrgs] = useState<ApiOrgSummary[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [membersResult, setMembersResult] = useState<ApiMembersResponse>({ members: [], total: 0, page: 1, limit: 20 });
  const [memberSearch, setMemberSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [memberPage, setMemberPage] = useState(1);
  const [invitations, setInvitations] = useState<ApiInvitation[]>([]);
  const [codes, setCodes] = useState<ApiInvitationCode[]>([]);
  const [createdCode, setCreatedCode] = useState<ApiCreatedInvitationCode | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const org = orgs.find((candidate) => candidate.id === orgId) ?? null;
  const canManage = org?.role === "owner" || org?.role === "moderator";
  const isOwner = org?.role === "owner";
  const pages = Math.max(1, Math.ceil(membersResult.total / membersResult.limit));

  const loadShell = async (): Promise<void> => {
    if (auth.state.status !== "signed-in") return;
    setLoading(true);
    setError(null);
    try {
      const [profile, list] = await Promise.all([
        api.fetchAccountProfile(auth.getToken),
        api.listOrganizations(auth.getToken)
      ]);
      setActiveOrgId(profile.activeOrgId);
      setOrgs(list.organizations);
      if (!list.organizations.some((candidate) => candidate.id === orgId)) {
        navigate("/organisations");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load organisation.");
    } finally {
      setLoading(false);
    }
  };

  const loadMembers = async (): Promise<void> => {
    const result = await api.listMembers(auth.getToken, orgId, {
      search: memberSearch.trim() || undefined,
      role: roleFilter,
      page: memberPage,
      limit: 20
    });
    setMembersResult(result);
  };

  useEffect(() => {
    void loadShell();
  }, [auth.state.status, orgId]);

  useEffect(() => {
    if (tab !== "members" || auth.state.status !== "signed-in") return;
    void loadMembers().catch((err) => setError(err instanceof Error ? err.message : "Unable to load members."));
  }, [auth.state.status, orgId, tab, memberSearch, roleFilter, memberPage]);

  useEffect(() => {
    if (tab !== "invitations" || !canManage) return;
    void api.listInvitations(auth.getToken, orgId).then((result) => {
      setInvitations(result.invitations);
      setCodes(result.codes);
    }).catch((err) => setError(err instanceof Error ? err.message : "Unable to load invitations."));
  }, [canManage, orgId, tab]);

  const refreshInvitations = async (): Promise<void> => {
    const result = await api.listInvitations(auth.getToken, orgId);
    setInvitations(result.invitations);
    setCodes(result.codes);
  };

  const updateRole = async (member: ApiMember, role: "moderator" | "member"): Promise<void> => {
    setBusy(true);
    try {
      await api.updateMemberRole(auth.getToken, orgId, member.membershipId, role);
      toast.success("Member role updated");
      await loadMembers();
    } catch (err) {
      toast.error("Role update failed", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (member: ApiMember): Promise<void> => {
    setBusy(true);
    try {
      await api.removeMember(auth.getToken, orgId, member.membershipId);
      toast.success("Member removed");
      await loadMembers();
      await loadShell();
    } catch (err) {
      toast.error("Remove failed", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const leave = async (): Promise<void> => {
    if (!org || !window.confirm(`Leave ${org.name}?`)) return;
    setBusy(true);
    try {
      await api.leaveOrganization(auth.getToken, org.id);
      await auth.refreshProfile();
      toast.success("Left organisation");
      navigate("/organisations");
    } catch (err) {
      toast.error("Unable to leave organisation", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page org-page">
      <div className="page-header">
        <div>
          <Button variant="ghost" size="xs" type="button" onClick={() => navigate("/organisations")}>
            Back
          </Button>
          <h1 className="page-title">{org?.name ?? "Organisation"}</h1>
          <p className="page-subtitle">
            {org ? `${org.memberCount} member${org.memberCount === 1 ? "" : "s"} · your role is ${org.role}` : loading ? "Loading organisation..." : "Organisation not found"}
          </p>
        </div>
        {org?.id === activeOrgId ? <span className="chip success">active</span> : null}
      </div>

      <div className="org-detail-tabs">
        {tabs.map((item) => (
          <button key={item.id} type="button" data-active={tab === item.id} onClick={() => navigate(getTabPath(orgId, item.id))}>
            {item.label}
          </button>
        ))}
      </div>

      {error ? <div className="auth-error">{error}</div> : null}

      {tab === "members" ? (
        <section className="org-section">
          <div className="auth-toolbar org-member-toolbar">
            <TextInput
              className="org-member-search"
              type="search"
              placeholder="Search members by name, email, or role"
              value={memberSearch}
              onChange={(event) => {
                setMemberPage(1);
                setMemberSearch(event.currentTarget.value);
              }}
            />
            <UiSelect
              ariaLabel="Filter members by role"
              className="org-member-role-filter"
              options={roleFilterOptions}
              value={roleFilter}
              onValueChange={(value) => {
                setMemberPage(1);
                setRoleFilter(value);
              }}
            />
          </div>
          <MemberStatsChart members={membersResult.members} />
          <MemberTable
            members={membersResult.members}
            canManage={canManage}
            isOwner={isOwner}
            busy={busy}
            onRoleChange={updateRole}
            onRemove={removeMember}
          />
          <Pagination page={memberPage} pages={pages} total={membersResult.total} onPage={setMemberPage} />
        </section>
      ) : null}

      {tab === "invitations" && org ? (
        <InvitationCodePanel
          org={org}
          canManage={canManage}
          isOwner={isOwner}
          busy={busy}
          codes={codes}
          invitations={invitations}
          createdCode={createdCode}
          setBusy={setBusy}
          setCreatedCode={setCreatedCode}
          reload={refreshInvitations}
        />
      ) : null}

      {tab === "storage" ? <OrganisationStorageSection orgId={orgId} /> : null}

      {tab === "options" && org ? (
        <section className="org-options">
          <OptionRow title="Leave organisation" detail="Remove your membership from this organisation.">
            <Button variant="danger" size="sm" type="button" disabled={busy || org.isPersonal} onClick={() => void leave()}>
              Leave
            </Button>
          </OptionRow>
          {isOwner ? (
            <OptionRow title="Transfer organisation" detail="Transfer ownership to another member before stepping away.">
              <Button variant="ghost" size="sm" type="button" disabled>
                Transfer
              </Button>
            </OptionRow>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function evidenceMethodLabel(method: string): string {
  return method.replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function MemberStatsChart({ members }: { members: ApiMember[] }): React.JSX.Element {
  const methods = new Map<string, number>();
  for (const member of members) for (const method of member.evidenceMethods) methods.set(method, (methods.get(method) ?? 0) + member.evidenceCount);
  const rows = [...methods.entries()].sort((a, b) => b[1] - a[1]);
  const totalEvidence = members.reduce((sum, member) => sum + member.evidenceCount, 0);
  const totalComments = members.reduce((sum, member) => sum + member.commentCount, 0);
  const max = Math.max(1, ...rows.map(([, count]) => count));
  return <div className="member-stats-chart"><div><strong>{totalEvidence.toLocaleString()}</strong> evidences · <strong>{totalComments.toLocaleString()}</strong> discussions</div><div className="member-method-bars">{rows.length ? rows.map(([method, count]) => <div key={method}><span>{evidenceMethodLabel(method)}</span><i style={{ width: `${(count / max) * 100}%` }} /><b>{count}</b></div>) : <span className="muted">No evidence recorded on this page.</span>}</div></div>;
}

function MemberTable(props: {
  members: ApiMember[];
  canManage: boolean;
  isOwner: boolean;
  busy: boolean;
  onRoleChange: (member: ApiMember, role: "moderator" | "member") => Promise<void>;
  onRemove: (member: ApiMember) => Promise<void>;
}): React.JSX.Element {
  return (
    <table className="table">
      <thead><tr><th>User</th><th>Role</th><th>Evidences</th><th>Discussions</th><th>Joined</th><th>Expiration</th><th style={{ textAlign: "right" }}>Actions</th></tr></thead>
      <tbody>
        {props.members.map((member) => {
          const canEdit = props.canManage && member.role !== "owner" && (props.isOwner || member.role === "member");
          return (
            <tr key={member.membershipId}>
              <td>
                <div className="org-title-cell">
                  <div className="sidebar-account-avatar">{getInitials(getMemberPrimaryText(member))}</div>
                  <div><strong>{getMemberPrimaryText(member)}</strong><span>{member.email ?? "No email available"}</span></div>
                </div>
              </td>
              <td><span className={`chip ${roleChipClass(member.role)}`}>{member.role}</span></td>
              <td className="muted">{member.evidenceCount.toLocaleString()}</td>
              <td className="muted">{member.commentCount.toLocaleString()}</td>
              <td className="muted">{formatRelativeTime(member.joinedAt)}</td>
              <td className="muted">{member.guestExpiresAt ? formatRelativeTime(member.guestExpiresAt) : "N/A"}</td>
              <td>
                <div className="table-actions">
                  {canEdit && props.isOwner ? (
                    <UiSelect ariaLabel={`Change role for ${getMemberPrimaryText(member)}`} className="ui-select-trigger-xs" options={editableRoleOptions} value={member.role === "moderator" ? "moderator" : "member"} disabled={props.busy} onValueChange={(value) => void props.onRoleChange(member, value)} />
                  ) : null}
                  {canEdit ? <Button variant="ghost" size="xs" type="button" disabled={props.busy} onClick={() => void props.onRemove(member)}>Remove</Button> : null}
                </div>
              </td>
            </tr>
          );
        })}
        {props.members.length === 0 ? <tr><td colSpan={7} className="muted">No members match this filter.</td></tr> : null}
      </tbody>
    </table>
  );
}

function Pagination(props: { page: number; pages: number; total: number; onPage: (page: number) => void }): React.JSX.Element {
  return (
    <div className="org-pagination">
      <span className="muted">{props.total} member{props.total === 1 ? "" : "s"}</span>
      <div className="row">
        <Button variant="ghost" size="xs" type="button" disabled={props.page <= 1} onClick={() => props.onPage(props.page - 1)}>Previous</Button>
        <span className="muted">Page {props.page} of {props.pages}</span>
        <Button variant="ghost" size="xs" type="button" disabled={props.page >= props.pages} onClick={() => props.onPage(props.page + 1)}>Next</Button>
      </div>
    </div>
  );
}

function OptionRow(props: { title: string; detail: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="org-option-row">
      <div>
        <h3>{props.title}</h3>
        <p>{props.detail}</p>
      </div>
      {props.children}
    </div>
  );
}

function InvitationCodePanel(props: {
  org: ApiOrgSummary;
  canManage: boolean;
  isOwner: boolean;
  busy: boolean;
  codes: ApiInvitationCode[];
  invitations: ApiInvitation[];
  createdCode: ApiCreatedInvitationCode | null;
  setBusy: (busy: boolean) => void;
  setCreatedCode: (code: ApiCreatedInvitationCode | null) => void;
  reload: () => Promise<void>;
}): React.JSX.Element {
  const auth = useDesktopAuth();
  const toast = useToast();
  const form = useForm<InvitationCodeFormValues>({
    resolver: zodResolver(invitationCodeFormSchema),
    defaultValues: { label: "Team onboarding", role: "member", password: "", emailDomain: "", expiresDays: "", guestDays: "" }
  });
  const [showCreate, setShowCreate] = useState(false);
  const roleValue = form.watch("role");
  const guestDaysValue = form.watch("guestDays");

  const createCode = async (values: InvitationCodeFormValues): Promise<void> => {
    props.setBusy(true);
    try {
      const result = await api.createInvitationCode(auth.getToken, props.org.id, {
        label: values.label.trim(),
        role: values.role,
        emailDomain: values.emailDomain || null,
        expiresAt: values.expiresDays ? Date.now() + Number(values.expiresDays) * 24 * 60 * 60 * 1000 : null,
        guestExpiresAfterDays: values.guestDays ? Number(values.guestDays) : null,
        ...(values.password?.trim() ? { password: values.password.trim() } : {})
      });
      props.setCreatedCode(result.code);
      form.setValue("password", "");
      setShowCreate(false);
      toast.success("Invitation code created");
      await props.reload();
    } catch (err) {
      toast.error("Code creation failed", err instanceof Error ? err.message : undefined);
    } finally {
      props.setBusy(false);
    }
  };

  const lockCode = async (code: ApiInvitationCode, locked: boolean): Promise<void> => {
    props.setBusy(true);
    try {
      await api.setInvitationCodeLocked(auth.getToken, props.org.id, code.id, locked);
      toast.success(locked ? "Invitation code locked" : "Invitation code unlocked");
      await props.reload();
    } catch (err) {
      toast.error("Code update failed", err instanceof Error ? err.message : undefined);
    } finally {
      props.setBusy(false);
    }
  };

  const deleteCode = async (code: ApiInvitationCode): Promise<void> => {
    props.setBusy(true);
    try {
      await api.deleteInvitationCode(auth.getToken, props.org.id, code.id);
      toast.success("Invitation code deleted");
      await props.reload();
    } catch (err) {
      toast.error("Code deletion failed", err instanceof Error ? err.message : undefined);
    } finally {
      props.setBusy(false);
    }
  };

  if (!props.canManage) {
    return <div className="empty-state"><h3>Member access</h3><p>Owners and moderators manage invitation codes.</p></div>;
  }

  return (
    <section className="org-section">
      <div className="org-section-header">
        <div>
          <h2>Invitation codes</h2>
          <p>Reusable codes for member onboarding.</p>
        </div>
        <Button variant="primary" size="sm" type="button" onClick={() => setShowCreate(true)} disabled={props.busy || props.codes.length >= 3}>Create</Button>
      </div>

      {props.createdCode ? (
        <div className="invite-token-box">
          <span className="detail-label">New static joining link</span>
          <span>{props.createdCode.code}</span>
          <div className="row">
            <Button variant="primary" size="xs" type="button" onClick={async () => { await copyToClipboard(props.createdCode?.code ?? ""); toast.success("Code copied"); }}>Copy code</Button>
            <Button variant="ghost" size="xs" type="button" onClick={async () => { await copyToClipboard(getInviteUrl(props.createdCode?.code ?? "")); toast.success("Join URL copied"); }}>Copy URL</Button>
            <Button variant="ghost" size="xs" type="button" onClick={() => props.setCreatedCode(null)}>Done</Button>
          </div>
        </div>
      ) : null}

      <table className="table">
        <thead><tr><th>Code</th><th>Restrictions</th><th>Guest</th><th>Status</th><th style={{ textAlign: "right" }}>Actions</th></tr></thead>
        <tbody>
          {props.codes.map((code) => (
            <tr key={code.id}>
              <td><strong>{code.label}</strong><span className="muted block">{code.role}</span></td>
              <td className="muted">{[code.hasPassword ? "password" : null, code.emailDomain ? `@${code.emailDomain}` : null, code.expiresAt ? `expires ${formatRelativeTime(code.expiresAt)}` : null].filter(Boolean).join(" · ") || "None"}</td>
              <td className="muted">{code.guestExpiresAfterDays ? `${code.guestExpiresAfterDays} days` : "Permanent"}</td>
              <td><span className={`chip ${code.lockedAt ? "danger" : "success"}`}>{code.lockedAt ? "locked" : "active"}</span></td>
              <td><div className="table-actions">{props.isOwner ? <Button variant="ghost" size="xs" type="button" disabled={props.busy} onClick={() => void lockCode(code, !code.lockedAt)}>{code.lockedAt ? "Unlock" : "Lock"}</Button> : null}<Button variant="ghost" size="xs" type="button" disabled={props.busy} onClick={() => void deleteCode(code)}>Delete</Button></div></td>
            </tr>
          ))}
          {props.codes.length === 0 ? <tr><td colSpan={5} className="muted">No static codes yet. Create one for repeat onboarding.</td></tr> : null}
        </tbody>
      </table>

      {props.invitations.length > 0 ? (
        <table className="table">
          <thead><tr><th>Direct invitation</th><th>Role</th><th>Status</th></tr></thead>
          <tbody>{props.invitations.map((invitation) => <tr key={invitation.id}><td>{invitation.email}</td><td><span className={`chip ${roleChipClass(invitation.role)}`}>{invitation.role}</span></td><td><span className="chip neutral">{invitation.status}</span></td></tr>)}</tbody>
        </table>
      ) : null}
      {showCreate ? (
        <Dialog open onClose={() => setShowCreate(false)} title="Create invitation code" footer={<><Button variant="ghost" size="sm" type="button" onClick={() => setShowCreate(false)} disabled={props.busy}>Cancel</Button><Button variant="primary" size="sm" type="button" onClick={() => void form.handleSubmit(createCode)()} disabled={props.busy}>{props.busy ? "Creating..." : "Create"}</Button></>}>
          <form className="column" style={{ gap: 12 }} onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(createCode)(event); }}>
            <label className="field"><span>Label</span><TextInput className="field-input" autoFocus {...form.register("label")} />{form.formState.errors.label ? <span className="field-error">{form.formState.errors.label.message}</span> : null}</label>
            <label className="field"><span>Role</span><UiSelect ariaLabel="Invitation role" className="field-input" options={editableRoleOptions} value={roleValue} onValueChange={(value) => form.setValue("role", value, { shouldDirty: true, shouldValidate: true })} /></label>
            <label className="field"><span>Password</span><TextInput className="field-input" type="password" placeholder="Optional" {...form.register("password")} /></label>
            <label className="field"><span>Email domain</span><TextInput className="field-input" placeholder="littlelives.com" {...form.register("emailDomain")} />{form.formState.errors.emailDomain ? <span className="field-error">{form.formState.errors.emailDomain.message}</span> : null}</label>
            <label className="field"><span>Code expires in days</span><TextInput className="field-input" type="number" min="1" placeholder="No expiry" {...form.register("expiresDays")} />{form.formState.errors.expiresDays ? <span className="field-error">{form.formState.errors.expiresDays.message}</span> : null}</label>
            <label className="field"><span>Guest days</span><UiSelect ariaLabel="Guest duration" className="field-input" options={guestDayOptions} value={guestDaysValue} onValueChange={(value) => form.setValue("guestDays", value, { shouldDirty: true, shouldValidate: true })} /></label>
          </form>
        </Dialog>
      ) : null}
    </section>
  );
}

function CreateOrganizationDialog(props: {
  onClose: () => void;
  onCreated: (organization: ApiOrgSummary) => Promise<void>;
}): React.JSX.Element {
  const auth = useDesktopAuth();
  const form = useForm<CreateOrganizationFormValues>({ resolver: zodResolver(createOrganizationFormSchema), defaultValues: { name: "" } });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (values: CreateOrganizationFormValues): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.createOrganization(auth.getToken, values.name.trim());
      await props.onCreated(result.organization);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create organisation.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={props.onClose} title="Create organisation" footer={<><Button variant="ghost" size="sm" type="button" onClick={props.onClose} disabled={busy}>Cancel</Button><Button variant="primary" size="sm" type="button" onClick={() => void form.handleSubmit(submit)()} disabled={busy}>{busy ? "Creating..." : "Create"}</Button></>}>
      <form className="column" style={{ gap: 12 }} onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(submit)(event); }}>
        <label className="field"><span>Name</span><TextInput className="field-input" autoFocus {...form.register("name")} />{form.formState.errors.name ? <span className="field-error">{form.formState.errors.name.message}</span> : null}</label>
      </form>
      {error ? <div className="auth-error">{error}</div> : null}
    </Dialog>
  );
}

function AcceptInvitationDialog(props: {
  onClose: () => void;
  onAccepted: (orgId: string) => Promise<void>;
}): React.JSX.Element {
  const auth = useDesktopAuth();
  const form = useForm<AcceptInvitationFormValues>({ resolver: zodResolver(acceptInvitationFormSchema), defaultValues: { token: "", password: "" } });
  const [requiresPassword, setRequiresPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (values: AcceptInvitationFormValues): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (!requiresPassword) {
        const lookup = await api.lookupInvitation(auth.getToken, values.token.trim()).catch(() => null);
        if (lookup?.code.requiresPassword) {
          setRequiresPassword(true);
          setError("This invitation code is password protected.");
          return;
        }
      }
      if (requiresPassword && !values.password) {
        setError("Enter the invitation password.");
        return;
      }
      const result = await api.acceptInvitation(auth.getToken, values.token.trim(), requiresPassword ? values.password : undefined);
      await props.onAccepted(result.organizationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to accept invitation.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={props.onClose} title="Accept invitation" footer={<><Button variant="ghost" size="sm" type="button" onClick={props.onClose} disabled={busy}>Cancel</Button><Button variant="primary" size="sm" type="button" onClick={() => void form.handleSubmit(submit)()} disabled={busy}>{busy ? "Joining..." : "Join"}</Button></>}>
      <form className="column" style={{ gap: 12 }} onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(submit)(event); }}>
        <label className="field"><span>Invitation code</span><TextInput className="field-input" mono autoFocus {...form.register("token")} />{form.formState.errors.token ? <span className="field-error">{form.formState.errors.token.message}</span> : null}</label>
        {requiresPassword ? <label className="field"><span>Password</span><TextInput className="field-input" type="password" {...form.register("password")} /></label> : null}
      </form>
      {error ? <div className="auth-error">{error}</div> : null}
    </Dialog>
  );
}
