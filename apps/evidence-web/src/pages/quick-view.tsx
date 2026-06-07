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
          <span className="font-mono font-semibold uppercase tracking-[0.12em] text-primary">
            Quick view
          </span>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">
            Review a session locally
          </h1>
          <p className="mx-auto mt-2 max-w-md text-base text-muted-foreground">
            Drop a session ZIP to replay it instantly. Nothing is uploaded — the
            archive is read entirely in your browser.
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
            "group relative flex w-full cursor-pointer flex-col items-center gap-4 rounded-2xl border-2 border-dashed border-border-strong bg-card/40 px-6 py-16 text-center transition-colors outline-none",
            "hover:border-primary/60 hover:bg-primary/[0.04] focus-visible:border-primary/60",
            "data-[dragover=true]:border-primary data-[dragover=true]:bg-primary/[0.08]",
          )}
        >
          <span className="flex size-16 items-center justify-center rounded-2xl border border-border bg-secondary text-muted-foreground transition-colors group-hover:text-primary group-data-[dragover=true]:text-primary [&_svg]:size-7">
            {isLoading ? (
              <FileArchive aria-hidden className="animate-pulse" />
            ) : (
              <UploadCloud aria-hidden />
            )}
          </span>
          <div className="space-y-1">
            <p className="text-base font-semibold text-foreground">
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
                buttonVariants({ variant: "secondary", size: "sm" }),
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

        <p className="mt-5 inline-flex items-center gap-1.5 text-muted-foreground">
          <ShieldCheck className="size-3.5 text-primary" aria-hidden />
          Processed locally in your browser — never uploaded.
        </p>
      </main>
    </div>
  );
}
