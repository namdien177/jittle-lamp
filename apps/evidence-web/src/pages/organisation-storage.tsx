import React, { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useOutletContext } from "react-router";
import { AlertTriangle, Database, HardDrive, Pause, Play, Plus, Square } from "lucide-react";
import {
  createOrganizationStorageInputSchema,
  updateOrganizationStorageInputSchema,
  type OrganizationStorage,
  type OrganizationStorageOverview,
  type StorageTransfer
} from "@jittle-lamp/shared";

import type { ApiOrgSummary } from "../api";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { SimpleDialog } from "../components/ui/dialog";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { SimpleSelect } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Hint, TruncatedText } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import { useAccountProfile } from "../queries";
import { storageApi, storageKeys, useStorageImpact, useStorageMutation, useStorageOverview, useStorageUsage } from "../storage-api";
import {
  corsRuleFor,
  formatBytes,
  formatShare,
  kindShareRows,
  memberShareRows,
  storagePeriodRange,
  storagePeriods,
  storageShareRows,
  usageBars,
  type StoragePeriodId,
  type StorageShareRow
} from "../storage-report";
import { AdminCard, CopyBlock, ErrorNote, StatTile, Toggle, pressable } from "../test-cases/admin-ui";
import { useToast } from "../toast";

// Organisation storage tab: usage statistics for every member; bring-your-own S3 storages, the
// write target and transfers for members with `storage.manage`.

type OrgOutletContext = { orgId: string; org: ApiOrgSummary | null };

const DEFAULT_OPTION = "default";

function ShareList(props: { rows: StorageShareRow[]; label: string; empty: string }): React.JSX.Element {
  if (props.rows.length === 0) return <p className="text-sm text-muted-foreground">{props.empty}</p>;
  return (
    <ul className="grid gap-3" aria-label={props.label}>
      {props.rows.map((row) => (
        <li key={row.key} className="grid gap-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <TruncatedText className={cn("font-medium", row.muted ? "text-muted-foreground line-through" : "text-foreground")}>{row.label}</TruncatedText>
            <span className="shrink-0 tabular-nums text-foreground">{formatBytes(row.bytes)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div
              className={cn("h-full rounded-full", row.muted ? "bg-muted-foreground/40" : "bg-primary")}
              style={{ width: `${Math.max(row.share * 100, row.bytes > 0 ? 1.5 : 0)}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {formatShare(row.share)} · {row.detail}
          </p>
        </li>
      ))}
    </ul>
  );
}

function UsageChart(props: { report: NonNullable<ReturnType<typeof useStorageUsage>["data"]> }): React.JSX.Element {
  const bars = usageBars(props.report);
  const labelEvery = bars.length > 31 ? 14 : bars.length > 10 ? 5 : 1;
  const linePoints = bars
    .map((bar, index) => `${((index + 0.5) / Math.max(bars.length, 1)) * 100},${100 - bar.storedRatio * 100}`)
    .join(" ");
  const peak = bars.reduce((max, bar) => Math.max(max, bar.addedBytes), 0);
  return (
    <figure className="grid gap-2">
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground" aria-hidden>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-primary/80" /> Added in period
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded-full bg-foreground" /> Stored at end of period
        </span>
      </div>
      <div
        role="img"
        aria-label={`Storage usage. ${formatBytes(props.report.totals.bytes)} stored now${peak > 0 ? `, at most ${formatBytes(peak)} added in one ${props.report.granularity}` : ""}.`}
        className="relative h-44 border-b border-border"
      >
        <div className="absolute inset-0 flex items-end gap-px">
          {bars.map((bar) => (
            <Hint key={bar.bucket} label={bar.description}>
              <div className="group relative flex h-full min-w-0 flex-1 items-end">
                <div
                  className={cn("w-full rounded-t-sm", bar.addedBytes > 0 ? "bg-primary/70 group-hover:bg-primary" : "bg-muted")}
                  style={{ height: `${bar.addedBytes > 0 ? Math.max(bar.addedRatio * 100, 2) : 1}%` }}
                />
              </div>
            </Hint>
          ))}
        </div>
        {bars.length > 1 ? (
          <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            <polyline points={linePoints} fill="none" stroke="var(--foreground)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </svg>
        ) : null}
      </div>
      <div className="flex gap-px" aria-hidden>
        {bars.map((bar, index) => (
          <span key={bar.bucket} className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-2xs text-muted-foreground">
            {index % labelEvery === 0 ? bar.label : ""}
          </span>
        ))}
      </div>
      <figcaption className="sr-only">
        <table>
          <caption>Storage per {props.report.granularity}</caption>
          <thead>
            <tr>
              <th scope="col">Period</th>
              <th scope="col">Added</th>
              <th scope="col">Stored</th>
            </tr>
          </thead>
          <tbody>
            {bars.map((bar) => (
              <tr key={bar.bucket}>
                <th scope="row">{bar.label}</th>
                <td>{formatBytes(bar.addedBytes)}</td>
                <td>{formatBytes(bar.storedBytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </figcaption>
    </figure>
  );
}

export function OrgStorageTab(): React.JSX.Element {
  const { orgId } = useOutletContext<OrgOutletContext>();
  const [periodId, setPeriodId] = useState<StoragePeriodId>("30d");
  // Rounded to the minute so the query key is stable between renders.
  const range = useMemo(() => storagePeriodRange(periodId, Math.floor(Date.now() / 60_000) * 60_000), [periodId]);
  const usage = useStorageUsage(orgId, range);
  const overview = useStorageOverview(orgId);
  const profile = useAccountProfile();
  const report = usage.data;
  const queryClient = useQueryClient();

  // A finished transfer moves bytes between storages: refresh the statistics.
  const activeTransferId = overview.data?.activeTransfer?.id ?? null;
  const previousTransferId = useRef<string | null>(null);
  useEffect(() => {
    if (previousTransferId.current && !activeTransferId) {
      void queryClient.invalidateQueries({ queryKey: [...storageKeys.all(orgId), "usage"] });
    }
    previousTransferId.current = activeTransferId;
  }, [activeTransferId, orgId, queryClient]);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-bold">Storage</h2>
          <p className="text-sm text-muted-foreground">Space used by this organisation's evidence, by member, storage and file type.</p>
        </div>
        <div role="radiogroup" aria-label="Period" className="flex overflow-hidden rounded-md border border-border bg-card">
          {storagePeriods.map((period) => (
            <button
              key={period.id}
              type="button"
              role="radio"
              aria-checked={periodId === period.id}
              onClick={() => setPeriodId(period.id)}
              className={cn("px-3.5 py-1.5 text-sm font-semibold", pressable, periodId === period.id ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-muted")}
            >
              {period.label}
            </button>
          ))}
        </div>
      </div>

      <ErrorNote error={usage.error} />
      {usage.isPending ? (
        <Skeleton className="h-80" />
      ) : report ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Stored" value={formatBytes(report.totals.bytes)} detail="across all storages" />
            <StatTile label="Evidence" value={report.totals.evidenceCount.toLocaleString()} />
            <StatTile label="Files" value={report.totals.artifactCount.toLocaleString()} />
            <StatTile label="In the bin" value={formatBytes(report.totals.binBytes)} detail="freed when the bin is purged" />
          </div>

          <AdminCard title="Usage over time" description="Bars show data added in each period; the line shows the total stored.">
            <UsageChart report={report} />
          </AdminCard>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <AdminCard title="By member" description="Who created the evidence">
              <ShareList rows={memberShareRows(report, profile.data?.localUserId ?? null)} label="Storage by member" empty="No evidence yet." />
            </AdminCard>
            <AdminCard title="By storage" description="Where the files are kept">
              <ShareList rows={storageShareRows(report)} label="Storage by location" empty="No evidence yet." />
            </AdminCard>
            <AdminCard title="By file type">
              <ShareList rows={kindShareRows(report)} label="Storage by file type" empty="No evidence yet." />
            </AdminCard>
          </div>
        </>
      ) : null}

      <ErrorNote error={overview.error} />
      {overview.data?.canManage ? <StorageConfiguration orgId={orgId} overview={overview.data} /> : null}
    </div>
  );
}

/* ── Storage configuration (storage.manage) ─────────────────────────────────── */

function StorageConfiguration(props: { orgId: string; overview: OrganizationStorageOverview }): React.JSX.Element {
  const { orgId, overview } = props;
  const toast = useToast();
  const [editing, setEditing] = useState<OrganizationStorage | "new" | null>(null);
  const [deleting, setDeleting] = useState<OrganizationStorage | null>(null);
  const activeStorages = overview.storages.filter((storage) => storage.status === "active");
  const updateSettings = useStorageMutation(orgId, (getToken, input: Parameters<typeof storageApi.updateSettings>[2]) =>
    storageApi.updateSettings(getToken, orgId, input)
  );
  const testStorage = useStorageMutation(orgId, (getToken, storageId: string) => storageApi.testStorage(getToken, orgId, storageId));

  const writeTarget = overview.settings.defaultStorageId ?? DEFAULT_OPTION;
  const writeOptions = [
    ...(overview.settings.defaultStorageDisabled ? [] : [{ value: DEFAULT_OPTION, label: "JittleLamp storage" }]),
    ...activeStorages.map((storage) => ({ value: storage.id, label: storage.name }))
  ];

  return (
    <section className="grid gap-4" aria-labelledby="storage-configuration">
      <div>
        <h2 id="storage-configuration" className="font-display text-lg font-bold">
          Storage configuration
        </h2>
        <p className="text-sm text-muted-foreground">Keep evidence in your own S3-compatible bucket next to, or instead of, JittleLamp storage.</p>
      </div>
      {!overview.secretsAvailable ? (
        <p role="note" className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          This server has no secrets master key (JL_SECRETS_MASTER_KEY), so storage credentials cannot be saved.
        </p>
      ) : null}

      <AdminCard title="Where new evidence is saved" description="Existing files stay where they are; use a transfer to move them.">
        <div className="grid gap-4">
          <Field label="Default storage" className="max-w-sm">
            <SimpleSelect
              ariaLabel="Default storage"
              options={writeOptions}
              value={writeTarget}
              disabled={updateSettings.isPending}
              onValueChange={(value) =>
                updateSettings.mutate(
                  { defaultStorageId: value === DEFAULT_OPTION ? null : value },
                  { onSuccess: () => toast.success("Default storage updated") }
                )
              }
            />
          </Field>
          <Toggle
            label="Turn off JittleLamp storage"
            description={
              overview.settings.defaultStorageId
                ? "New evidence is never saved to JittleLamp storage. Files already there stay readable until you transfer them."
                : "Choose one of your storages as the default first."
            }
            checked={overview.settings.defaultStorageDisabled}
            disabled={updateSettings.isPending || (!overview.settings.defaultStorageId && !overview.settings.defaultStorageDisabled)}
            onChange={(checked) => updateSettings.mutate({ defaultStorageDisabled: checked })}
          />
          <ErrorNote error={updateSettings.error} />
        </div>
      </AdminCard>

      <AdminCard
        title="Your storages"
        description={`JittleLamp storage holds ${formatBytes(overview.defaultStorageUsage.bytes)} in ${overview.defaultStorageUsage.artifactCount.toLocaleString()} files.`}
        actions={
          <Button size="sm" onClick={() => setEditing("new")} disabled={!overview.secretsAvailable}>
            <Plus className="size-4" aria-hidden /> Add storage
          </Button>
        }
        bodyClassName="p-0"
      >
        {overview.storages.length === 0 ? (
          <div className="flex items-center gap-3 p-4 text-sm text-muted-foreground">
            <Database className="size-5 shrink-0" aria-hidden />
            No storages yet. Evidence is saved to JittleLamp storage.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Bucket</TableHead>
                <TableHead className="text-right">Used</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.storages.map((storage) => (
                <TableRow key={storage.id}>
                  <TableCell className="font-medium">
                    <span className="flex items-center gap-2">
                      <HardDrive className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      {storage.name}
                      {overview.settings.defaultStorageId === storage.id ? <Badge variant="brand">Default</Badge> : null}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-xs">{storage.keyPrefix ? `${storage.bucket}/${storage.keyPrefix}` : storage.bucket}</span>
                    <span className="block text-xs text-muted-foreground">{storage.endpoint ?? `AWS S3 · ${storage.region}`}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatBytes(storage.usage.bytes)}
                    <span className="block text-xs text-muted-foreground">{storage.usage.artifactCount.toLocaleString()} files</span>
                  </TableCell>
                  <TableCell>
                    {storage.status === "active" ? (
                      <Badge variant="success">Connected</Badge>
                    ) : (
                      <Hint label="Files in this storage can no longer be opened.">
                        <Badge variant="danger">Removed</Badge>
                      </Hint>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {storage.status === "active" ? (
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={testStorage.isPending}
                          onClick={() =>
                            testStorage.mutate(storage.id, {
                              onSuccess: () => toast.success(`${storage.name} is reachable`),
                              onError: (error) => toast.error(error instanceof Error ? error.message : "Connection failed")
                            })
                          }
                        >
                          Test
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(storage)}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDeleting(storage)}>
                          Remove
                        </Button>
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </AdminCard>

      <TransferCard orgId={orgId} overview={overview} />

      {editing ? <StorageFormDialog orgId={orgId} storage={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
      {deleting ? <DeleteStorageDialog orgId={orgId} storage={deleting} onClose={() => setDeleting(null)} /> : null}
    </section>
  );
}

function storageName(overview: OrganizationStorageOverview, storageId: string | null): string {
  if (!storageId) return "JittleLamp storage";
  return overview.storages.find((storage) => storage.id === storageId)?.name ?? "Removed storage";
}

function TransferProgress(props: { transfer: StorageTransfer; overview: OrganizationStorageOverview; orgId: string }): React.JSX.Element {
  const { transfer } = props;
  const control = useStorageMutation(props.orgId, (getToken, action: "pause" | "resume" | "cancel") =>
    storageApi.controlTransfer(getToken, props.orgId, transfer.id, action)
  );
  const ratio = transfer.bytesTotal > 0 ? transfer.bytesDone / transfer.bytesTotal : transfer.artifactsTotal > 0 ? transfer.artifactsDone / transfer.artifactsTotal : 0;
  const paused = transfer.status === "paused" || transfer.status === "pause_requested";
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">
          {storageName(props.overview, transfer.sourceStorageId)} → {storageName(props.overview, transfer.targetStorageId)}
        </span>
        <span className="tabular-nums text-muted-foreground">
          {formatBytes(transfer.bytesDone)} of {formatBytes(transfer.bytesTotal)} · {transfer.artifactsDone.toLocaleString()} of {transfer.artifactsTotal.toLocaleString()} files
        </span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="Transfer progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
      >
        <div className={cn("h-full rounded-full transition-[width] duration-500", paused ? "bg-muted-foreground/50" : "bg-primary")} style={{ width: `${Math.min(ratio, 1) * 100}%` }} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {transfer.status === "queued" ? "Waiting to start…" : paused ? "Paused." : "Copying, verifying checksums and removing originals…"}
          {transfer.artifactsFailed > 0 ? ` ${transfer.artifactsFailed} file(s) could not be moved and stay where they are.` : ""}
        </p>
        <div className="flex gap-2">
          {paused ? (
            <Button size="sm" variant="outline" disabled={control.isPending} onClick={() => control.mutate("resume")}>
              <Play className="size-4" aria-hidden /> Resume
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={control.isPending} onClick={() => control.mutate("pause")}>
              <Pause className="size-4" aria-hidden /> Pause
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={control.isPending} onClick={() => control.mutate("cancel")}>
            <Square className="size-4" aria-hidden /> Cancel
          </Button>
        </div>
      </div>
      <ErrorNote error={control.error} />
    </div>
  );
}

function TransferCard(props: { orgId: string; overview: OrganizationStorageOverview }): React.JSX.Element {
  const { orgId, overview } = props;
  const toast = useToast();
  const activeStorages = overview.storages.filter((storage) => storage.status === "active");
  const sources = [
    ...(overview.defaultStorageUsage.artifactCount > 0 ? [{ value: DEFAULT_OPTION, label: `JittleLamp storage (${formatBytes(overview.defaultStorageUsage.bytes)})` }] : []),
    ...activeStorages
      .filter((storage) => storage.usage.artifactCount > 0)
      .map((storage) => ({ value: storage.id, label: `${storage.name} (${formatBytes(storage.usage.bytes)})` }))
  ];
  const [source, setSource] = useState<string>(sources[0]?.value ?? DEFAULT_OPTION);
  const targets = activeStorages.filter((storage) => storage.id !== source).map((storage) => ({ value: storage.id, label: storage.name }));
  const [target, setTarget] = useState<string>("");
  const effectiveTarget = targets.some((option) => option.value === target) ? target : (targets[0]?.value ?? "");
  const start = useStorageMutation(orgId, (getToken, input: { sourceStorageId: string | null; targetStorageId: string }) =>
    storageApi.startTransfer(getToken, orgId, input)
  );
  const lastFinished = overview.recentTransfers[0];

  return (
    <AdminCard title="Transfer files" description="Moves files to another storage. Each file is copied, its checksum verified, and only then is the original deleted.">
      {overview.activeTransfer ? (
        <TransferProgress transfer={overview.activeTransfer} overview={overview} orgId={orgId} />
      ) : sources.length === 0 || activeStorages.length === 0 ? (
        <p className="text-sm text-muted-foreground">{activeStorages.length === 0 ? "Add a storage to transfer files into it." : "There are no files to transfer."}</p>
      ) : (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="From" className="min-w-56">
              <SimpleSelect ariaLabel="Transfer from" options={sources} value={sources.some((option) => option.value === source) ? source : (sources[0]?.value ?? DEFAULT_OPTION)} onValueChange={setSource} />
            </Field>
            <Field label="To" className="min-w-56">
              {targets.length > 0 ? (
                <SimpleSelect ariaLabel="Transfer to" options={targets} value={effectiveTarget} onValueChange={setTarget} />
              ) : (
                <p className="py-2 text-sm text-muted-foreground">Add another storage first.</p>
              )}
            </Field>
            <Button
              disabled={start.isPending || !effectiveTarget}
              onClick={() =>
                start.mutate(
                  { sourceStorageId: source === DEFAULT_OPTION ? null : source, targetStorageId: effectiveTarget },
                  { onSuccess: () => toast.success("Transfer started") }
                )
              }
            >
              Start transfer
            </Button>
          </div>
          <ErrorNote error={start.error} />
        </div>
      )}
      {!overview.activeTransfer && lastFinished ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Last transfer {lastFinished.status}: {lastFinished.artifactsDone.toLocaleString()} files ({formatBytes(lastFinished.bytesDone)}) to{" "}
          {storageName(overview, lastFinished.targetStorageId)}
          {lastFinished.artifactsFailed > 0 ? `, ${lastFinished.artifactsFailed} failed${lastFinished.lastError ? ` (${lastFinished.lastError})` : ""}` : ""}.
        </p>
      ) : null}
    </AdminCard>
  );
}

type StorageFormState = {
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  keyPrefix: string;
  forcePathStyle: boolean;
  serverSideEncryption: boolean;
  accessKeyId: string;
  secretAccessKey: string;
};

function StorageFormDialog(props: { orgId: string; storage: OrganizationStorage | null; onClose: () => void }): React.JSX.Element {
  const { orgId, storage } = props;
  const toast = useToast();
  const [form, setForm] = useState<StorageFormState>({
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
  const [validation, setValidation] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const inUse = (storage?.usage.artifactCount ?? 0) > 0;
  const set = <K extends keyof StorageFormState>(key: K, value: StorageFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setVerified(false);
  };
  const testConnection = useStorageMutation(orgId, (getToken, input: Parameters<typeof storageApi.testConnection>[2]) =>
    storageApi.testConnection(getToken, orgId, input)
  );
  const save = useStorageMutation(orgId, (getToken, _input: void) => {
    if (!storage) {
      const parsed = createOrganizationStorageInputSchema.safeParse(form);
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Check the storage details");
      return storageApi.createStorage(getToken, orgId, form);
    }
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
    return storageApi.updateStorage(getToken, orgId, storage.id, update);
  });

  const runTest = () => {
    setValidation(null);
    const parsed = createOrganizationStorageInputSchema.omit({ name: true }).safeParse(form);
    if (!parsed.success) {
      setValidation(storage ? "Enter the access key and secret to test new settings." : (parsed.error.issues[0]?.message ?? "Check the storage details"));
      return;
    }
    testConnection.mutate(form, { onSuccess: () => setVerified(true) });
  };

  const webOrigin = typeof window === "undefined" ? "https://your-jittle-lamp-web" : window.location.origin;

  return (
    <SimpleDialog
      open
      onClose={props.onClose}
      title={storage ? `Edit ${storage.name}` : "Add storage"}
      description="Any S3-compatible service works: AWS S3, Cloudflare R2, MinIO, Backblaze B2, Wasabi…"
      size="lg"
      footer={
        <>
          <Button variant="outline" size="sm" onClick={props.onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="outline" size="sm" onClick={runTest} disabled={testConnection.isPending || save.isPending}>
            {testConnection.isPending ? "Testing…" : verified ? "Connection OK" : "Test connection"}
          </Button>
          <Button
            size="sm"
            disabled={save.isPending}
            onClick={() =>
              save.mutate(undefined, {
                onSuccess: () => {
                  toast.success(storage ? "Storage updated" : "Storage added");
                  props.onClose();
                }
              })
            }
          >
            {save.isPending ? "Verifying…" : storage ? "Save" : "Add storage"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="storage-name" className="sm:col-span-2">
          <Input id="storage-name" autoFocus value={form.name} placeholder="QA evidence bucket" onChange={(event) => set("name", event.target.value)} />
        </Field>
        <Field label="Endpoint" htmlFor="storage-endpoint" hint="Leave empty for AWS S3." className="sm:col-span-2">
          <Input
            id="storage-endpoint"
            value={form.endpoint}
            placeholder="https://<account>.r2.cloudflarestorage.com"
            disabled={inUse}
            onChange={(event) => set("endpoint", event.target.value)}
          />
        </Field>
        <Field label="Bucket" htmlFor="storage-bucket">
          <Input id="storage-bucket" value={form.bucket} disabled={inUse} onChange={(event) => set("bucket", event.target.value)} />
        </Field>
        <Field label="Region" htmlFor="storage-region" hint="Use auto for R2.">
          <Input id="storage-region" value={form.region} onChange={(event) => set("region", event.target.value)} />
        </Field>
        <Field label="Key prefix" htmlFor="storage-prefix" hint="Optional folder inside the bucket." className="sm:col-span-2">
          <Input id="storage-prefix" value={form.keyPrefix} placeholder="jittle-lamp/evidence" disabled={inUse} onChange={(event) => set("keyPrefix", event.target.value)} />
        </Field>
        <Field label="Access key ID" htmlFor="storage-access-key">
          <Input
            id="storage-access-key"
            autoComplete="off"
            value={form.accessKeyId}
            placeholder={storage?.accessKeyLast4 ? `Unchanged (…${storage.accessKeyLast4})` : ""}
            onChange={(event) => set("accessKeyId", event.target.value)}
          />
        </Field>
        <Field label="Secret access key" htmlFor="storage-secret">
          <Input
            id="storage-secret"
            type="password"
            autoComplete="new-password"
            value={form.secretAccessKey}
            placeholder={storage ? "Unchanged" : ""}
            onChange={(event) => set("secretAccessKey", event.target.value)}
          />
        </Field>
        <div className="grid gap-2 sm:col-span-2">
          <Toggle label="Path-style URLs" description="Needed by MinIO and some self-hosted services." checked={form.forcePathStyle} onChange={(checked) => set("forcePathStyle", checked)} />
          <Toggle
            label="Server-side encryption (SSE-S3)"
            description="Turn off if your provider rejects the encryption header."
            checked={form.serverSideEncryption}
            onChange={(checked) => set("serverSideEncryption", checked)}
          />
        </div>
        {inUse ? (
          <p className="text-sm text-muted-foreground sm:col-span-2">
            The endpoint, bucket and prefix are locked because this storage holds files. To move to another bucket, add it as a new storage and transfer.
          </p>
        ) : null}
        <details className="rounded-md border border-border px-3 py-2 text-sm sm:col-span-2">
          <summary className="cursor-pointer font-medium">Bucket CORS for playback</summary>
          <p className="mt-2 text-muted-foreground">Recordings play straight from your bucket, so allow this site to read it:</p>
          <div className="mt-2">
            <CopyBlock label="CORS configuration" value={corsRuleFor(webOrigin)} multiline />
          </div>
          <p className="mt-2 text-muted-foreground">JittleLamp needs permission to put, get and delete objects in the bucket (and prefix).</p>
        </details>
        <div className="grid gap-2 sm:col-span-2">
          {validation ? <ErrorNote error={validation} /> : null}
          <ErrorNote error={testConnection.error} />
          <ErrorNote error={save.error} />
        </div>
      </div>
    </SimpleDialog>
  );
}

function DeleteStorageDialog(props: { orgId: string; storage: OrganizationStorage; onClose: () => void }): React.JSX.Element {
  const { orgId, storage } = props;
  const toast = useToast();
  const impact = useStorageImpact(orgId, storage.id);
  const [confirmName, setConfirmName] = useState("");
  const remove = useStorageMutation(orgId, (getToken, name: string) => storageApi.deleteStorage(getToken, orgId, storage.id, name));
  const affected = impact.data?.artifactCount ?? 0;

  return (
    <SimpleDialog
      open
      onClose={props.onClose}
      title={`Remove ${storage.name}?`}
      size="md"
      footer={
        <>
          <Button variant="outline" size="sm" onClick={props.onClose} disabled={remove.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={remove.isPending || impact.isPending || confirmName.trim() !== storage.name}
            onClick={() =>
              remove.mutate(confirmName, {
                onSuccess: () => {
                  toast.success(`${storage.name} removed`);
                  props.onClose();
                }
              })
            }
          >
            {remove.isPending ? "Removing…" : "Remove storage"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 text-sm">
        {impact.isPending ? (
          <Skeleton className="h-16" />
        ) : affected > 0 ? (
          <div role="alert" className="grid gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
            <p className="flex items-start gap-2 font-semibold">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              {affected.toLocaleString()} files of {impact.data?.evidenceCount.toLocaleString()} evidence ({formatBytes(impact.data?.bytes ?? 0)}) will become unavailable.
            </p>
            <p>
              JittleLamp stops reading this bucket. The files are not deleted from it, but adding the same bucket again will <strong>not</strong> reconnect them: their integrity can no
              longer be guaranteed. Transfer them to another storage first if you still need them.
            </p>
          </div>
        ) : (
          <p className="text-muted-foreground">No evidence is stored here. JittleLamp forgets the connection and its credentials.</p>
        )}
        <ErrorNote error={impact.error} />
        <Field label={`Type ${storage.name} to confirm`} htmlFor="storage-delete-confirm">
          <Input id="storage-delete-confirm" autoComplete="off" value={confirmName} onChange={(event) => setConfirmName(event.target.value)} />
        </Field>
        <ErrorNote error={remove.error} />
      </div>
    </SimpleDialog>
  );
}
