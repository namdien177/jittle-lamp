import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";

// Opaque bearer secrets for runners (design.md §5.4, §9.3). Only their sha256 is stored.
export const RUNNER_REGISTRATION_TOKEN_PREFIX = "jl_rr_";
export const RUNNER_WORKER_TOKEN_PREFIX = "jl_rw_";
export const RUN_TOKEN_PREFIX = "jl_run_";

export const createOpaqueToken = (prefix: string): string =>
	`${prefix}${Buffer.from(randomBytes(32)).toString("base64url")}`;

export const hashToken = (token: string): string =>
	createHash("sha256").update(token, "utf8").digest("hex");

export const sha256Text = (value: string): string =>
	createHash("sha256").update(value, "utf8").digest("hex");
