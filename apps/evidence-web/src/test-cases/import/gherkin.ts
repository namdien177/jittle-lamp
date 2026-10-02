// Client-side preview of a Gherkin `.feature` file as a transcript document (design.md §7: Given/When
// → [Act], Then → [Assert], Background → steps run first, Scenario Outline + Examples → dataset).
// The file itself is sent to the backend unchanged; this preview only shows what the import will
// produce before the upload.

type GherkinKeyword = "given" | "when" | "then";

type ScenarioDraft = {
  title: string;
  tags: string[];
  steps: Array<{ keyword: GherkinKeyword; text: string }>;
  examples: { columns: string[]; rows: string[][] } | null;
  outline: boolean;
};

const stepPattern = /^(Given|When|Then|And|But|\*)\s+(.*)$/i;

function parseTableRow(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, "|").trim());
}

function outlineParams(text: string): string {
  return text.replace(/<([^<>]+)>/g, (_match, name: string) => `{${name.trim().replace(/\s+/g, "_")}}`);
}

export type GherkinPreview = {
  feature: string | null;
  scenarios: number;
  document: string;
};

export function gherkinToTranscript(source: string): GherkinPreview {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let feature: string | null = null;
  let featureTags: string[] = [];
  let pendingTags: string[] = [];
  const background: ScenarioDraft["steps"] = [];
  const scenarios: ScenarioDraft[] = [];
  let section: "none" | "background" | "scenario" | "examples" | "docstring" = "none";
  let docstringReturn: "background" | "scenario" = "scenario";
  let current: ScenarioDraft | null = null;
  let lastKeyword: GherkinKeyword = "given";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (section === "docstring") {
      if (line.startsWith('"""') || line.startsWith("```")) section = docstringReturn;
      continue;
    }
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("@")) {
      pendingTags.push(...line.split(/\s+/).filter((tag) => tag.startsWith("@")).map((tag) => tag.slice(1)));
      continue;
    }
    const heading = /^(Feature|Background|Scenario Outline|Scenario Template|Scenario|Example|Examples|Scenarios|Rule):\s*(.*)$/i.exec(line);
    if (heading) {
      const keyword = (heading[1] as string).toLowerCase();
      const title = (heading[2] ?? "").trim();
      if (keyword === "feature") {
        feature = title || null;
        featureTags = pendingTags;
        section = "none";
      } else if (keyword === "background") {
        section = "background";
        lastKeyword = "given";
      } else if (keyword === "examples" || keyword === "scenarios") {
        section = "examples";
        if (current) current.examples = { columns: [], rows: [] };
      } else if (keyword === "rule") {
        section = "none";
      } else {
        current = {
          title: title || `Scenario ${scenarios.length + 1}`,
          tags: pendingTags,
          steps: [],
          examples: null,
          outline: keyword.includes("outline") || keyword.includes("template")
        };
        scenarios.push(current);
        section = "scenario";
        lastKeyword = "given";
      }
      pendingTags = [];
      continue;
    }
    if (line.startsWith('"""') || line.startsWith("```")) {
      docstringReturn = section === "background" ? "background" : "scenario";
      section = "docstring";
      continue;
    }
    if (line.startsWith("|")) {
      if (section === "examples" && current?.examples) {
        const cells = parseTableRow(line);
        if (current.examples.columns.length === 0) current.examples.columns = cells;
        else current.examples.rows.push(cells);
      }
      continue;
    }
    const step = stepPattern.exec(line);
    if (step && (section === "background" || section === "scenario")) {
      const word = (step[1] as string).toLowerCase();
      const keyword: GherkinKeyword = word === "given" || word === "when" || word === "then" ? word : lastKeyword;
      lastKeyword = keyword;
      const entry = { keyword, text: (step[2] ?? "").trim() };
      if (section === "background") background.push(entry);
      else current?.steps.push(entry);
    }
  }

  const blocks = scenarios.map((scenario) => {
    const out = [`# ${scenario.title}`];
    const tags = [...new Set([...featureTags, ...scenario.tags])];
    if (tags.length > 0) out.push(`Tags: ${tags.join(", ")}`);
    const params = scenario.outline ? scenario.examples?.columns ?? [] : [];
    if (params.length > 0) out.push(`Params: ${params.map((name) => name.replace(/\s+/g, "_")).join(", ")}`);
    out.push("");
    let checkpointOpen = false;
    for (const step of [...background, ...scenario.steps]) {
      const text = scenario.outline ? outlineParams(step.text) : step.text;
      if (step.keyword === "then") {
        if (!checkpointOpen) {
          out.push("", `## Checkpoint: ${text}`);
          checkpointOpen = true;
        }
        out.push(`[Assert] ${text}`);
      } else {
        if (checkpointOpen) out.push("");
        checkpointOpen = false;
        out.push(`[Act] ${text}`);
      }
    }
    if (scenario.outline && scenario.examples && scenario.examples.columns.length > 0) {
      const columns = scenario.examples.columns.map((name) => name.replace(/\s+/g, "_"));
      out.push("", "## Dataset", `| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`);
      for (const row of scenario.examples.rows) out.push(`| ${columns.map((_column, index) => row[index] ?? "").join(" | ")} |`);
    }
    return out.join("\n");
  });

  return { feature, scenarios: scenarios.length, document: blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "" };
}
