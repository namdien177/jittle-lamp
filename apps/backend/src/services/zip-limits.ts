import { unzipSync } from "fflate";

// Bounded ZIP extraction. fflate's unzipSync allocates each entry at its declared
// uncompressed size and never grows past it, so summing `originalSize` in the filter caps
// the memory a crafted archive (ZIP bomb) can make the server allocate.

export const MAX_XLSX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
export const MAX_EVIDENCE_ZIP_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

export class ZipTooLargeError extends Error {
	constructor(readonly maxBytes: number) {
		super(
			`ZIP contents exceed ${Math.floor(maxBytes / (1024 * 1024))} MB uncompressed`,
		);
		this.name = "ZipTooLargeError";
	}
}

export class ZipUnreadableError extends Error {
	constructor() {
		super("not a readable ZIP archive");
		this.name = "ZipUnreadableError";
	}
}

export type BoundedUnzipResult = {
	// Every entry name in the central directory, including ones that were not extracted.
	names: string[];
	files: Record<string, Uint8Array>;
};

export const unzipBounded = (
	bytes: Uint8Array,
	options: {
		maxUncompressedBytes: number;
		// Entries to extract; others are listed in `names` but never inflated.
		include?: (name: string) => boolean;
	},
): BoundedUnzipResult => {
	const names: string[] = [];
	let total = 0;
	let files: Record<string, Uint8Array>;
	try {
		files = unzipSync(bytes, {
			filter: (entry) => {
				names.push(entry.name);
				if (options.include && !options.include(entry.name)) return false;
				total += entry.originalSize;
				if (total > options.maxUncompressedBytes) {
					throw new ZipTooLargeError(options.maxUncompressedBytes);
				}
				return true;
			},
		});
	} catch (error) {
		if (error instanceof ZipTooLargeError) throw error;
		throw new ZipUnreadableError();
	}
	return { names, files };
};
