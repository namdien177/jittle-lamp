import React from "react";
import { serializeTestCase } from "@jittle-lamp/shared";

import { textModeUpdate, testCaseFromDoc } from "./model";
import { StepEditor, type StepEditorProps } from "./step-editor";
import { injectStepEditorStyles } from "./styles";

// Test case editor = structured steps + Text toggle. Both views are projections of the same
// EditorDoc, so switching is lossless (design.md §7 "Structured step editor"). The host renders the
// case details (title, tags, environment, …) with its own form components.

export type TestCaseEditorMode = "steps" | "text";

export type TestCaseEditorProps = StepEditorProps & {
  mode: TestCaseEditorMode;
  onModeChange: (mode: TestCaseEditorMode) => void;
  // Rendered at the right of the Steps/Text switch, e.g. version history and Save.
  toolbar?: React.ReactNode;
};

export function TestCaseEditor(props: TestCaseEditorProps): React.JSX.Element {
  injectStepEditorStyles();
  const { mode, onModeChange, doc, onChange } = props;
  const [text, setText] = React.useState(() => serializeTestCase(testCaseFromDoc(doc)));
  const lastSyncedDoc = React.useRef(doc);
  const [extraCases, setExtraCases] = React.useState(0);
  const notifiedCases = React.useRef(0);
  const onMultiCasePaste = props.onMultiCasePaste;

  // Tell the host once the typing settles, not on every keystroke.
  React.useEffect(() => {
    if (extraCases < 2) {
      notifiedCases.current = 0;
      return;
    }
    const timer = window.setTimeout(() => {
      if (notifiedCases.current === extraCases) return;
      notifiedCases.current = extraCases;
      onMultiCasePaste?.(text, extraCases);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [extraCases, text, onMultiCasePaste]);

  // Entering Text mode shows the current document; leaving it parses the text back.
  const switchMode = (next: TestCaseEditorMode) => {
    if (next === mode) return;
    if (next === "steps" && extraCases > 1) return;
    if (next === "text") {
      setText(serializeTestCase(testCaseFromDoc(doc)));
      lastSyncedDoc.current = doc;
    }
    onModeChange(next);
  };

  React.useEffect(() => {
    // An external doc change while in text mode (reload, fix) refreshes the text.
    if (mode === "text" && doc !== lastSyncedDoc.current) {
      setText(serializeTestCase(testCaseFromDoc(doc)));
      lastSyncedDoc.current = doc;
    }
  }, [doc, mode]);

  return (
    <div className="jl-se-workbench">
      <div className="jl-se-toolbar">
        <div role="tablist" aria-label="Editor view" className="jl-se-modes">
          {(["steps", "text"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              className="jl-se-mode"
              onClick={() => switchMode(value)}
              disabled={value === "steps" && mode === "text" && extraCases > 1}
            >
              {value === "steps" ? "Steps" : "Text"}
            </button>
          ))}
        </div>
        {props.toolbar}
      </div>
      {mode === "steps" ? (
        <StepEditor {...props} />
      ) : (
        <textarea
          className="jl-se-text"
          aria-label="Transcript document"
          spellCheck={false}
          value={text}
          readOnly={props.readOnly}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setText(value);
            const update = textModeUpdate(value, doc);
            setExtraCases(update.cases > 1 ? update.cases : 0);
            // While the text holds several cases the doc keeps its last single-case state.
            if (update.doc === null) return;
            lastSyncedDoc.current = update.doc;
            onChange(update.doc);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && props.onRun) {
              event.preventDefault();
              props.onRun();
            }
          }}
        />
      )}
      {mode === "text" && extraCases > 1 ? (
        <p role="status" className="jl-se-notice">
          This text holds {extraCases} cases (# headings). One case fits here: remove the extra headings to keep editing, or use New case to split the
          document. Until then the steps view keeps the last single-case version.
        </p>
      ) : null}
    </div>
  );
}
