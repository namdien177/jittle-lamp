import React, { useEffect, useMemo, useRef, useState } from "react";
import { FileArchive, ShieldCheck, UploadCloud } from "lucide-react";

import { createWebPlaybackAdapter, createWebStorageAdapter } from "../adapters";
import { PublicTopbar } from "../components/public-topbar";
import { buttonVariants } from "../components/ui/button";
import { cn } from "../lib/cn";
import { EvidenceViewerContent } from "../evidence-viewer-content";
import type { LoadedSession } from "../loader";
import { useWebFileAdapter } from "../web-adapter";

type Phase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "viewing"; loaded: LoadedSession };

export function QuickViewPage(): React.JSX.Element {
  const storageAdapter = useMemo(() => createWebStorageAdapter(), []);
  const playbackAdapter = useMemo(() => createWebPlaybackAdapter(), []);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const previousVideoUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (previousVideoUrlRef.current) {
        playbackAdapter.releaseSource?.({
          videoPath: previousVideoUrlRef.current,
        });
      }
    };
  }, [playbackAdapter]);

  const handleFile = async (file: File): Promise<void> => {
    setPhase({ kind: "loading" });
    try {
      const loaded = await storageAdapter.loadFromZipFile?.(file);
      if (!loaded) throw new Error("Web ZIP storage adapter is unavailable.");
      if (previousVideoUrlRef.current) {
        playbackAdapter.releaseSource?.({
          videoPath: previousVideoUrlRef.current,
        });
      }
      previousVideoUrlRef.current = loaded.videoUrl;
      playbackAdapter.loadSource({
        videoPath: loaded.videoUrl,
        mimeType: "video/webm",
      });
      setPhase({ kind: "viewing", loaded });
    } catch (err) {
      setPhase({
        kind: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const fileAdapter = useWebFileAdapter({
    disabled: phase.kind === "loading",
    onFile: handleFile,
  });

  const closeViewer = (): void => {
    if (previousVideoUrlRef.current) {
      playbackAdapter.releaseSource?.({
        videoPath: previousVideoUrlRef.current,
      });
      previousVideoUrlRef.current = null;
    }
    setPhase({ kind: "idle" });
  };

  if (phase.kind === "viewing") {
    const fetchVideoBytes = async (): Promise<Uint8Array | null> => {
      if (phase.loaded.recordingBytes.length > 0)
        return phase.loaded.recordingBytes;
      try {
        const response = await fetch(phase.loaded.videoUrl);
        if (!response.ok)
          throw new Error(`Failed to fetch recording (${response.status}).`);
        return new Uint8Array(await response.arrayBuffer());
      } catch {
        return null;
      }
    };
    return (
      <EvidenceViewerContent
        key={phase.loaded.archive.sessionId}
        loadedArchive={phase.loaded.archive}
        loadedTimeline={phase.loaded.timeline}
        loadedMergeGroups={phase.loaded.mergeGroups}
        videoSrc={phase.loaded.videoUrl}
        recordingBytesInitial={phase.loaded.recordingBytes}
        source="zip"
        viewerMode="page"
        isOwner
        shareLinkUrl={null}
        fetchVideoBytes={fetchVideoBytes}
        onVideoError={() => undefined}
        onClose={closeViewer}
      />
    );
  }

  const isLoading = phase.kind === "loading";

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <PublicTopbar />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-4 py-12 sm:px-6">
        <div className="mb-8 text-center">
          <span className="jl-eyebrow text-primary">
            Quick view
          </span>
          <h1 className="mt-2 font-display text-4xl font-bold">
            Drop ZIP here
          </h1>
          <p className="jl-lead mx-auto mt-2 max-w-md">
            Review a local evidence ZIP in-browser.
            No upload, fully local.
          </p>
        </div>

        <div
          role="button"
          tabIndex={0}
          data-dragover={fileAdapter.isDragOver ? "true" : "false"}
          onDragOver={fileAdapter.onDragOver}
          onDragLeave={fileAdapter.onDragLeave}
          onDrop={fileAdapter.onDrop}
          onClick={fileAdapter.openDialog}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") fileAdapter.openDialog();
          }}
          className={cn(
            "group relative flex min-h-80 w-full cursor-pointer flex-col items-center justify-center gap-5 rounded-md border-2 border-dashed border-border-strong bg-card px-6 py-16 text-center transition-colors outline-none",
            "hover:border-primary hover:bg-primary/[0.05] focus-visible:border-primary",
            "data-[dragover=true]:border-primary data-[dragover=true]:bg-primary/[0.08]",
          )}
        >
          <span className="flex size-16 items-center justify-center rounded-md bg-secondary text-primary transition-colors group-data-[dragover=true]:text-primary [&_svg]:size-7">
            {isLoading ? (
              <FileArchive aria-hidden className="animate-pulse" />
            ) : (
              <UploadCloud aria-hidden />
            )}
          </span>
          <div className="space-y-1">
            <p className="font-display text-2xl font-bold text-foreground">
              {isLoading
                ? "Extracting and validating…"
                : "Drop a session ZIP here"}
            </p>
            <p className="text-base text-muted-foreground">
              {isLoading
                ? "This can take a moment for large recordings."
                : "or click to browse your files"}
            </p>
          </div>
          {phase.kind === "error" ? (
            <p className="max-w-md break-words text-base text-destructive">
              {phase.error}
            </p>
          ) : null}
          {!isLoading ? (
            <span
              className={cn(
                buttonVariants({ variant: "primary", size: "sm" }),
                "pointer-events-none",
              )}
            >
              Browse file
            </span>
          ) : null}
          <input
            type="file"
            accept=".zip"
            className="hidden"
            ref={fileAdapter.inputRef}
            onChange={fileAdapter.onInputChange}
          />
        </div>

        <div className="mt-6 grid w-full gap-2">
          <div className="jl-row-card">
            <ShieldCheck className="size-5 shrink-0 text-primary" aria-hidden />
            <p className="text-base text-foreground">
              <strong>Local only.</strong>{" "}
              <span className="text-muted-foreground">
                Processed in your browser, never uploaded.
              </span>
            </p>
          </div>
          <div className="jl-row-card">
            <FileArchive className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            <p className="text-base text-foreground">
              <strong>Validates ZIP.</strong>{" "}
              <span className="text-muted-foreground">
                Needs session archive and recording files.
              </span>
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
