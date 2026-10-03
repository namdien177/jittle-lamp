import type { ViewerPayload } from "../rpc";

export type ViewerSource = ViewerPayload["source"];

export function getViewerSourceLabel(source: ViewerSource): string {
  switch (source) {
    case "library":
      return "Library";
    case "zip":
      return "ZIP";
    case "local":
      return "Local";
    case "cloud":
      return "Cloud";
  }
}

export function canEditViewerNotes(source: ViewerSource): boolean {
  return source === "library";
}

export function shouldPersistViewerReviewState(source: ViewerSource): boolean {
  return source === "library";
}

export function shouldClearViewerTempSession(payload: Pick<ViewerPayload, "source" | "tempId">): boolean {
  return (payload.source === "zip" || payload.source === "cloud") && payload.tempId !== undefined;
}

export function getViewerReadOnlyNotice(source: ViewerSource): string | null {
  switch (source) {
    case "library":
      return null;
    case "local":
      return "Local session — notes are read-only and not persisted.";
    case "zip":
      return "Notes are read-only for ZIP imports and are not saved.";
    case "cloud":
      return "Cloud evidence — notes are read-only here.";
  }
}
