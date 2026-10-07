import React, { useState } from "react";
import { Link } from "react-router";
import { AlertTriangle, KeyRound, Plus, Server, ShieldCheck, Trash2 } from "lucide-react";
import type { RunnerPool } from "@jittle-lamp/shared";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmDialog, SimpleDialog } from "../../components/ui/dialog";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { EmptyState } from "../../components/ui/empty";
import { Skeleton } from "../../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { apiOrigin } from "../../env";
import { cn } from "../../lib/cn";
import { formatRelativeTime } from "../../utils";
import { testAdminApi } from "../../test-cases/admin-api";
import { testAdminKeys, useRunnerPools, useTestAdminMutation, useTestPermissions } from "../../test-cases/admin-queries";
import { AdminCard, CopyBlock, ErrorNote, ReadOnlyNotice, pressable } from "../../test-cases/admin-ui";
import { testRunHref } from "../../notifications/notification-links";
import { poolQueueSummary, registrationTokenAction, runnerCommands } from "../../test-config/config-ui";
import { RunnerUpdatePanel } from "./runner-update";
import { Hint } from "../../components/ui/tooltip";

// Settings → Runner pools (design.md §5.4, docs/e2e-test-cases/runner-setup.md): pools, workers and
// registration. The registration token appears once, right after the pool is created.

function resolvedApiOrigin(): string {
  if (apiOrigin.startsWith("http")) return apiOrigin;
  return `${window.location.origin}${apiOrigin}`;
}

export function SettingsTestRunnerPoolsPage(): React.JSX.Element {
  const permissions = useTestPermissions();
  const canManage = permissions.can("test_config.manage");
  const pools = useRunnerPools();
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<{ title: string; note: string; token: string } | null>(null);
  const issueToken = useTestAdminMutation((getToken, poolId: string) => testAdminApi.issueRegistrationToken(getToken, poolId), [testAdminKeys.runnerPools]);
  const updateRunner = useTestAdminMutation(
    (getToken, input: { poolId: string; cancel: boolean }) => testAdminApi.updateRunnerPool(getToken, input.poolId, input.cancel),
    [testAdminKeys.runnerPools]
  );
  const [removing, setRemoving] = useState<{ pool: RunnerPool; workerId: string; hostname: string } | null>(null);
  const removeWorker = useTestAdminMutation(
    (getToken, input: { poolId: string; workerId: string }) => testAdminApi.deleteRunnerWorker(getToken, input.poolId, input.workerId),
    [testAdminKeys.runnerPools]
  );

  return (
    <div className="grid min-w-0 gap-4">
      {!canManage && !permissions.loading ? <ReadOnlyNotice permission="test_config.manage" /> : null}
      <AdminCard
        title="Runner pools"
        description="A run goes to the pool its environment is bound to. Self-hosted pools reach targets behind a VPN."
        actions={
          canManage ? (
            <Button size="sm" className={pressable} onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              New pool
            </Button>
          ) : null
        }
      >
        <ErrorNote error={pools.error ?? removeWorker.error ?? issueToken.error ?? updateRunner.error} />
        {pools.isPending ? (
          <Skeleton className="h-40" />
        ) : (pools.data ?? []).length === 0 ? (
          <EmptyState icon={<Server aria-hidden />} title="No runner pools" description="Create a self-hosted pool and start a runner on a host that can reach your app." />
        ) : (
          <div className="grid min-w-0 gap-4">
            {(pools.data ?? []).map((pool) => {
              const online = pool.workers.filter((worker) => worker.status === "online").length;
              const tokenAction = registrationTokenAction(pool, canManage);
              return (
                <section key={pool.id} aria-label={`Pool ${pool.name}`} className="min-w-0 overflow-hidden rounded-md border border-border">
                  <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
                    <Server className="size-4 text-muted-foreground" aria-hidden />
                    <h3 className="font-mono text-sm font-semibold text-foreground">{pool.name}</h3>
                    <Badge variant={pool.kind === "cloud" ? "default" : "outline"}>{pool.kind}</Badge>
                    <span className="text-sm text-muted-foreground">
                      {online} of {pool.workers.length} online · up to {pool.maxConcurrentRuns} at a time ·{" "}
                      <span className={cn(pool.queued + pool.explorationsQueued > 0 && online === 0 && "font-semibold text-warning")}>{poolQueueSummary(pool)}</span>
                    </span>
                    {tokenAction ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        className="ml-auto"
                        disabled={issueToken.isPending}
                        aria-label={tokenAction.ariaLabel}
                        onClick={() =>
                          void issueToken
                            .mutateAsync(pool.id)
                            .then((response) => setIssued({ title: tokenAction.title, note: tokenAction.note, token: response.registrationToken }))
                        }
                      >
                        <KeyRound aria-hidden />
                        {tokenAction.label}
                      </Button>
                    ) : null}
                  </header>
                  <RunnerUpdatePanel pool={pool} canManage={canManage} busy={updateRunner.isPending}
                    onUpdate={cancel => void updateRunner.mutateAsync({ poolId: pool.id, cancel }).catch(() => undefined)} />
                  {pool.queued + pool.explorationsQueued > 0 && online === 0 ? (
                    <p className="flex items-center gap-2 border-b border-border bg-warning/10 px-4 py-2 text-sm text-warning">
                      <AlertTriangle className="size-4" aria-hidden />
                      {pool.queued > 0 && pool.explorationsQueued > 0
                        ? "Runs and imports are waiting with no runner online. Start a worker for this pool."
                        : pool.queued > 0
                          ? "Runs are waiting with NO_RUNNER. Start a worker for this pool."
                          : "Imports are waiting to be explored with no runner online. Start a worker for this pool."}
                    </p>
                  ) : null}
                  {pool.workers.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-muted-foreground">No worker has registered yet.</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="pl-4">Worker</TableHead>
                          <TableHead className="w-28">Status</TableHead>
                          <TableHead className="w-24">Version</TableHead>
                          <TableHead className="w-36">Last heartbeat</TableHead>
                          <TableHead>Current run</TableHead>
                          <TableHead className="w-16 pr-4">
                            <span className="sr-only">Actions</span>
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pool.workers.map((worker) => (
                          <TableRow key={worker.id}>
                            <TableCell className="pl-4 font-mono text-sm">{worker.hostname}</TableCell>
                            <TableCell>
                              <span className="inline-flex items-center gap-1.5 text-sm">
                                <span className={cn("size-2 rounded-full", worker.status === "online" ? "bg-primary" : "bg-muted-foreground/50")} aria-hidden />
                                {worker.status}
                              </span>
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {worker.version}
                              {worker.versionSkew ? <span className="ml-1 text-warning" aria-label={`Version differs from server ${pool.serverVersion}`}>⚠</span> : null}
                              {worker.drainingVersion ? <span className="block text-muted-foreground">draining</span> : null}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">{worker.lastHeartbeatAt ? formatRelativeTime(worker.lastHeartbeatAt) : "never"}</TableCell>
                            <TableCell className="text-sm">
                              {worker.currentRunId ? (
                                <Link to={testRunHref(worker.currentRunId)} className="font-mono text-xs text-primary hover:underline">
                                  {worker.currentRunId}
                                </Link>
                              ) : (
                                <span className="text-muted-foreground">idle</span>
                              )}
                            </TableCell>
                            <TableCell className="pr-4 text-right">
                              {canManage && pool.kind === "self-hosted" ? (
                                <Hint label="Remove worker">
                                  <Button variant="ghost" size="icon-sm" aria-label={`Remove worker ${worker.hostname}`} onClick={() => setRemoving({ pool, workerId: worker.id, hostname: worker.hostname })}>
                                    <Trash2 aria-hidden />
                                  </Button>
                                </Hint>
                              ) : null}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </AdminCard>
      {creating ? <CreatePoolDialog onClose={() => setCreating(false)} /> : null}
      {issued ? <TokenIssuedDialog title={issued.title} note={issued.note} token={issued.token} onClose={() => setIssued(null)} /> : null}
      <ConfirmDialog
        open={removing !== null}
        destructive
        title={`Remove worker ${removing?.hostname ?? ""}?`}
        description="Its worker credential stops working. A run it holds returns to the queue when the lease expires. Register the host again with a new pool token."
        confirmLabel="Remove worker"
        busy={removeWorker.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) void removeWorker.mutateAsync({ poolId: removing.pool.id, workerId: removing.workerId }).finally(() => setRemoving(null));
        }}
      />
    </div>
  );
}

function CreatePoolDialog(props: { onClose: () => void }): React.JSX.Element {
  const [name, setName] = useState("");
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState("1");
  const [created, setCreated] = useState<{ pool: RunnerPool; token: string } | null>(null);
  const create = useTestAdminMutation((getToken, body: { name: string; maxConcurrentRuns: number }) => testAdminApi.createRunnerPool(getToken, body), [testAdminKeys.runnerPools]);
  const concurrency = Number(maxConcurrentRuns);
  const valid = name.trim().length > 0 && Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 50;

  const submit = async () => {
    if (!valid) return;
    const response = await create.mutateAsync({ name: name.trim(), maxConcurrentRuns: concurrency });
    setCreated({ pool: response.pool, token: response.registrationToken });
  };

  if (created) return <TokenIssuedDialog title={`Pool ${created.pool.name} created`} token={created.token} onClose={props.onClose} />;

  return (
    <SimpleDialog
      title="New runner pool"
      description="A self-hosted pool for a devbox or CI host you control."
      onClose={props.onClose}
      size="sm"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={props.onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button size="sm" className={pressable} disabled={!valid || create.isPending} onClick={() => void submit()}>
            {create.isPending ? "Creating…" : "Create pool"}
          </Button>
        </>
      }
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Name" htmlFor="pool-name">
          <Input id="pool-name" value={name} onChange={(event) => setName(event.target.value)} className="font-mono" placeholder="devbox" maxLength={100} />
        </Field>
        <Field label="Runs at a time" htmlFor="pool-concurrency" hint="Across all workers of the pool (1–50)">
          <Input id="pool-concurrency" type="number" min={1} max={50} value={maxConcurrentRuns} onChange={(event) => setMaxConcurrentRuns(event.target.value)} />
        </Field>
        <ErrorNote error={create.error} />
      </form>
    </SimpleDialog>
  );
}

function TokenIssuedDialog(props: { title: string; note?: string; token: string; onClose: () => void }): React.JSX.Element {
  const commands = runnerCommands({ apiOrigin: resolvedApiOrigin(), token: props.token });
  return (
    <SimpleDialog
      title={props.title}
      onClose={props.onClose}
      size="lg"
      closeOnOverlay={false}
      footer={
        <Button size="sm" onClick={props.onClose}>
          I have copied the token
        </Button>
      }
    >
      <div className="flex gap-3 rounded-md border border-primary/30 bg-primary/10 p-3 text-sm text-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <p>
          This registration token is shown once. A worker uses it on its first start, then keeps its own credential. Anyone with the token can add a worker to this pool, so treat it like a password.
          {props.note ? ` ${props.note}` : null}
        </p>
      </div>
      <CopyBlock label="Registration token" value={props.token} />
      <CopyBlock label="Start a runner" value={commands.start} multiline />
      <CopyBlock label="Docker compose" value={commands.docker} multiline />
      <p className="text-sm text-muted-foreground">
        systemd and the full setup are in <code className="font-mono text-xs">docs/e2e-test-cases/runner-setup.md</code>. Bind an environment to this pool in Environments.
      </p>
    </SimpleDialog>
  );
}
