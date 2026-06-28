import { describe, expect, test } from "bun:test";

import { buildSectionTimeline, buildTimeline, buildVisibleActionRangeSelection, buildVisibleActionRows, createSessionArchive, createSessionDraft, deriveAnchorMs, findActiveIndex, formatOffset, getContiguousMergeableActionIds, type ActionMergeGroup, type SessionEvent } from "@jittle-lamp/shared";

const T0 = "2024-06-01T12:00:00.000Z";
const T1 = "2024-06-01T12:00:05.000Z";
const T2 = "2024-06-01T12:00:10.000Z";
const T3 = "2024-06-01T12:01:00.000Z";
type BasicInteractionType = "click" | "input" | "submit";

function makeLifecycle(at: string, phase: "idle" | "armed" | "recording" | "processing" | "ready" | "failed", detail = "detail"): SessionEvent {
  return { at, payload: { kind: "lifecycle", phase, detail } };
}

function makeInteraction(at: string, type: BasicInteractionType, selector?: string): SessionEvent {
  return { at, payload: { kind: "interaction", type, ...(selector ? { selector } : {}) } };
}

function makeNavigation(at: string, selector?: string): SessionEvent {
  return {
    at,
    payload: {
      kind: "interaction",
      type: "navigation",
      url: "https://example.com/next",
      ...(selector ? { selector } : {})
    }
  };
}

function makeNetwork(at: string, method = "GET", url = "https://example.com/api"): SessionEvent {
  return {
    at,
    payload: {
      kind: "network",
      method,
      url,
      request: { headers: [], cookies: [] }
    }
  };
}

function makeConsole(at: string, message: string): SessionEvent {
  return { at, payload: { kind: "console", level: "info", message, args: [] } };
}

function makeError(at: string, message: string): SessionEvent {
  return { at, payload: { kind: "error", message, source: "page" } };
}

function makeArchive(events: SessionEvent[]) {
  const draft = createSessionDraft({
    page: { title: "Example", url: "https://example.com" },
    now: new Date(T0)
  });

  return createSessionArchive({
    ...draft,
    createdAt: T0,
    updatedAt: events.at(-1)?.at ?? T0,
    phase: "ready",
    events
  });
}

function makeMergeArchive() {
  return makeArchive([
    makeInteraction(T0, "click", "#one"),
    makeInteraction(T1, "click", "#two"),
    makeInteraction(T2, "click", "#three"),
    makeInteraction(T3, "click", "#four")
  ]);
}

describe("deriveAnchorMs", () => {
  test("returns createdAt for empty sections", () => {
    expect(deriveAnchorMs(makeArchive([]))).toBe(new Date(T0).getTime());
  });

  test("uses first lifecycle recording phase as anchor", () => {
    const archive = makeArchive([makeLifecycle(T1, "armed"), makeLifecycle(T0, "recording"), makeLifecycle(T2, "ready")]);
    expect(deriveAnchorMs(archive)).toBe(new Date(T0).getTime());
  });

  test("uses first recording phase even if not earliest event", () => {
    const archive = makeArchive([makeLifecycle(T0, "armed"), makeLifecycle(T1, "recording"), makeLifecycle(T2, "ready")]);
    expect(deriveAnchorMs(archive)).toBe(new Date(T1).getTime());
  });

  test("falls back to earliest action when no recording phase", () => {
    const archive = makeArchive([makeLifecycle(T2, "ready"), makeLifecycle(T1, "armed"), makeLifecycle(T3, "failed")]);
    expect(deriveAnchorMs(archive)).toBe(new Date(T0).getTime());
  });
});

describe("buildTimeline", () => {
  test("returns empty array for empty sections", () => {
    expect(buildTimeline(makeArchive([]))).toEqual([]);
  });

  test("assigns correct offsetMs relative to anchor", () => {
    const items = buildTimeline(makeArchive([makeLifecycle(T0, "recording"), makeLifecycle(T1, "ready")]));
    expect(items).toHaveLength(2);
    expect(items[0]!.offsetMs).toBe(0);
    expect(items[1]!.offsetMs).toBe(5000);
  });

  test("sorts items by offsetMs ascending", () => {
    const items = buildTimeline(makeArchive([makeLifecycle(T2, "ready"), makeLifecycle(T0, "recording"), makeLifecycle(T1, "processing")]));
    expect(items[0]!.offsetMs).toBe(0);
    expect(items[1]!.offsetMs).toBe(5000);
    expect(items[2]!.offsetMs).toBe(10000);
  });

  test("classifies section and kind", () => {
    expect(buildTimeline(makeArchive([makeInteraction(T0, "click")]))[0]!.section).toBe("actions");
    expect(buildTimeline(makeArchive([makeConsole(T0, "hello")]))[0]!.section).toBe("console");
    expect(buildTimeline(makeArchive([makeNetwork(T0)]))[0]!.section).toBe("network");
  });

  test("builds readable labels", () => {
    expect(buildTimeline(makeArchive([makeLifecycle(T0, "recording", "Started capture")]))[0]!.label).toBe("recording: Started capture");
    expect(buildTimeline(makeArchive([makeInteraction(T0, "click", "#submit-btn")]))[0]!.label).toBe("click #submit-btn");
    expect(
      buildTimeline(
        makeArchive([
          {
            at: T0,
            payload: {
              kind: "interaction",
              type: "selection",
              selectedText: "Important highlighted text"
            }
          }
        ])
      )[0]!.label
    ).toBe('Highlight "Important highlighted text"');
    expect(buildTimeline(makeArchive([makeNetwork(T0, "POST", "https://api.example.com/data")]))[0]!.label).toBe("POST https://api.example.com/data");
    expect(buildTimeline(makeArchive([makeConsole(T0, "console output here")]))[0]!.label).toBe("console output here");
    expect(buildTimeline(makeArchive([makeError(T0, "TypeError: undefined")]))[0]!.label).toBe("TypeError: undefined");
  });

  test("uses target text and role for user action labels", () => {
    const items = buildTimeline(
      makeArchive([
        {
          at: T0,
          payload: {
            kind: "interaction",
            type: "click",
            selector: '[data-testid="login-button"]',
            target: {
              selector: '[data-testid="login-button"]',
              selectorAlternates: ['[data-testid="login-button"]', "#login"],
              tagName: "button",
              dataTestId: "login-button",
              id: "login",
              role: null,
              textPreview: "Login"
            }
          }
        }
      ])
    );

    expect(items[0]!.label).toBe('Click "Login" button');
  });

  test("hides tab label prefixes when the session only has one tab", () => {
    const items = buildTimeline(
      makeArchive([
        {
          at: T0,
          tab: { id: 1, title: "Checkout", url: "https://example.com/checkout" },
          payload: { kind: "interaction", type: "click", selector: "#submit" }
        },
        {
          at: T1,
          tab: { id: 1, title: "Checkout", url: "https://example.com/checkout" },
          payload: { kind: "console", level: "info", message: "saved", args: [] }
        }
      ])
    );

    expect(items.map((item) => item.label)).toEqual(["click #submit", "saved"]);
    expect(items[0]?.tabLabel).toBe("Checkout");
  });

  test("prefixes actions logs and network labels when active tab changes", () => {
    const items = buildTimeline(
      makeArchive([
        {
          at: T0,
          tab: { id: 1, title: "Checkout", url: "https://example.com/checkout" },
          payload: { kind: "interaction", type: "click", selector: "#submit" }
        },
        {
          at: T1,
          tab: { id: 2, title: "Settings", url: "https://example.com/settings" },
          payload: {
            kind: "interaction",
            type: "navigation",
            url: "https://example.com/settings",
            title: "Settings"
          }
        },
        {
          at: T2,
          tab: { id: 2, title: "Settings", url: "https://example.com/settings" },
          payload: { kind: "network", method: "POST", url: "https://example.com/api/save", request: { headers: [], cookies: [] } }
        },
        {
          at: T3,
          tab: { id: 2, title: "Settings", url: "https://example.com/settings" },
          payload: { kind: "console", level: "info", message: "saved", args: [] }
        }
      ])
    );

    expect(items.map((item) => item.label)).toEqual([
      "[Checkout] click #submit",
      '[Settings] Navigate to "Settings"',
      "[Settings] POST https://example.com/api/save",
      "[Settings] saved"
    ]);
  });

  test("adds indexes when tab titles are duplicated", () => {
    const items = buildTimeline(
      makeArchive([
        {
          at: T0,
          tab: { id: 1, title: "App", url: "https://a.example.com" },
          payload: { kind: "interaction", type: "click", selector: "#one" }
        },
        {
          at: T1,
          tab: { id: 2, title: "App", url: "https://b.example.com" },
          payload: { kind: "interaction", type: "click", selector: "#two" }
        }
      ])
    );

    expect(items.map((item) => item.label)).toEqual(["[App 1] click #one", "[App 2] click #two"]);
  });

  test("events before anchor have negative offsetMs", () => {
    const items = buildTimeline(makeArchive([makeLifecycle(T1, "recording"), makeLifecycle(T0, "armed")]));
    const armedItem = items.find((i) => i.kind === "lifecycle" && "phase" in i.payload && i.payload.phase === "armed");
    expect(armedItem!.offsetMs).toBe(-5000);
  });
});

describe("buildSectionTimeline network search", () => {
  test("filters network items by plain text across url headers and response body", () => {
    const archive = makeArchive([
      {
        at: T0,
        payload: {
          kind: "network",
          method: "GET",
          url: "https://example.com/api/users",
          subtype: "xhr",
          request: {
            headers: [{ name: "x-trace-id", value: "trace-123" }],
            cookies: []
          },
          response: {
            headers: [{ name: "content-type", value: "application/json" }],
            setCookieHeaders: [],
            setCookies: [],
            body: { disposition: "captured", value: "hello response", encoding: "utf8" }
          }
        }
      },
      makeNetwork(T1, "GET", "https://example.com/assets/app.css")
    ]);

    expect(buildSectionTimeline(archive, "network", "all", "trace-123")).toHaveLength(1);
    expect(buildSectionTimeline(archive, "network", "all", "hello response")).toHaveLength(1);
    expect(buildSectionTimeline(archive, "network", "all", "app.css")).toHaveLength(1);
    expect(buildSectionTimeline(archive, "network", "all", "missing-value")).toHaveLength(0);
  });

  test("filters network items by regex query", () => {
    const archive = makeArchive([
      makeNetwork(T0, "GET", "https://example.com/api/users/123"),
      makeNetwork(T1, "GET", "https://example.com/assets/app.css")
    ]);

    const items = buildSectionTimeline(archive, "network", "all", "/users\\/\\d+/i");
    expect(items).toHaveLength(1);
    expect(items[0]!.label).toContain("/users/123");
  });
});

describe("buildSectionTimeline actions", () => {
  test("keeps lifecycle bookkeeping out of the user actions section", () => {
    const archive = makeArchive([
      makeLifecycle(T0, "recording", "Content capture ready on https://example.com/page"),
      makeInteraction(T1, "click", "#save"),
      makeError(T2, "Uncaught error")
    ]);

    const items = buildSectionTimeline(archive, "actions");

    expect(items.map((item) => item.kind)).toEqual(["interaction", "error"]);
    expect(items.map((item) => item.label)).toEqual(["click #save", "Uncaught error"]);
  });
});

describe("findActiveIndex", () => {
  const items = buildTimeline(makeArchive([makeLifecycle(T0, "recording"), makeLifecycle(T1, "ready"), makeLifecycle(T2, "failed")]));

  test("returns -1 for empty items", () => {
    expect(findActiveIndex([], 5000)).toBe(-1);
  });

  test("tracks the most recent visible item", () => {
    expect(findActiveIndex(items, -1000)).toBe(-1);
    expect(findActiveIndex(items, 0)).toBe(0);
    expect(findActiveIndex(items, 2500)).toBe(0);
    expect(findActiveIndex(items, 5000)).toBe(1);
    expect(findActiveIndex(items, 10000)).toBe(2);
    expect(findActiveIndex(items, 99999)).toBe(2);
  });

  test("handles boundary values at exact offsets and duplicate timestamps", () => {
    const duplicateOffsetItems = buildTimeline(
      makeArchive([
        makeLifecycle(T0, "recording"),
        makeLifecycle(T0, "armed"),
        makeLifecycle(T1, "ready")
      ])
    );

    expect(findActiveIndex(duplicateOffsetItems, -1)).toBe(-1);
    expect(findActiveIndex(duplicateOffsetItems, 0)).toBe(1);
    expect(findActiveIndex(duplicateOffsetItems, 1)).toBe(1);
    expect(findActiveIndex(duplicateOffsetItems, 4999)).toBe(1);
    expect(findActiveIndex(duplicateOffsetItems, 5000)).toBe(2);
    expect(findActiveIndex(duplicateOffsetItems, Number.MAX_SAFE_INTEGER)).toBe(2);
  });
});

describe("formatOffset", () => {
  test("formats offsets", () => {
    expect(formatOffset(0)).toBe("00:00");
    expect(formatOffset(5000)).toBe("00:05");
    expect(formatOffset(60000)).toBe("01:00");
    expect(formatOffset(90000)).toBe("01:30");
    expect(formatOffset(3600000)).toBe("60:00");
    expect(formatOffset(-5000)).toBe("-00:05");
    expect(formatOffset(-60000)).toBe("-01:00");
    expect(formatOffset(5999)).toBe("00:05");
  });
});

describe("visible action merge helpers", () => {
  test("buildVisibleActionRows collapses merged members into one visible row", () => {
    const archive = makeMergeArchive();
    const ids = archive.sections.actions.filter((entry) => entry.payload.kind === "interaction").map((entry) => entry.id);
    const mergeGroups: ActionMergeGroup[] = [
      {
        id: "merge-1",
        kind: "merge-group",
        memberIds: [ids[1]!, ids[2]!],
        tags: [],
        label: "Middle",
        createdAt: T3
      }
    ];

    const rows = buildVisibleActionRows(archive, mergeGroups);

    expect(rows.map((row) => row.id)).toEqual([ids[0]!, "merge-1", ids[3]!]);
  });

  test("buildVisibleActionRangeSelection uses visible row order", () => {
    const archive = makeMergeArchive();
    const ids = archive.sections.actions.filter((entry) => entry.payload.kind === "interaction").map((entry) => entry.id);
    const mergeGroups: ActionMergeGroup[] = [
      {
        id: "merge-1",
        kind: "merge-group",
        memberIds: [ids[1]!, ids[2]!],
        tags: [],
        label: "Middle",
        createdAt: T3
      }
    ];

    expect(buildVisibleActionRangeSelection(archive, mergeGroups, ids[0]!, ids[3]!)).toEqual([ids[0]!, "merge-1", ids[3]!]);
  });

  test("allows merge only for consecutive visible unmerged action rows", () => {
    const archive = makeMergeArchive();
    const ids = archive.sections.actions.filter((entry) => entry.payload.kind === "interaction").map((entry) => entry.id);

    expect(getContiguousMergeableActionIds(archive, [], [ids[0]!, ids[1]!, ids[2]!, ids[3]!])).toEqual(ids);
    expect(getContiguousMergeableActionIds(archive, [], [ids[0]!, ids[1]!, ids[3]!])).toEqual([]);
  });

  test("rejects merge when a visible merged row is included or skipped", () => {
    const archive = makeMergeArchive();
    const ids = archive.sections.actions.filter((entry) => entry.payload.kind === "interaction").map((entry) => entry.id);
    const mergeGroups: ActionMergeGroup[] = [
      {
        id: "merge-1",
        kind: "merge-group",
        memberIds: [ids[1]!, ids[2]!],
        tags: [],
        label: "Middle",
        createdAt: T3
      }
    ];

    expect(getContiguousMergeableActionIds(archive, mergeGroups, [ids[0]!, ids[3]!])).toEqual([]);
    expect(getContiguousMergeableActionIds(archive, mergeGroups, [ids[0]!, "merge-1"])).toEqual([]);
  });
});
