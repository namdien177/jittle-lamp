#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readConfig } from "./client";
import { createJittleLampMcpServer } from "./server";

try {
	const server = createJittleLampMcpServer(readConfig(process.env));
	await server.connect(new StdioServerTransport());
} catch (error) {
	console.error(
		error instanceof Error ? error.message : "Unable to start Jittle Lamp MCP",
	);
	process.exitCode = 1;
}
