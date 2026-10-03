import React from "react";
import { ArrowLeft, ArrowRight, Check, ChevronRight, Lightbulb, Pencil } from "lucide-react";
import { parseTranscriptDocument, serializeTestCase } from "@jittle-lamp/shared";
import { TestCaseEditor, emptyEditorDoc, isMacPlatform, serializeEditorDoc, type EditorDoc, type TestCaseEditorMode } from "@jittle-lamp/ui";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Kbd } from "../components/ui/kbd";
import { cn } from "../lib/cn";
import { useToast } from "../toast";
import { CaseDetailsForm } from "./case-details-form";
import { SimilarHint, useEditorCatalog } from "./editor-support";
import { useCreateTestCase } from "./queries";

// New case (`c`) in two steps: the details (what the case proves and where it runs), then the
// instructions on their own page. Pasting a multi-case document in Text view offers to split it
// into one case per `# title`.

type Step = "details" | "steps";

const STEPS: readonly { id: Step; label: string }[] = [
  { id: "details", label: "Details" },
  { id: "steps", label: "Instructions" }
];

const writingTips = ["One intent per step", "Act first, then Assert what should be true", "Name what you see on screen, not selectors"];

export function QuickCreateDialog(props: { onClose: () => void; onCreated: (ids: string[]) => void }): React.JSX.Element {
  const toast = useToast();
  const catalog = useEditorCatalog();
  const create = useCreateTestCase();
  const [doc, setDoc] = React.useState<EditorDoc>(() => emptyEditorDoc());
  const [step, setStep] = React.useState<Step>("details");
  const [mode, setMode] = React.useState<TestCaseEditorMode>("steps");
  const [showMore, setShowMore] = React.useState(false);
  const [titleTouched, setTitleTouched] = React.useState(false);
  const [split, setSplit] = React.useState<{ document: string; cases: number } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const environment = catalog.environmentFor(doc, null);
  const hasTitle = doc.title.trim().length > 0;

  const createOne = async (transcript: string, environmentId: string | null) =>
    create.mutateAsync({ transcript, status: "active", ...(environmentId ? { environmentId } : {}) });

  const next = () => {
    setTitleTouched(true);
    if (hasTitle) setStep("steps");
  };

  const submit = async () => {
    if (busy) return;
    if (!hasTitle) {
      setTitleTouched(true);
      setStep("details");
      return;
    }
    setBusy(true);
    try {
      const created = await createOne(serializeEditorDoc(doc), environment?.id ?? null);
      toast.success(`Created ${created.key}`, created.title);
      props.onCreated([created.id]);
    } catch (error) {
      toast.error("Create failed", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const createSplit = async () => {
    if (!split || busy) return;
    setBusy(true);
    const ids: string[] = [];
    try {
      for (const testCase of parseTranscriptDocument(split.document).cases) {
        const env = testCase.metadata.env ? catalog.environments.find((candidate) => candidate.name === testCase.metadata.env) : undefined;
        ids.push((await createOne(serializeTestCase(testCase), env?.id ?? null)).id);
      }
      toast.success(`Created ${ids.length} cases`);
      props.onCreated(ids);
    } catch (error) {
      toast.error(`Created ${ids.length} of ${split.cases}`, error instanceof Error ? error.message : undefined);
      if (ids.length > 0) props.onCreated(ids);
    } finally {
      setBusy(false);
    }
  };

  const extras = [doc.metadata.links.length > 0, doc.metadata.params.length > 0, doc.dataset !== null].filter(Boolean).length;

  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogContent size={step === "details" ? "lg" : "xl"} className="jl-tc-scope transition-[max-width] duration-200">
        <DialogHeader className="gap-3">
          <Stepper current={step} onSelect={(target) => (target === "steps" ? next() : setStep(target))} />
          <div className="space-y-1">
            <DialogTitle>{step === "details" ? "New test case" : "Write the instructions"}</DialogTitle>
            <DialogDescription>
              {step === "details" ? "Say what the case proves and where it runs. Steps come next." : "The agent follows these steps like a user and checks every Assert."}
            </DialogDescription>
          </div>
        </DialogHeader>

        <DialogBody
          // The instructions page keeps a steady height while rows are added.
          className={cn("gap-5 pt-2", step === "steps" && "min-h-[min(520px,62vh)]")}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
              event.preventDefault();
              void submit();
            }
          }}
        >
          {step === "details" ? (
            <>
              <CaseDetailsForm
                layout="stacked"
                fields={["title", "environment", "tags", "description"]}
                doc={doc}
                onChange={setDoc}
                environments={catalog.environments}
                tagSuggestions={catalog.tagSuggestions}
                autoFocusTitle
                titleError={titleTouched && !hasTitle ? "Add a title: it says what the case proves." : undefined}
                titleAccessory={<SimilarHint title={doc.title} />}
                onTitleEnter={next}
              />
              <div className="rounded-lg border border-border">
                <button
                  type="button"
                  aria-expanded={showMore}
                  onClick={() => setShowMore((value) => !value)}
                  className="flex h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-medium text-foreground transition-colors hover:bg-accent/60"
                >
                  <ChevronRight aria-hidden className={cn("size-4 text-muted-foreground transition-transform duration-150", showMore && "rotate-90")} />
                  Links, params and dataset
                  <span className="font-normal text-muted-foreground">{extras > 0 ? `${extras} set` : "Optional"}</span>
                </button>
                {showMore ? (
                  <div className="border-t border-border p-4">
                    <CaseDetailsForm
                      layout="stacked"
                      fields={["links", "params", "dataset"]}
                      doc={doc}
                      onChange={setDoc}
                      environments={catalog.environments}
                    />
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{doc.title}</p>
                  <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span>{environment ? `Runs on ${environment.name}` : "No default environment"}</span>
                    {doc.metadata.tags.slice(0, 4).map((tag) => (
                      <Badge key={tag} variant="outline" className="font-normal">
                        {tag}
                      </Badge>
                    ))}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setStep("details")}>
                  <Pencil aria-hidden />
                  Edit details
                </Button>
              </div>

              <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Writing tips">
                <Lightbulb aria-hidden className="size-3.5 text-warning" />
                {writingTips.map((tip) => (
                  <li key={tip} className="flex items-center gap-1.5">
                    <Check aria-hidden className="size-3 text-primary" />
                    {tip}
                  </li>
                ))}
              </ul>

              {split ? (
                <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm">
                  <span className="mr-auto">The pasted document holds {split.cases} cases.</span>
                  <Button size="sm" variant="ghost" onClick={() => setSplit(null)} disabled={busy}>
                    Dismiss
                  </Button>
                  <Button size="sm" onClick={() => void createSplit()} disabled={busy}>
                    Split into {split.cases} cases
                  </Button>
                </div>
              ) : null}

              <TestCaseEditor
                doc={doc}
                onChange={setDoc}
                mode={mode}
                onModeChange={setMode}
                autoFocus
                macros={catalog.macros}
                macrosLoaded={catalog.macrosLoaded}
                credentials={catalog.credentials}
                environmentVariables={environment ? Object.keys(environment.variables) : []}
                environmentName={environment?.name ?? null}
                onMultiCasePaste={(document, cases) => setSplit({ document, cases })}
              />
            </>
          )}
        </DialogBody>

        <DialogFooter className="items-center sm:justify-between">
          {step === "details" ? (
            <>
              <span className="hidden text-xs text-muted-foreground sm:inline">
                <Kbd>↵</Kbd> in the title goes to the next step
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={props.onClose}>
                  Cancel
                </Button>
                <Button size="sm" onClick={next}>
                  Next: instructions
                  <ArrowRight aria-hidden />
                </Button>
              </div>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => setStep("details")} disabled={busy}>
                <ArrowLeft aria-hidden />
                Back
              </Button>
              <Button size="sm" onClick={() => void submit()} disabled={busy}>
                {busy ? "Creating…" : "Create case"}
                <Kbd className="border-primary-foreground/20 bg-primary-foreground/15 text-primary-foreground">{isMacPlatform() ? "⌘S" : "Ctrl+S"}</Kbd>
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stepper(props: { current: Step; onSelect: (step: Step) => void }): React.JSX.Element {
  const currentIndex = STEPS.findIndex((item) => item.id === props.current);
  return (
    <ol className="flex items-center gap-2 text-xs" aria-label="Progress">
      {STEPS.map((item, index) => {
        const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming";
        return (
          <li key={item.id} className="flex items-center gap-2">
            {index > 0 ? <span aria-hidden className="h-px w-6 bg-border" /> : null}
            <button
              type="button"
              aria-current={state === "current" ? "step" : undefined}
              onClick={() => props.onSelect(item.id)}
              className={cn(
                "flex items-center gap-1.5 rounded-md py-0.5 pr-1.5 font-medium transition-colors",
                state === "current" ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <span
                className={cn(
                  "grid size-5 place-items-center rounded-full border text-xs tabular-nums",
                  state === "current" && "border-primary bg-primary text-primary-foreground",
                  state === "done" && "border-primary/40 bg-primary/10 text-brand-300",
                  state === "upcoming" && "border-border text-muted-foreground"
                )}
              >
                {state === "done" ? <Check className="size-3" aria-hidden /> : index + 1}
              </span>
              {item.label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
