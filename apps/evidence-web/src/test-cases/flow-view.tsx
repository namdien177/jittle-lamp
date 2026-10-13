import React from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeChange, type NodeProps, type NodeTypes } from "@xyflow/react";
import { ExternalLink, Zap } from "lucide-react";
import { parseTestCaseTranscript, type TestCaseDetail, type TestRunDetail, type TranscriptCheckpoint, type TestCaseListResponse } from "@jittle-lamp/shared";

import { useAuth } from "../auth";
import { cn } from "../lib/cn";
import { useAuthToken } from "../queries";
import { testApi } from "./api";
import { caseHref } from "./case-page-model";
import { buildFlowGraph, flowNodeForStep, layoutFlow, selectableFlowNodes, type FlowGraph, type FlowLinkedCase, type FlowNode, type FlowNodeData, type FlowStepRow, type FlowStepStatus } from "./flow-model";
import { useTestOrgId } from "./org";
import { testKeys } from "./query-keys";

// The case page's Flow pane (roadmap §3.4, decision 4): the step model as an xyflow diagram with a
// computed, locked layout. Selection drives everything (no hover state without a fine pointer);
// `j`/`k` move it through the nodes in document order without motion (§3.7).

export type FlowViewProps = {
  detail: TestCaseDetail;
  latestRun: TestRunDetail | null;
  selectedStepId: string | null;
  onSelectStep: (stepId: string) => void;
  environmentName?: string | null;
  // Cases a [Use: KEY] node can link to; see useFlowLinkedCases.
  linkedCases?: ReadonlyArray<FlowLinkedCase>;
};

// Ids and titles of the cases a [Use: KEY] step can name, so a node links to `/test-cases/:id`.
// Same request as the editor's useLinkableCases, read with the ids kept.
export function useFlowLinkedCases(): FlowLinkedCase[] {
  const getToken = useAuthToken();
  const orgId = useTestOrgId();
  const auth = useAuth();
  const query = useQuery({
    queryKey: testKeys.linkableCases(orgId),
    queryFn: () => testApi.listTestCases(getToken, { sort: "key", order: "asc", limit: 500 }),
    enabled: auth.isLoaded && Boolean(auth.isSignedIn) && orgId !== null,
    staleTime: 20_000,
    select: (page: TestCaseListResponse) => page.items.map((item) => ({ key: item.key, id: item.id, title: item.title }))
  });
  return query.data ?? [];
}

// xyflow type names: `output` is one of its built-in node types (with its own stylesheet rules),
// so the output pill registers as `pill`.
export type FlowNodeType = Node<{ node: FlowNode; selected: boolean }, Exclude<FlowNodeData["kind"], "output"> | "pill">;

export function flowNodeType(kind: FlowNodeData["kind"]): FlowNodeType["type"] {
  return kind === "output" ? "pill" : kind;
}

// Rail colours of the step editor (packages/ui step-editor/styles.ts `--se-t-*`), copied so the
// diagram matches the rows without sharing a stylesheet.
const typeColour: Record<string, string> = {
  act: "#16a34a",
  assert: "#2563eb",
  open: "#6b7280",
  login: "#d97706",
  macro: "#d97706",
  use: "#7c3aed",
  wait: "#64748b",
  extract: "#0d9488",
  screenshot: "#a8a29e",
  note: "#c4c4cc",
  query: "#0f766e",
  api: "#ea580c"
};

const statusDot: Record<FlowStepStatus, string> = {
  passed: "bg-success",
  failed: "bg-destructive",
  blocked: "bg-warning",
  running: "bg-primary jl-tc-pulse",
  skipped: "bg-muted-foreground/40",
  pending: "border border-border bg-transparent"
};

const statusBorder: Partial<Record<FlowStepStatus, string>> = {
  failed: "border-destructive",
  blocked: "border-warning",
  running: "border-primary/60"
};

const endLabel: Record<NonNullable<Extract<FlowNodeData, { kind: "end" }>["outcome"]>, { text: string; className: string }> = {
  passed: { text: "Passed", className: "text-success" },
  failed: { text: "Failed", className: "text-destructive" },
  blocked: { text: "Blocked", className: "text-warning" },
  running: { text: "Running", className: "text-primary" },
  queued: { text: "Queued", className: "text-muted-foreground" }
};

function parseCheckpoints(transcript: string): TranscriptCheckpoint[] {
  try {
    return parseTestCaseTranscript(transcript).testCase.checkpoints;
  } catch {
    // A transcript the parser rejects still renders its steps; checkpoints keep a generic title.
    return [];
  }
}

export function FlowView(props: FlowViewProps): React.JSX.Element {
  const { detail, latestRun } = props;
  const checkpoints = React.useMemo(() => parseCheckpoints(detail.transcript), [detail.transcript]);
  const graph = React.useMemo(
    () => buildFlowGraph({ steps: detail.steps, checkpoints, run: latestRun, environmentName: props.environmentName ?? null, linkedCases: props.linkedCases ?? [] }),
    [detail.steps, checkpoints, latestRun, props.environmentName, props.linkedCases]
  );
  // Zero steps: the same words the Steps pane shows.
  if (detail.steps.filter((step) => !step.disabled).length === 0) return <p className="p-6 text-sm text-muted-foreground">No steps</p>;
  return (
    <ReactFlowProvider>
      <FlowCanvas graph={graph} layoutKey={`${detail.transcriptVersion}:${latestRun?.id ?? ""}`} selectedStepId={props.selectedStepId} onSelectStep={props.onSelectStep} />
    </ReactFlowProvider>
  );
}

const nodeTypes: NodeTypes = {
  start: FlowNodeView,
  setup: FlowNodeView,
  checkpoint: FlowNodeView,
  use: FlowNodeView,
  query: FlowNodeView,
  api: FlowNodeView,
  pill: FlowNodeView,
  end: FlowNodeView
};

// xyflow's own variables take the app tokens; its base stylesheet is imported in index.css.
const canvasStyle = {
  "--xy-background-color": "transparent",
  "--xy-background-pattern-color": "color-mix(in oklab, var(--foreground) 14%, transparent)",
  "--xy-edge-stroke": "color-mix(in oklab, var(--muted-foreground) 60%, transparent)",
  "--xy-edge-stroke-width": "1.5",
  "--xy-edge-label-color": "var(--muted-foreground)",
  "--xy-edge-label-background-color": "var(--background)",
  "--xy-controls-button-background-color": "var(--card)",
  "--xy-controls-button-background-color-hover": "var(--accent)",
  "--xy-controls-button-color": "var(--muted-foreground)",
  "--xy-controls-button-color-hover": "var(--foreground)",
  "--xy-controls-button-border-color": "var(--border)",
  "--xy-controls-box-shadow": "var(--shadow-soft)"
} as React.CSSProperties;

const edgeLabelStyle = { fontFamily: "var(--font-mono-proto, ui-monospace, monospace)", fontSize: 10 } as const;

type MeasuredSizes = Map<string, { width: number; height: number }>;

function FlowCanvas(props: { graph: FlowGraph; layoutKey: string; selectedStepId: string | null; onSelectStep: (stepId: string) => void }): React.JSX.Element {
  const { graph, layoutKey } = props;
  const flow = useReactFlow<FlowNodeType, Edge>();
  // Sizes xyflow measured, by node id; null until the first measurement.
  const [measured, setMeasured] = React.useState<MeasuredSizes | null>(null);
  // Keyboard moves render without transition; a pointer press turns motion back on.
  const [instant, setInstant] = React.useState(false);
  const selectedNode = flowNodeForStep(graph, props.selectedStepId);

  // First layout from estimated sizes; once xyflow measured the nodes, lay out again with the
  // real ones. A node keeps its measured size across data changes until xyflow reports a new one.
  const layout = React.useMemo(() => layoutFlow(graph, measured ? (node) => measured.get(node.id) ?? null : undefined), [graph, measured]);

  // Fit on mount and whenever a node moved or resized, not on every poll: the signature only
  // changes with positions and sizes. xyflow takes new positions in its own effect, so the fit
  // waits one frame. The `fitView` prop covers the very first paint.
  const layoutSignature = `${layoutKey}|${layout.nodes.map((node) => `${node.id}:${Math.round(node.x)}:${Math.round(node.y)}:${Math.round(node.height)}`).join("|")}`;
  React.useEffect(() => {
    // Until the first measurement the estimated layout is on screen, fitted by the prop.
    if (measured === null) return;
    const frame = requestAnimationFrame(() => void flow.fitView({ padding: 0.12, duration: 0 }));
    return () => cancelAnimationFrame(frame);
  }, [measured !== null, layoutSignature, flow]);

  // xyflow measures nodes with a ResizeObserver and reports the sizes as dimension changes;
  // a run arriving adds the cache-ratio row, so heights change after the first pass.
  const onNodesChange = (changes: NodeChange<FlowNodeType>[]) => {
    let next: MeasuredSizes | null = null;
    for (const change of changes) {
      if (change.type !== "dimensions" || !change.dimensions) continue;
      const previous = (next ?? measured)?.get(change.id);
      if (previous && Math.abs(previous.width - change.dimensions.width) < 0.5 && Math.abs(previous.height - change.dimensions.height) < 0.5) continue;
      next = next ?? new Map(measured ?? []);
      next.set(change.id, { width: change.dimensions.width, height: change.dimensions.height });
    }
    // Nothing changed size, so the layout stands.
    if (next === null) return;
    setMeasured(next);
  };

  const nodes = React.useMemo<FlowNodeType[]>(
    () =>
      layout.nodes.map((node) => ({
        id: node.id,
        type: flowNodeType(node.data.kind),
        position: { x: node.x, y: node.y },
        data: { node, selected: selectedNode?.id === node.id },
        draggable: false,
        connectable: false,
        selectable: false,
        focusable: false
      })),
    [layout, selectedNode]
  );

  const edges = React.useMemo<Edge[]>(
    () =>
      layout.edges.map((edge) => {
        if (edge.kind === "sequence") return { id: edge.id, source: edge.source, target: edge.target, sourceHandle: "out", targetHandle: "in", animated: edge.animated };
        // Producer → pill runs sideways; pill → consumer drops down the side with its label.
        if (edge.label === null) return { id: edge.id, source: edge.source, target: edge.target, sourceHandle: "side-out", targetHandle: "in", type: "straight" };
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: "out",
          targetHandle: "side-in",
          type: "smoothstep",
          label: edge.label,
          labelStyle: edgeLabelStyle,
          labelBgPadding: [4, 2] as [number, number],
          labelBgBorderRadius: 4
        };
      }),
    [layout]
  );

  const moveSelection = (direction: 1 | -1) => {
    const order = selectableFlowNodes(graph);
    // No node stands for a step, so there is nothing to move to.
    if (order.length === 0) return;
    const current = order.findIndex((node) => node.id === selectedNode?.id);
    const next = order[current === -1 ? (direction === 1 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, current + direction))];
    const stepId = next?.stepIds[0];
    if (stepId === undefined) return;
    setInstant(true);
    props.onSelectStep(stepId);
  };

  return (
    <div
      className="jl-flow relative min-h-0 flex-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
      data-instant={instant ? "true" : "false"}
      tabIndex={0}
      aria-label="Flow"
      onPointerDownCapture={() => setInstant(false)}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key !== "j" && event.key !== "k") return;
        event.preventDefault();
        moveSelection(event.key === "j" ? 1 : -1);
      }}
    >
      <ReactFlow<FlowNodeType, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        style={canvasStyle}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        minZoom={0.3}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        panOnDrag
        zoomOnScroll
        zoomOnDoubleClick={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        disableKeyboardA11y
        proOptions={{ hideAttribution: true }}
        onNodesChange={onNodesChange}
        onNodeClick={(_event, node) => {
          const stepId = node.data.node.stepIds[0];
          // Start without steps and End have nothing to select.
          if (stepId === undefined) return;
          props.onSelectStep(stepId);
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <Controls position="bottom-right" showInteractive={false} showFitView={false} />
      </ReactFlow>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------------------------

// Exported for the static render test; xyflow mounts it through nodeTypes.
export function FlowNodeView(props: NodeProps<FlowNodeType>): React.JSX.Element {
  const { node, selected } = props.data;
  const data = node.data;
  if (data.kind === "output") {
    return (
      <div className="jl-flow-node jl-flow-pill flex h-6 items-center rounded-full border border-teal-600/40 bg-card px-2 font-mono text-[11px] leading-none text-foreground shadow-soft" data-kind="output" data-selected={selected ? "true" : "false"}>
        <Handle id="in" type="target" position={Position.Left} isConnectable={false} />
        {data.name}
        <Handle id="out" type="source" position={Position.Bottom} isConnectable={false} />
      </div>
    );
  }
  const status = "status" in data ? data.status : null;
  const clickable = node.stepIds.length > 0;
  return (
    <div
      className={cn(
        "jl-flow-node rounded-lg border border-border bg-card text-card-foreground shadow-soft",
        data.kind === "end" ? "w-40" : "w-72",
        clickable ? "jl-tc-press cursor-pointer" : "cursor-default",
        status ? statusBorder[status] : null,
        selected ? "border-primary ring-1 ring-primary" : null
      )}
      data-kind={data.kind}
      data-status={status ?? undefined}
      data-selected={selected ? "true" : "false"}
      role={clickable ? "button" : undefined}
    >
      <Handle id="in" type="target" position={Position.Top} isConnectable={false} />
      <Handle id="side-in" type="target" position={Position.Right} isConnectable={false} />
      <NodeBody data={data} />
      <Handle id="out" type="source" position={Position.Bottom} isConnectable={false} />
      <Handle id="side-out" type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

function NodeBody(props: { data: Exclude<FlowNodeData, { kind: "output" }> }): React.JSX.Element {
  const { data } = props;
  switch (data.kind) {
    case "start":
      return (
        <div className="px-3 py-2">
          <div className="flex h-5 items-center gap-2 text-xs">
            <span className="font-medium">Start</span>
            {data.environment ? <span className="truncate font-mono text-[11px] text-muted-foreground">{data.environment}</span> : null}
          </div>
          <StepRows rows={data.rows} />
        </div>
      );
    case "setup":
    case "checkpoint":
      return (
        <div className="px-3 py-2">
          <div className="flex h-5 items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate font-medium">{data.title}</span>
            {data.status ? <span className={cn("size-2 shrink-0 rounded-full", statusDot[data.status])} aria-label={data.status} /> : null}
          </div>
          <StepRows rows={data.rows} />
          {data.replay ? (
            <div className="flex h-5 items-center gap-1 text-[11px] tabular-nums text-muted-foreground">
              <Zap className="size-2.5 text-success" aria-hidden />
              {data.replay.replayed}/{data.replay.ran} replayed
            </div>
          ) : null}
        </div>
      );
    case "use":
      return (
        <div className="px-3 py-2">
          <div className="flex h-5 items-center gap-2 text-xs">
            <span className="size-1.5 shrink-0 rounded-sm" style={{ backgroundColor: typeColour.use }} aria-hidden />
            <span className="font-mono text-[11px]">{data.caseKey}</span>
            <span className="rounded border border-border px-1 font-mono text-[10px] uppercase leading-4 text-muted-foreground">{data.mode}</span>
            {data.replayed ? <Zap className="size-2.5 text-success" aria-label="replayed" /> : null}
            <span className="ml-auto" />
            {data.status ? <span className={cn("size-2 shrink-0 rounded-full", statusDot[data.status])} aria-label={data.status} /> : null}
          </div>
          <div className="flex h-5 items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate">{data.caseTitle ?? "—"}</span>
            {data.alias ? <span className="shrink-0 font-mono text-[11px] text-muted-foreground">as {data.alias}</span> : null}
          </div>
          <div className="flex h-5 items-center text-[11px]">
            {data.caseId ? (
              <Link to={caseHref(data.caseId)} className="nodrag nopan inline-flex items-center gap-1 rounded text-muted-foreground hover:text-foreground" onClick={(event) => event.stopPropagation()}>
                <ExternalLink className="size-3" aria-hidden /> open {data.caseKey}
              </Link>
            ) : null}
          </div>
        </div>
      );
    case "query":
    case "api":
      return (
        <div className="px-3 py-2">
          <div className="flex h-5 items-center gap-2 text-xs">
            <span className="size-1.5 shrink-0 rounded-sm" style={{ backgroundColor: typeColour[data.kind] }} aria-hidden />
            <span className="font-medium">{data.kind === "query" ? "Query" : "API"}</span>
            {data.profile ? <span className="truncate font-mono text-[11px] text-muted-foreground">{data.profile}</span> : null}
            {data.replayed ? <Zap className="size-2.5 text-success" aria-label="replayed" /> : null}
            <span className="ml-auto" />
            {data.status ? <span className={cn("size-2 shrink-0 rounded-full", statusDot[data.status])} aria-label={data.status} /> : null}
          </div>
          <div className="h-5 truncate text-xs leading-5">{data.instruction}</div>
          {data.binding ? <div className="h-5 font-mono text-[11px] leading-5 text-muted-foreground">{"→"} {data.binding}</div> : null}
        </div>
      );
    case "end": {
      const outcome = data.outcome ? endLabel[data.outcome] : null;
      return (
        <div className="flex h-10 items-center justify-center gap-2 px-3 text-xs">
          <span className="font-medium">End</span>
          {outcome ? <span className={cn("font-medium", outcome.className)}>{outcome.text}</span> : null}
        </div>
      );
    }
  }
}

function StepRows(props: { rows: ReadonlyArray<FlowStepRow> }): React.JSX.Element | null {
  // A node without steps (a Start with no [Open]) has no list to draw.
  if (props.rows.length === 0) return null;
  return (
    <ol className="m-0 list-none p-0">
      {props.rows.map((row) => (
        <li key={row.stepId} className="flex h-5 items-center gap-2 text-xs" data-step-id={row.stepId}>
          <span className="h-3 w-1 shrink-0 rounded-sm" style={{ backgroundColor: typeColour[row.type] ?? typeColour.act }} aria-hidden />
          <span className="w-4 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">{row.ordinal}</span>
          <span className="min-w-0 flex-1 truncate">{row.label}</span>
          {row.replayed ? <Zap className="size-2.5 shrink-0 text-success" aria-label="replayed" /> : null}
          {row.status ? <span className={cn("size-1.5 shrink-0 rounded-full", statusDot[row.status])} aria-label={row.status} /> : null}
        </li>
      ))}
    </ol>
  );
}
