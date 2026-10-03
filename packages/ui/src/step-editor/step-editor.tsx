import React from "react";
import {
  expandMacros,
  lintTestCase,
  type ExpandedStep,
  type LintFinding,
  type MacroDefinition,
  type MacroParam
} from "@jittle-lamp/shared";

import { editorCommandAllowed, editorKeyCommand, isMacPlatform, type EditorCommand } from "./keyboard";
import {
  applyFixToDoc,
  applyTypePick,
  argsFromParamValues,
  convertRowToHeading,
  credentialOptions,
  credentialReference,
  cycleRowType,
  declareParam,
  describeLintFix,
  detectTrigger,
  duplicateRow,
  extractedNamesBefore,
  formatStepChip,
  insertElementName,
  insertReference,
  insertRowAfter,
  isApplicableFix,
  isBlankRow,
  lintByRow,
  mapRowsToSteps,
  moveRow,
  moveRowTo,
  paramValuesFromArgs,
  pasteIntoRow,
  phrasingTemplates,
  removeRow,
  rowStepType,
  setRowArgs,
  setRowTag,
  setRowText,
  suggestElementNames,
  testCaseFromDoc,
  tokenizeInstruction,
  toggleRowDisabled,
  typeOptions,
  variableOptions,
  withBuiltinMacros,
  type CredentialOption,
  type EditorCredential,
  type EditorDoc,
  type EditorCase,
  type EditorMacro,
  type EditorRow,
  type EditorTrigger,
  type HeadingRow,
  type StepRow,
  type TypeOption,
  type VariableOption
} from "./model";
import { injectStepEditorStyles } from "./styles";

export type StepEditorRowStatus = {
  cache: "active" | "stale" | "invalid" | null;
  cacheDetail?: string | null;
  lastOutcome: "passed" | "failed" | "blocked" | "skipped" | null;
  lastMode?: string | null;
};

export type StepEditorProps = {
  doc: EditorDoc;
  onChange: (doc: EditorDoc) => void;
  macros?: readonly EditorMacro[];
  // False until the org macro catalog has loaded; unknown-macro lint waits for it.
  macrosLoaded?: boolean;
  // Cases a [Use: KEY] row can name; with casesLoaded, an unknown key is a lint error.
  cases?: readonly EditorCase[];
  casesLoaded?: boolean;
  // Key of the case being edited: not offered to [Use] and linted as self-use.
  caseKey?: string | null;
  credentials?: readonly EditorCredential[];
  environmentVariables?: readonly string[];
  environmentName?: string | null;
  elementNames?: readonly string[];
  stepStatus?: Readonly<Record<string, StepEditorRowStatus>>;
  readOnly?: boolean;
  onRun?: () => void;
  onRunFromStep?: (stepId: string) => void;
  // A pasted document with several `# title` cases; the host offers "split into N cases".
  onMultiCasePaste?: (document: string, cases: number) => void;
  ariaLabel?: string;
  autoFocus?: boolean;
};

type PickerState =
  | { kind: "type"; rowId: string; trigger: EditorTrigger | null; index: number; viaKeyboard: boolean; form: { option: TypeOption; values: Record<string, string> } | null }
  | { kind: "variable"; rowId: string; trigger: EditorTrigger; index: number; viaKeyboard: boolean }
  | { kind: "credential"; rowId: string; trigger: EditorTrigger; index: number; viaKeyboard: boolean };

type DropState = { rowId: string; position: "before" | "after" } | null;

const severityRank: Record<LintFinding["severity"], number> = { error: 3, warning: 2, info: 1 };

function macroDefinitions(macros: readonly EditorMacro[]): MacroDefinition[] {
  return macros
    .filter((macro) => typeof macro.transcript === "string")
    .map((macro) => ({ name: macro.name, params: macro.params, transcript: macro.transcript ?? "", version: macro.version ?? 1, status: "active" as const }));
}

export function StepEditor(props: StepEditorProps): React.JSX.Element {
  injectStepEditorStyles();
  const { doc, onChange } = props;
  const macros = props.macros ?? [];
  const caseKey = props.caseKey ?? null;
  const cases = React.useMemo(
    () => (props.cases ?? []).filter((linked) => linked.key.toLowerCase() !== caseKey?.toLowerCase()),
    [props.cases, caseKey]
  );
  const credentials = props.credentials ?? [];
  const environmentVariables = props.environmentVariables ?? [];
  const elementNames = props.elementNames ?? [];
  const readOnly = props.readOnly ?? false;
  const isMac = React.useMemo(isMacPlatform, []);
  const mod = isMac ? "⌘" : "Ctrl";

  const [focusedRowId, setFocusedRowId] = React.useState<string | null>(null);
  // Roving tabindex: only the last focused row (or the first row) is in the tab order; ↑/↓ move
  // between rows, so Tab leaves the editor instead of walking every row.
  const [activeRowId, setActiveRowId] = React.useState<string | null>(null);
  const [pendingFocus, setPendingFocus] = React.useState<{ rowId: string; caret: number | "end" } | null>(null);
  const [picker, setPicker] = React.useState<PickerState | null>(null);
  const [dragRowId, setDragRowId] = React.useState<string | null>(null);
  const [drop, setDrop] = React.useState<DropState>(null);
  const inputRefs = React.useRef(new Map<string, HTMLInputElement>());
  const chipRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const listId = React.useId();

  const parsed = React.useMemo(() => testCaseFromDoc(doc), [doc]);
  // The runner ships a built-in Login macro (packages/e2e-runner/macros); an org macro of that
  // name overrides it, so [Login: X] is never an unknown macro.
  const lintMacros = React.useMemo(() => withBuiltinMacros(macros), [macros]);
  const findings = React.useMemo(
    () =>
      lintTestCase(parsed, {
        ...(props.macrosLoaded ? { macros: lintMacros } : {}),
        ...(props.casesLoaded ? { cases } : {}),
        ...(caseKey ? { caseKey } : {}),
        ...(props.environmentVariables ? { environmentVariables } : {}),
        elementNames
      }),
    [parsed, props.macrosLoaded, lintMacros, props.casesLoaded, cases, caseKey, props.environmentVariables, environmentVariables, elementNames]
  );
  const rowSteps = React.useMemo(() => mapRowsToSteps(doc, parsed).steps, [doc, parsed]);
  const lint = React.useMemo(() => lintByRow(doc, parsed, findings), [doc, parsed, findings]);
  const expansion = React.useMemo(() => {
    const definitions = macroDefinitions(macros);
    if (definitions.length === 0) return new Map<string, ExpandedStep[]>();
    const expanded = expandMacros(parsed.steps, definitions).steps;
    const byParent = new Map<string, ExpandedStep[]>();
    for (const step of expanded) {
      if (step.parentStepId === null || step.depth !== 1) continue;
      byParent.set(step.parentStepId, [...(byParent.get(step.parentStepId) ?? []), step]);
    }
    return byParent;
  }, [parsed, macros]);

  React.useLayoutEffect(() => {
    if (!pendingFocus) return;
    const input = inputRefs.current.get(pendingFocus.rowId);
    if (!input) return;
    input.focus();
    const caret = pendingFocus.caret === "end" ? input.value.length : pendingFocus.caret;
    input.setSelectionRange(caret, caret);
    setPendingFocus(null);
  }, [pendingFocus, doc]);

  React.useEffect(() => {
    if (!props.autoFocus) return;
    const first = doc.rows[0];
    if (first) setPendingFocus({ rowId: first.rowId, caret: "end" });
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Every edit goes through here or `change`; read-only editors never call onChange.
  const change = (next: EditorDoc) => {
    if (!readOnly) onChange(next);
  };
  const commit = (next: EditorDoc, focus?: { rowId: string | null; caret?: number | "end" }) => {
    if (readOnly) {
      if (focus?.rowId) setPendingFocus({ rowId: focus.rowId, caret: focus.caret ?? "end" });
      return;
    }
    onChange(next);
    if (focus?.rowId) setPendingFocus({ rowId: focus.rowId, caret: focus.caret ?? "end" });
  };

  // ------------------------------------------------------------------------------------------
  // Picker options
  // ------------------------------------------------------------------------------------------

  const pickerRow = picker ? doc.rows.find((row) => row.rowId === picker.rowId) : undefined;
  const typeChoices: TypeOption[] = picker?.kind === "type" ? typeOptions(picker.trigger?.query ?? "", macros, cases) : [];
  const variableChoices: VariableOption[] =
    picker?.kind === "variable"
      ? variableOptions(picker.trigger.query, {
          environmentVariables,
          environmentName: props.environmentName ?? null,
          params: doc.metadata.params,
          datasetColumns: doc.dataset?.columns ?? [],
          extracted: extractedNamesBefore(doc, picker.rowId)
        })
      : [];
  const credentialChoices: CredentialOption[] =
    picker?.kind === "credential" && pickerRow?.kind === "step"
      ? credentialOptions(picker.trigger.query, credentials, rowStepType(pickerRow) === "login")
      : [];
  const choiceCount =
    picker?.kind === "type" ? (picker.form ? 0 : typeChoices.length) : picker?.kind === "variable" ? variableChoices.length : credentialChoices.length;

  const openTypeForm = (row: StepRow, option: TypeOption, trigger: EditorTrigger | null, viaKeyboard: boolean) => {
    const values = option.tag.toLowerCase() === (row.tag ?? "").toLowerCase() ? paramValuesFromArgs(option.params, row.args) : {};
    setPicker({ kind: "type", rowId: row.rowId, trigger, index: 0, viaKeyboard, form: { option, values } });
  };

  const applyType = (row: StepRow, option: TypeOption, trigger: EditorTrigger | null, values: Record<string, string>) => {
    let next = setRowTag(doc, row.rowId, option.tag, option.args ?? argsFromParamValues(option.params, values));
    if (trigger) next = setRowText(next, row.rowId, applyTypePick(row.text, trigger));
    setPicker(null);
    commit(next, { rowId: row.rowId, caret: "end" });
  };

  const acceptPicker = (index: number) => {
    if (!picker || !pickerRow || pickerRow.kind !== "step") return;
    const row = pickerRow;
    if (picker.kind === "type") {
      if (picker.form) {
        applyType(row, picker.form.option, picker.trigger, picker.form.values);
        return;
      }
      const option = typeChoices[index];
      if (!option) return;
      if (option.params.length > 0) {
        openTypeForm(row, option, picker.trigger, picker.viaKeyboard);
        return;
      }
      applyType(row, option, picker.trigger, {});
      return;
    }
    if (picker.kind === "variable") {
      const option = variableChoices[index];
      if (!option) return;
      const inserted = insertReference(row.text, picker.trigger, `{${option.name}}`);
      let next = setRowText(doc, row.rowId, inserted.text);
      if (option.source === "declare") next = declareParam(next, option.name);
      setPicker(null);
      commit(next, { rowId: row.rowId, caret: inserted.caret });
      return;
    }
    const option = credentialChoices[index];
    if (!option) return;
    if (option.field === null) {
      let next = setRowArgs(doc, row.rowId, [{ name: null, value: option.profile }]);
      next = setRowText(next, row.rowId, applyTypePick(row.text, picker.trigger));
      setPicker(null);
      commit(next, { rowId: row.rowId, caret: "end" });
      return;
    }
    const inserted = insertReference(row.text, picker.trigger, credentialReference(option));
    setPicker(null);
    commit(setRowText(doc, row.rowId, inserted.text), { rowId: row.rowId, caret: inserted.caret });
  };

  // ------------------------------------------------------------------------------------------
  // Commands
  // ------------------------------------------------------------------------------------------

  const runCommand = (command: EditorCommand, row: EditorRow, event: React.KeyboardEvent): boolean => {
    const index = doc.rows.findIndex((candidate) => candidate.rowId === row.rowId);
    if (!editorCommandAllowed(command, readOnly)) return false;
    switch (command) {
      case "picker-next":
        setPicker((current) => (current ? { ...current, index: Math.min(choiceCount - 1, current.index + 1), viaKeyboard: true } : current));
        return true;
      case "picker-prev":
        setPicker((current) => (current ? { ...current, index: Math.max(0, current.index - 1), viaKeyboard: true } : current));
        return true;
      case "picker-accept":
        acceptPicker(picker?.index ?? 0);
        return true;
      case "picker-close":
        setPicker(null);
        return true;
      case "type-next":
      case "type-prev":
        if (row.kind !== "step") return false;
        change(cycleRowType(doc, row.rowId, command === "type-next" ? 1 : -1));
        return true;
      case "run":
        props.onRun?.();
        return Boolean(props.onRun);
      case "run-from-here": {
        const step = rowSteps.get(row.rowId);
        if (!step || !props.onRunFromStep) return false;
        props.onRunFromStep(step.stepId);
        return true;
      }
      case "duplicate-row": {
        const result = duplicateRow(doc, row.rowId);
        commit(result.doc, { rowId: result.focusRowId });
        return true;
      }
      case "move-up":
      case "move-down": {
        const result = moveRow(doc, row.rowId, command === "move-up" ? -1 : 1);
        commit(result.doc, { rowId: result.focusRowId, caret: (event.target as HTMLInputElement).selectionStart ?? "end" });
        return true;
      }
      case "toggle-disabled":
        change(toggleRowDisabled(doc, row.rowId));
        return true;
      case "new-row": {
        const result = insertRowAfter(doc, row.rowId);
        commit(result.doc, { rowId: result.focusRowId });
        return true;
      }
      case "delete-row": {
        if (doc.rows.length <= 1) return false;
        const result = removeRow(doc, row.rowId);
        commit(result.doc, { rowId: result.focusRowId });
        return true;
      }
      case "focus-prev": {
        const previous = doc.rows[index - 1];
        if (!previous) return false;
        setPendingFocus({ rowId: previous.rowId, caret: "end" });
        return true;
      }
      case "focus-next": {
        const nextRow = doc.rows[index + 1];
        if (!nextRow) return false;
        setPendingFocus({ rowId: nextRow.rowId, caret: "end" });
        return true;
      }
    }
  };

  const onFieldKeyDown = (row: EditorRow, event: React.KeyboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const command = editorKeyCommand(event.nativeEvent, {
      target: row.kind === "heading" ? "heading" : "field",
      pickerOpen: picker !== null && picker.rowId === row.rowId && (picker.kind !== "type" || picker.form === null),
      fieldEmpty: input.value.length === 0,
      caretAtStart: input.selectionStart === 0 && input.selectionEnd === 0,
      caretAtEnd: input.selectionStart === input.value.length,
      isMac
    });
    if (command && runCommand(command, row, event)) event.preventDefault();
  };

  const onChipKeyDown = (row: StepRow, event: React.KeyboardEvent<HTMLButtonElement>) => {
    const command = editorKeyCommand(event.nativeEvent, { target: "chip", pickerOpen: false, fieldEmpty: false, caretAtStart: false, caretAtEnd: false, isMac });
    if (command === "type-next" || command === "type-prev" || command === "duplicate-row" || command === "move-up" || command === "move-down" || command === "toggle-disabled" || command === "run") {
      if (runCommand(command, row, event)) event.preventDefault();
    }
  };

  const onFieldChange = (row: EditorRow, event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.value;
    const caret = event.currentTarget.selectionStart ?? value.length;
    if (row.kind === "step" && row.text.length === 0 && (value === "#" || value === "# ")) {
      const result = convertRowToHeading(doc, row.rowId);
      setPicker(null);
      commit(result.doc, { rowId: result.focusRowId });
      return;
    }
    change(setRowText(doc, row.rowId, value));
    if (row.kind !== "step") return;
    const trigger = detectTrigger(value, caret);
    if (!trigger) {
      if (picker?.rowId === row.rowId && !(picker.kind === "type" && picker.form)) setPicker(null);
      return;
    }
    const viaKeyboard = true;
    if (trigger.kind === "type") setPicker({ kind: "type", rowId: row.rowId, trigger, index: 0, viaKeyboard, form: null });
    else setPicker({ kind: trigger.kind, rowId: row.rowId, trigger, index: 0, viaKeyboard });
  };

  const onFieldPaste = (row: EditorRow, event: React.ClipboardEvent<HTMLInputElement>) => {
    if (readOnly) return;
    const text = event.clipboardData.getData("text/plain");
    const result = pasteIntoRow(doc, row.rowId, text);
    if (result.kind === "none") return;
    event.preventDefault();
    if (result.kind === "multi-case") {
      props.onMultiCasePaste?.(result.document, result.cases);
      return;
    }
    commit(result.doc, { rowId: result.focusRowId });
  };

  // ------------------------------------------------------------------------------------------
  // Drag and drop
  // ------------------------------------------------------------------------------------------

  const onDragOver = (row: EditorRow, event: React.DragEvent<HTMLDivElement>) => {
    if (dragRowId === null || readOnly) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const position = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    setDrop((current) => (current?.rowId === row.rowId && current.position === position ? current : { rowId: row.rowId, position }));
  };

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!readOnly && dragRowId !== null && drop !== null && drop.rowId !== dragRowId) {
      const without = doc.rows.filter((row) => row.rowId !== dragRowId);
      const target = without.findIndex((row) => row.rowId === drop.rowId);
      const result = moveRowTo(doc, dragRowId, drop.position === "before" ? target : target + 1);
      change(result.doc);
    }
    setDragRowId(null);
    setDrop(null);
  };

  // ------------------------------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------------------------------

  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  let ordinal = 0;

  const tabRowId = doc.rows.some((row) => row.rowId === activeRowId) ? activeRowId : (doc.rows[0]?.rowId ?? null);

  return (
    <div className="jl-se" role="grid" aria-label={props.ariaLabel ?? "Test steps"} aria-readonly={readOnly}>
      <div className="jl-se-summary" role="status">
        <span>
          {parsed.steps.length} step{parsed.steps.length === 1 ? "" : "s"} · {parsed.checkpoints.length} checkpoint
          {parsed.checkpoints.length === 1 ? "" : "s"}
        </span>
        {counts.error > 0 ? <span data-tone="error">{counts.error} error{counts.error === 1 ? "" : "s"}</span> : null}
        {counts.warning > 0 ? <span data-tone="warning">{counts.warning} warning{counts.warning === 1 ? "" : "s"}</span> : null}
        {lint.caseLevel.map((finding, index) => (
          <span key={`${finding.ruleId}-${index}`} data-tone={finding.severity}>
            {finding.message}
          </span>
        ))}
      </div>

      {doc.rows.map((row) => {
        const focused = focusedRowId === row.rowId;
        const rowFindings = lint.byRow.get(row.rowId) ?? [];
        const step = row.kind === "step" ? rowSteps.get(row.rowId) : undefined;
        if (row.kind === "step" && !isBlankRow(row)) ordinal += 1;
        const rowOrdinal = row.kind === "step" && !isBlankRow(row) ? ordinal : null;
        const pickerHere = picker?.rowId === row.rowId ? picker : null;
        const dropHere = drop?.rowId === row.rowId ? drop.position : undefined;
        return (
          <div
            key={row.rowId}
            role="row"
            className="jl-se-row"
            data-kind={row.kind}
            data-focused={focused ? "true" : "false"}
            data-disabled={row.kind === "step" && row.disabled ? "true" : "false"}
            {...(dropHere ? { "data-drop": dropHere } : {})}
            onDragOver={(event) => onDragOver(row, event)}
            onDrop={onDrop}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop((current) => (current?.rowId === row.rowId ? null : current));
            }}
          >
            <button
              type="button"
              className="jl-se-handle"
              draggable={!readOnly}
              aria-label={`Reorder ${row.kind === "heading" ? "checkpoint" : `step ${rowOrdinal ?? ""}`}. ${mod}⇧↑ or ${mod}⇧↓ to move`}
              tabIndex={-1}
              onDragStart={(event) => {
                setDragRowId(row.rowId);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", row.rowId);
              }}
              onDragEnd={() => {
                setDragRowId(null);
                setDrop(null);
              }}
            >
              ⋮⋮
            </button>
            {row.kind === "heading" ? (
              <HeadingRowView
                row={row}
                focused={focused}
                readOnly={readOnly}
                inputRef={(element) => {
                  if (element) inputRefs.current.set(row.rowId, element);
                  else inputRefs.current.delete(row.rowId);
                }}
                onFocus={() => {
                  setFocusedRowId(row.rowId);
                  setActiveRowId(row.rowId);
                }}
                tabbable={tabRowId === row.rowId}
                onBlur={() => setFocusedRowId((current) => (current === row.rowId ? null : current))}
                onChange={(event) => onFieldChange(row, event)}
                onKeyDown={(event) => onFieldKeyDown(row, event)}
                onRemove={() => commit(removeRow(doc, row.rowId).doc)}
              />
            ) : (
              <StepRowView
                row={row}
                ordinal={rowOrdinal}
                focused={focused}
                readOnly={readOnly}
                macros={macros}
                cases={cases}
                mod={mod}
                findings={rowFindings}
                status={step ? props.stepStatus?.[step.stepId] : undefined}
                expansion={step ? expansion.get(step.stepId) ?? [] : []}
                suggestions={focused && ["act", "assert", "wait"].includes(rowStepType(row)) ? suggestElementNames(row.text, elementNames) : []}
                listId={`${listId}-${row.rowId}`}
                pickerOpen={pickerHere !== null}
                inputRef={(element) => {
                  if (element) inputRefs.current.set(row.rowId, element);
                  else inputRefs.current.delete(row.rowId);
                }}
                chipRef={(element) => {
                  if (element) chipRefs.current.set(row.rowId, element);
                  else chipRefs.current.delete(row.rowId);
                }}
                onFocus={() => {
                  setFocusedRowId(row.rowId);
                  setActiveRowId(row.rowId);
                }}
                tabbable={tabRowId === row.rowId}
                onBlur={(event) => {
                  const related = event.relatedTarget as Node | null;
                  if (related && event.currentTarget.closest(".jl-se-row")?.contains(related)) return;
                  setFocusedRowId((current) => (current === row.rowId ? null : current));
                  setPicker((current) => (current?.rowId === row.rowId && !(current.kind === "type" && current.form) ? null : current));
                }}
                onChange={(event) => onFieldChange(row, event)}
                onKeyDown={(event) => onFieldKeyDown(row, event)}
                onPaste={(event) => onFieldPaste(row, event)}
                onChipKeyDown={(event) => onChipKeyDown(row, event)}
                onChipClick={() => {
                  setPicker({ kind: "type", rowId: row.rowId, trigger: null, index: 0, viaKeyboard: false, form: null });
                  setPendingFocus({ rowId: row.rowId, caret: "end" });
                }}
                onParamsClick={() => {
                  const option = typeOptions(row.tag ?? "", macros).find((candidate) => candidate.tag.toLowerCase() === (row.tag ?? "").toLowerCase());
                  if (option) openTypeForm(row, option, null, false);
                }}
                onApplyFix={(finding) => {
                  if (!isApplicableFix(finding.fix)) return;
                  commit(applyFixToDoc(doc, finding.fix), { rowId: row.rowId });
                }}
                onPickSuggestion={(name) => commit(setRowText(doc, row.rowId, insertElementName(row.text, name)), { rowId: row.rowId })}
                onRunFromHere={props.onRunFromStep && step ? () => props.onRunFromStep?.(step.stepId) : undefined}
              >
                {pickerHere && row.kind === "step" ? (
                  <Picker
                    picker={pickerHere}
                    listId={`${listId}-${row.rowId}`}
                    typeChoices={typeChoices}
                    variableChoices={variableChoices}
                    credentialChoices={credentialChoices}
                    credentials={credentials}
                    onHover={(index) => setPicker((current) => (current ? { ...current, index, viaKeyboard: false } : current))}
                    onAccept={acceptPicker}
                    onFormChange={(values) =>
                      setPicker((current) => (current && current.kind === "type" && current.form ? { ...current, form: { ...current.form, values } } : current))
                    }
                    onFormSubmit={() => {
                      if (pickerHere.kind === "type" && pickerHere.form) applyType(row, pickerHere.form.option, pickerHere.trigger, pickerHere.form.values);
                    }}
                    onClose={() => {
                      setPicker(null);
                      setPendingFocus({ rowId: row.rowId, caret: "end" });
                    }}
                  />
                ) : null}
              </StepRowView>
            )}
          </div>
        );
      })}

      {!readOnly ? (
        <button
          type="button"
          className="jl-se-add"
          onClick={() => {
            const last = doc.rows[doc.rows.length - 1];
            const result = insertRowAfter(doc, last?.rowId ?? null);
            commit(result.doc, { rowId: result.focusRowId });
          }}
        >
          + Add step
        </button>
      ) : null}

      <div className="jl-se-footer" aria-label="Keyboard shortcuts">
        <span><kbd>↵</kbd>new step of the same type</span>
        <span><kbd>/</kbd><kbd>[</kbd>type or macro</span>
        <span><kbd>{"{"}</kbd>variable</span>
        <span><kbd>@</kbd>credential, file</span>
        <span><kbd>#</kbd>checkpoint</span>
        <span><kbd>Alt ↑↓</kbd>change type</span>
        <span><kbd>{mod}↵</kbd>run</span>
        <span><kbd>{mod}D</kbd>duplicate</span>
        <span><kbd>{mod}⇧↑↓</kbd>move</span>
        <span><kbd>{mod}/</kbd>disable</span>
      </div>
    </div>
  );
}

function HeadingRowView(props: {
  row: HeadingRow;
  tabbable: boolean;
  focused: boolean;
  readOnly: boolean;
  inputRef: (element: HTMLInputElement | null) => void;
  onFocus: () => void;
  onBlur: () => void;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <>
      <span className="jl-se-num" aria-hidden>
        #
      </span>
      <div className="jl-se-field" role="gridcell" style={{ display: "flex", alignItems: "center" }}>
        <span className="jl-se-heading-label">Checkpoint</span>
        <input
          ref={props.inputRef}
          className="jl-se-input jl-se-heading-input"
          value={props.row.title}
          placeholder="What this group of asserts proves"
          aria-label="Checkpoint title"
          tabIndex={props.tabbable ? 0 : -1}
          readOnly={props.readOnly}
          onFocus={props.onFocus}
          onBlur={props.onBlur}
          onChange={props.onChange}
          onKeyDown={props.onKeyDown}
        />
      </div>
      <div className="jl-se-status">
        {!props.readOnly ? (
          <button type="button" className="jl-se-iconbtn" aria-label="Remove checkpoint heading" tabIndex={props.tabbable ? 0 : -1} onClick={props.onRemove}>
            ✕
          </button>
        ) : null}
      </div>
    </>
  );
}

function StepRowView(props: {
  row: StepRow;
  tabbable: boolean;
  ordinal: number | null;
  focused: boolean;
  readOnly: boolean;
  macros: readonly EditorMacro[];
  cases: readonly EditorCase[];
  mod: string;
  findings: readonly LintFinding[];
  status: StepEditorRowStatus | undefined;
  expansion: readonly ExpandedStep[];
  suggestions: readonly string[];
  listId: string;
  pickerOpen: boolean;
  children?: React.ReactNode;
  inputRef: (element: HTMLInputElement | null) => void;
  chipRef: (element: HTMLButtonElement | null) => void;
  onFocus: () => void;
  onBlur: (event: React.FocusEvent<HTMLElement>) => void;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onPaste: (event: React.ClipboardEvent<HTMLInputElement>) => void;
  onChipKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  onChipClick: () => void;
  onParamsClick: () => void;
  onApplyFix: (finding: LintFinding) => void;
  onPickSuggestion: (name: string) => void;
  onRunFromHere: (() => void) | undefined;
}): React.JSX.Element {
  const { row } = props;
  const type = rowStepType(row);
  const chip = formatStepChip(row, props.macros, props.cases);
  const tokens = tokenizeInstruction(row.text);
  const worst = props.findings.reduce<LintFinding | null>(
    (current, finding) => (current === null || severityRank[finding.severity] > severityRank[current.severity] ? finding : current),
    null
  );
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const isCall = type === "login" || type === "macro" || type === "use";
  const showBelow = props.findings.length > 0 || (isCall && props.expansion.length > 0) || props.suggestions.length > 0;

  return (
    <>
      <span className="jl-se-num">{props.ordinal ?? ""}</span>
      <span className="jl-se-chipgroup">
        <button
          ref={props.chipRef}
          type="button"
          className="jl-se-chip"
          data-type={type}
          aria-label={`Step type ${chip.tag}. Alt+Up or Alt+Down to change, Enter to pick a type or macro`}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          tabIndex={props.tabbable ? 0 : -1}
          disabled={props.readOnly}
          onKeyDown={props.onChipKeyDown}
          onClick={props.onChipClick}
          onFocus={props.onFocus}
          onBlur={props.onBlur}
        >
          {chip.tag}
        </button>
        {chip.params !== null ? (
          <button
            type="button"
            className="jl-se-params"
            aria-label={`Edit ${chip.tag} parameters: ${chip.hint ?? chip.params}`}
            title={chip.hint}
            tabIndex={props.tabbable ? 0 : -1}
            disabled={props.readOnly}
            onClick={props.onParamsClick}
            onFocus={props.onFocus}
            onBlur={props.onBlur}
          >
            {type === "login" ? "🔒 " : ""}
            {chip.params}
          </button>
        ) : null}
      </span>
      <div className="jl-se-field" role="gridcell">
        <input
          ref={(element) => {
            inputRef.current = element;
            props.inputRef(element);
          }}
          className="jl-se-input"
          data-hidden={props.focused || props.pickerOpen ? "false" : "true"}
          value={row.text}
          placeholder={phrasingTemplates[type]}
          aria-label={`Step ${props.ordinal ?? "new"} instruction`}
          tabIndex={props.tabbable ? 0 : -1}
          aria-autocomplete="list"
          aria-expanded={props.pickerOpen}
          aria-controls={props.pickerOpen ? props.listId : undefined}
          readOnly={props.readOnly}
          spellCheck
          onFocus={props.onFocus}
          onBlur={props.onBlur}
          onChange={props.onChange}
          onKeyDown={props.onKeyDown}
          onPaste={props.onPaste}
        />
        {!props.focused && !props.pickerOpen ? (
          <div className="jl-se-display" data-empty={row.text.length === 0 ? "true" : "false"} aria-hidden onMouseDown={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}>
            {row.text.length === 0
              ? phrasingTemplates[type]
              : tokens.map((token, index) => <InstructionTokenView key={index} token={token} />)}
          </div>
        ) : null}
        {props.children}
      </div>
      <div className="jl-se-status">
        {worst ? (
          <span className={`jl-se-badge`} data-tone={worst.severity === "error" ? "error" : worst.severity === "warning" ? "warn" : undefined} title={props.findings.map((finding) => finding.message).join("\n")}>
            lint {props.findings.length}
          </span>
        ) : null}
        {props.status?.cache === "active" ? (
          <span className="jl-se-badge" data-tone="ok" title={props.status.cacheDetail ?? "Cached script replays without the model"}>
            cached
          </span>
        ) : props.status?.cache === "stale" || props.status?.cache === "invalid" ? (
          <span className="jl-se-badge" data-tone="warn" title={props.status.cacheDetail ?? "Cached script will be re-recorded"}>
            {props.status.cache}
          </span>
        ) : null}
        {props.status?.lastOutcome ? (
          <span className="jl-se-outcome" data-outcome={props.status.lastOutcome} title={`Last run: ${props.status.lastOutcome}${props.status.lastMode ? ` · ${props.status.lastMode}` : ""}`}>
            <span className="jl-se-dot" aria-label={`Last run ${props.status.lastOutcome}`} />
          </span>
        ) : null}
        {props.onRunFromHere && props.focused ? (
          <button type="button" className="jl-se-iconbtn" aria-label="Run from this step" title="Run from this step (⌥↵)" onMouseDown={(event) => event.preventDefault()} onClick={props.onRunFromHere}>
            ▶
          </button>
        ) : null}
      </div>
      {showBelow ? (
        <div className="jl-se-below">
          {isCall && props.expansion.length > 0 ? (
            <div className="jl-se-expansion" aria-label={`Steps from macro ${chip.tag}`}>
              ↳ {props.expansion.length} step{props.expansion.length === 1 ? "" : "s"} from macro {chip.tag}:{" "}
              {props.expansion.map((child) => `${child.tag ? `[${child.tag}] ` : ""}${child.text}`).join(" · ")}
            </div>
          ) : null}
          {props.findings.map((finding, index) => (
            <div key={`${finding.ruleId}-${index}`} className="jl-se-lint" data-severity={finding.severity}>
              <span>{finding.message}</span>
              {!props.readOnly && isApplicableFix(finding.fix) ? (
                <button
                  type="button"
                  className="jl-se-fix"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => props.onApplyFix(finding)}
                >
                  {describeLintFix(finding.fix)}
                </button>
              ) : null}
            </div>
          ))}
          {props.suggestions.length > 0 && !props.readOnly ? (
            <div className="jl-se-suggest" aria-label="Elements seen in the last run">
              <span>seen on screen:</span>
              {props.suggestions.map((name) => (
                <button key={name} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => props.onPickSuggestion(name)}>
                  {name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function InstructionTokenView(props: { token: ReturnType<typeof tokenizeInstruction>[number] }): React.JSX.Element {
  const { token } = props;
  switch (token.kind) {
    case "text":
      return <>{token.value}</>;
    case "variable":
      return (
        <span className="jl-se-token" data-kind="variable" title={`Variable {${token.name}}`}>
          {token.name}
        </span>
      );
    case "credential":
      return (
        <span className="jl-se-token" data-kind="credential" title="Credential reference; the value never leaves the runner">
          <span aria-label="credential">🔒</span>
          {token.profile}
          {token.field ? `.${token.field}` : ""}
        </span>
      );
    case "file":
      return (
        <span className="jl-se-token" data-kind="file" title={`File ${token.path}`}>
          📎 {token.path}
        </span>
      );
    case "quoted":
      return (
        <span className="jl-se-token" data-kind="quoted">
          {token.value}
        </span>
      );
  }
}

function Picker(props: {
  picker: PickerState;
  listId: string;
  typeChoices: readonly TypeOption[];
  variableChoices: readonly VariableOption[];
  credentialChoices: readonly CredentialOption[];
  credentials: readonly EditorCredential[];
  onHover: (index: number) => void;
  onAccept: (index: number) => void;
  onFormChange: (values: Record<string, string>) => void;
  onFormSubmit: () => void;
  onClose: () => void;
}): React.JSX.Element | null {
  const { picker } = props;
  const firstFieldRef = React.useRef<HTMLInputElement | null>(null);
  const formOpen = picker.kind === "type" && picker.form !== null;
  React.useEffect(() => {
    if (formOpen) firstFieldRef.current?.focus();
  }, [formOpen]);

  if (picker.kind === "type" && picker.form) {
    const { option, values } = picker.form;
    return (
      <div className="jl-se-picker" data-keyboard={picker.viaKeyboard ? "true" : "false"} role="dialog" aria-label={`${option.label} parameters`}>
        <div className="jl-se-picker-head">
          {option.label} · parameters
        </div>
        <form
          className="jl-se-form"
          onSubmit={(event) => {
            event.preventDefault();
            props.onFormSubmit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              props.onClose();
            }
          }}
        >
          {option.params.map((param: MacroParam, index) => (
            <label key={param.name}>
              <span>
                {param.name}
                {param.required ? " *" : ""}
              </span>
              <input
                ref={index === 0 ? firstFieldRef : undefined}
                value={values[param.name] ?? ""}
                placeholder={param.default ?? (param.kind === "credential" ? "PROFILE_NAME" : "")}
                list={param.kind === "credential" ? `${props.listId}-profiles` : undefined}
                aria-label={`${option.label} ${param.name}`}
                onChange={(event) => props.onFormChange({ ...values, [param.name]: event.currentTarget.value })}
              />
            </label>
          ))}
          <datalist id={`${props.listId}-profiles`}>
            {props.credentials.map((credential) => (
              <option key={credential.profile} value={credential.profile} />
            ))}
          </datalist>
          <div className="jl-se-form-actions">
            <button type="button" className="jl-se-btn" onClick={props.onClose}>
              Cancel
            </button>
            <button type="submit" className="jl-se-btn" data-variant="primary">
              Apply
            </button>
          </div>
        </form>
      </div>
    );
  }

  type Item = { key: string; main: React.ReactNode; detail: string };
  const items: Item[] =
    picker.kind === "type"
      ? props.typeChoices.map((option) => ({
          key: `${option.kind}:${option.label}`,
          main: <code>{option.kind === "case" ? `[${option.tag}: ${option.args?.[0]?.value ?? ""}]` : option.kind === "macro" || option.tag === "Use" ? `[${option.tag}: …]` : `[${option.tag}]`}</code>,
          detail: option.description
        }))
      : picker.kind === "variable"
        ? props.variableChoices.map((option) => ({
            key: `${option.source}:${option.name}`,
            main: option.source === "declare" ? <code>+ declare {`{${option.name}}`}</code> : <code>{`{${option.name}}`}</code>,
            detail: option.detail
          }))
        : props.credentialChoices.map((option) => ({
            key: option.label,
            main: (
              <code>
                {option.profile === "" ? "📎 " : option.secret || option.field === null ? "🔒 " : ""}
                {option.label}
              </code>
            ),
            detail: option.profile === "" ? "file reference" : option.field === null ? "credential profile" : option.secret ? "secret field · filled by the runner" : "public field"
          }));
  const heading = picker.kind === "type" ? "Step type · macros" : picker.kind === "variable" ? "Variables · type to filter" : "Credentials · files";

  return (
    <div className="jl-se-picker" data-keyboard={picker.viaKeyboard ? "true" : "false"}>
      <div className="jl-se-picker-head">{heading}</div>
      <div role="listbox" id={props.listId} aria-label={heading}>
        {items.length === 0 ? (
          <div className="jl-se-option" aria-disabled="true">
            <span className="jl-se-option-detail">No matches</span>
          </div>
        ) : (
          items.map((item, index) => (
            <div
              key={item.key}
              role="option"
              aria-selected={index === picker.index}
              className="jl-se-option"
              onMouseEnter={() => props.onHover(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                props.onAccept(index);
              }}
            >
              <span>{item.main}</span>
              <span className="jl-se-option-detail">{item.detail}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
