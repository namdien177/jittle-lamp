import React from "react";
import { parseTranscriptDocument, serializeTestCase } from "@jittle-lamp/shared";
import { TestCaseEditor, emptyEditorDoc, serializeEditorDoc, type EditorDoc, type TestCaseEditorMode } from "@jittle-lamp/ui";

import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { useToast } from "../toast";
import { SimilarHint, useEditorCatalog } from "./editor-support";
import { useCreateTestCase } from "./queries";

// Quick create (`c`): title + the same structured editor. Pasting a multi-case document offers
// to split it into one case per `# title`.
export function QuickCreateDialog(props: { onClose: () => void; onCreated: (ids: string[]) => void }): React.JSX.Element {
  const toast = useToast();
  const catalog = useEditorCatalog();
  const create = useCreateTestCase();
  const [doc, setDoc] = React.useState<EditorDoc>(() => emptyEditorDoc());
  const [mode, setMode] = React.useState<TestCaseEditorMode>("steps");
  const [split, setSplit] = React.useState<{ document: string; cases: number } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const environment = catalog.environmentFor(doc, null);

  const createOne = async (transcript: string, environmentId: string | null) =>
    create.mutateAsync({ transcript, status: "active", ...(environmentId ? { environmentId } : {}) });

  const submit = async () => {
    if (busy) return;
    const transcript = serializeEditorDoc(doc);
    if (doc.title.trim().length === 0) {
      toast.error("Add a title", "The title says what the case proves.");
      return;
    }
    setBusy(true);
    try {
      const created = await createOne(transcript, environment?.id ?? null);
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

  return (
    <Dialog
      open
      onClose={props.onClose}
      size="xl"
      closeOnOverlay={false}
      title="New test case"
      description="One intent per step, actions separate from asserts, visible labels instead of selectors."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" className="jl-tc-press" onClick={() => void submit()} disabled={busy}>
            {busy ? "Creating…" : "Create case"}
          </Button>
        </>
      }
    >
      {split ? (
        <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/8 px-3 py-2 text-[13px]">
          <span className="mr-auto">The pasted document holds {split.cases} cases.</span>
          <Button size="xs" variant="ghost" onClick={() => setSplit(null)} disabled={busy}>
            Dismiss
          </Button>
          <Button size="xs" className="jl-tc-press" onClick={() => void createSplit()} disabled={busy}>
            Split into {split.cases} cases
          </Button>
        </div>
      ) : null}
      <div
        className="jl-tc-scope"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            void submit();
          }
        }}
      >
        <TestCaseEditor
          doc={doc}
          onChange={setDoc}
          mode={mode}
          onModeChange={setMode}
          macros={catalog.macros}
          macrosLoaded={catalog.macrosLoaded}
          credentials={catalog.credentials}
          environments={catalog.environments}
          environmentVariables={environment ? Object.keys(environment.variables) : []}
          environmentName={environment?.name ?? null}
          tagSuggestions={catalog.tagSuggestions}
          titleAccessory={<SimilarHint title={doc.title} />}
          onMultiCasePaste={(document, cases) => setSplit({ document, cases })}
        />
      </div>
    </Dialog>
  );
}
