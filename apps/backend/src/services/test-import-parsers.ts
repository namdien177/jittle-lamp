import { Buffer } from "node:buffer";
import type { importMappingSchema } from "@jittle-lamp/shared";
import { strFromU8 } from "fflate";
import type { z } from "zod/v4";

import {
	MAX_XLSX_UNCOMPRESSED_BYTES,
	unzipBounded,
	ZipTooLargeError,
} from "./zip-limits";

// Source formats that become transcript documents (design.md §7 "Entry points"). Every parser
// returns one transcript document per item so lint and similarity run once for all paths.

export type ImportCandidate = {
	title: string;
	transcript: string;
	externalId: string | null;
	source: Record<string, unknown>;
};

const metadataLine = (label: string, value: string | null | undefined) =>
	value && value.trim().length > 0 ? [`${label}: ${value.trim()}`] : [];

const quoteListItem = (item: string) =>
	/[,"]/.test(item) ? `"${item.replace(/"/g, '\\"')}"` : item;

export const buildCaseDocument = (input: {
	title: string;
	tags?: string[];
	externalId?: string | null;
	links?: string[];
	description?: string | null;
	steps: string[];
	dataset?: { columns: string[]; rows: Array<Record<string, string>> } | null;
}): string => {
	const lines = [
		`# ${input.title.replace(/\s+/g, " ").trim()}`,
		...metadataLine(
			"Description",
			input.description?.replace(/\s*\n\s*/g, " ") ?? null,
		),
		...metadataLine(
			"Tags",
			(input.tags ?? []).filter(Boolean).map(quoteListItem).join(", "),
		),
		...metadataLine("Links", (input.links ?? []).map(quoteListItem).join(", ")),
		...metadataLine("External-id", input.externalId ?? null),
		"",
		...input.steps,
	];
	if (input.dataset && input.dataset.columns.length > 0) {
		const cell = (value: string) => value.replace(/\|/g, "\\|");
		lines.push(
			"",
			"## Dataset",
			`| ${input.dataset.columns.map(cell).join(" | ")} |`,
			`| ${input.dataset.columns.map(() => "---").join(" | ")} |`,
			...input.dataset.rows.map(
				(row) =>
					`| ${input.dataset?.columns.map((column) => cell(row[column] ?? "")).join(" | ")} |`,
			),
		);
	}
	return `${lines.join("\n").trim()}\n`;
};

// ---------------------------------------------------------------------------------------------
// Gherkin: Given/When → [Act], Then (and And/But after Then) → [Assert], Background → steps
// prefixed to every scenario, Scenario Outline + Examples → ## Dataset with {param} references.
// ---------------------------------------------------------------------------------------------

type GherkinStep = { keyword: string; text: string };
type GherkinScenario = {
	title: string;
	tags: string[];
	steps: GherkinStep[];
	examples: { columns: string[]; rows: string[][] } | null;
	line: number;
};

const stepKeyword =
	/^(Given|When|Then|And|But|\*|Cho|Khi|Thì|Và|Nhưng)\s+(.*)$/u;

const parseTableRow = (line: string): string[] =>
	line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split(/(?<!\\)\|/)
		.map((cell) => cell.trim().replace(/\\\|/g, "|"));

export const parseGherkin = (
	content: string,
	fileName: string | undefined,
): ImportCandidate[] => {
	const lines = content.replace(/\r\n?/g, "\n").split("\n");
	let featureName = "";
	let featureTags: string[] = [];
	let pendingTags: string[] = [];
	const background: GherkinStep[] = [];
	const scenarios: GherkinScenario[] = [];
	let section: "none" | "background" | "scenario" | "examples" = "none";
	let current: GherkinScenario | null = null;
	let inDocString = false;

	lines.forEach((raw, index) => {
		const line = raw.trim();
		if (line.startsWith('"""') || line.startsWith("```")) {
			inDocString = !inDocString;
			return;
		}
		if (inDocString) {
			const target = section === "background" ? background : current?.steps;
			const last = target?.[target.length - 1];
			if (last) last.text = `${last.text} ${line}`.trim();
			return;
		}
		if (line.length === 0 || line.startsWith("#")) return;
		if (line.startsWith("@")) {
			pendingTags.push(
				...line
					.split(/\s+/)
					.filter((tag) => tag.startsWith("@"))
					.map((tag) => tag.slice(1)),
			);
			return;
		}
		const heading = /^([\p{L} ]+?):\s*(.*)$/u.exec(line);
		const keyword = heading?.[1]?.trim().toLowerCase() ?? "";
		if (heading && /^(feature|tính năng)$/.test(keyword)) {
			featureName = heading[2] ?? "";
			featureTags = pendingTags;
			pendingTags = [];
			section = "none";
			return;
		}
		if (heading && /^(background|bối cảnh)$/.test(keyword)) {
			section = "background";
			return;
		}
		if (
			heading &&
			/^(scenario|scenario outline|scenario template|example|kịch bản|khung kịch bản)$/.test(
				keyword,
			)
		) {
			current = {
				title: heading[2] ?? "",
				tags: pendingTags,
				steps: [],
				examples: null,
				line: index + 1,
			};
			pendingTags = [];
			scenarios.push(current);
			section = "scenario";
			return;
		}
		if (heading && /^(examples|scenarios|ví dụ)$/.test(keyword)) {
			section = "examples";
			if (current) current.examples = { columns: [], rows: [] };
			return;
		}
		if (line.startsWith("|")) {
			if (section === "examples" && current?.examples) {
				const cells = parseTableRow(line);
				if (current.examples.columns.length === 0)
					current.examples.columns = cells;
				else current.examples.rows.push(cells);
				return;
			}
			// A data table under a step: keep it readable on the step line.
			const target = section === "background" ? background : current?.steps;
			const last = target?.[target.length - 1];
			if (last) last.text = `${last.text} [${parseTableRow(line).join(", ")}]`;
			return;
		}
		const step = stepKeyword.exec(line);
		if (step) {
			const entry = { keyword: step[1] ?? "", text: step[2] ?? "" };
			if (section === "background") background.push(entry);
			else if (current) current.steps.push(entry);
		}
	});

	const toLine = (steps: GherkinStep[]): string[] => {
		let mode: "act" | "assert" = "act";
		return steps.map((step) => {
			const keyword = step.keyword.toLowerCase();
			if (["given", "when", "cho", "khi"].includes(keyword)) mode = "act";
			else if (["then", "thì"].includes(keyword)) mode = "assert";
			const text = step.text.replace(/<([^<>\s]+)>/g, "{$1}");
			return `${mode === "assert" ? "[Assert]" : "[Act]"} ${text}`;
		});
	};

	const featureTag = featureName
		? `feature:${featureName
				.toLowerCase()
				.normalize("NFD")
				.replace(/[̀-ͯ]/g, "")
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-|-$/g, "")}`
		: null;
	const prefix = fileName ? fileName.replace(/\.feature$/i, "") : featureName;
	return scenarios.map((scenario) => {
		const examples = scenario.examples;
		const dataset =
			examples && examples.columns.length > 0
				? {
						columns: examples.columns,
						rows: examples.rows.map((row) =>
							Object.fromEntries(
								examples.columns.map((column, index) => [
									column,
									row[index] ?? "",
								]),
							),
						),
					}
				: null;
		const tags = [
			...new Set(
				[
					...featureTags,
					...scenario.tags,
					...(featureTag ? [featureTag] : []),
				].filter(Boolean),
			),
		];
		const externalId = `${prefix || "feature"}:${scenario.title}`;
		return {
			title: scenario.title,
			externalId,
			transcript: buildCaseDocument({
				title: scenario.title,
				tags,
				externalId,
				steps: toLine([...background, ...scenario.steps]),
				dataset,
			}),
			source: { kind: "gherkin", feature: featureName, line: scenario.line },
		};
	});
};

// ---------------------------------------------------------------------------------------------
// CSV and XLSX rows with a column mapping
// ---------------------------------------------------------------------------------------------

export const parseCsv = (content: string): string[][] => {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	const text = content.replace(/^﻿/, "");
	const delimiter =
		(text.split("\n")[0]?.split(";").length ?? 0) >
		(text.split("\n")[0]?.split(",").length ?? 0)
			? ";"
			: ",";
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (quoted) {
			if (char === '"') {
				if (text[index + 1] === '"') {
					field += '"';
					index += 1;
				} else quoted = false;
			} else field += char;
			continue;
		}
		if (char === '"') quoted = true;
		else if (char === delimiter) {
			row.push(field);
			field = "";
		} else if (char === "\n" || char === "\r") {
			if (char === "\r" && text[index + 1] === "\n") index += 1;
			row.push(field);
			field = "";
			if (row.some((cell) => cell.trim().length > 0)) rows.push(row);
			row = [];
		} else field += char;
	}
	row.push(field);
	if (row.some((cell) => cell.trim().length > 0)) rows.push(row);
	return rows;
};

const decodeXml = (value: string) =>
	value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, code: string) =>
			String.fromCodePoint(Number(code)),
		)
		.replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
			String.fromCodePoint(Number.parseInt(code, 16)),
		)
		.replace(/&amp;/g, "&");

const columnIndex = (ref: string): number => {
	const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
	return (
		[...letters].reduce(
			(total, letter) => total * 26 + letter.charCodeAt(0) - 64,
			0,
		) - 1
	);
};

// Minimal XLSX reader (first worksheet, shared and inline strings, numbers) on fflate, which
// the backend already ships; no spreadsheet dependency.
export const parseXlsx = (base64: string): string[][] => {
	let files: Record<string, Uint8Array>;
	try {
		files = unzipBounded(new Uint8Array(Buffer.from(base64, "base64")), {
			maxUncompressedBytes: MAX_XLSX_UNCOMPRESSED_BYTES,
			include: (name) =>
				name === "xl/sharedStrings.xml" ||
				/^xl\/worksheets\/sheet\d+\.xml$/.test(name),
		}).files;
	} catch (error) {
		if (error instanceof ZipTooLargeError) throw error;
		throw new Error(
			"content is not a readable .xlsx file (base64 ZIP expected)",
		);
	}
	const shared: string[] = [];
	const sharedXml = files["xl/sharedStrings.xml"];
	if (sharedXml) {
		for (const match of strFromU8(sharedXml).matchAll(
			/<si>([\s\S]*?)<\/si>/g,
		)) {
			const text = [...(match[1] ?? "").matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
				.map((part) => decodeXml(part[1] ?? ""))
				.join("");
			shared.push(text);
		}
	}
	const sheetName =
		Object.keys(files)
			.filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
			.sort(
				(a, b) => Number(/\d+/.exec(a)?.[0]) - Number(/\d+/.exec(b)?.[0]),
			)[0] ?? null;
	const sheet = sheetName ? files[sheetName] : undefined;
	if (!sheet) throw new Error(".xlsx file has no worksheet");
	const rows: string[][] = [];
	for (const rowMatch of strFromU8(sheet).matchAll(
		/<row[^>]*>([\s\S]*?)<\/row>/g,
	)) {
		const cells: string[] = [];
		for (const cell of (rowMatch[1] ?? "").matchAll(
			/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
		)) {
			const attributes = cell[1] ?? "";
			const body = cell[2] ?? "";
			const ref = /\br="([A-Z]+)\d+"/.exec(attributes)?.[1] ?? "";
			const type = /\bt="([^"]+)"/.exec(attributes)?.[1] ?? "n";
			const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
			let text = "";
			if (type === "s") text = shared[Number(value)] ?? "";
			else if (type === "inlineStr")
				text = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
					.map((part) => decodeXml(part[1] ?? ""))
					.join("");
			else text = value !== undefined ? decodeXml(value) : "";
			const index = ref ? columnIndex(ref) : cells.length;
			while (cells.length < index) cells.push("");
			cells[index] = text;
		}
		if (cells.some((cell) => cell.trim().length > 0)) rows.push(cells);
	}
	return rows;
};

const guessColumn = (
	headers: string[],
	patterns: RegExp[],
): string | undefined =>
	headers.find((header) =>
		patterns.some((pattern) => pattern.test(header.trim())),
	);

// Numbered or bulleted cell lines become one step each; lines that already carry a tag keep it.
const cellSteps = (
	value: string | undefined,
	tag: "[Act]" | "[Assert]" | "[Note]",
) =>
	(value ?? "")
		.split(/\r?\n/)
		.map((line) =>
			line
				.trim()
				.replace(/^(?:\d+[.)]|[-*•])\s*/, "")
				.trim(),
		)
		.filter((line) => line.length > 0)
		.map((line) => (/^\[[^\]]+\]/.test(line) ? line : `${tag} ${line}`));

export const rowsToCandidates = (
	rows: string[][],
	mapping: z.infer<typeof importMappingSchema> | undefined,
	kind: "csv" | "xlsx",
): ImportCandidate[] => {
	const [header, ...body] = rows;
	if (!header) return [];
	const headers = header.map((cell) => cell.trim());
	const column = {
		title:
			mapping?.title ??
			guessColumn(headers, [/^(title|name|summary|test case|tên)$/i]),
		steps: mapping?.steps ?? guessColumn(headers, [/^(steps?|actions?|bước)/i]),
		expected:
			mapping?.expected ??
			guessColumn(headers, [/^(expected|expected results?|kết quả)/i]),
		preconditions:
			mapping?.preconditions ??
			guessColumn(headers, [/^(pre-?conditions?|setup|điều kiện)/i]),
		id:
			mapping?.id ?? guessColumn(headers, [/^(id|key|case id|external id)$/i]),
		tags: mapping?.tags ?? guessColumn(headers, [/^(tags?|labels?)$/i]),
	};
	if (!column.title) {
		throw new Error(
			`No title column; map one of: ${headers.filter(Boolean).join(", ")}`,
		);
	}
	const indexOf = (name: string | undefined) =>
		name === undefined ? -1 : headers.indexOf(name);
	const cell = (row: string[], name: string | undefined) => {
		const index = indexOf(name);
		return index >= 0 ? (row[index] ?? "") : undefined;
	};
	return body.flatMap((row, index) => {
		const title = cell(row, column.title)?.trim();
		if (!title) return [];
		const externalId = cell(row, column.id)?.trim() || null;
		const tags = (cell(row, column.tags) ?? "")
			.split(/[,;]/)
			.map((tag) => tag.trim())
			.filter(Boolean);
		return [
			{
				title,
				externalId,
				transcript: buildCaseDocument({
					title,
					tags,
					externalId,
					steps: [
						...cellSteps(cell(row, column.preconditions), "[Note]"),
						...cellSteps(cell(row, column.steps), "[Act]"),
						...cellSteps(cell(row, column.expected), "[Assert]"),
					],
				}),
				source: {
					kind,
					row: index + 2,
					values: Object.fromEntries(
						headers.map((name, column) => [name, row[column] ?? ""]),
					),
				},
			},
		];
	});
};

// ---------------------------------------------------------------------------------------------
// Jira: issues by JQL through the REST API with an organisation `jira` credential
// ---------------------------------------------------------------------------------------------

export type JiraIssue = {
	key: string;
	url: string;
	summary: string;
	description: string;
	labels: string[];
};

// Atlassian Document Format to plain text.
export const adfToText = (node: unknown): string => {
	if (typeof node === "string") return node;
	if (!node || typeof node !== "object") return "";
	const record = node as { type?: string; text?: string; content?: unknown[] };
	if (record.type === "text") return record.text ?? "";
	const inner = (record.content ?? []).map(adfToText).join("");
	switch (record.type) {
		case "paragraph":
		case "heading":
			return `${inner}\n`;
		case "listItem":
			return `- ${inner.trim()}\n`;
		case "hardBreak":
			return "\n";
		default:
			return inner;
	}
};

export const searchJiraIssues = async (input: {
	baseUrl: string;
	email: string;
	apiToken: string;
	jql: string;
	maxResults?: number;
	fetchImpl?: typeof fetch;
}): Promise<JiraIssue[]> => {
	const base = input.baseUrl.replace(/\/+$/, "");
	const url = new URL(`${base}/rest/api/3/search/jql`);
	url.searchParams.set("jql", input.jql);
	url.searchParams.set("fields", "summary,description,labels");
	url.searchParams.set("maxResults", String(input.maxResults ?? 50));
	const response = await (input.fetchImpl ?? fetch)(url, {
		headers: {
			accept: "application/json",
			authorization: `Basic ${Buffer.from(`${input.email}:${input.apiToken}`).toString("base64")}`,
		},
	});
	if (!response.ok) {
		throw new Error(`Jira search failed with HTTP ${response.status}`);
	}
	const body = (await response.json()) as {
		issues?: Array<{
			key?: string;
			fields?: { summary?: string; description?: unknown; labels?: string[] };
		}>;
	};
	return (body.issues ?? []).flatMap((issue) =>
		issue.key
			? [
					{
						key: issue.key,
						url: `${base}/browse/${issue.key}`,
						summary: issue.fields?.summary ?? issue.key,
						description: adfToText(issue.fields?.description ?? "").trim(),
						labels: issue.fields?.labels ?? [],
					},
				]
			: [],
	);
};

export const jiraGenerationPrompt = (issue: JiraIssue): string =>
	[
		"Write one end-to-end test case for this Jira issue as a Jittle Lamp transcript document.",
		"Format: a '# Title' line, then one step per line. Use [Open] <path> to navigate, [Act] <one user intent> for actions,",
		"[Assert] <specific expected result> for checks, and '## Checkpoint: <name>' headings to group asserts.",
		"Refer to logins as [Login: <PROFILE>] and never write passwords or secrets. Use visible labels, not selectors.",
		"Return only the transcript, without code fences or commentary.",
		"",
		`Issue: ${issue.key}`,
		`Summary: ${issue.summary}`,
		"Description and acceptance criteria:",
		issue.description || "(none)",
	].join("\n");

// Model output may arrive in a code fence or with chatter around the document.
export const extractTranscript = (text: string): string => {
	const fenced = /```(?:[a-z]*)\n([\s\S]*?)```/i.exec(text);
	const body = fenced?.[1] ?? text;
	const start = body.search(/^#\s/m);
	return (start >= 0 ? body.slice(start) : body).trim();
};
