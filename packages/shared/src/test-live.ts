import { z } from "zod/v4";

// Live view and take-over of a cloud or self-hosted run (design.md §5.4, ADR 0002 decision 11,
// phase 2). The runner streams JPEG frames while someone watches; a person with the right to
// cancel the run can take over: the agent pauses before its next action, the person's input is
// replayed into the page and tagged `user:takeover`, and nothing done meanwhile is cached.
//
//   viewer  → POST /test-runs/:id/live/watch                     keeps frames flowing (30 s TTL)
//   viewer  → GET  /test-runs/:id/live/frame                     latest JPEG (404 until one exists)
//   viewer  → POST /test-runs/:id/live/takeover {action}         start | stop
//   viewer  → POST /test-runs/:id/live/input {events}            only the take-over holder
//   runner  → GET  /test-runs/:id/live/control?after=<seq>       run token: what to do and new input
//   runner  → PUT  /test-runs/:id/live/frame                     run token, image/jpeg body

export const liveInputEventSchema = z.discriminatedUnion("kind", [
  z.object({ seq: z.number().int().nonnegative(), kind: z.literal("click"), x: z.number().min(0), y: z.number().min(0), button: z.enum(["left", "right"]).default("left"), double: z.boolean().default(false) }),
  z.object({ seq: z.number().int().nonnegative(), kind: z.literal("move"), x: z.number().min(0), y: z.number().min(0) }),
  z.object({ seq: z.number().int().nonnegative(), kind: z.literal("scroll"), x: z.number().min(0), y: z.number().min(0), deltaY: z.number() }),
  z.object({ seq: z.number().int().nonnegative(), kind: z.literal("type"), text: z.string().min(1).max(2000) }),
  z.object({ seq: z.number().int().nonnegative(), kind: z.literal("press"), key: z.string().min(1).max(40) })
]);

// Coordinates are CSS pixels of the run's viewport (the viewer scales from the frame it shows).
export const liveInputRequestSchema = z.object({
  events: z.array(z.union([
    z.object({ kind: z.literal("click"), x: z.number().min(0), y: z.number().min(0), button: z.enum(["left", "right"]).default("left"), double: z.boolean().default(false) }),
    z.object({ kind: z.literal("move"), x: z.number().min(0), y: z.number().min(0) }),
    z.object({ kind: z.literal("scroll"), x: z.number().min(0), y: z.number().min(0), deltaY: z.number() }),
    z.object({ kind: z.literal("type"), text: z.string().min(1).max(2000) }),
    z.object({ kind: z.literal("press"), key: z.string().min(1).max(40) })
  ])).min(1).max(100)
});

export const liveTakeoverRequestSchema = z.object({ action: z.enum(["start", "stop"]) });

export const liveControlResponseSchema = z.object({
  // Someone is watching: send frames.
  live: z.boolean(),
  takeover: z.boolean(),
  takeoverBy: z.string().nullable(),
  inputs: z.array(liveInputEventSchema),
  cancelRequested: z.boolean().default(false)
});

export const liveStateSchema = z.object({
  available: z.boolean(),
  // A secret was typed in the run: frames are replaced by a placeholder from then on.
  framesHidden: z.boolean().default(false),
  takeoverBy: z.string().nullable(),
  paused: z.boolean(),
  frameAt: z.number().int().nonnegative().nullable(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).nullable()
});

export const takeoverTag = "user:takeover";

export type LiveInputEvent = z.infer<typeof liveInputEventSchema>;
export type LiveInputRequest = z.infer<typeof liveInputRequestSchema>;
export type LiveControlResponse = z.infer<typeof liveControlResponseSchema>;
export type LiveState = z.infer<typeof liveStateSchema>;
