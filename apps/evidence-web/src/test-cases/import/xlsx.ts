import { unzipSync, strFromU8 } from "fflate";

// Minimal XLSX reader for the column-mapping step: the first worksheet as a grid of strings.
// It handles shared strings, inline strings, numbers and booleans; formulas yield their cached
// value. Enough to pick columns and preview rows; the backend parses the file again on import.

const xmlEntities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

// Out-of-range numeric entities (&#x110000;, &#99999999;) stay as written instead of throwing.
function codePoint(value: number, fallback: string): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : fallback;
}

export function decodeXmlText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return codePoint(Number.parseInt(lower.slice(2), 16), match);
    if (lower.startsWith("#")) return codePoint(Number.parseInt(lower.slice(1), 10), match);
    return xmlEntities[lower] ?? match;
  });
}

// Limits for the in-browser preview: the file itself and each unpacked part (zip bombs).
export const maxXlsxBytes = 20 * 1024 * 1024;
export const maxXlsxPartBytes = 100 * 1024 * 1024;

const neededPart = /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/;

// Concatenates every <t> run inside a shared string or inline string (rich text has several).
function textRuns(xml: string): string {
  let text = "";
  for (const match of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) text += decodeXmlText(match[1] ?? "");
  return text;
}

export function columnIndexFromRef(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0]?.toUpperCase() ?? "A";
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function readEntry(files: Record<string, Uint8Array>, path: string): string | null {
  const entry = files[path] ?? files[path.replace(/^\//, "")];
  return entry ? strFromU8(entry) : null;
}

function firstSheetPath(files: Record<string, Uint8Array>): string {
  const workbook = readEntry(files, "xl/workbook.xml");
  const rels = readEntry(files, "xl/_rels/workbook.xml.rels");
  const sheetRelId = workbook ? /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1] : undefined;
  if (rels && sheetRelId) {
    for (const match of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const tag = match[0];
      if (tag.includes(`Id="${sheetRelId}"`)) {
        const target = /Target="([^"]+)"/.exec(tag)?.[1];
        if (target) return target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
      }
    }
  }
  return "xl/worksheets/sheet1.xml";
}

export function readXlsxRows(bytes: Uint8Array): string[][] {
  if (bytes.byteLength > maxXlsxBytes) {
    throw new Error(`This workbook is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB; the limit is ${maxXlsxBytes / 1024 / 1024} MB. Split it or export the sheet as CSV.`);
  }
  let files: Record<string, Uint8Array>;
  let oversized: string | null = null;
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        if (!neededPart.test(file.name)) return false;
        if (file.originalSize > maxXlsxPartBytes) {
          oversized = file.name;
          return false;
        }
        return true;
      }
    });
  } catch {
    throw new Error("This file is not a valid .xlsx workbook.");
  }
  if (oversized) throw new Error(`The workbook part ${oversized} unpacks to more than ${maxXlsxPartBytes / 1024 / 1024} MB.`);
  const sharedXml = readEntry(files, "xl/sharedStrings.xml");
  const shared = sharedXml ? [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => textRuns(match[1] ?? "")) : [];
  const sheet = readEntry(files, firstSheetPath(files));
  if (!sheet) throw new Error("The workbook has no worksheet.");

  const rows: string[][] = [];
  for (const rowMatch of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row: string[] = [];
    const body = rowMatch[1] ?? "";
    let nextColumn = 0;
    for (const cellMatch of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cellMatch[1] ?? "";
      const inner = cellMatch[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/i.exec(attributes)?.[1];
      const column = ref ? columnIndexFromRef(ref) : nextColumn;
      nextColumn = column + 1;
      const type = /\bt="([^"]+)"/.exec(attributes)?.[1] ?? "n";
      const rawValue = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = "";
      if (type === "s" && rawValue !== undefined) value = shared[Number.parseInt(rawValue, 10)] ?? "";
      else if (type === "inlineStr") value = textRuns(inner);
      else if (type === "b") value = rawValue === "1" ? "TRUE" : "FALSE";
      else if (rawValue !== undefined) value = decodeXmlText(rawValue);
      while (row.length < column) row.push("");
      row[column] = value;
    }
    rows.push(row);
  }
  return rows.filter((row) => row.some((cell) => cell.trim().length > 0));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
