import { describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import { recordingFileName, sessionArchiveFileName } from "@jittle-lamp/shared";
import { strToU8, zipSync } from "fflate";

import { HttpError } from "../src/http/test-http";
import { parseXlsx } from "../src/services/test-import-parsers";
import { validateRunEvidenceZip } from "../src/services/test-run-evidence";
import {
	MAX_EVIDENCE_ZIP_UNCOMPRESSED_BYTES,
	MAX_XLSX_UNCOMPRESSED_BYTES,
	unzipBounded,
	ZipTooLargeError,
} from "../src/services/zip-limits";
import { createTestCaseFixture } from "./test-case-fixtures";

// Review finding: unzipSync ran uncapped on XLSX imports, run evidence and automation
// uploads, so a few KB of ZIP could declare gigabytes of uncompressed data. The declared size
// in the central directory is what fflate allocates, so these fixtures patch only that field.

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;

// Rewrites the declared uncompressed size of `name` in the ZIP central directory.
const declareUncompressedSize = (
	zip: Uint8Array,
	name: string,
	size: number,
): Uint8Array => {
	const copy = Uint8Array.from(zip);
	const view = new DataView(copy.buffer);
	const encodedName = Buffer.from(name, "utf8");
	for (let offset = 0; offset + 46 <= copy.length; offset += 1) {
		if (view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE) continue;
		const nameLength = view.getUint16(offset + 28, true);
		const entryName = Buffer.from(
			copy.subarray(offset + 46, offset + 46 + nameLength),
		);
		if (entryName.equals(encodedName)) {
			view.setUint32(offset + 24, size, true);
			return copy;
		}
	}
	throw new Error(`entry ${name} not found in the central directory`);
};

const xlsxWorkbook = () =>
	zipSync({
		"xl/sharedStrings.xml": strToU8("<sst><si><t>Title</t></si></sst>"),
		"xl/worksheets/sheet1.xml": strToU8(
			'<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>',
		),
	});

describe("bounded ZIP extraction", () => {
	it("rejects a ZIP whose declared uncompressed size exceeds the cap before inflating", () => {
		const bomb = declareUncompressedSize(
			zipSync({ "big.bin": new Uint8Array(64) }),
			"big.bin",
			0xfffffff0,
		);
		expect(() =>
			unzipBounded(bomb, { maxUncompressedBytes: 1024 * 1024 }),
		).toThrow(ZipTooLargeError);
	});

	it("lists entries it does not extract and does not count them toward the cap", () => {
		const zip = declareUncompressedSize(
			zipSync({
				"wanted.txt": strToU8("hello"),
				"ignored.bin": new Uint8Array(32),
			}),
			"ignored.bin",
			0xfffffff0,
		);
		const result = unzipBounded(zip, {
			maxUncompressedBytes: 1024,
			include: (name) => name === "wanted.txt",
		});
		expect(result.names.sort()).toEqual(["ignored.bin", "wanted.txt"]);
		expect(Object.keys(result.files)).toEqual(["wanted.txt"]);
	});

	it("caps XLSX imports at 20 MB uncompressed", () => {
		expect(MAX_XLSX_UNCOMPRESSED_BYTES).toBe(20 * 1024 * 1024);
		const bomb = declareUncompressedSize(
			xlsxWorkbook(),
			"xl/worksheets/sheet1.xml",
			MAX_XLSX_UNCOMPRESSED_BYTES + 1,
		);
		expect(() => parseXlsx(Buffer.from(bomb).toString("base64"))).toThrow(
			ZipTooLargeError,
		);
	});

	it("caps run evidence at 200 MB uncompressed with a 413", () => {
		expect(MAX_EVIDENCE_ZIP_UNCOMPRESSED_BYTES).toBe(200 * 1024 * 1024);
		const bomb = declareUncompressedSize(
			zipSync({
				[sessionArchiveFileName]: strToU8("{}"),
				[recordingFileName]: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
				"run-report.json": strToU8("{}"),
			}),
			recordingFileName,
			MAX_EVIDENCE_ZIP_UNCOMPRESSED_BYTES + 1,
		);
		let caught: unknown;
		try {
			validateRunEvidenceZip(bomb, crypto.randomUUID());
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(HttpError);
		expect(caught).toMatchObject({
			status: 413,
			code: "TEST_RUN_EVIDENCE_ZIP_TOO_LARGE",
		});
	});

	it("returns 413 IMPORT_TOO_LARGE for an XLSX bomb through the import route", async () => {
		const fixture = await createTestCaseFixture();
		const bomb = declareUncompressedSize(
			xlsxWorkbook(),
			"xl/sharedStrings.xml",
			0xfffffff0,
		);
		const response = await fixture.call<{ error: { code: string } }>(
			"/test-cases/import",
			{
				token: fixture.qa.token,
				body: {
					sourceKind: "xlsx",
					content: Buffer.from(bomb).toString("base64"),
				},
			},
		);
		expect(response.status).toBe(413);
		expect(response.body.error.code).toBe("IMPORT_TOO_LARGE");
	});

	it("returns 413 for an automation evidence ZIP bomb", async () => {
		const fixture = await createTestCaseFixture();
		const token = await fixture.automationToken(fixture.qa);
		const bomb = declareUncompressedSize(
			zipSync({
				[sessionArchiveFileName]: strToU8("{}"),
				[recordingFileName]: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
			}),
			recordingFileName,
			0xfffffff0,
		);
		const response = await fixture.call<{ error: { code: string } }>(
			"/automation/evidences/zip",
			{
				method: "POST",
				token,
				raw: Uint8Array.from(bomb).buffer,
				headers: { "content-type": "application/zip" },
			},
		);
		expect(response.status).toBe(413);
		expect(response.body.error.code).toBe("AUTOMATION_UPLOAD_TOO_LARGE");
	});
});
