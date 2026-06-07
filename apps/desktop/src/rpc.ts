import type { ArchiveAnnotation, SessionArchive } from "@jittle-lamp/shared";

import type { ResolvedCompanionConfig } from "./companion/config";
import type { CompanionArtifactWrite, CompanionRuntimeState } from "./companion/server";

export type { SessionArtifact, SessionRecord } from "./companion/sessions-db";

export type ContextMenuItem =
  | { type: "separator" }
  | {
      type?: "normal";
      label: string;
      action?: string;
      data?: unknown;
      enabled?: boolean;
    };

/**
 * The stable shape the renderer receives when opening any session for viewing,
 * regardless of whether it came from the library, a ZIP import, or a local
 * folder on disk outside the indexed library.
 *
 * `source` lets the renderer know whether notes are editable (library only).
 * `tempId` is present only for ZIP imports and must be passed back to
 * `clearTempSession` when the viewer is closed.
 *
 * - `"library"` — folder-backed session inside the configured output dir;
 *   notes are persisted in SQLite and are editable.
 * - `"zip"`     — temporary session extracted from an imported ZIP; notes are
 *   always empty and read-only.
 * - `"local"`   — ad-hoc session loaded directly from an arbitrary folder
 *   on the local machine; never persisted into SQLite; notes are read-only.
 */
export type ViewerPayload = {
  source: "library" | "zip" | "local";
  archive: SessionArchive;
  videoPath: string;
  notes: string;
  tempId?: string;
};

export type DesktopCompanionConfigSnapshot = Pick<
  ResolvedCompanionConfig,
  "autoSyncToCloud" | "configFilePath" | "defaultOutputDir" | "envOverrideActive" | "outputDir" | "savedOutputDir" | "source"
>;

export type DesktopCompanionRuntimeSnapshot = Pick<CompanionRuntimeState, "lastError" | "origin" | "outputDir" | "status"> & {
  recentWrites: CompanionArtifactWrite[];
};

export type DesktopUpdateState = {
  status: "idle" | "checking" | "not-available" | "available" | "error" | "unsupported";
  currentVersion: string;
  availableVersion: string | null;
  releaseDate: string | null;
  progressPercent: number | null;
  lastCheckedAt: string | null;
  error: string | null;
};

export const desktopIpcRequestChannel = "jittle-lamp:desktop-request";
export const desktopIpcMessageChannel = "jittle-lamp:desktop-message";

export type DesktopRequestMap = {
  chooseOutputDirectory: {
    params: {
      startingFolder: string;
    };
    response: {
      selectedPath: string | null;
    };
  };
  addSessionTag: {
    params: {
      sessionId: string;
      tag: string;
    };
    response: {
      ok: true;
    };
  };
  clearTempSession: {
    params: {
      tempId: string;
    };
    response: {
      ok: true;
    };
  };
  deleteSession: {
    params: {
      sessionId: string;
    };
    response: {
      ok: true;
    };
  };
  exitApp: {
    params: undefined;
    response: {
      ok: true;
    };
  };
  getCompanionConfig: {
    params: undefined;
    response: DesktopCompanionConfigSnapshot;
  };
  getCompanionRuntime: {
    params: undefined;
    response: DesktopCompanionRuntimeSnapshot;
  };
  getDesktopUpdateState: {
    params: undefined;
    response: DesktopUpdateState;
  };
  checkForDesktopUpdate: {
    params: undefined;
    response: DesktopUpdateState;
  };
  installDesktopUpdate: {
    params: undefined;
    response: {
      ok: true;
    };
  };
  getSessionNotes: {
    params: {
      sessionId: string;
    };
    response: {
      notes: string;
    };
  };
  getVideoPlaybackUrl: {
    params: {
      videoPath: string;
      mimeType: string;
    };
    response: {
      url: string;
    };
  };
  exportSessionZip: {
    params: {
      sessionId: string;
    };
    response: {
      savedPath: string;
    };
  };
  prepareSessionUpload: {
    params: {
      sessionId: string;
    };
    response: {
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
    };
  };
  markSessionRemoteSynced: {
    params: {
      sessionId: string;
      evidenceId: string;
      orgId: string;
    };
    response: {
      ok: true;
    };
  };
  importZipSession: {
    params: undefined;
    response: ViewerPayload;
  };
  openLocalSession: {
    params: undefined;
    response: ViewerPayload;
  };
  listAllTags: {
    params: undefined;
    response: string[];
  };
  listSessions: {
    params: undefined;
    response: import("./companion/sessions-db").SessionRecord[];
  };
  loadLibrarySession: {
    params: {
      sessionId: string;
    };
    response: ViewerPayload;
  };
  openPath: {
    params: {
      path: string;
    };
    response: {
      ok: true;
    };
  };
  openExternalUrl: {
    params: {
      url: string;
    };
    response: {
      ok: true;
    };
  };
  removeSessionTag: {
    params: {
      sessionId: string;
      tag: string;
    };
    response: {
      ok: true;
    };
  };
  saveOutputDirectory: {
    params: {
      outputDir: string;
    };
    response: DesktopCompanionConfigSnapshot;
  };
  saveAutoSyncToCloud: {
    params: {
      autoSyncToCloud: boolean;
    };
    response: DesktopCompanionConfigSnapshot;
  };
  setSessionNotes: {
    params: {
      sessionId: string;
      notes: string;
    };
    response: {
      ok: true;
    };
  };
  saveSessionReviewState: {
    params: {
      sessionId: string;
      notes: string;
      annotations: ArchiveAnnotation[];
    };
    response: {
      ok: true;
      archive: SessionArchive;
    };
  };
  showContextMenu: {
    params: {
      menu: ContextMenuItem[];
    };
    response: {
      ok: true;
    };
  };
};

export type DesktopRendererMessageMap = {
  contextMenuClicked: {
    action: string;
    data?: unknown;
  };
};
