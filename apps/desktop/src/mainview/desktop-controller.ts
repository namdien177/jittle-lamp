import { useEffect, useMemo, useRef, useState } from "react";

import type { TimelineSection } from "@jittle-lamp/shared";

import type {
  DesktopCompanionConfigSnapshot,
  DesktopCompanionRuntimeSnapshot,
  DesktopUpdateState,
  SessionRecord,
  ViewerPayload
} from "../rpc";
import type { FetchToken } from "./api";
import { createDesktopBridge, type DesktopBridge } from "./desktop-bridge";
import { createDesktopNotesAdapter, createDesktopStorageAdapter } from "./adapters";
import {
  collectViewerVideoDiagnostics,
  createViewerVideoState,
  loadViewerVideoSource,
  recordViewerVideoEvent,
  resetViewerVideoDiagnostics,
  type ViewerVideoState
} from "./viewer-video";
import { applyViewerPayload, createViewerState, resetViewerState, type ViewerState } from "./viewer-state";
import { shouldClearViewerTempSession } from "./viewer-source";
import { reportDesktopViewerTelemetry } from "./viewer-rollout";
import { syncDesktopSessionToServer } from "./session-sync";
import { findActiveIndex } from "@jittle-lamp/shared";
import {
  createMergeGroup,
  closeMergeDialog as closeMergeDialogState,
  deriveSectionTimeline,
  deriveTimeline,
  getArchiveMergeGroups,
  getContiguousMergeableSelection,
  openMergeDialog as openMergeDialogState,
  selectActionRange,
  selectSingleAction,
  toggleActionSelection,
  validateMergeDialog
} from "@jittle-lamp/viewer-core";
import type { DatePreset } from "./catalog-view";
import { formatErrorMessage } from "./utils";

export type FeedbackTone = "neutral" | "success" | "error";

export type ViewState = {
  bridgeError: string | null;
  config: DesktopCompanionConfigSnapshot | null;
  runtime: DesktopCompanionRuntimeSnapshot | null;
  update: DesktopUpdateState | null;
  sessions: SessionRecord[];
  allTags: string[];
  dateFilter: DatePreset;
  tagFilter: string | null;
  editingTagSessionId: string | null;
  draftOutputDir: string;
  feedback: { text: string; tone: FeedbackTone };
  isChoosingFolder: boolean;
  isCheckingForUpdate: boolean;
  isInstallingUpdate: boolean;
  isLoading: boolean;
  isSaving: boolean;
  isSavingAutoSync: boolean;
};

export type DesktopController = {
  bridge: DesktopBridge | null;
  state: ViewState;
  viewerState: ViewerState;
  viewerVideoRef: React.RefObject<HTMLVideoElement | null>;
  viewerReactRootRef: React.RefObject<HTMLDivElement | null>;
  setDateFilter: (preset: DatePreset) => void;
  setTagFilter: (tag: string | null) => void;
  startTagEdit: (sessionId: string) => void;
  cancelTagEdit: () => void;
  addTagToSession: (sessionId: string, tag: string) => void;
  removeTagFromSession: (sessionId: string, tag: string) => void;
  chooseFolder: () => void;
  saveFolder: () => void;
  setAutoSyncToCloud: (value: boolean) => void;
  setDraftOutputDir: (value: string) => void;
  openCurrentOutputFolder: () => void;
  openConfigFile: () => void;
  checkForUpdate: () => void;
  installUpdate: () => void;
  openLocalSession: () => void;
  importZip: () => void;
  viewSession: (sessionId: string) => void;
  openSessionFolder: (sessionId: string) => void;
  exportSessionZip: (sessionId: string) => Promise<{ savedPath: string }>;
  prepareSessionUpload: (sessionId: string) => Promise<{
    sessionId: string;
    title: string;
    artifacts: Array<{
      key: "recording" | "archive" | "playback";
      kind: "recording" | "network-log";
      mimeType: string;
      bytes: number;
      checksum: string;
      payload: Uint8Array;
    }>;
  }>;
  markSessionRemoteSynced: (input: { sessionId: string; evidenceId: string; orgId: string }) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  reloadSessions: () => Promise<void>;
  closeViewer: () => void;
  setViewerNotesValue: (value: string) => void;
  saveViewerNotes: () => void;
  copyViewerValue: (value: string, label: string) => Promise<void>;
  setViewerSection: (section: TimelineSection) => void;
  setViewerSubtype: (value: ViewerState["networkSubtypeFilter"]) => void;
  setViewerSearch: (value: string) => void;
  clickTimelineItem: (itemId: string, offsetMs: number, event: React.MouseEvent<HTMLButtonElement>) => void;
  openTimelineContext: (itemId: string, event: React.MouseEvent<HTMLButtonElement>) => void;
  focusViewerTimeline: () => void;
  closeNetworkDetail: () => void;
  updateTimelineHighlight: () => void;
  handleViewerVideoError: () => void;
  setMergeValue: (value: string) => void;
  submitMergeDialog: () => void;
  closeMergeDialog: () => void;
  reloadEverything: () => Promise<void>;
};

const runtimePollIntervalMs = 2_000;
const mediaEventNames = [
  "loadstart",
  "loadedmetadata",
  "loadeddata",
  "canplay",
  "canplaythrough",
  "play",
  "playing",
  "waiting",
  "stalled",
  "suspend",
  "abort",
  "emptied",
  "pause",
  "error"
] as const;

function initialViewState(): ViewState {
  return {
    bridgeError: null,
    config: null,
    runtime: null,
    update: null,
    sessions: [],
    allTags: [],
    dateFilter: "all",
    tagFilter: null,
    editingTagSessionId: null,
    draftOutputDir: "",
    feedback: { text: "Loading desktop companion status…", tone: "neutral" },
    isChoosingFolder: false,
    isCheckingForUpdate: false,
    isInstallingUpdate: false,
    isLoading: true,
    isSaving: false,
    isSavingAutoSync: false
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function cloneViewerState(state: ViewerState): ViewerState {
  return {
    ...state,
    timeline: [...state.timeline],
    pendingMergeActionIds: [...state.pendingMergeActionIds],
    selectedActionIds: new Set(state.selectedActionIds),
    mergeGroups: [...state.mergeGroups]
  };
}

function hasUploadableLocalRecord(session: SessionRecord): boolean {
  return (
    session.artifacts.some((artifact) => artifact.artifactName === "recording.webm") &&
    session.artifacts.some((artifact) => artifact.artifactName === "session.archive.json")
  );
}

export function useDesktopController(options: { authStatus?: string; getAuthToken?: FetchToken } = {}): DesktopController {
  const bridge = useMemo(() => createDesktopBridge(), []);
  const [state, setState] = useState<ViewState>(() => initialViewState());
  const [viewerState, setViewerState] = useState<ViewerState>(() => createViewerState());
  const stateRef = useRef(state);
  const viewerStateRef = useRef(viewerState);
  const viewerReactRootRef = useRef<HTMLDivElement | null>(null);
  const viewerVideoStateRef = useRef<ViewerVideoState>(createViewerVideoState());

  // `viewerVideoRef` is a callback-ref-object: it satisfies the
  // `React.RefObject<HTMLVideoElement | null>` contract that `ViewerModal`
  // assigns to (it writes `ref.current = el`), but the `current` setter also
  // attaches/detaches the diagnostic media-event listeners deterministically
  // when the <video> element (which lives inside ViewerModal) mounts/unmounts.
  // This replaces the previous effect keyed on `viewerState.open`, which could
  // run before the element existed (the <video> lives in another component).
  const viewerVideoRef = useMemo<React.RefObject<HTMLVideoElement | null>>(() => {
    let element: HTMLVideoElement | null = null;
    let attachedHandlers: Array<{ eventName: (typeof mediaEventNames)[number]; handler: () => void }> = [];
    return {
      get current(): HTMLVideoElement | null {
        return element;
      },
      set current(next: HTMLVideoElement | null) {
        if (next === element) return;
        if (element) {
          for (const { eventName, handler } of attachedHandlers) {
            element.removeEventListener(eventName, handler);
          }
          attachedHandlers = [];
        }
        element = next;
        if (element) {
          const target = element;
          attachedHandlers = mediaEventNames.map((eventName) => {
            const handler = (): void => recordViewerVideoEvent(target, viewerVideoStateRef.current, eventName);
            target.addEventListener(eventName, handler);
            return { eventName, handler };
          });
        }
      }
    };
  }, []);
  const contextTargetIdRef = useRef<string | null>(null);
  const hasReportedViewerBootRef = useRef(false);
  const isAutoScrollingRef = useRef(false);
  const autoSyncInFlightRef = useRef<Set<string>>(new Set());
  const autoSyncAttemptedRef = useRef<Set<string>>(new Set());
  const storageAdapter = useMemo(() => (bridge ? createDesktopStorageAdapter(bridge) : null), [bridge]);
  const notesAdapter = useMemo(() => createDesktopNotesAdapter(), []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    viewerStateRef.current = viewerState;
  }, [viewerState]);

  const patchState = (update: Partial<ViewState> | ((previous: ViewState) => ViewState)): void => {
    setState((previous) => (typeof update === "function" ? update(previous) : { ...previous, ...update }));
  };

  const updateViewer = (mutator: (next: ViewerState) => void): void => {
    setViewerState((previous) => {
      const next = cloneViewerState(previous);
      mutator(next);
      return next;
    });
  };

  const reloadCatalog = async (): Promise<void> => {
    if (!bridge) return;
    const [sessions, allTags] = await Promise.all([
      bridge.rpc.request.listSessions(undefined).catch((): SessionRecord[] => stateRef.current.sessions),
      bridge.rpc.request.listAllTags(undefined).catch((): string[] => stateRef.current.allTags)
    ]);
    patchState({ sessions, allTags });
  };

  const reloadEverything = async (): Promise<void> => {
    if (!bridge) return;
    const [config, runtime, update] = await Promise.all([
      bridge.rpc.request.getCompanionConfig(undefined),
      bridge.rpc.request.getCompanionRuntime(undefined),
      bridge.rpc.request.getDesktopUpdateState(undefined)
    ]);
    patchState({ config, runtime, update, draftOutputDir: config.outputDir });
    await reloadCatalog();
  };

  const getSelectedActionEntryIds = (): string[] => {
    const current = viewerStateRef.current;
    const payload = current.payload;
    return payload ? getContiguousMergeableSelection(payload.archive, current.mergeGroups, current.selectedActionIds) : [];
  };

  const renderViewerPane = (): void => {
    if (!hasReportedViewerBootRef.current) {
      reportDesktopViewerTelemetry({ implementation: "react", phase: "booted" });
      hasReportedViewerBootRef.current = true;
    }
  };

  const persistViewerReviewState = async (successText?: string): Promise<void> => {
    const current = viewerStateRef.current;
    const payload = current.payload;
    if (!payload) return;

    if (!notesAdapter.canEdit(payload.source) || !storageAdapter) {
      if (successText) patchState({ feedback: { tone: "neutral", text: successText } });
      return;
    }

    const response = await storageAdapter.saveSessionReviewState?.({
      sessionId: payload.archive.sessionId,
      notes: current.notesValue,
      annotations: current.mergeGroups
    });
    if (!response) throw new Error("Session review persistence adapter is unavailable.");

    updateViewer((next) => {
      if (!next.payload || next.payload.archive.sessionId !== payload.archive.sessionId) return;
      next.notesDirty = false;
      next.payload = {
        ...next.payload,
        archive: response.archive,
        notes: next.notesValue
      };
      next.timeline = deriveTimeline(response.archive);
      next.mergeGroups = getArchiveMergeGroups(response.archive);
    });

    if (successText) patchState({ feedback: { tone: "success", text: successText } });
  };

  const openViewer = (payload: ViewerPayload): void => {
    const previousPayload = viewerStateRef.current.payload;
    if (previousPayload && shouldClearViewerTempSession(previousPayload) && bridge) {
      const previousTempId = previousPayload.tempId;
      if (previousTempId !== undefined) {
        void bridge.rpc.request.clearTempSession({ tempId: previousTempId }).catch(() => undefined);
      }
    }

    setViewerState(() => {
      const next = createViewerState();
      applyViewerPayload(next, payload);
      return next;
    });
    renderViewerPane();
  };

  const closeViewer = (): void => {
    const payload = viewerStateRef.current.payload;
    const video = viewerVideoRef.current;

    setViewerState((previous) => {
      const next = cloneViewerState(previous);
      resetViewerState(next);
      return next;
    });

    contextTargetIdRef.current = null;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    viewerVideoStateRef.current.loadVersion += 1;
    resetViewerVideoDiagnostics(viewerVideoStateRef.current);

    if (payload && shouldClearViewerTempSession(payload) && bridge) {
      const tempId = payload.tempId;
      if (tempId !== undefined) {
        void bridge.rpc.request.clearTempSession({ tempId }).catch(() => undefined);
      }
    }
  };

  useEffect(() => {
    reportDesktopViewerTelemetry({ implementation: "react", phase: "selected" });
  }, []);

  useEffect(() => {
    if (!bridge) {
      patchState({
        bridgeError: "Electron preload bridge did not initialize in this renderer.",
        feedback: { tone: "error", text: "Desktop runtime unavailable." },
        isLoading: false
      });
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const [config, runtime, update, sessions, allTags] = await Promise.all([
          bridge.rpc.request.getCompanionConfig(undefined),
          bridge.rpc.request.getCompanionRuntime(undefined),
          bridge.rpc.request.getDesktopUpdateState(undefined),
          bridge.rpc.request.listSessions(undefined).catch((): SessionRecord[] => []),
          bridge.rpc.request.listAllTags(undefined).catch((): string[] => [])
        ]);
        if (cancelled) return;
        patchState({
          config,
          runtime,
          update,
          sessions,
          allTags,
          draftOutputDir: config.outputDir,
          feedback: {
            tone: runtime.status === "error" ? "error" : "neutral",
            text:
              runtime.status === "error"
                ? runtime.lastError ?? "The desktop companion failed to start."
                : config.envOverrideActive
                  ? "JITTLE_LAMP_OUTPUT_DIR is currently overriding the saved desktop setting."
                  : "Desktop companion ready."
          },
          isLoading: false
        });
      } catch (error) {
        if (cancelled) return;
        patchState({
          feedback: { tone: "error", text: formatErrorMessage(error, "Unable to load desktop companion state.") },
          isLoading: false
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;

    const interval = setInterval(() => {
      void (async () => {
        try {
          const [runtime, update, sessions, allTags] = await Promise.all([
            bridge.rpc.request.getCompanionRuntime(undefined),
            bridge.rpc.request.getDesktopUpdateState(undefined),
            bridge.rpc.request.listSessions(undefined).catch((): SessionRecord[] => stateRef.current.sessions),
            bridge.rpc.request.listAllTags(undefined).catch((): string[] => stateRef.current.allTags)
          ]);
          const current = stateRef.current;
          const changed: Partial<ViewState> = {};
          if (!deepEqual(current.runtime, runtime)) changed.runtime = runtime;
          if (!deepEqual(current.update, update)) changed.update = update;
          if (!deepEqual(current.sessions, sessions)) changed.sessions = sessions;
          if (!deepEqual(current.allTags, allTags)) changed.allTags = allTags;
          if (Object.keys(changed).length > 0) patchState(changed);
        } catch {
          // ignored — periodic poll
        }
      })();
    }, runtimePollIntervalMs);

    return () => clearInterval(interval);
  }, [bridge]);

  useEffect(() => {
    if (!bridge || options.authStatus !== "signed-in" || !options.getAuthToken || state.config?.autoSyncToCloud === false) return;

    const candidates = state.sessions
      .filter((session) => hasUploadableLocalRecord(session))
      .filter((session) => !session.remoteEvidenceId)
      .filter((session) => !autoSyncInFlightRef.current.has(session.sessionId))
      .filter((session) => !autoSyncAttemptedRef.current.has(session.sessionId))
      .slice(0, 2);

    for (const session of candidates) {
      autoSyncInFlightRef.current.add(session.sessionId);
      autoSyncAttemptedRef.current.add(session.sessionId);
      void syncDesktopSessionToServer({
        getToken: options.getAuthToken,
        sessionId: session.sessionId,
        prepareSessionUpload: (sessionId) => bridge.rpc.request.prepareSessionUpload({ sessionId }),
        markSessionRemoteSynced: async (input) => {
          await bridge.rpc.request.markSessionRemoteSynced(input);
        }
      })
        .then(async () => {
          patchState({
            feedback: { tone: "success", text: "New companion recording synced to cloud." }
          });
          await reloadCatalog();
        })
        .catch((error) => {
          patchState({
            feedback: {
              tone: "error",
              text: formatErrorMessage(error, "Automatic cloud sync failed.")
            }
          });
        })
        .finally(() => {
          autoSyncInFlightRef.current.delete(session.sessionId);
        });
    }
  }, [bridge, options.authStatus, options.getAuthToken, state.config?.autoSyncToCloud, state.sessions]);

  useEffect(() => {
    if (!bridge) return;
    const unsubscribe = bridge.onContextMenuClicked(({ action }) => {
      if (action === "merge") {
        const selectedActionIds = getSelectedActionEntryIds();
        if (selectedActionIds.length < 2) {
          patchState({ feedback: { tone: "error", text: "Select at least two actions before merging." } });
          return;
        }
        updateViewer((next) => openMergeDialogState(next, selectedActionIds));
      } else if (action === "unmerge") {
        const targetId = contextTargetIdRef.current;
        contextTargetIdRef.current = null;
        if (!targetId) return;
        updateViewer((next) => {
          next.mergeGroups = next.mergeGroups.filter((group) => group.id !== targetId);
          next.selectedActionIds = new Set();
        });
        void persistViewerReviewState("Merge removed.");
      }
    });
    return () => unsubscribe();
  }, [bridge]);

  // Media-event listeners are attached/detached by the `viewerVideoRef`
  // callback-ref-object above, deterministically when the <video> element
  // mounts/unmounts, so no `viewerState.open`-keyed effect is needed here.

  useEffect(() => {
    const payload = viewerState.payload;
    const video = viewerVideoRef.current;
    if (!payload || !viewerState.open || !video) return;

    const recordingArtifact = payload.archive.artifacts.find((artifact) => artifact.kind === "recording.webm");
    void loadViewerVideoSource({
      videoPath: payload.videoPath,
      mimeType: recordingArtifact?.mimeType || "video/webm",
      viewerVideo: video,
      viewerVideoState: viewerVideoStateRef.current,
      desktopBridge: bridge,
      getViewerSource: () => viewerStateRef.current.payload?.source ?? "unknown",
      isViewerOpen: () => viewerStateRef.current.open,
      onBridgeUnavailable: () => {
        patchState({ feedback: { tone: "error", text: "Desktop bridge unavailable for evidence video loading." } });
      },
      onLoadFailure: () => undefined
    });
  }, [bridge, viewerState.open, viewerState.payload?.videoPath]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        if (viewerStateRef.current.mergeDialogOpen) {
          updateViewer((next) => closeMergeDialogState(next));
        } else if (viewerStateRef.current.open) {
          closeViewer();
        } else if (stateRef.current.editingTagSessionId !== null) {
          patchState({ editingTagSessionId: null });
        }
        return;
      }

      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "q") {
        event.preventDefault();
        if (bridge) void bridge.rpc.request.exitApp(undefined);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [bridge]);

  return {
    bridge,
    state,
    viewerState,
    viewerVideoRef,
    viewerReactRootRef,
    setDateFilter: (preset) => patchState({ dateFilter: preset }),
    setTagFilter: (tag) => patchState({ tagFilter: tag }),
    startTagEdit: (sessionId) => patchState({ editingTagSessionId: sessionId }),
    cancelTagEdit: () => patchState({ editingTagSessionId: null }),
    addTagToSession: (sessionId, tag) => {
      void (async () => {
        if (!bridge) return;
        const trimmed = tag.trim();
        if (!trimmed) return;
        try {
          await bridge.rpc.request.addSessionTag({ sessionId, tag: trimmed });
          await reloadCatalog();
        } catch (error) {
          patchState({ feedback: { tone: "error", text: formatErrorMessage(error, "Failed to add tag.") } });
        } finally {
          patchState({ editingTagSessionId: null });
        }
      })();
    },
    removeTagFromSession: (sessionId, tag) => {
      void (async () => {
        if (!bridge) return;
        try {
          await bridge.rpc.request.removeSessionTag({ sessionId, tag });
          await reloadCatalog();
        } catch (error) {
          patchState({ feedback: { tone: "error", text: formatErrorMessage(error, "Failed to remove tag.") } });
        }
      })();
    },
    setDraftOutputDir: (value) => patchState({ draftOutputDir: value }),
    chooseFolder: () => {
      void (async () => {
        const current = stateRef.current;
        if (!bridge || !current.config || current.config.envOverrideActive) return;
        patchState({ isChoosingFolder: true });
        try {
          const { selectedPath } = await bridge.rpc.request.chooseOutputDirectory({
            startingFolder: current.draftOutputDir || current.config.outputDir
          });
          patchState({
            draftOutputDir: selectedPath ?? stateRef.current.draftOutputDir
          });
        } catch (error) {
          patchState({ feedback: { tone: "error", text: formatErrorMessage(error, "Unable to open the native folder picker.") } });
        } finally {
          patchState({ isChoosingFolder: false });
        }
      })();
    },
    saveFolder: () => {
      void (async () => {
        const current = stateRef.current;
        if (!bridge || !current.config || current.config.envOverrideActive) return;
        patchState({ isSaving: true });
        try {
          const nextConfig = await bridge.rpc.request.saveOutputDirectory({ outputDir: current.draftOutputDir });
          const nextRuntime = await bridge.rpc.request.getCompanionRuntime(undefined);
          patchState({
            config: nextConfig,
            runtime: nextRuntime,
            draftOutputDir: nextConfig.outputDir,
            feedback: { tone: "success", text: "Saved. New extension exports will use this folder immediately." }
          });
        } catch (error) {
          patchState({ feedback: { tone: "error", text: formatErrorMessage(error, "Unable to save the output folder.") } });
        } finally {
          patchState({ isSaving: false });
        }
      })();
    },
    setAutoSyncToCloud: (value) => {
      void (async () => {
        if (!bridge || stateRef.current.isSavingAutoSync) return;
        const previousConfig = stateRef.current.config;
        patchState((previous) => ({
          ...previous,
          config: previous.config ? { ...previous.config, autoSyncToCloud: value } : previous.config,
          isSavingAutoSync: true
        }));
        try {
          const nextConfig = await bridge.rpc.request.saveAutoSyncToCloud({ autoSyncToCloud: value });
          patchState({
            config: nextConfig,
            feedback: {
              tone: "success",
              text: value ? "New companion recordings will sync to cloud automatically." : "Automatic cloud sync is off."
            }
          });
        } catch (error) {
          patchState({
            config: previousConfig,
            feedback: { tone: "error", text: formatErrorMessage(error, "Unable to save automatic sync setting.") }
          });
        } finally {
          patchState({ isSavingAutoSync: false });
        }
      })();
    },
    openCurrentOutputFolder: () => {
      const current = stateRef.current;
      if (!bridge || !current.config) return;
      void bridge.rpc.request.openPath({ path: current.config.outputDir });
    },
    openConfigFile: () => {
      const current = stateRef.current;
      if (!bridge || !current.config) return;
      void bridge.rpc.request.openPath({ path: current.config.configFilePath });
    },
    checkForUpdate: () => {
      void (async () => {
        if (!bridge || stateRef.current.isCheckingForUpdate) return;
        patchState({
          isCheckingForUpdate: true,
          feedback: { tone: "neutral", text: "Checking for a desktop update…" }
        });
        try {
          const update = await bridge.rpc.request.checkForDesktopUpdate(undefined);
          patchState({
            update,
            feedback: {
              tone: update.status === "error" ? "error" : update.status === "available" ? "success" : "neutral",
              text: formatUpdateFeedback(update)
            }
          });
        } catch (error) {
          patchState({ feedback: { tone: "error", text: formatErrorMessage(error, "Unable to check for updates.") } });
        } finally {
          patchState({ isCheckingForUpdate: false });
        }
      })();
    },
    installUpdate: () => {
      void (async () => {
        if (!bridge || stateRef.current.update?.status !== "available") return;
        patchState({
          isInstallingUpdate: true,
          feedback: { tone: "neutral", text: "Opening the desktop update installer…" }
        });
        try {
          await bridge.rpc.request.installDesktopUpdate(undefined);
        } catch (error) {
          patchState({
            isInstallingUpdate: false,
            feedback: { tone: "error", text: formatErrorMessage(error, "Unable to install the update.") }
          });
        }
      })();
    },
    openLocalSession: () => {
      void (async () => {
        if (!bridge || viewerStateRef.current.isOpening) return;
        updateViewer((next) => {
          next.isOpening = true;
        });
        try {
          const payload = await storageAdapter?.openLocalSession?.();
          if (!payload) throw new Error("Local session adapter is unavailable.");
          openViewer(payload);
        } catch (error) {
          patchState({ feedback: { tone: "error", text: formatErrorMessage(error, "Failed to open local session.") } });
        } finally {
          updateViewer((next) => {
            next.isOpening = false;
          });
        }
      })();
    },
    importZip: () => {
      void (async () => {
        if (!bridge || viewerStateRef.current.isOpening) return;
        updateViewer((next) => {
          next.isOpening = true;
        });
        try {
          const payload = await storageAdapter?.importZipSession?.();
          if (!payload) throw new Error("ZIP import adapter is unavailable.");
          openViewer(payload);
        } catch (error) {
          patchState({ feedback: { tone: "error", text: formatErrorMessage(error, "Failed to import ZIP session.") } });
        } finally {
          updateViewer((next) => {
            next.isOpening = false;
          });
        }
      })();
    },
    viewSession: (sessionId) => {
      void (async () => {
        if (!bridge || viewerStateRef.current.isOpening) return;
        updateViewer((next) => {
          next.isOpening = true;
        });
        try {
          const payload = await storageAdapter?.loadLibrarySession?.(sessionId);
          if (!payload) throw new Error("Library session adapter is unavailable.");
          openViewer(payload);
        } catch (error) {
          patchState({ feedback: { tone: "error", text: formatErrorMessage(error, "Failed to load session.") } });
        } finally {
          updateViewer((next) => {
            next.isOpening = false;
          });
        }
      })();
    },
    openSessionFolder: (sessionId) => {
      if (!bridge) return;
      const session = stateRef.current.sessions.find((candidate) => candidate.sessionId === sessionId);
      if (!session) return;
      void bridge.rpc.request.openPath({ path: session.sessionFolder });
    },
    exportSessionZip: async (sessionId) => {
      if (!bridge) throw new Error("Desktop bridge unavailable.");
      const exportResult = await storageAdapter?.exportSessionZip?.(sessionId);
      if (!exportResult) throw new Error("ZIP export adapter is unavailable.");
      return exportResult;
    },
    prepareSessionUpload: async (sessionId) => {
      if (!bridge) throw new Error("Desktop bridge unavailable.");
      return bridge.rpc.request.prepareSessionUpload({ sessionId });
    },
    markSessionRemoteSynced: async (input) => {
      if (!bridge) throw new Error("Desktop bridge unavailable.");
      await bridge.rpc.request.markSessionRemoteSynced(input);
      await reloadCatalog();
    },
    deleteSession: async (sessionId) => {
      if (!bridge) throw new Error("Desktop bridge unavailable.");
      await bridge.rpc.request.deleteSession({ sessionId });
      patchState((previous) => ({
        ...previous,
        sessions: previous.sessions.filter((session) => session.sessionId !== sessionId)
      }));
    },
    reloadSessions: reloadCatalog,
    closeViewer,
    setViewerNotesValue: (value) => {
      updateViewer((next) => {
        next.notesValue = value;
        next.notesDirty = next.notesValue !== (next.payload?.notes ?? "");
      });
    },
    saveViewerNotes: () => {
      void (async () => {
        updateViewer((next) => {
          next.notesSaving = true;
        });
        try {
          await persistViewerReviewState("Notes saved.");
        } catch (error) {
          patchState({ feedback: { tone: "error", text: formatErrorMessage(error, "Failed to save notes.") } });
        } finally {
          updateViewer((next) => {
            next.notesSaving = false;
          });
        }
      })();
    },
    copyViewerValue: async (value) => {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      }
    },
    setViewerSection: (section) => {
      updateViewer((next) => {
        next.activeSection = section;
        next.networkDetailIndex = null;
      });
    },
    setViewerSubtype: (value) => {
      updateViewer((next) => {
        next.networkSubtypeFilter = value;
        next.networkDetailIndex = null;
      });
    },
    setViewerSearch: (value) => {
      updateViewer((next) => {
        next.networkSearchQuery = value;
        next.networkDetailIndex = null;
      });
    },
    clickTimelineItem: (itemId, offsetMs, event) => {
      const current = viewerStateRef.current;
      const video = viewerVideoRef.current;
      if (video) video.currentTime = Math.max(0, offsetMs / 1000);
      updateViewer((next) => {
        next.autoFollow = false;
        if (next.activeSection === "actions" && next.payload) {
          if (event.metaKey || event.ctrlKey) {
            const selection = toggleActionSelection(
              { selectedActionIds: next.selectedActionIds, anchorActionId: next.anchorActionId },
              itemId
            );
            next.selectedActionIds = selection.selectedActionIds;
            next.anchorActionId = selection.anchorActionId;
          } else if (event.shiftKey && next.anchorActionId) {
            const selection = selectActionRange(
              next.payload.archive,
              next.mergeGroups,
              { selectedActionIds: next.selectedActionIds, anchorActionId: next.anchorActionId },
              itemId
            );
            if (selection.selectedActionIds.size > 0) next.selectedActionIds = selection.selectedActionIds;
          } else {
            const selection = selectSingleAction(itemId);
            next.selectedActionIds = selection.selectedActionIds;
            next.anchorActionId = selection.anchorActionId;
          }
        } else {
          const fullTimelineIndex = current.timeline.findIndex((timelineItem) => timelineItem.id === itemId);
          if (fullTimelineIndex !== -1) {
            const timelineItem = current.timeline[fullTimelineIndex];
            const drawerable = timelineItem?.kind === "network" || timelineItem?.kind === "console";
            next.networkDetailIndex =
              drawerable && current.networkDetailIndex !== fullTimelineIndex
                ? fullTimelineIndex
                : null;
          }
        }
      });
    },
    openTimelineContext: (itemId, event) => {
      const current = viewerStateRef.current;
      if (current.activeSection !== "actions" || !current.payload || !bridge) return;
      event.preventDefault();
      contextTargetIdRef.current = itemId;
      updateViewer((next) => {
        if (!next.selectedActionIds.has(itemId)) {
          const selection = selectSingleAction(itemId);
          next.selectedActionIds = selection.selectedActionIds;
          next.anchorActionId = selection.anchorActionId;
        }
      });
      const isMerged = Boolean(current.mergeGroups.find((group) => group.id === itemId));
      const selectedActionIds = getSelectedActionEntryIds();
      const canMerge = !isMerged && selectedActionIds.length >= 2;
      const canUnmerge = isMerged;
      if (!canMerge && !canUnmerge) return;
      const menu: import("../rpc").ContextMenuItem[] = [];
      if (canMerge) menu.push({ label: "Merge Actions…", action: "merge" });
      if (canUnmerge) menu.push({ label: "Un-merge", action: "unmerge" });
      void bridge.rpc.request.showContextMenu({ menu });
    },
    focusViewerTimeline: () => {
      updateViewer((next) => {
        next.autoFollow = true;
      });
    },
    closeNetworkDetail: () => {
      updateViewer((next) => {
        next.networkDetailIndex = null;
      });
    },
    updateTimelineHighlight: () => {
      const current = viewerStateRef.current;
      const payload = current.payload;
      const video = viewerVideoRef.current;
      if (!payload || !video) return;
      const items = deriveSectionTimeline(payload.archive, current.activeSection, current.networkSubtypeFilter, current.networkSearchQuery);
      const activeIndex = findActiveIndex(items, video.currentTime * 1000);
      updateViewer((next) => {
        next.activeIndex = activeIndex;
      });
      if (!current.autoFollow || isAutoScrollingRef.current) return;
      isAutoScrollingRef.current = true;
      requestAnimationFrame(() => {
        const activeRow = viewerReactRootRef.current?.querySelector<HTMLElement>(".viewer-timeline .timeline-item[data-active='true']");
        activeRow?.scrollIntoView({ block: "nearest" });
        isAutoScrollingRef.current = false;
      });
    },
    handleViewerVideoError: () => {
      const video = viewerVideoRef.current;
      if (!video) return;
      const diagnostics = collectViewerVideoDiagnostics(video, viewerVideoStateRef.current, "error-event");
      console.error("[jittle-lamp][viewer-video] playback failed", diagnostics);
      patchState({
        feedback: {
          tone: "error",
          text: `Unable to play the evidence video (${diagnostics.error.codeLabel}).`
        }
      });
    },
    setMergeValue: (value) => {
      updateViewer((next) => {
        next.mergeDialogValue = value;
        next.mergeDialogError = null;
      });
    },
    submitMergeDialog: () => {
      const validation = validateMergeDialog(viewerStateRef.current);
      if (!validation.ok) {
        updateViewer((next) => {
          next.mergeDialogError = validation.error;
        });
        return;
      }
      const group = createMergeGroup({
        id: `mg-${Date.now()}`,
        createdAt: new Date().toISOString(),
        label: validation.label,
        selectedActionIds: validation.selectedActionIds
      });
      updateViewer((next) => {
        next.mergeGroups = [...next.mergeGroups, group];
        next.selectedActionIds = new Set();
        closeMergeDialogState(next);
      });
      void persistViewerReviewState("Merged actions.");
    },
    closeMergeDialog: () => {
      updateViewer((next) => closeMergeDialogState(next));
    },
    reloadEverything
  };
}

function formatUpdateFeedback(update: DesktopUpdateState): string {
  if (update.status === "available") {
    return `Version ${update.availableVersion ?? "a new update"} is available and can be installed with the macOS installer.`;
  }

  if (update.status === "not-available") {
    return "You are already on the latest desktop version.";
  }

  if (update.status === "unsupported") {
    return update.error ?? "Updates are only available in the packaged desktop app.";
  }

  if (update.status === "error") {
    return update.error ?? "Unable to check for updates.";
  }

  return "Desktop updater is idle.";
}
