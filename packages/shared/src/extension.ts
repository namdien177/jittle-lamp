import { z } from "zod/v4";

import {
  captureSessionDraftSchema,
  isoTimestampSchema,
  interactionEventSchema,
  networkEventSchema,
  pageContextSchema,
  sessionArchiveSchema,
  sessionIdSchema
} from "./session";

export const popupGetStateRequestSchema = z.object({
  type: z.literal("jl/popup-get-state")
});

export const popupStartRecordingRequestSchema = z.object({
  type: z.literal("jl/popup-start-recording"),
  tabId: z.number().int().nonnegative().optional(),
  page: pageContextSchema.pick({ title: true, url: true }).partial().optional(),
  name: z.string().trim().min(1).max(160).optional(),
  playTabAudio: z.boolean().optional(),
  requestSiteAccess: z.boolean().optional()
});

export const popupStopRecordingRequestSchema = z.object({
  type: z.literal("jl/popup-stop-recording")
});

export const popupAbortRecordingRequestSchema = z.object({
  type: z.literal("jl/popup-abort-recording")
});

export const popupRetryUploadRequestSchema = z.object({
  type: z.literal("jl/popup-retry-upload")
});

export const popupStartCloudSignInRequestSchema = z.object({
  type: z.literal("jl/popup-start-cloud-sign-in")
});

export const popupOpenEvidenceListRequestSchema = z.object({
  type: z.literal("jl/popup-open-evidence-list")
});

export const popupLogoutCloudRequestSchema = z.object({
  type: z.literal("jl/popup-logout-cloud")
});

export const popupUpdateSessionNameRequestSchema = z.object({
  type: z.literal("jl/popup-update-session-name"),
  name: z.string().trim().min(1).max(160)
});

export const popupRequestSchema = z.discriminatedUnion("type", [
  popupGetStateRequestSchema,
  popupStartRecordingRequestSchema,
  popupStopRecordingRequestSchema,
  popupAbortRecordingRequestSchema,
  popupRetryUploadRequestSchema,
  popupStartCloudSignInRequestSchema,
  popupOpenEvidenceListRequestSchema,
  popupLogoutCloudRequestSchema,
  popupUpdateSessionNameRequestSchema
]);

export const popupSessionSummarySchema = captureSessionDraftSchema
  .pick({
    sessionId: true,
    name: true,
    phase: true,
    createdAt: true,
    updatedAt: true,
    page: true,
    artifacts: true
  })
  .extend({
    eventCount: z.number().int().nonnegative(),
    statusText: z.string().min(1).optional()
  });

export const companionStateSchema = z.object({
  status: z.enum(["online", "offline"]),
  origin: z.string().url(),
  outputDir: z.string().min(1).optional(),
  checkedAt: isoTimestampSchema,
  error: z.string().min(1).optional()
});

export const cloudAuthStateSchema = z.object({
  status: z.enum(["signed-in", "signed-out", "unknown"]),
  origin: z.string().url().optional(),
  accountLabel: z.string().min(1).optional(),
  checkedAt: isoTimestampSchema,
  error: z.string().min(1).optional()
});

export const popupStateSchema = z.object({
  activeSession: popupSessionSummarySchema.nullable(),
  companion: companionStateSchema,
  cloud: cloudAuthStateSchema.default({
    status: "unknown",
    checkedAt: "1970-01-01T00:00:00.000Z"
  }),
  canStart: z.boolean(),
  canStop: z.boolean()
});

export const popupResponseSchema = z.object({
  ok: z.boolean(),
  state: popupStateSchema,
  error: z.string().min(1).optional()
});

export const contentBeginCaptureMessageSchema = z.object({
  type: z.literal("jl/content-begin-capture"),
  sessionId: sessionIdSchema
});

export const contentEndCaptureMessageSchema = z.object({
  type: z.literal("jl/content-end-capture"),
  sessionId: sessionIdSchema
});

export const contentToggleWidgetMessageSchema = z.object({
  type: z.literal("jl/content-toggle-widget"),
  state: popupStateSchema.optional()
});

export const contentRefreshWidgetMessageSchema = z.object({
  type: z.literal("jl/content-refresh-widget"),
  state: popupStateSchema
});

export const contentWidgetPingMessageSchema = z.object({
  type: z.literal("jl/content-widget-ping")
});

export const backgroundToContentMessageSchema = z.discriminatedUnion("type", [
  contentBeginCaptureMessageSchema,
  contentEndCaptureMessageSchema,
  contentToggleWidgetMessageSchema,
  contentRefreshWidgetMessageSchema,
  contentWidgetPingMessageSchema
]);

export const contentReadyMessageSchema = z.object({
  type: z.literal("jl/content-ready"),
  sessionId: sessionIdSchema,
  page: pageContextSchema.omit({ tabId: true })
});

export const interactionMessageSchema = z.object({
  type: z.literal("jl/interaction"),
  sessionId: sessionIdSchema,
  payload: interactionEventSchema
});

export const contentNetworkMessageSchema = z.object({
  type: z.literal("jl/network"),
  sessionId: sessionIdSchema,
  payload: networkEventSchema
});

export const contentRuntimeMessageSchema = z.discriminatedUnion("type", [
  contentReadyMessageSchema,
  interactionMessageSchema,
  contentNetworkMessageSchema
]);

export const offscreenStartRecordingRequestSchema = z.object({
  type: z.literal("jl/offscreen-start-recording"),
  sessionId: sessionIdSchema,
  tabId: z.number().int().nonnegative(),
  streamId: z.string().min(1),
  playTabAudio: z.boolean().optional()
});

export const offscreenStopAndExportRequestSchema = z.object({
  type: z.literal("jl/offscreen-stop-and-export"),
  sessionId: sessionIdSchema,
  archive: sessionArchiveSchema,
  cloudRequired: z.boolean().optional(),
  cloudAuthToken: z.string().min(1).optional()
});

export const offscreenAbortRecordingRequestSchema = z.object({
  type: z.literal("jl/offscreen-abort-recording"),
  sessionId: sessionIdSchema
});

export const offscreenRetryCloudUploadRequestSchema = z.object({
  type: z.literal("jl/offscreen-retry-cloud-upload"),
  sessionId: sessionIdSchema,
  cloudAuthToken: z.string().min(1)
});

export const offscreenRequestSchema = z.discriminatedUnion("type", [
  offscreenStartRecordingRequestSchema,
  offscreenStopAndExportRequestSchema,
  offscreenAbortRecordingRequestSchema,
  offscreenRetryCloudUploadRequestSchema
]);

export const offscreenResponseSchema = z.object({
  ok: z.boolean(),
  recordingBytes: z.number().int().nonnegative().optional(),
  eventBytes: z.number().int().nonnegative().optional(),
  destination: z.enum(["cloud", "companion", "downloads"]).optional(),
  outputDir: z.string().min(1).optional(),
  cloudUrl: z.string().url().optional(),
  error: z.string().min(1).optional()
});

export type PopupRequest = z.infer<typeof popupRequestSchema>;
export type PopupResponse = z.infer<typeof popupResponseSchema>;
export type PopupSessionSummary = z.infer<typeof popupSessionSummarySchema>;
export type CompanionState = z.infer<typeof companionStateSchema>;
export type CloudAuthState = z.infer<typeof cloudAuthStateSchema>;
export type PopupState = z.infer<typeof popupStateSchema>;
export type BackgroundToContentMessage = z.infer<typeof backgroundToContentMessageSchema>;
export type ContentRuntimeMessage = z.infer<typeof contentRuntimeMessageSchema>;
export type OffscreenRequest = z.infer<typeof offscreenRequestSchema>;
export type OffscreenResponse = z.infer<typeof offscreenResponseSchema>;
