import { z } from "zod/v4";

export const sessionSchemaVersion = 3;

export const isoTimestampSchema = z.string().datetime({ offset: true });
export const sessionIdSchema = z.string().min(8).max(128);
export const nonEmptyPathSchema = z.string().min(1);
export const archiveEntryIdSchema = z.string().min(1);

export const capturePhaseSchema = z.enum([
  "idle",
  "armed",
  "recording",
  "processing",
  "ready",
  "failed"
]);

export const artifactKindSchema = z.enum(["recording.webm", "session.archive.json"]);

export const sessionArtifactSchema = z.object({
  kind: artifactKindSchema,
  relativePath: nonEmptyPathSchema,
  mimeType: z.string().min(1),
  bytes: z.number().int().nonnegative().optional()
});

export const pageContextSchema = z.object({
  url: z.string().url(),
  title: z.string().min(1),
  tabId: z.number().int().nonnegative().optional()
});

export const consoleEventSchema = z.object({
  kind: z.literal("console"),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
  args: z.array(z.string()).default([])
});

export const networkHeaderSchema = z.object({
  name: z.string().min(1),
  value: z.string()
});

export const networkCookieSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  domain: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  expires: z.number().finite().optional(),
  size: z.number().int().nonnegative().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  session: z.boolean().optional(),
  sameSite: z.string().min(1).optional(),
  priority: z.string().min(1).optional(),
  sameParty: z.boolean().optional(),
  sourcePort: z.number().int().optional(),
  sourceScheme: z.string().min(1).optional(),
  partitionKey: z.string().min(1).optional(),
  partitioned: z.boolean().optional()
});

export const networkAssociatedCookieSchema = z.object({
  cookie: networkCookieSchema,
  blockedReasons: z.array(z.string().min(1)).default([])
});

export const networkSetCookieSchema = networkCookieSchema.extend({
  raw: z.string().min(1)
});

export const networkBodyCaptureSchema = z.object({
  disposition: z.enum(["captured", "truncated", "omitted", "unavailable"]),
  encoding: z.enum(["utf8", "base64"]).optional(),
  mimeType: z.string().min(1).optional(),
  value: z.string().optional(),
  byteLength: z.number().int().nonnegative().optional(),
  omittedByteLength: z.number().int().nonnegative().optional(),
  reason: z.string().min(1).optional()
});

export const networkSubtypeSchema = z.enum([
  "xhr",
  "fetch",
  "document",
  "stylesheet",
  "script",
  "image",
  "font",
  "media",
  "websocket",
  "other"
]);

export const networkEventSchema = z.object({
  kind: z.literal("network"),
  method: z.string().min(1),
  url: z.string().url(),
  subtype: networkSubtypeSchema.optional(),
  status: z.number().int().min(100).max(599).optional(),
  statusText: z.string().min(1).optional(),
  durationMs: z.number().nonnegative().optional(),
  requestId: z.string().min(1).optional(),
  request: z.object({
    headers: z.array(networkHeaderSchema).default([]),
    cookies: z.array(networkAssociatedCookieSchema).default([]),
    body: networkBodyCaptureSchema.optional()
  }),
  response: z
    .object({
      headers: z.array(networkHeaderSchema).default([]),
      setCookieHeaders: z.array(z.string().min(1)).default([]),
      setCookies: z.array(networkSetCookieSchema).default([]),
      body: networkBodyCaptureSchema.optional()
    })
    .optional(),
  failureText: z.string().min(1).optional()
});

export const interactionPointerTypeSchema = z.enum(["mouse", "pen", "touch"]);

export const interactionModifiersSchema = z.object({
  alt: z.boolean().default(false),
  ctrl: z.boolean().default(false),
  meta: z.boolean().default(false),
  shift: z.boolean().default(false)
});

export const interactionRectSchema = z.object({
  left: z.number().finite(),
  top: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite()
});

export const interactionPageMetricsSchema = z.object({
  viewport: z.object({
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative()
  }),
  document: z.object({
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative()
  }),
  scroll: z.object({
    x: z.number().finite(),
    y: z.number().finite()
  }),
  devicePixelRatio: z.number().positive().optional(),
  url: z.string().url().optional(),
  title: z.string().min(1).optional()
});

export const interactionTargetSchema = z.object({
  selector: z.string().min(1).optional(),
  selectorAlternates: z.array(z.string().min(1)).default([]),
  tagName: z.string().min(1).optional(),
  dataTestId: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  role: z.string().min(1).nullable().optional(),
  href: z.string().min(1).optional(),
  textPreview: z.string().max(240).optional(),
  inputType: z.string().min(1).optional(),
  rect: interactionRectSchema.optional()
});

const baseInteractionSchema = z.object({
  kind: z.literal("interaction"),
  selector: z.string().min(1).optional(),
  valuePreview: z.string().max(240).optional(),
  target: interactionTargetSchema.optional(),
  page: interactionPageMetricsSchema.optional()
});

export const clickInteractionEventSchema = baseInteractionSchema.extend({
  type: z.literal("click"),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  clientX: z.number().finite().optional(),
  clientY: z.number().finite().optional(),
  pageX: z.number().finite().optional(),
  pageY: z.number().finite().optional(),
  button: z.number().int().optional(),
  buttons: z.number().int().optional(),
  clickCount: z.number().int().nonnegative().optional(),
  pointerType: interactionPointerTypeSchema.optional(),
  modifiers: interactionModifiersSchema.optional()
});

export const inputInteractionEventSchema = baseInteractionSchema.extend({
  type: z.literal("input"),
  inputType: z.string().min(1).optional(),
  inputKind: z.enum(["text", "textarea", "select", "checkbox", "radio", "contenteditable", "other"]).optional(),
  value: z.string().optional(),
  valueLength: z.number().int().nonnegative().optional(),
  redacted: z.boolean().optional(),
  checked: z.boolean().optional(),
  selectedIndex: z.number().int().optional(),
  selectionStart: z.number().int().nonnegative().nullable().optional(),
  selectionEnd: z.number().int().nonnegative().nullable().optional(),
  isComposing: z.boolean().optional()
});

export const submitInteractionEventSchema = baseInteractionSchema.extend({
  type: z.literal("submit"),
  formSelector: z.string().min(1).optional(),
  submitterSelector: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
  action: z.string().url().optional()
});

export const navigationInteractionEventSchema = baseInteractionSchema.extend({
  type: z.literal("navigation"),
  url: z.string().url(),
  title: z.string().min(1).optional(),
  navigationType: z.enum(["pushState", "replaceState", "popstate", "hashchange", "location", "submit"]).optional(),
  referrer: z.string().url().optional()
});

export const keyboardInteractionEventSchema = baseInteractionSchema.extend({
  type: z.literal("keyboard"),
  eventType: z.enum(["keydown", "keyup"]),
  key: z.string().min(1),
  code: z.string().min(1).optional(),
  location: z.number().int().nonnegative().optional(),
  repeat: z.boolean().optional(),
  isComposing: z.boolean().optional(),
  redacted: z.boolean().optional(),
  modifiers: interactionModifiersSchema.optional()
});

export const interactionEventSchema = z.discriminatedUnion("type", [
  clickInteractionEventSchema,
  inputInteractionEventSchema,
  submitInteractionEventSchema,
  navigationInteractionEventSchema,
  keyboardInteractionEventSchema
]);

export const errorEventSchema = z.object({
  kind: z.literal("error"),
  message: z.string().min(1),
  stack: z.string().optional(),
  source: z.enum(["page", "extension", "runtime"])
});

export const lifecycleEventSchema = z.object({
  kind: z.literal("lifecycle"),
  phase: capturePhaseSchema,
  detail: z.string().min(1)
});

export const sessionEventPayloadSchema = z.union([
  consoleEventSchema,
  networkEventSchema,
  interactionEventSchema,
  errorEventSchema,
  lifecycleEventSchema
]);

export const sessionEventSchema = z.object({
  at: isoTimestampSchema,
  payload: sessionEventPayloadSchema
});

export const archiveActionPayloadSchema = z.union([
  interactionEventSchema,
  errorEventSchema,
  lifecycleEventSchema
]);

export const archiveActionSchema = z.object({
  id: archiveEntryIdSchema,
  seq: z.number().int().nonnegative(),
  at: isoTimestampSchema,
  tags: z.array(z.string().min(1)).default([]),
  payload: archiveActionPayloadSchema
});

export const archiveConsoleEntrySchema = z.object({
  id: archiveEntryIdSchema,
  seq: z.number().int().nonnegative(),
  at: isoTimestampSchema,
  payload: consoleEventSchema
});

export const archiveNetworkEntrySchema = z.object({
  id: archiveEntryIdSchema,
  seq: z.number().int().nonnegative(),
  at: isoTimestampSchema,
  subtype: networkSubtypeSchema,
  payload: networkEventSchema
});

export const actionMergeGroupSchema = z.object({
  id: archiveEntryIdSchema,
  kind: z.literal("merge-group"),
  memberIds: z.array(archiveEntryIdSchema).min(2),
  tags: z.array(z.string().min(1)).default([]),
  label: z.string().min(1),
  createdAt: isoTimestampSchema
});

export const archiveAnnotationSchema = z.discriminatedUnion("kind", [actionMergeGroupSchema]);

export const sessionArchiveSchema = z.object({
  schemaVersion: z.literal(sessionSchemaVersion),
  sessionId: sessionIdSchema,
  name: z.string().min(1),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  phase: capturePhaseSchema,
  page: pageContextSchema,
  artifacts: z.array(sessionArtifactSchema),
  sections: z.object({
    actions: z.array(archiveActionSchema).default([]),
    console: z.array(archiveConsoleEntrySchema).default([]),
    network: z.array(archiveNetworkEntrySchema).default([])
  }),
  annotations: z.array(archiveAnnotationSchema).default([]),
  notes: z.array(z.string()).default([])
});

export const captureSessionDraftSchema = z.object({
  sessionId: sessionIdSchema,
  name: z.string().min(1),
  nameEdited: z.boolean().default(false),
  phase: capturePhaseSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  page: pageContextSchema,
  artifacts: z.array(sessionArtifactSchema),
  events: z.array(sessionEventSchema),
  notes: z.array(z.string()).default([])
});

export type NetworkSubtype = z.infer<typeof networkSubtypeSchema>;
export type CapturePhase = z.infer<typeof capturePhaseSchema>;
export type SessionArtifact = z.infer<typeof sessionArtifactSchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SessionArchive = z.infer<typeof sessionArchiveSchema>;
export type ArchiveAction = z.infer<typeof archiveActionSchema>;
export type ArchiveConsoleEntry = z.infer<typeof archiveConsoleEntrySchema>;
export type ArchiveNetworkEntry = z.infer<typeof archiveNetworkEntrySchema>;
export type ArchiveAnnotation = z.infer<typeof archiveAnnotationSchema>;
export type ActionMergeGroup = z.infer<typeof actionMergeGroupSchema>;
export type CaptureSessionDraft = z.infer<typeof captureSessionDraftSchema>;

export function sanitizeCapturedUrl(input: string): string {
  try {
    const url = new URL(input);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return input;
  }
}

export function createSessionName(input: { title: string; url: string }): string {
  const title = input.title.trim();

  if (title.length > 0) {
    return title;
  }

  const hostnameMatch = sanitizeCapturedUrl(input.url).match(/^[a-z]+:\/\/([^/]+)/i);

  if (hostnameMatch?.[1]) {
    return hostnameMatch[1];
  }

  return "Untitled session";
}

export function createSessionId(now: Date = new Date()): string {
  return `jl_${now.getTime().toString(36)}`;
}

export function createSessionArtifacts(sessionId: string): SessionArtifact[] {
  return [
    {
      kind: "recording.webm",
      relativePath: `${sessionId}/recording.webm`,
      mimeType: "video/webm"
    },
    {
      kind: "session.archive.json",
      relativePath: `${sessionId}/session.archive.json`,
      mimeType: "application/json"
    }
  ];
}

export function createSessionDraft(input: {
  page: { tabId?: number; title: string; url: string };
  now?: Date;
}): CaptureSessionDraft {
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const sessionId = createSessionId(now);
  const sanitizedUrl = sanitizeCapturedUrl(input.page.url);

  return {
    sessionId,
    name: createSessionName({
      title: input.page.title,
      url: sanitizedUrl
    }),
    nameEdited: false,
    phase: "armed",
    createdAt: timestamp,
    updatedAt: timestamp,
    page: {
      tabId: input.page.tabId,
      title: input.page.title,
      url: sanitizedUrl
    },
    artifacts: createSessionArtifacts(sessionId),
    events: [
      {
        at: timestamp,
        payload: {
          kind: "lifecycle",
          phase: "armed",
          detail: "Session scaffold created from active tab."
        }
      }
    ],
    notes: []
  };
}

export function appendDraftEvent(
  draft: CaptureSessionDraft,
  payload: z.input<typeof sessionEventPayloadSchema>,
  now: Date = new Date()
): CaptureSessionDraft {
  const timestamp = now.toISOString();

  return {
    ...draft,
    updatedAt: timestamp,
    events: [
      ...draft.events,
      {
        at: timestamp,
        payload: sessionEventPayloadSchema.parse(payload)
      }
    ]
  };
}

export function updateDraftPage(
  draft: CaptureSessionDraft,
  page: { tabId?: number; title: string; url: string },
  now: Date = new Date()
): CaptureSessionDraft {
  const sanitizedUrl = sanitizeCapturedUrl(page.url);

  return {
    ...draft,
    name: draft.nameEdited
      ? draft.name
      : createSessionName({
          title: page.title,
          url: sanitizedUrl
        }),
    updatedAt: now.toISOString(),
    page: {
      tabId: page.tabId,
      title: page.title,
      url: sanitizedUrl
    }
  };
}

export function transitionDraftPhase(
  draft: CaptureSessionDraft,
  phase: CapturePhase,
  detail: string,
  now: Date = new Date()
): CaptureSessionDraft {
  return appendDraftEvent(
    {
      ...draft,
      phase,
      updatedAt: now.toISOString()
    },
    {
      kind: "lifecycle",
      phase,
      detail
    },
    now
  );
}

export function renameSessionDraft(
  draft: CaptureSessionDraft,
  name: string,
  now: Date = new Date()
): CaptureSessionDraft {
  const trimmed = name.trim();

  if (trimmed.length === 0) {
    throw new Error("Session name cannot be empty.");
  }

  return {
    ...draft,
    name: trimmed,
    nameEdited: true,
    updatedAt: now.toISOString()
  };
}

export function generateArchiveEntryId(
  sessionId: string,
  section: "actions" | "console" | "network",
  index: number
): string {
  return `${sessionId}:${section}:${String(index).padStart(6, "0")}`;
}

export function createSessionArchive(draft: CaptureSessionDraft): SessionArchive {
  const actions: ArchiveAction[] = [];
  const consoleEntries: ArchiveConsoleEntry[] = [];
  const networkEntries: ArchiveNetworkEntry[] = [];

  for (let index = 0; index < draft.events.length; index += 1) {
    const event = draft.events[index];
    if (!event) continue;

    const seq = index;

    switch (event.payload.kind) {
      case "interaction":
      case "error":
      case "lifecycle":
        actions.push({
          id: generateArchiveEntryId(draft.sessionId, "actions", actions.length),
          seq,
          at: event.at,
          tags: [],
          payload: event.payload
        });
        break;

      case "console":
        consoleEntries.push({
          id: generateArchiveEntryId(draft.sessionId, "console", consoleEntries.length),
          seq,
          at: event.at,
          payload: event.payload
        });
        break;

      case "network":
        networkEntries.push({
          id: generateArchiveEntryId(draft.sessionId, "network", networkEntries.length),
          seq,
          at: event.at,
          subtype: event.payload.subtype ?? "other",
          payload: {
            ...event.payload,
            subtype: event.payload.subtype ?? "other"
          }
        });
        break;
    }
  }

  return sessionArchiveSchema.parse({
    schemaVersion: sessionSchemaVersion,
    sessionId: draft.sessionId,
    name: draft.name,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    phase: draft.phase,
    page: draft.page,
    artifacts: draft.artifacts,
    sections: {
      actions,
      console: consoleEntries,
      network: networkEntries
    },
    annotations: [],
    notes: draft.notes
  });
}
