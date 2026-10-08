import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Dialog, TextInput, UiSelect } from "@jittle-lamp/ui";
import {
  corsRuleFor,
  createOrganizationStorageInputSchema,
  formatBytes,
  formatShare,
  kindShareRows,
  memberShareRows,
  storagePeriodRange,
  storagePeriods,
  storageShareRows,
  updateOrganizationStorageInputSchema,
  usageBars,
  type OrganizationStorage,
  type OrganizationStorageOverview,
  type StoragePeriodId,
  type StorageShareRow,
  type StorageTransfer,
  type StorageUsageReport
} from "@jittle-lamp/shared";

import { api, webOrigin } from "../api";
import { useDesktopAuth } from "../auth-context";
import { useToast } from "../ui/toast";

// Organisation storage tab: same statistics and storage configuration as evidence-web
// (apps/evidence-web/src/pages/organisation-storage.tsx), in the desktop styles.

const DEFAULT_OPTION = "default";

const errorText = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

function ShareList(props: { rows: StorageShareRow[]; empty: string; searchable?: boolean }): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(50);
  const normalized = query.trim().toLowerCase();
  const filteredRows = normalized ? props.rows.filter((row) => `${row.label} ${row.detail}`.toLowerCase().includes(normalized)) : props.rows;
  useEffect(() => setVisibleCount(50), [query, props.rows.length]);
  if (props.rows.length === 0) return <p className="storage-muted">{props.empty}</p>;
  return (
    <div className="storage-share-panel">
      {props.searchable ? <TextInput aria-label="Search members" placeholder="Search members" value={query} onChange={(event) => setQuery(event.target.value)} /> : null}
      {filteredRows.length === 0 ? <p className="storage-muted">No matching members.</p> : (
        <div className="storage-share-scroll" onScroll={(event) => {
          const element = event.currentTarget;
          if (element.scrollTop + element.clientHeight >= element.scrollHeight - 48) setVisibleCount((count) => Math.min(count + 50, filteredRows.length));
        }}>
          <ul className="storage-share-list">
            {filteredRows.slice(0, visibleCount).map((row) => (
              <li key={row.key}>
                <div className="storage-share-head"><span className={row.muted ? "storage-share-removed" : undefined}>{row.label}</span><strong>{formatBytes(row.bytes)}</strong></div>
                <div className="storage-meter" aria-hidden><div data-muted={row.muted ? "true" : undefined} style={{ width: `${Math.max(row.share * 100, row.bytes > 0 ? 1.5 : 0)}%` }} /></div>
                <span className="storage-muted">{formatShare(row.share)} · {row.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function UsageChart(props: { report: StorageUsageReport }): React.JSX.Element {
  const bars = usageBars(props.report);
  const labelEvery = bars.length > 31 ? 14 : bars.length > 10 ? 5 : 1;
  const points = bars.map((bar, index) => `${((index + 0.5) / Math.max(bars.length, 1)) * 100},${100 - bar.storedRatio * 100}`).join(" ");
  return (
    <figure className="storage-chart">
      <div className="storage-legend" aria-hidden>
        <span>
          <i className="storage-legend-bar" /> Added in period
        </span>
        <span>
          <i className="storage-legend-line" /> Stored at end of period
        </span>
      </div>
      <div className="storage-chart-plot" role="img" aria-label={`Storage usage. ${formatBytes(props.report.totals.bytes)} stored now.`}>
        <div className="storage-chart-bars">
          {bars.map((bar) => (
            <div key={bar.bucket} className="storage-chart-column" title={bar.description}>
              <div data-empty={bar.addedBytes === 0 ? "true" : undefined} style={{ height: `${bar.addedBytes > 0 ? Math.max(bar.addedRatio * 100, 2) : 1}%` }} />
            </div>
          ))}
        </div>
        {bars.length > 1 ? (
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            <polyline points={points} fill="none" stroke="var(--text)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </svg>
        ) : null}
      </div>
      <div className="storage-chart-labels" aria-hidden>
        {bars.map((bar, index) => (
          <span key={bar.bucket}>{index % labelEvery === 0 ? bar.label : ""}</span>
        ))}
      </div>
    </figure>
  );
}

export function OrganisationStorageSection(props: { orgId: string }): React.JSX.Element {
  const { orgId } = props;
  const auth = useDesktopAuth();
  const [periodId, setPeriodId] = useState<StoragePeriodId>("30d");
  const range = useMemo(() => storagePeriodRange(periodId, Date.now()), [periodId]);
  const [report, setReport] = useState<StorageUsageReport | null>(null);
  const [overview, setOverview] = useState<OrganizationStorageOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signedIn = auth.state.status === "signed-in";

  const loadOverview = useCallback(async () => {
    setOverview(await api.storageOverview(auth.getToken, orgId));
  }, [auth.getToken, orgId]);

  const reload = useCallback(async () => {
    try {
      const [usage] = await Promise.all([api.storageUsage(auth.getToken, orgId, range), loadOverview()]);
      setReport(usage);
      setError(null);
    } catch (err) {
      setError(errorText(err, "Unable to load storage."));
    }
  }, [auth.getToken, orgId, range, loadOverview]);

  useEffect(() => {
    if (signedIn) void reload();
  }, [signedIn, reload]);

  // Poll while a transfer runs.
  const transferActive = Boolean(overview?.activeTransfer);
  useEffect(() => {
    if (!transferActive) return;
    const timer = window.setInterval(() => void reload(), 3_000);
    return () => window.clearInterval(timer);
  }, [transferActive, reload]);

  return (
    <div className="storage-page">
      <div className="org-section-header">
        <div>
          <h2>Storage</h2>
          <p>Space used by this organisation's evidence, by member, storage and file type.</p>
        </div>
        <div className="storage-periods" role="radiogroup" aria-label="Period">
          {storagePeriods.map((period) => (
            <button key={period.id} type="button" role="radio" aria-checked={periodId === period.id} data-active={periodId === period.id} onClick={() => setPeriodId(period.id)}>
              {period.label}
            </button>
          ))}
        </div>
      </div>

      {error ? <div className="auth-error">{error}</div> : null}
      {!report ? (
        <p className="storage-muted">Loading storage…</p>
      ) : (
        <>
          <div className="storage-stats">
            <div className="storage-stat">
              <span>Stored</span>
              <strong>{formatBytes(report.totals.bytes)}</strong>
            </div>
            <div className="storage-stat">
              <span>Evidence</span>
              <strong>{report.totals.evidenceCount.toLocaleString()}</strong>
            </div>
            <div className="storage-stat">
              <span>Files</span>
              <strong>{report.totals.artifactCount.toLocaleString()}</strong>
            </div>
            <div className="storage-stat">
              <span>In the bin</span>
              <strong>{formatBytes(report.totals.binBytes)}</strong>
            </div>
          </div>
          <section className="org-section">
            <div className="org-section-header">
              <div>
                <h2>Usage over time</h2>
                <p>Bars show data added in each period; the line shows the total stored.</p>
              </div>
            </div>
            <UsageChart report={report} />
          </section>
          <div className="storage-grid">
            <section className="org-section">
              <div className="org-section-header">
                <h2>By member</h2>
              </div>
              <ShareList rows={memberShareRows(report, auth.state.status === "signed-in" ? (auth.state.profile?.localUserId ?? null) : null)} empty="No evidence yet." searchable />
            </section>
            <section className="org-section">
              <div className="org-section-header">
                <h2>By storage</h2>
              </div>
              <ShareList rows={storageShareRows(report)} empty="No evidence yet." />
            </section>
            <section className="org-section">
              <div className="org-section-header">
                <h2>By file type</h2>
              </div>
              <ShareList rows={kindShareRows(report)} empty="No evidence yet." />
            </section>
          </div>
        </>
      )}

      {overview?.canManage ? <StorageConfiguration orgId={orgId} overview={overview} onChanged={reload} /> : null}
    </div>
  );
}

function StorageConfiguration(props: { orgId: string; overview: OrganizationStorageOverview; onChanged: () => Promise<void> }): React.JSX.Element {
  const { orgId, overview } = props;
  const auth = useDesktopAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<OrganizationStorage | "new" | null>(null);
  const [deleting, setDeleting] = useState<OrganizationStorage | null>(null);
  const activeStorages = overview.storages.filter((storage) => storage.status === "active");

  const run = async (action: () => Promise<unknown>, success: string, failure: string) => {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      await props.onChanged();
    } catch (err) {
      toast.error(failure, errorText(err, ""));
    } finally {
      setBusy(false);
    }
  };

  const writeOptions = [
    ...(overview.settings.defaultStorageDisabled ? [] : [{ value: DEFAULT_OPTION, label: "JittleLamp storage" }]),
    ...activeStorages.map((storage) => ({ value: storage.id, label: storage.name }))
  ];

  return (
    <>
      <div className="org-section-header storage-config-header">
        <div>
          <h2>Storage configuration</h2>
          <p>Keep evidence in your own S3-compatible bucket next to, or instead of, JittleLamp storage.</p>
        </div>
      </div>
      {!overview.secretsAvailable ? <div className="auth-error">This server has no secrets master key, so storage credentials cannot be saved.</div> : null}

      <section className="org-section">
        <div className="org-section-header">
          <div>
            <h2>Where new evidence is saved</h2>
            <p>Existing files stay where they are; use a transfer to move them.</p>
          </div>
        </div>
        <label className="field storage-narrow">
          <span>Default storage</span>
          <UiSelect
            ariaLabel="Default storage"
            className="field-input"
            disabled={busy}
            options={writeOptions}
            value={overview.settings.defaultStorageId ?? DEFAULT_OPTION}
            onValueChange={(value) =>
              void run(
                () => api.updateStorageSettings(auth.getToken, orgId, { defaultStorageId: value === DEFAULT_OPTION ? null : value }),
                "Default storage updated",
                "Could not update the default storage"
              )
            }
          />
        </label>
        {activeStorages.length > 0 ? <label className="storage-toggle">
          <input
            type="checkbox"
            checked={overview.settings.defaultStorageDisabled}
            disabled={busy || (!overview.settings.defaultStorageId && !overview.settings.defaultStorageDisabled)}
            onChange={(event) =>
              void run(
                () => api.updateStorageSettings(auth.getToken, orgId, { defaultStorageDisabled: event.target.checked }),
                event.target.checked ? "JittleLamp storage turned off" : "JittleLamp storage turned on",
                "Could not update storage settings"
              )
            }
          />
          <span>
            <strong>Turn off JittleLamp storage</strong>
            <span className="storage-muted">
              {overview.settings.defaultStorageId ? " New evidence is never saved to JittleLamp storage." : " Choose one of your storages as the default first."}
            </span>
          </span>
        </label> : null}
      </section>

      <section className="org-table-shell">
        <div className="org-section-header storage-table-header">
          <div>
            <h2>Your storages</h2>
            <p>
              JittleLamp storage holds {formatBytes(overview.defaultStorageUsage.bytes)} in {overview.defaultStorageUsage.artifactCount.toLocaleString()} files.
            </p>
          </div>
          <Button variant="primary" size="sm" disabled={!overview.secretsAvailable} onClick={() => setEditing("new")}>
            Add storage
          </Button>
        </div>
        {overview.storages.length === 0 ? null : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Bucket</th>
                <th>Used</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {overview.storages.map((storage) => (
                <tr key={storage.id}>
                  <td>
                    {storage.name} {overview.settings.defaultStorageId === storage.id ? <span className="chip accent">default</span> : null}
                  </td>
                  <td>
                    <code>{storage.keyPrefix ? `${storage.bucket}/${storage.keyPrefix}` : storage.bucket}</code>
                    <span className="storage-muted storage-block">{storage.endpoint ?? `AWS S3 · ${storage.region}`}</span>
                  </td>
                  <td>
                    {formatBytes(storage.usage.bytes)}
                    <span className="storage-muted storage-block">{storage.usage.artifactCount.toLocaleString()} files</span>
                  </td>
                  <td>{storage.status === "active" ? <span className="chip success">connected</span> : <span className="chip danger">removed</span>}</td>
                  <td>
                    {storage.status === "active" ? (
                      <div className="table-actions">
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={busy}
                          onClick={() => void run(() => api.testStorage(auth.getToken, orgId, storage.id), `${storage.name} is reachable`, "Connection failed")}
                        >
                          Test
                        </Button>
                        <Button variant="ghost" size="xs" onClick={() => setEditing(storage)}>
                          Edit
                        </Button>
                        <Button variant="danger" size="xs" onClick={() => setDeleting(storage)}>
                          Remove
                        </Button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {activeStorages.length > 0 ? <TransferSection orgId={orgId} overview={overview} onChanged={props.onChanged} /> : null}

      {editing ? (
        <StorageFormDialog
          orgId={orgId}
          storage={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await props.onChanged();
          }}
        />
      ) : null}
      {deleting ? (
        <DeleteStorageDialog
          orgId={orgId}
          storage={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={async () => {
            setDeleting(null);
            await props.onChanged();
          }}
        />
      ) : null}
    </>
  );
}

function storageName(overview: OrganizationStorageOverview, storageId: string | null): string {
  if (!storageId) return "JittleLamp storage";
  return overview.storages.find((storage) => storage.id === storageId)?.name ?? "Removed storage";
}

function TransferSection(props: { orgId: string; overview: OrganizationStorageOverview; onChanged: () => Promise<void> }): React.JSX.Element {
  const { orgId, overview } = props;
  const auth = useDesktopAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const activeStorages = overview.storages.filter((storage) => storage.status === "active");
  const sources = [
    ...(overview.defaultStorageUsage.artifactCount > 0 ? [{ value: DEFAULT_OPTION, label: `JittleLamp storage (${formatBytes(overview.defaultStorageUsage.bytes)})` }] : []),
    ...activeStorages.filter((storage) => storage.usage.artifactCount > 0).map((storage) => ({ value: storage.id, label: `${storage.name} (${formatBytes(storage.usage.bytes)})` }))
  ];
  const [sourceChoice, setSource] = useState(sources[0]?.value ?? DEFAULT_OPTION);
  const source = sources.some((option) => option.value === sourceChoice) ? sourceChoice : (sources[0]?.value ?? DEFAULT_OPTION);
  const targets = activeStorages.filter((storage) => storage.id !== source).map((storage) => ({ value: storage.id, label: storage.name }));
  const [targetChoice, setTarget] = useState("");
  const target = targets.some((option) => option.value === targetChoice) ? targetChoice : (targets[0]?.value ?? "");
  const transfer: StorageTransfer | null = overview.activeTransfer;

  const act = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      await props.onChanged();
    } catch (err) {
      toast.error("Transfer request failed", errorText(err, ""));
    } finally {
      setBusy(false);
    }
  };

  const ratio = transfer ? (transfer.bytesTotal > 0 ? transfer.bytesDone / transfer.bytesTotal : transfer.artifactsTotal > 0 ? transfer.artifactsDone / transfer.artifactsTotal : 0) : 0;
  const paused = transfer?.status === "paused" || transfer?.status === "pause_requested";

  return (
    <section className="org-section">
      <div className="org-section-header">
        <div>
          <h2>Transfer files</h2>
          <p>Each file is copied, its checksum verified, and only then is the original deleted.</p>
        </div>
      </div>
      {transfer ? (
        <>
          <p>
            <strong>
              {storageName(overview, transfer.sourceStorageId)} → {storageName(overview, transfer.targetStorageId)}
            </strong>{" "}
            <span className="storage-muted">
              {formatBytes(transfer.bytesDone)} of {formatBytes(transfer.bytesTotal)} · {transfer.artifactsDone} of {transfer.artifactsTotal} files
              {transfer.artifactsFailed > 0 ? ` · ${transfer.artifactsFailed} failed` : ""}
            </span>
          </p>
          <div className="storage-meter storage-progress" role="progressbar" aria-label="Transfer progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}>
            <div data-muted={paused ? "true" : undefined} style={{ width: `${Math.min(ratio, 1) * 100}%` }} />
          </div>
          <div className="table-actions">
            {paused ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void act(() => api.controlStorageTransfer(auth.getToken, orgId, transfer.id, "resume"), "Transfer resumed")}>
                Resume
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void act(() => api.controlStorageTransfer(auth.getToken, orgId, transfer.id, "pause"), "Transfer paused")}>
                Pause
              </Button>
            )}
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act(() => api.controlStorageTransfer(auth.getToken, orgId, transfer.id, "cancel"), "Transfer cancelled")}>
              Cancel
            </Button>
          </div>
        </>
      ) : sources.length === 0 || activeStorages.length === 0 ? (
        <p className="storage-muted">{activeStorages.length === 0 ? "Add a storage to transfer files into it." : "There are no files to transfer."}</p>
      ) : (
        <div className="storage-transfer-row">
          <label className="field">
            <span>From</span>
            <UiSelect ariaLabel="Transfer from" className="field-input" options={sources} value={source} onValueChange={setSource} />
          </label>
          <label className="field">
            <span>To</span>
            {targets.length > 0 ? (
              <UiSelect ariaLabel="Transfer to" className="field-input" options={targets} value={target} onValueChange={setTarget} />
            ) : (
              <span className="storage-muted">Add another storage first.</span>
            )}
          </label>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || !target}
            onClick={() =>
              void act(() => api.startStorageTransfer(auth.getToken, orgId, { sourceStorageId: source === DEFAULT_OPTION ? null : source, targetStorageId: target }), "Transfer started")
            }
          >
            Start transfer
          </Button>
        </div>
      )}
    </section>
  );
}

function StorageFormDialog(props: { orgId: string; storage: OrganizationStorage | null; onClose: () => void; onSaved: () => Promise<void> }): React.JSX.Element {
  const { orgId, storage } = props;
  const auth = useDesktopAuth();
  const toast = useToast();
  const [form, setForm] = useState({
    name: storage?.name ?? "",
    endpoint: storage?.endpoint ?? "",
    region: storage?.region ?? "us-east-1",
    bucket: storage?.bucket ?? "",
    keyPrefix: storage?.keyPrefix ?? "",
    forcePathStyle: storage?.forcePathStyle ?? false,
    serverSideEncryption: storage?.serverSideEncryption ?? true,
    accessKeyId: "",
    secretAccessKey: ""
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inUse = (storage?.usage.artifactCount ?? 0) > 0;
  const set = (key: keyof typeof form, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }));

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      if (storage) {
        const update = {
          name: form.name,
          endpoint: form.endpoint.trim() || null,
          region: form.region,
          bucket: form.bucket,
          keyPrefix: form.keyPrefix.trim() || null,
          forcePathStyle: form.forcePathStyle,
          serverSideEncryption: form.serverSideEncryption,
          ...(form.accessKeyId ? { accessKeyId: form.accessKeyId } : {}),
          ...(form.secretAccessKey ? { secretAccessKey: form.secretAccessKey } : {})
        };
        const parsed = updateOrganizationStorageInputSchema.safeParse(update);
        if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Check the storage details");
        await api.updateStorage(auth.getToken, orgId, storage.id, update);
      } else {
        const parsed = createOrganizationStorageInputSchema.safeParse(form);
        if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Check the storage details");
        await api.createStorage(auth.getToken, orgId, form);
      }
      toast.success(storage ? "Storage updated" : "Storage added");
      await props.onSaved();
    } catch (err) {
      setError(errorText(err, "Could not save the storage."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={storage ? `Edit ${storage.name}` : "Add storage"}
      description="Any S3-compatible service works: AWS S3, Cloudflare R2, MinIO, Backblaze B2, Wasabi…"
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={() => void save()} disabled={busy}>
            {busy ? "Verifying…" : storage ? "Save" : "Add storage"}
          </Button>
        </>
      }
    >
      <div className="column" style={{ gap: 12 }}>
        <label className="field">
          <span>Name</span>
          <TextInput className="field-input" autoFocus value={form.name} onChange={(event) => set("name", event.target.value)} />
        </label>
        <label className="field">
          <span>Endpoint (empty for AWS S3)</span>
          <TextInput className="field-input" value={form.endpoint} disabled={inUse} placeholder="https://<account>.r2.cloudflarestorage.com" onChange={(event) => set("endpoint", event.target.value)} />
        </label>
        <div className="storage-form-pair">
          <label className="field">
            <span>Bucket</span>
            <TextInput className="field-input" value={form.bucket} disabled={inUse} onChange={(event) => set("bucket", event.target.value)} />
          </label>
          <label className="field">
            <span>Region</span>
            <TextInput className="field-input" value={form.region} onChange={(event) => set("region", event.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>Key prefix (optional)</span>
          <TextInput className="field-input" value={form.keyPrefix} disabled={inUse} onChange={(event) => set("keyPrefix", event.target.value)} />
        </label>
        <div className="storage-form-pair">
          <label className="field">
            <span>Access key ID</span>
            <TextInput
              className="field-input"
              autoComplete="off"
              value={form.accessKeyId}
              placeholder={storage?.accessKeyLast4 ? `Unchanged (…${storage.accessKeyLast4})` : ""}
              onChange={(event) => set("accessKeyId", event.target.value)}
            />
          </label>
          <label className="field">
            <span>Secret access key</span>
            <TextInput
              className="field-input"
              type="password"
              autoComplete="new-password"
              value={form.secretAccessKey}
              placeholder={storage ? "Unchanged" : ""}
              onChange={(event) => set("secretAccessKey", event.target.value)}
            />
          </label>
        </div>
        <label className="storage-toggle">
          <input type="checkbox" checked={form.forcePathStyle} onChange={(event) => set("forcePathStyle", event.target.checked)} />
          <span>Path-style URLs (MinIO and some self-hosted services)</span>
        </label>
        <label className="storage-toggle">
          <input type="checkbox" checked={form.serverSideEncryption} onChange={(event) => set("serverSideEncryption", event.target.checked)} />
          <span>Server-side encryption (SSE-S3)</span>
        </label>
        {inUse ? <p className="storage-muted">The endpoint, bucket and prefix are locked because this storage holds files. Add a new storage and transfer instead.</p> : null}
        <details className="storage-cors">
          <summary>Bucket CORS for playback</summary>
          <p className="storage-muted">Recordings play straight from your bucket, so allow the web app to read it:</p>
          <pre>{corsRuleFor(webOrigin)}</pre>
        </details>
        {error ? <div className="auth-error">{error}</div> : null}
      </div>
    </Dialog>
  );
}

function DeleteStorageDialog(props: { orgId: string; storage: OrganizationStorage; onClose: () => void; onDeleted: () => Promise<void> }): React.JSX.Element {
  const { orgId, storage } = props;
  const auth = useDesktopAuth();
  const toast = useToast();
  const [impact, setImpact] = useState<{ artifactCount: number; evidenceCount: number; bytes: number } | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .storageImpact(auth.getToken, orgId, storage.id)
      .then(setImpact)
      .catch((err) => setError(errorText(err, "Unable to check this storage.")));
  }, [auth.getToken, orgId, storage.id]);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteStorage(auth.getToken, orgId, storage.id, confirmName);
      toast.success(`${storage.name} removed`);
      await props.onDeleted();
    } catch (err) {
      setError(errorText(err, "Could not remove the storage."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={`Remove ${storage.name}?`}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" disabled={busy || !impact || confirmName.trim() !== storage.name} onClick={() => void remove()}>
            {busy ? "Removing…" : "Remove storage"}
          </Button>
        </>
      }
    >
      <div className="column" style={{ gap: 12 }}>
        {!impact ? (
          <p className="storage-muted">Checking what is stored here…</p>
        ) : impact.artifactCount > 0 ? (
          <div className="auth-error" role="alert">
            <strong>
              {impact.artifactCount} files of {impact.evidenceCount} evidence ({formatBytes(impact.bytes)}) will become unavailable.
            </strong>{" "}
            JittleLamp stops reading this bucket. Adding the same bucket again will not reconnect these files, because their integrity can no longer be guaranteed. Transfer them first if
            you still need them.
          </div>
        ) : (
          <p className="storage-muted">No evidence is stored here. JittleLamp forgets the connection and its credentials.</p>
        )}
        <label className="field">
          <span>Type {storage.name} to confirm</span>
          <TextInput className="field-input" autoComplete="off" value={confirmName} onChange={(event) => setConfirmName(event.target.value)} />
        </label>
        {error ? <div className="auth-error">{error}</div> : null}
      </div>
    </Dialog>
  );
}
