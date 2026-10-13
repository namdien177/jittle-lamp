import dagre from "@dagrejs/dagre";
import type { TestRunDetail, TestRunStep, TranscriptCheckpoint, TranscriptStep } from "@jittle-lamp/shared";

// Pure model of the case page's Flow view (roadmap §3.4, decision 4): the parsed steps, their
// checkpoints and the latest run become nodes and edges; dagre places them top to bottom. No
// React, no xyflow: flow-view.tsx maps this onto xyflow nodes, tests read it directly.

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

// Steps as the shared schema has them today, plus the fields the grammar is gaining on another
// branch (`[Use: KEY as alias]`, `[Query]/[API] ... -> {name}`, step types `query` and `api`).
// They are read defensively here and never required.
export type FlowStep = Omit<Pick<TranscriptStep, "stepId" | "ordinal" | "type" | "tag" | "args" | "text" | "checkpointId" | "variables" | "disabled">, "type"> & {
  type: string;
  alias?: string | null;
  binding?: string | null;
};

export type FlowRunStep = Pick<TestRunStep, "stepId" | "status" | "mode">;

export type FlowRun = Pick<TestRunDetail, "id" | "status" | "outcome" | "currentStepId"> & { steps: ReadonlyArray<FlowRunStep> };

export type FlowLinkedCase = { key: string; id: string | null; title: string | null };

export type FlowGraphInput = {
  steps: ReadonlyArray<FlowStep>;
  checkpoints: ReadonlyArray<Pick<TranscriptCheckpoint, "checkpointId" | "title">>;
  run?: FlowRun | null;
  environmentName?: string | null;
  linkedCases?: ReadonlyArray<FlowLinkedCase>;
};

// ---------------------------------------------------------------------------------------------
// Nodes and edges
// ---------------------------------------------------------------------------------------------

export type FlowStepStatus = "pending" | "running" | "passed" | "failed" | "blocked" | "skipped";

export type FlowStepRow = {
  stepId: string;
  ordinal: number;
  type: string;
  label: string;
  // null until a run reports the step.
  status: FlowStepStatus | null;
  replayed: boolean;
};

export type FlowUseMode = "api" | "ui" | "auto" | "reused";

export type FlowNodeData =
  | { kind: "start"; environment: string | null; rows: FlowStepRow[] }
  | { kind: "setup" | "checkpoint"; title: string; rows: FlowStepRow[]; status: FlowStepStatus | null; replay: { ran: number; replayed: number } | null }
  | { kind: "use"; caseKey: string; caseTitle: string | null; caseId: string | null; alias: string | null; mode: FlowUseMode; status: FlowStepStatus | null; replayed: boolean }
  | { kind: "query" | "api"; profile: string | null; instruction: string; binding: string | null; status: FlowStepStatus | null; replayed: boolean }
  | { kind: "output"; name: string }
  | { kind: "end"; outcome: "passed" | "failed" | "blocked" | "running" | "queued" | null };

export type FlowNodeKind = FlowNodeData["kind"];

export type FlowNode = {
  id: string;
  data: FlowNodeData;
  // Steps the node stands for, in document order; the first is what a click selects.
  stepIds: string[];
  // Estimated size for the first layout; the view re-lays out with measured sizes.
  width: number;
  height: number;
};

export type FlowEdge = {
  id: string;
  source: string;
  target: string;
  kind: "sequence" | "output";
  label: string | null;
  animated: boolean;
};

export type FlowGraph = { nodes: FlowNode[]; edges: FlowEdge[] };

export type PositionedFlowNode = FlowNode & { x: number; y: number };

export type FlowLayout = { nodes: PositionedFlowNode[]; edges: FlowEdge[] };

// Node types that stand alone in the diagram rather than inside a checkpoint list.
const standaloneTypes = new Set(["use", "query", "api"]);

export const flowNodeWidth = 288;
export const flowEndWidth = 160;
export const flowOutputHeight = 24;
const rowHeight = 20;
const titleHeight = 20;
const padding = 20;

function positionalArg(step: FlowStep): string | null {
  const positional = step.args.find((arg) => arg.name === null);
  return positional && positional.value.trim().length > 0 ? positional.value.trim() : null;
}

function namedArg(step: FlowStep, name: string): string | null {
  const named = step.args.find((arg) => arg.name?.toLowerCase() === name);
  return named && named.value.trim().length > 0 ? named.value.trim() : null;
}

// `[Use: TC-0012 as registration]` or `[Use: case=TC-0012, as=registration]`: the key and the
// alias. The schema's `alias` field wins once the grammar branch lands; until then the positional
// argument still carries `KEY as alias` as one string.
export function useReference(step: FlowStep): { caseKey: string | null; alias: string | null } {
  const positional = positionalArg(step);
  const asMatch = positional ? /^(\S+)\s+as\s+(\S+)$/i.exec(positional) : null;
  const caseKey = namedArg(step, "case") ?? asMatch?.[1] ?? positional;
  const alias = step.alias ?? namedArg(step, "as") ?? asMatch?.[2] ?? null;
  return { caseKey, alias };
}

// `[Extract: name]`, `[Query: PROFILE] ... -> {name}` or `[API: PROFILE] ... -> {name}`: the name
// the step binds for later steps.
export function stepBinding(step: FlowStep): string | null {
  if (step.binding) return step.binding;
  if (step.type === "extract") return positionalArg(step);
  if (step.type === "query" || step.type === "api") {
    const arrow = /->\s*\{([^{}\s]+)\}\s*$/.exec(step.text);
    return arrow?.[1] ?? null;
  }
  return null;
}

function stepLabel(step: FlowStep): string {
  if (step.text.length > 0) return step.text;
  const positional = positionalArg(step);
  const tag = step.tag ?? step.type;
  return positional ? `${tag}: ${positional}` : tag;
}

function runStatus(step: FlowRunStep | undefined): FlowStepStatus | null {
  if (!step) return null;
  return step.status;
}

// One status for a node: a failure fails it, a block blocks it, a running step runs it, every
// step passed (or was skipped) passes it; otherwise it is pending.
function groupStatus(rows: ReadonlyArray<FlowStepRow>): FlowStepStatus | null {
  const reported = rows.filter((row) => row.status !== null);
  if (reported.length === 0) return null;
  if (reported.some((row) => row.status === "failed")) return "failed";
  if (reported.some((row) => row.status === "blocked")) return "blocked";
  if (reported.some((row) => row.status === "running")) return "running";
  if (reported.every((row) => row.status === "passed" || row.status === "skipped")) return reported.some((row) => row.status === "passed") ? "passed" : "skipped";
  return "pending";
}

function replayRatio(rows: ReadonlyArray<FlowStepRow>, hasRun: boolean): { ran: number; replayed: number } | null {
  // Without run data there is no cache ratio to show.
  if (!hasRun) return null;
  const ran = rows.filter((row) => row.status === "passed" || row.status === "failed" || row.status === "blocked");
  return { ran: ran.length, replayed: ran.filter((row) => row.replayed).length };
}

export function buildFlowGraph(input: FlowGraphInput): FlowGraph {
  const steps = input.steps.filter((step) => !step.disabled);
  const run = input.run ?? null;
  const runSteps = new Map((run?.steps ?? []).map((step) => [step.stepId, step]));
  const titles = new Map(input.checkpoints.map((checkpoint) => [checkpoint.checkpointId, checkpoint.title]));
  const linked = new Map((input.linkedCases ?? []).map((item) => [item.key.toLowerCase(), item]));

  const row = (step: FlowStep): FlowStepRow => {
    const reported = runSteps.get(step.stepId);
    return { stepId: step.stepId, ordinal: step.ordinal, type: step.type, label: stepLabel(step), status: runStatus(reported), replayed: reported?.mode === "replayed" };
  };

  // Nodes in document order. `main` are the ones the sequence edges chain; output pills hang off
  // their producer and point at their first consumer.
  const nodes: FlowNode[] = [];
  const main: FlowNode[] = [];
  const outputs: Array<{ node: FlowNode; producer: FlowNode; producerIndex: number }> = [];

  const pushMain = (node: FlowNode) => {
    nodes.push(node);
    main.push(node);
  };

  const pushOutput = (producer: FlowNode, name: string) => {
    const node: FlowNode = {
      id: `out:${producer.id}:${name}`,
      data: { kind: "output", name },
      stepIds: producer.stepIds.length > 0 ? [producer.stepIds[producer.stepIds.length - 1] as string] : [],
      width: Math.max(56, 20 + name.length * 7.2),
      height: flowOutputHeight
    };
    nodes.push(node);
    outputs.push({ node, producer, producerIndex: main.length - 1 });
  };

  // Start: the environment and the leading [Open]/[Login] steps before anything else happens.
  let index = 0;
  const startRows: FlowStepRow[] = [];
  while (index < steps.length) {
    const step = steps[index] as FlowStep;
    if (step.checkpointId !== null || (step.type !== "open" && step.type !== "login")) break;
    startRows.push(row(step));
    index += 1;
  }
  pushMain({
    id: "start",
    data: { kind: "start", environment: input.environmentName ?? null, rows: startRows },
    stepIds: startRows.map((item) => item.stepId),
    width: flowNodeWidth,
    height: padding + titleHeight + startRows.length * rowHeight
  });

  // Groups: a run of plain steps under one checkpoint (or none: Setup). A standalone step closes
  // the group; the same checkpoint continues in a new node after it.
  let group: { key: string; kind: "setup" | "checkpoint"; title: string; rows: FlowStepRow[]; steps: FlowStep[] } | null = null;
  const groupCounts = new Map<string, number>();

  const flushGroup = () => {
    // Nothing to flush when no plain step opened a group since the last node.
    if (group === null) return;
    const occurrence = groupCounts.get(group.key) ?? 0;
    groupCounts.set(group.key, occurrence + 1);
    const ratio = replayRatio(group.rows, run !== null);
    const node: FlowNode = {
      id: occurrence === 0 ? `group:${group.key}` : `group:${group.key}:${occurrence}`,
      data: { kind: group.kind, title: group.title, rows: group.rows, status: groupStatus(group.rows), replay: ratio },
      stepIds: group.rows.map((item) => item.stepId),
      width: flowNodeWidth,
      height: padding + titleHeight + group.rows.length * rowHeight + (ratio ? rowHeight : 0)
    };
    pushMain(node);
    for (const step of group.steps) {
      const binding = stepBinding(step);
      if (binding) pushOutput(node, binding);
    }
    group = null;
  };

  for (; index < steps.length; index += 1) {
    const step = steps[index] as FlowStep;
    if (standaloneTypes.has(step.type)) {
      flushGroup();
      const reported = runSteps.get(step.stepId);
      const status = runStatus(reported);
      const replayed = reported?.mode === "replayed";
      if (step.type === "use") {
        const { caseKey, alias } = useReference(step);
        const key = caseKey ?? "?";
        const target = linked.get(key.toLowerCase());
        const requested = (namedArg(step, "mode") ?? "auto").toLowerCase();
        const mode: FlowUseMode = replayed ? "reused" : requested === "api" || requested === "ui" ? requested : "auto";
        const node: FlowNode = {
          id: `step:${step.stepId}`,
          data: { kind: "use", caseKey: key, caseTitle: target?.title ?? null, caseId: target?.id ?? null, alias, mode, status, replayed },
          stepIds: [step.stepId],
          width: flowNodeWidth,
          height: padding + titleHeight * 3
        };
        pushMain(node);
        if (alias) {
          // One pill per `{alias.name}` a later step reads; the bare alias when none does.
          const consumed = new Set<string>();
          for (const later of steps.slice(index + 1)) {
            for (const variable of later.variables) if (variable.startsWith(`${alias}.`)) consumed.add(variable);
          }
          if (consumed.size === 0) pushOutput(node, alias);
          for (const name of consumed) pushOutput(node, name);
        }
        continue;
      }
      const binding = stepBinding(step);
      const instruction = binding ? step.text.replace(/\s*->\s*\{[^{}\s]+\}\s*$/, "") : step.text;
      const node: FlowNode = {
        id: `step:${step.stepId}`,
        data: { kind: step.type === "query" ? "query" : "api", profile: namedArg(step, "profile") ?? positionalArg(step), instruction, binding, status, replayed },
        stepIds: [step.stepId],
        width: flowNodeWidth,
        height: padding + titleHeight * (binding ? 3 : 2)
      };
      pushMain(node);
      if (binding) pushOutput(node, binding);
      continue;
    }
    const key = step.checkpointId ?? "setup";
    if (group !== null && group.key !== key) flushGroup();
    if (group === null) {
      group = {
        key,
        kind: step.checkpointId === null ? "setup" : "checkpoint",
        title: step.checkpointId === null ? "Setup" : (titles.get(step.checkpointId) ?? "Checkpoint"),
        rows: [],
        steps: []
      };
    }
    group.rows.push(row(step));
    group.steps.push(step);
  }
  flushGroup();

  pushMain({
    id: "end",
    data: { kind: "end", outcome: endOutcome(run) },
    stepIds: [],
    width: flowEndWidth,
    height: 40
  });

  // Edges: the document-order chain, animated where the runner currently is, then one edge per
  // output pill to the first later node that reads it.
  const currentNodeId = currentNode(main, run);
  const edges: FlowEdge[] = [];
  for (let position = 0; position + 1 < main.length; position += 1) {
    const source = main[position] as FlowNode;
    const target = main[position + 1] as FlowNode;
    edges.push({ id: `seq:${source.id}:${target.id}`, source: source.id, target: target.id, kind: "sequence", label: null, animated: run?.status === "running" && source.id === currentNodeId });
  }
  const stepsById = new Map(steps.map((step) => [step.stepId, step]));
  for (const output of outputs) {
    edges.push({ id: `out:${output.producer.id}:${output.node.id}`, source: output.producer.id, target: output.node.id, kind: "output", label: null, animated: false });
    const name = (output.node.data as { name: string }).name;
    const consumer = main.slice(output.producerIndex + 1).find((candidate) => candidate.stepIds.some((stepId) => stepsById.get(stepId)?.variables.includes(name)));
    // An output nothing reads yet stays a dangling pill.
    if (!consumer) continue;
    edges.push({ id: `use:${output.node.id}:${consumer.id}`, source: output.node.id, target: consumer.id, kind: "output", label: `{${name}}`, animated: false });
  }

  return { nodes, edges };
}

function endOutcome(run: FlowRun | null): Extract<FlowNodeData, { kind: "end" }>["outcome"] {
  if (!run) return null;
  if (run.outcome) return run.outcome;
  if (run.status === "running" || run.status === "paused") return "running";
  if (run.status === "queued" || run.status === "claimed") return "queued";
  return null;
}

// The node holding the step the runner is inside: the run's currentStepId, else its first step
// still reported as running.
function currentNode(main: ReadonlyArray<FlowNode>, run: FlowRun | null): string | null {
  if (!run) return null;
  const currentStepId = run.currentStepId ?? run.steps.find((step) => step.status === "running")?.stepId ?? null;
  if (currentStepId === null) return null;
  return main.find((node) => node.stepIds.includes(currentStepId))?.id ?? null;
}

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

export const flowLayoutOptions = { rankdir: "TB", nodesep: 24, ranksep: 40 } as const;

// Gap between a producer and the output pills stacked beside it, and between those pills.
export const flowOutputGap = 16;
const outputStackGap = 8;

// Top-to-bottom dagre layout of the sequence chain. Output pills stay out of dagre: they sit to
// the right of their producer, vertically centred on it, so the chain keeps one straight column
// and the pill→consumer edge runs down the side. `measure` swaps a node's estimated size for the
// size the DOM reported.
export function layoutFlow(graph: FlowGraph, measure?: (node: FlowNode) => { width: number; height: number } | null): FlowLayout {
  const dag = new dagre.graphlib.Graph();
  dag.setGraph({ ...flowLayoutOptions });
  dag.setDefaultEdgeLabel(() => ({}));
  const sizes = new Map<string, { width: number; height: number }>();
  for (const node of graph.nodes) {
    const size = measure?.(node) ?? { width: node.width, height: node.height };
    sizes.set(node.id, size);
    if (node.data.kind === "output") continue;
    dag.setNode(node.id, { width: size.width, height: size.height });
  }
  for (const edge of graph.edges) {
    if (edge.kind !== "sequence") continue;
    dag.setEdge(edge.source, edge.target);
  }
  dagre.layout(dag);

  const placed = new Map<string, PositionedFlowNode>();
  for (const node of graph.nodes) {
    if (node.data.kind === "output") continue;
    const size = sizes.get(node.id) ?? node;
    const centre = dag.node(node.id);
    placed.set(node.id, { ...node, width: size.width, height: size.height, x: centre.x - size.width / 2, y: centre.y - size.height / 2 });
  }

  // Pills per producer, in document order, as one centred stack.
  const stacks = new Map<string, FlowNode[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "output" || edge.label !== null) continue;
    const pill = graph.nodes.find((node) => node.id === edge.target);
    if (!pill) continue;
    stacks.set(edge.source, [...(stacks.get(edge.source) ?? []), pill]);
  }
  for (const [producerId, pills] of stacks) {
    const producer = placed.get(producerId);
    // A pill whose producer is not in the chain has nowhere to hang.
    if (!producer) continue;
    const heights = pills.map((pill) => (sizes.get(pill.id) ?? pill).height);
    const total = heights.reduce((sum, height) => sum + height, 0) + outputStackGap * (pills.length - 1);
    let y = producer.y + producer.height / 2 - total / 2;
    pills.forEach((pill, index) => {
      const size = sizes.get(pill.id) ?? pill;
      placed.set(pill.id, { ...pill, width: size.width, height: size.height, x: producer.x + producer.width + flowOutputGap, y });
      y += (heights[index] ?? size.height) + outputStackGap;
    });
  }

  const nodes = graph.nodes.map((node) => placed.get(node.id) ?? { ...node, x: 0, y: 0 });
  return { nodes, edges: graph.edges };
}

// Document-order nodes a keyboard move lands on: those standing for at least one step.
export function selectableFlowNodes(graph: FlowGraph): FlowNode[] {
  return graph.nodes.filter((node) => node.data.kind !== "output" && node.stepIds.length > 0);
}

export function flowNodeForStep(graph: FlowGraph, stepId: string | null): FlowNode | null {
  if (stepId === null) return null;
  return graph.nodes.find((node) => node.data.kind !== "output" && node.stepIds.includes(stepId)) ?? null;
}
