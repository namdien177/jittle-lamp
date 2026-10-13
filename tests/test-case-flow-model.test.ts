import { describe, expect, test } from "bun:test";
import { parseTestCaseTranscript } from "@jittle-lamp/shared";

import {
  buildFlowGraph,
  flowNodeForStep,
  flowOutputGap,
  layoutFlow,
  selectableFlowNodes,
  stepBinding,
  useReference,
  type FlowGraphInput,
  type FlowNodeData,
  type FlowRun
} from "../apps/evidence-web/src/test-cases/flow-model";
import { fixtureRunDetail, fixtureRunSteps, fixtureTestCaseDetail } from "./fixtures/test-api-fixtures";

// The Flow view's pure model (roadmap §3.4): steps and checkpoints become nodes, document order
// becomes edges, outputs point at their first reader, and dagre places it all top to bottom.

function graphOf(transcript: string, extra: Partial<FlowGraphInput> = {}) {
  const { testCase } = parseTestCaseTranscript(transcript);
  return { testCase, graph: buildFlowGraph({ steps: testCase.steps, checkpoints: testCase.checkpoints, ...extra }) };
}

function kinds(graph: { nodes: Array<{ data: FlowNodeData }> }): string[] {
  return graph.nodes.map((node) => node.data.kind);
}

// The node data whose `kind` admits K (a group's kind is "setup" | "checkpoint").
type DataOf<K extends FlowNodeData["kind"]> = FlowNodeData extends infer T ? (T extends { kind: infer Kind } ? (K extends Kind ? T : never) : never) : never;

function data<K extends FlowNodeData["kind"]>(graph: { nodes: Array<{ data: FlowNodeData }> }, kind: K, index = 0): DataOf<K> {
  const matches = graph.nodes.filter((node) => node.data.kind === kind);
  const node = matches[index];
  if (!node) throw new Error(`no ${kind} node #${index}`);
  return node.data as DataOf<K>;
}

function nodeId(graph: { nodes: Array<{ id: string }> }, index: number): string {
  const node = graph.nodes[index];
  if (!node) throw new Error(`no node #${index}`);
  return node.id;
}

function stepIdAt(testCase: { steps: Array<{ stepId: string }> }, index: number): string {
  const step = testCase.steps[index];
  if (!step) throw new Error(`no step #${index}`);
  return step.stepId;
}

describe("flow model: nodes", () => {
  test("checkpoints only: Start takes the leading [Open]/[Login], Setup the rest, one node per checkpoint, End last", () => {
    const { graph } = graphOf(
      "# A\n\n[Open] /login\n[Login: PCF_HQ_ADMIN]\n[Assert] dashboard\n\n## Checkpoint: One\n[Act] click\n[Assert] saw it\n\n## Checkpoint: Two\n[Screenshot] done\n",
      { environmentName: "pcf-uat" }
    );
    expect(kinds(graph)).toEqual(["start", "setup", "checkpoint", "checkpoint", "end"]);
    const start = data(graph, "start");
    expect(start.environment).toBe("pcf-uat");
    expect(start.rows.map((row) => row.type)).toEqual(["open", "login"]);
    expect(start.rows[1]?.label).toBe("Login: PCF_HQ_ADMIN");
    expect(data(graph, "setup").rows.map((row) => row.label)).toEqual(["dashboard"]);
    expect(data(graph, "checkpoint", 0).title).toBe("One");
    expect(data(graph, "checkpoint", 0).rows.map((row) => row.ordinal)).toEqual([4, 5]);
    expect(data(graph, "checkpoint", 1).title).toBe("Two");
    expect(data(graph, "end").outcome).toBeNull();
    // No run: no status, no cache ratio.
    expect(data(graph, "checkpoint", 0).status).toBeNull();
    expect(data(graph, "checkpoint", 0).replay).toBeNull();
    const sequence = graph.edges.filter((edge) => edge.kind === "sequence");
    expect(sequence.map((edge) => `${edge.source}>${edge.target}`)).toEqual([
      "start>group:setup",
      "group:setup>group:cp_" + (graph.nodes[2]?.id.slice("group:cp_".length) ?? ""),
      `${graph.nodes[2]?.id}>${graph.nodes[3]?.id}`,
      `${graph.nodes[3]?.id}>end`
    ]);
    expect(graph.edges.every((edge) => !edge.animated)).toBe(true);
  });

  test("disabled steps stay out; a case with only plain steps is Start, Setup, End", () => {
    const { graph } = graphOf("# A\n\n[Act] one\n[Act] two\n");
    expect(kinds(graph)).toEqual(["start", "setup", "end"]);
    expect(data(graph, "start").rows).toEqual([]);
    const { graph: withDisabled } = graphOf("# A\n\n[Act] one\n// [Act] off\n[Act] two\n");
    expect(data(withDisabled, "setup").rows.map((row) => row.label)).toEqual(["one", "two"]);
  });

  test("[Use] with alias and outputs referenced later: a use node, one pill per {alias.name}, labelled edge to the first reader, link by key", () => {
    const { graph, testCase } = graphOf(
      "# A\n\n[Open] /\n[Use: TC-0012 as registration]\n[Act] wait\n[Act] open {registration.applicationId}\n[Assert] {registration.applicationId} and {registration.childName}\n",
      { linkedCases: [{ key: "tc-0012", id: "case_12", title: "Parent registers a child" }] }
    );
    expect(kinds(graph)).toEqual(["start", "use", "output", "output", "setup", "end"]);
    const use = data(graph, "use");
    expect(use).toMatchObject({ caseKey: "TC-0012", alias: "registration", caseId: "case_12", caseTitle: "Parent registers a child", mode: "auto", status: null, replayed: false });
    expect(data(graph, "output", 0).name).toBe("registration.applicationId");
    expect(data(graph, "output", 1).name).toBe("registration.childName");
    const useNode = nodeId(graph, 1);
    const pill = nodeId(graph, 2);
    const setup = nodeId(graph, 4);
    expect(graph.nodes[1]?.stepIds).toEqual([stepIdAt(testCase, 1)]);
    // The pill stands for its producer step, so clicking it selects that step.
    expect(graph.nodes[2]?.stepIds).toEqual([stepIdAt(testCase, 1)]);
    const outputs = graph.edges.filter((edge) => edge.kind === "output");
    expect(outputs.map((edge) => [edge.source, edge.target, edge.label])).toEqual([
      [useNode, pill, null],
      [pill, setup, "{registration.applicationId}"],
      [useNode, nodeId(graph, 3), null],
      [nodeId(graph, 3), setup, "{registration.childName}"]
    ]);
  });

  test("[Use] without a later reader keeps one bare alias pill; no alias means no pill; mode= sets the chip", () => {
    const { graph } = graphOf("# A\n\n[Use: TC-0001 as login]\n[Act] continue\n");
    expect(kinds(graph)).toEqual(["start", "use", "output", "setup", "end"]);
    expect(data(graph, "output").name).toBe("login");
    expect(graph.edges.filter((edge) => edge.kind === "output" && edge.label !== null)).toEqual([]);
    const { graph: plain } = graphOf("# A\n\n[Use: case=TC-0001, mode=api]\n[Act] continue\n");
    expect(kinds(plain)).toEqual(["start", "use", "setup", "end"]);
    expect(data(plain, "use").mode).toBe("api");
    expect(data(plain, "use").caseTitle).toBeNull();
    expect(data(plain, "use").caseId).toBeNull();
  });

  test("the schema's alias and binding fields win over the written form when present", () => {
    const { testCase } = parseTestCaseTranscript("# A\n\n[Use: TC-0001]\n[Extract: orderId] the order id\n");
    const useStep = { ...(testCase.steps[0] as NonNullable<(typeof testCase.steps)[0]>), alias: "shop" };
    expect(useReference(useStep)).toEqual({ caseKey: "TC-0001", alias: "shop" });
    expect(useReference(testCase.steps[0] as NonNullable<(typeof testCase.steps)[0]>)).toEqual({ caseKey: "TC-0001", alias: null });
    const extract = testCase.steps[1] as NonNullable<(typeof testCase.steps)[1]>;
    expect(stepBinding(extract)).toBe("orderId");
    expect(stepBinding({ ...extract, binding: "order" })).toBe("order");
    // Query and API steps (another branch's grammar) bind through `-> {name}` or the field.
    expect(stepBinding({ ...extract, type: "query", args: [], text: "select id from orders -> {orderId}" })).toBe("orderId");
    expect(stepBinding({ ...extract, type: "api", args: [], text: "GET /orders" })).toBeNull();
  });

  test("[Extract] binding consumed by a later [Open]: the pill hangs off the checkpoint and its edge lands on the reader", () => {
    const { graph } = graphOf("# A\n\n[Open] /\n\n## Checkpoint: Find\n[Extract: applicationId] the id in the header\n[Assert] visible\n\n## Checkpoint: Review\n[Act] breathe\n\n## Checkpoint: Open\n[Open] /apps/{applicationId}\n");
    expect(kinds(graph)).toEqual(["start", "checkpoint", "output", "checkpoint", "checkpoint", "end"]);
    expect(data(graph, "output").name).toBe("applicationId");
    expect(graph.edges.filter((edge) => edge.kind === "output").map((edge) => [edge.source, edge.target, edge.label])).toEqual([
      [nodeId(graph, 1), nodeId(graph, 2), null],
      [nodeId(graph, 2), nodeId(graph, 4), "{applicationId}"]
    ]);
  });

  test("[Query] and [API] steps (another branch's types) become their own nodes with profile, instruction and binding", () => {
    const { testCase } = parseTestCaseTranscript("# A\n\n[Open] /\n[Act] later {rows}\n");
    const base = testCase.steps[1] as NonNullable<(typeof testCase.steps)[1]>;
    const query = { ...base, stepId: "st_query", ordinal: 2, type: "query", tag: "Query", args: [{ name: null, value: "PCF_DB" }], text: "select * from forms -> {rows}", variables: [] };
    const api = { ...base, stepId: "st_api", ordinal: 3, type: "api", tag: "API", args: [{ name: "profile", value: "PCF_API" }], text: "GET /forms/{rows}", variables: ["rows"] };
    const graph = buildFlowGraph({ steps: [testCase.steps[0] as NonNullable<(typeof testCase.steps)[0]>, query, api], checkpoints: [] });
    expect(kinds(graph)).toEqual(["start", "query", "output", "api", "end"]);
    expect(data(graph, "query")).toMatchObject({ profile: "PCF_DB", instruction: "select * from forms", binding: "rows" });
    expect(data(graph, "api")).toMatchObject({ profile: "PCF_API", instruction: "GET /forms/{rows}", binding: null });
    expect(graph.edges.find((edge) => edge.label === "{rows}")?.target).toBe("step:st_api");
  });

  test("a checkpoint split by a [Use] continues in a second node with the same title", () => {
    const { graph } = graphOf("# A\n\n## Checkpoint: Flow\n[Act] before\n[Use: TC-0001]\n[Act] after\n");
    expect(kinds(graph)).toEqual(["start", "checkpoint", "use", "checkpoint", "end"]);
    expect(graph.nodes[1]?.id).not.toBe(graph.nodes[3]?.id);
    expect(data(graph, "checkpoint", 1).title).toBe("Flow");
  });
});

describe("flow model: run status", () => {
  const detail = fixtureTestCaseDetail();
  const checkpoints = parseTestCaseTranscript(detail.transcript).testCase.checkpoints;

  test("a completed run colours the rows, aggregates the node status, counts the cache ratio and sets the outcome", () => {
    const run = fixtureRunDetail({ status: "completed", outcome: "passed" });
    const graph = buildFlowGraph({ steps: detail.steps, checkpoints, run });
    expect(kinds(graph)).toEqual(["start", "setup", "checkpoint", "end"]);
    expect(data(graph, "start").rows.map((row) => row.status)).toEqual(["passed", "passed"]);
    // Row 2 is the [Login] the fixture marks as run by the agent; the [Open] is deterministic.
    expect(data(graph, "start").rows.map((row) => row.replayed)).toEqual([false, false]);
    const setup = data(graph, "setup");
    expect(setup.status).toBe("passed");
    expect(setup.rows.map((row) => row.replayed)).toEqual([false, true]);
    expect(setup.replay).toEqual({ ran: 2, replayed: 1 });
    expect(data(graph, "checkpoint").replay).toEqual({ ran: 2, replayed: 0 });
    expect(data(graph, "end").outcome).toBe("passed");
    expect(graph.edges.some((edge) => edge.animated)).toBe(false);
  });

  test("a failed step fails its node; the end shows the run outcome", () => {
    const steps = fixtureRunSteps(["passed", "passed", "passed", "passed", "failed", "skipped"]);
    const run: FlowRun = { ...fixtureRunDetail({ status: "failed", outcome: "failed" }), steps };
    const graph = buildFlowGraph({ steps: detail.steps, checkpoints, run });
    expect(data(graph, "setup").status).toBe("passed");
    expect(data(graph, "checkpoint").status).toBe("failed");
    expect(data(graph, "checkpoint").rows.map((row) => row.status)).toEqual(["failed", "skipped"]);
    expect(data(graph, "end").outcome).toBe("failed");
  });

  test("while running, the edge leaving the current step's node is animated and nothing else is", () => {
    const run = fixtureRunDetail({ status: "running" });
    const graph = buildFlowGraph({ steps: detail.steps, checkpoints, run });
    // The fixture's running step is the fourth (last of Setup).
    expect(data(graph, "setup").status).toBe("running");
    expect(data(graph, "setup").rows.map((row) => row.status)).toEqual(["passed", "running"]);
    expect(data(graph, "checkpoint").status).toBe("pending");
    expect(data(graph, "end").outcome).toBe("running");
    const animated = graph.edges.filter((edge) => edge.animated);
    expect(animated.map((edge) => [edge.source, edge.target])).toEqual([["group:setup", nodeId(graph, 2)]]);
  });

  test("a queued run reports pending rows, no cache ratio counts and a queued end", () => {
    const run = fixtureRunDetail({ status: "queued" });
    const graph = buildFlowGraph({ steps: detail.steps, checkpoints, run });
    expect(data(graph, "setup").status).toBe("pending");
    expect(data(graph, "setup").replay).toEqual({ ran: 0, replayed: 0 });
    expect(data(graph, "end").outcome).toBe("queued");
  });

  test("[Use] run as replayed shows the reused chip", () => {
    const { testCase } = parseTestCaseTranscript("# A\n\n[Use: TC-0001]\n[Act] continue\n");
    const useId = testCase.steps[0]?.stepId ?? "";
    const run: FlowRun = { id: "r1", status: "completed", outcome: "passed", currentStepId: null, steps: [{ stepId: useId, status: "passed", mode: "replayed" }] };
    const graph = buildFlowGraph({ steps: testCase.steps, checkpoints: [], run });
    expect(data(graph, "use")).toMatchObject({ mode: "reused", replayed: true, status: "passed" });
  });
});

describe("flow model: layout and selection", () => {
  const transcript = "# A\n\n[Open] /\n[Login: X]\n[Act] prepare\n[Use: TC-0012 as registration]\n[Act] open {registration.applicationId}\n\n## Checkpoint: Find\n[Extract: applicationId] the id\n[Assert] ok\n\n## Checkpoint: Open\n[Open] /apps/{applicationId}\n";

  test("dagre: every position is finite, the chain stacks top to bottom without overlap, pills sit beside their producer", () => {
    const { graph } = graphOf(transcript);
    const layout = layoutFlow(graph);
    for (const node of layout.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
      expect(node.width).toBeGreaterThan(0);
      expect(node.height).toBeGreaterThan(0);
    }
    const chain = layout.nodes.filter((node) => node.data.kind !== "output");
    for (let index = 0; index + 1 < chain.length; index += 1) {
      const above = chain[index];
      const below = chain[index + 1];
      if (!above || !below) throw new Error("chain too short");
      expect(below.y).toBeGreaterThanOrEqual(above.y + above.height);
    }
    // One straight column: every chain node shares the centre x of the first.
    const centre = (node: { x: number; width: number }) => node.x + node.width / 2;
    const first = chain[0];
    if (!first) throw new Error("no nodes");
    for (const node of chain) expect(Math.abs(centre(node) - centre(first))).toBeLessThan(0.5);
    for (const edge of graph.edges.filter((item) => item.kind === "output" && item.label === null)) {
      const producer = layout.nodes.find((node) => node.id === edge.source);
      const pill = layout.nodes.find((node) => node.id === edge.target);
      if (!producer || !pill) throw new Error("missing pill or producer");
      expect(pill.x).toBe(producer.x + producer.width + flowOutputGap);
      expect(pill.y).toBeGreaterThanOrEqual(producer.y);
      expect(pill.y + pill.height).toBeLessThanOrEqual(producer.y + producer.height);
    }
  });

  test("measured sizes replace the estimates and move the rows below", () => {
    const { graph } = graphOf(transcript);
    const estimated = layoutFlow(graph);
    const measured = layoutFlow(graph, (node) => (node.id === "start" ? { width: 288, height: 300 } : null));
    const startAfter = measured.nodes.find((node) => node.id === "start");
    const setupBefore = estimated.nodes.find((node) => node.id === "group:setup");
    const setupAfter = measured.nodes.find((node) => node.id === "group:setup");
    expect(startAfter?.height).toBe(300);
    expect((setupAfter?.y ?? 0) - (setupBefore?.y ?? 0)).toBeGreaterThan(200);
  });

  test("j/k order and the node for a step", () => {
    const { graph, testCase } = graphOf(transcript);
    expect(selectableFlowNodes(graph).map((node) => node.data.kind)).toEqual(["start", "setup", "use", "setup", "checkpoint", "checkpoint"]);
    const extractId = testCase.steps[5]?.stepId ?? "";
    expect(flowNodeForStep(graph, extractId)?.data.kind).toBe("checkpoint");
    expect(flowNodeForStep(graph, null)).toBeNull();
    expect(flowNodeForStep(graph, "nope")).toBeNull();
  });
});
