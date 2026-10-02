// CSV reading and writing for the import wizard (design.md §7 "Import pipeline"). Pure functions:
// no DOM, no React, so root tests can import them.

export type CsvDelimiter = "," | ";" | "\t";

// Picks the delimiter that splits the header line into the most columns, ignoring quoted text.
export function detectCsvDelimiter(text: string): CsvDelimiter {
  const firstLine = firstRecordLine(text);
  const candidates: CsvDelimiter[] = [",", ";", "\t"];
  let best: CsvDelimiter = ",";
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = countOutsideQuotes(firstLine, candidate);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

function firstRecordLine(text: string): string {
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (char === "\n" || char === "\r")) return text.slice(0, index);
  }
  return text;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let inQuotes = false;
  let count = 0;
  for (const char of line) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && char === delimiter) count += 1;
  }
  return count;
}

// RFC 4180 parser: quoted fields, doubled quotes, embedded newlines, CRLF and a UTF-8 BOM.
// Fully blank lines are dropped.
export function parseCsv(input: string, delimiter: CsvDelimiter = detectCsvDelimiter(input)): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;

  const endField = () => {
    row.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (char === delimiter) {
      endField();
    } else if (char === "\r") {
      if (text[index + 1] === "\n") index += 1;
      endRow();
    } else if (char === "\n") {
      endRow();
    } else {
      field += char;
      fieldStarted = true;
    }
  }
  if (field.length > 0 || row.length > 0) endRow();
  return rows;
}

export type TabularData = {
  headers: string[];
  records: Array<Record<string, string>>;
};

// First row is the header. Blank or repeated header names get a suffix so every column is addressable.
export function rowsToRecords(rows: readonly string[][]): TabularData {
  const [headerRow, ...body] = rows;
  if (!headerRow) return { headers: [], records: [] };
  const seen = new Map<string, number>();
  const headers = headerRow.map((raw, index) => {
    const base = raw.trim() || `Column ${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base} (${count + 1})`;
  });
  const records = body
    .filter((row) => row.some((cell) => cell.trim().length > 0))
    .map((row) => {
      const record: Record<string, string> = {};
      headers.forEach((header, index) => {
        record[header] = row[index] ?? "";
      });
      return record;
    });
  return { headers, records };
}

function escapeCsvCell(value: string): string {
  // Neutralise spreadsheet formulas in exported cells (CSV injection).
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
}
