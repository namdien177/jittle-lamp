import React, { useEffect, useMemo, useRef, useState } from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { useNavigate } from "react-router";
import { Check, CornerDownLeft, Pencil, Search, Video, X } from "lucide-react";

import { cn } from "../../lib/cn";
import type { ApiEvidenceSummary } from "../../api";
import { useEvidences, useRenameEvidence } from "../../queries";
import { useToast } from "../../toast";
import { formatRelativeTime } from "../../utils";
import { Spinner } from "../ui/misc";

const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

export function EvidenceSearch(): React.JSX.Element {
  const [open, setOpen] = useState(false);

  // Global ⌘K / Ctrl+K toggle.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search evidence"
        className="inline-flex h-10 items-center gap-2 rounded-md border border-border-strong bg-secondary px-3 text-base text-muted-foreground outline-none transition-colors hover:border-white/20 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 sm:w-64 sm:justify-between"
      >
        <span className="inline-flex items-center gap-2">
          <Search aria-hidden className="size-4" />
          <span className="hidden sm:inline">Search evidence…</span>
        </span>
        <kbd className="hidden items-center gap-0.5 rounded border border-border-strong bg-background px-1.5 py-0.5 font-mono text-sm text-muted-foreground sm:inline-flex">
          {isMac ? "⌘" : "Ctrl"}K
        </kbd>
      </button>
      {open ? <SearchPalette onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function SearchPalette({ onClose }: { onClose: () => void }): React.JSX.Element {
  const navigate = useNavigate();
  const toast = useToast();
  const evidencesQuery = useEvidences({ limit: 100 });
  const renameEvidence = useRenameEvidence();

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  const all = evidencesQuery.data?.evidences ?? [];
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? all.filter((e) => [e.title, e.sourceType, e.id].some((f) => f.toLowerCase().includes(q)))
      : all;
    return [...list].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
  }, [all, query]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  const openEvidence = (evidence: ApiEvidenceSummary): void => {
    navigate(`/evidence/${encodeURIComponent(evidence.id)}`);
    onClose();
  };

  const startRename = (evidence: ApiEvidenceSummary): void => {
    setEditingId(evidence.id);
    setEditValue(evidence.title);
  };

  const commitRename = (evidence: ApiEvidenceSummary): void => {
    const title = editValue.trim();
    setEditingId(null);
    if (!title || title === evidence.title) return;
    renameEvidence.mutate(
      { evidenceId: evidence.id, title },
      {
        onSuccess: () => toast.success("Evidence renamed", title),
        onError: (error) =>
          toast.error("Rename failed", error instanceof Error ? error.message : undefined)
      }
    );
  };

  const onInputKeyDown = (event: React.KeyboardEvent): void => {
    if (editingId) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((prev) => Math.min(prev + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((prev) => Math.max(prev - 1, 0));
    } else if (event.key === "Enter") {
      const target = results[selected];
      if (target) {
        event.preventDefault();
        openEvidence(target);
      }
    }
  };

  return (
    <BaseDialog.Root open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-[900] bg-black/65 backdrop-blur-sm transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <BaseDialog.Viewport className="fixed inset-0 z-[901] flex items-start justify-center overflow-y-auto p-4 pt-[12vh] [pointer-events:none]">
          <BaseDialog.Popup className="pointer-events-auto flex w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border-strong bg-popover text-popover-foreground shadow-pop transition-[opacity,transform] duration-150 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0">
            <BaseDialog.Title className="sr-only">Search evidence</BaseDialog.Title>
            <div className="flex items-center gap-2.5 border-b border-border px-4">
              <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={onInputKeyDown}
                placeholder="Search evidence by name, type, or id…"
                className="h-12 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground/70"
                aria-label="Search evidence"
              />
              <button
                type="button"
                onClick={onClose}
                aria-label="Close search"
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>

            <div ref={listRef} className="jl-scroll max-h-[min(24rem,55vh)] overflow-y-auto p-1.5">
              {evidencesQuery.isPending ? (
                <p className="px-3 py-8 text-center text-base text-muted-foreground">Loading evidence…</p>
              ) : results.length === 0 ? (
                <p className="px-3 py-8 text-center text-base text-muted-foreground">
                  {all.length === 0 ? "No evidence in this workspace yet." : "No matches found."}
                </p>
              ) : (
                results.map((evidence, index) => {
                  const editing = editingId === evidence.id;
                  const active = index === selected;
                  return (
                    <div
                      key={evidence.id}
                      onMouseEnter={() => setSelected(index)}
                      className={cn(
                        "group flex items-center gap-3 rounded-md px-2.5 py-2",
                        active && !editing ? "bg-white/[0.06]" : ""
                      )}
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-secondary text-primary">
                        <Video className="size-4" aria-hidden />
                      </span>
                      {editing ? (
                        <input
                          autoFocus
                          value={editValue}
                          onChange={(e) => setEditValue(e.currentTarget.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitRename(evidence);
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              setEditingId(null);
                            }
                          }}
                          onBlur={() => commitRename(evidence)}
                          className="h-7 flex-1 rounded border border-ring/70 bg-black/30 px-2 text-base text-foreground outline-none ring-2 ring-ring/30"
                          aria-label="Rename evidence"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => openEvidence(evidence)}
                          className="flex min-w-0 flex-1 flex-col items-start text-left"
                        >
                          <span className="w-full truncate text-base font-medium text-foreground">
                            {evidence.title}
                          </span>
                          <span className="w-full truncate font-mono text-sm text-muted-foreground">
                            {evidence.sourceType} · {evidence.id.slice(0, 16)}… ·{" "}
                            {formatRelativeTime(evidence.updatedAt)}
                          </span>
                        </button>
                      )}
                      {editing ? (
                        <span className="inline-flex size-7 items-center justify-center text-primary">
                          {renameEvidence.isPending ? <Spinner /> : <Check className="size-4" aria-hidden />}
                        </span>
                      ) : (
                        <button
                          type="button"
                          aria-label={`Rename ${evidence.title}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            startRename(evidence);
                          }}
                          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-white/[0.08] hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                        >
                          <Pencil className="size-3.5" aria-hidden />
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <CornerDownLeft className="size-3" aria-hidden /> open
              </span>
              <span className="inline-flex items-center gap-1">
                <Pencil className="size-3" aria-hidden /> rename
              </span>
              <span className="ml-auto">esc to close</span>
            </div>
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
