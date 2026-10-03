import React from "react";
import { safeExternalHref } from "../safe-url";
import { serializeTestCase, type ParamDeclaration, type TranscriptDataset } from "@jittle-lamp/shared";

import {
  docFromTranscript,
  textModeUpdate,
  groupTagsByNamespace,
  linkLabel,
  setDataset,
  setTitle,
  testCaseFromDoc,
  updateMetadata,
  type EditorDoc
} from "./model";
import { StepEditor, type StepEditorProps } from "./step-editor";
import { injectStepEditorStyles } from "./styles";

// Test case editor = metadata form + structured steps + Text toggle. Both views are projections of
// the same EditorDoc, so switching is lossless (design.md §7 "Structured step editor").

export type TestCaseEditorMode = "steps" | "text";

export type TestCaseEditorProps = StepEditorProps & {
  mode: TestCaseEditorMode;
  onModeChange: (mode: TestCaseEditorMode) => void;
  environments?: readonly { name: string }[];
  tagSuggestions?: readonly string[];
  // Rendered next to the title field, e.g. "3 similar cases".
  titleAccessory?: React.ReactNode;
  // Environment the case uses when the transcript has no `Env:` line (the stored case setting).
  environmentFallback?: string | null;
  showMetadata?: boolean;
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
    <div className="jl-se-workbench" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {props.showMetadata !== false ? (
        <MetadataForm
          doc={doc}
          onChange={onChange}
          readOnly={props.readOnly ?? false}
          environments={props.environments ?? []}
          tagSuggestions={props.tagSuggestions ?? []}
          titleAccessory={props.titleAccessory}
          environmentFallback={props.environmentFallback ?? null}
        />
      ) : null}
      <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}>
        <div role="tablist" aria-label="Editor view" className="jl-se-modes" style={{ display: "inline-flex", gap: 2, padding: 2, borderRadius: 8, border: "1px solid var(--border, rgba(127,127,127,.25))" }}>
          {(["steps", "text"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              className="jl-se-btn"
              data-variant={mode === value ? "primary" : undefined}
              style={{ border: 0, background: mode === value ? undefined : "transparent" }}
              onClick={() => switchMode(value)}
              disabled={value === "steps" && mode === "text" && extraCases > 1}
              title={value === "steps" && extraCases > 1 ? "The text holds more than one case" : undefined}
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
        <p role="status" style={{ margin: 0, fontSize: 13, lineHeight: 1.45, color: "color-mix(in srgb, var(--warning, #f59e0b) 75%, var(--foreground, #222))" }}>
          This text holds {extraCases} cases (# headings). One case fits here: remove the extra headings to keep editing, or use New case to split the
          document. Until then the steps view keeps the last single-case version.
        </p>
      ) : null}
    </div>
  );
}

export function MetadataForm(props: {
  doc: EditorDoc;
  onChange: (doc: EditorDoc) => void;
  readOnly: boolean;
  environments: readonly { name: string }[];
  tagSuggestions: readonly string[];
  titleAccessory?: React.ReactNode;
  environmentFallback?: string | null;
}): React.JSX.Element {
  injectStepEditorStyles();
  const { doc, onChange, readOnly } = props;
  const id = React.useId();
  const [tagDraft, setTagDraft] = React.useState("");
  const [linkDraft, setLinkDraft] = React.useState("");
  const metadata = doc.metadata;

  const addTags = (raw: string) => {
    const added = raw
      .split(/[,\n]/)
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0 && !metadata.tags.includes(tag));
    if (added.length > 0) onChange(updateMetadata(doc, { tags: [...metadata.tags, ...added] }));
    setTagDraft("");
  };

  const addLink = () => {
    const url = linkDraft.trim();
    if (!/^https?:\/\/\S+$/i.test(url) || metadata.links.includes(url)) return;
    onChange(updateMetadata(doc, { links: [...metadata.links, url] }));
    setLinkDraft("");
  };

  const setParams = (params: ParamDeclaration[]) => onChange(updateMetadata(doc, { params }));
  const dataset = doc.dataset;
  const setGrid = (next: TranscriptDataset | null) => onChange(setDataset(doc, next));

  return (
    <div className="jl-meta" aria-label="Case details">
      <label className="jl-meta-label" htmlFor={`${id}-title`}>
        Title
      </label>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          id={`${id}-title`}
          style={{ flex: "1 1 320px", fontSize: 15, fontWeight: 600 }}
          value={doc.title}
          placeholder="What the case proves, e.g. HQ admin logout returns a clean login form"
          readOnly={readOnly}
          onChange={(event) => onChange(setTitle(doc, event.currentTarget.value))}
        />
        {props.titleAccessory}
      </div>

      <label className="jl-meta-label" htmlFor={`${id}-description`}>
        Description
      </label>
      <textarea
        id={`${id}-description`}
        value={metadata.description ?? ""}
        placeholder="Why this case exists (markdown)"
        readOnly={readOnly}
        onChange={(event) => {
          const value = event.currentTarget.value;
          onChange(updateMetadata(doc, { description: value.length > 0 ? value : null }));
        }}
      />

      <span className="jl-meta-label">Tags</span>
      <div className="jl-meta-chips">
        {groupTagsByNamespace(metadata.tags).map((group) => (
          <span key={group.namespace || "free"} className="jl-meta-group" aria-label={group.namespace ? `${group.namespace} tags` : "Free tags"}>
            {group.namespace ? <span className="jl-meta-ns">{group.namespace}:</span> : null}
            {group.tags.map((entry) => (
              <span key={entry.tag} className="jl-meta-chip">
                {entry.name}
                {!readOnly ? (
                  <button type="button" aria-label={`Remove tag ${entry.tag}`} onClick={() => onChange(updateMetadata(doc, { tags: metadata.tags.filter((tag) => tag !== entry.tag) }))}>
                    ×
                  </button>
                ) : null}
              </span>
            ))}
          </span>
        ))}
        {!readOnly ? (
          <>
            <input
              aria-label="Add tag"
              list={`${id}-tags`}
              value={tagDraft}
              placeholder="namespace:tag"
              style={{ width: 160 }}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (value.endsWith(",")) addTags(value);
                else setTagDraft(value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addTags(tagDraft);
                }
                if (event.key === "Backspace" && tagDraft.length === 0 && metadata.tags.length > 0) {
                  onChange(updateMetadata(doc, { tags: metadata.tags.slice(0, -1) }));
                }
              }}
              onBlur={() => {
                if (tagDraft.trim().length > 0) addTags(tagDraft);
              }}
            />
            <datalist id={`${id}-tags`}>
              {props.tagSuggestions
                .filter((tag) => !metadata.tags.includes(tag))
                .slice(0, 200)
                .map((tag) => (
                  <option key={tag} value={tag} />
                ))}
            </datalist>
          </>
        ) : null}
      </div>

      <label className="jl-meta-label" htmlFor={`${id}-env`}>
        Environment
      </label>
      <div>
        <select
          id={`${id}-env`}
          value={metadata.env ?? ""}
          disabled={readOnly}
          onChange={(event) => {
            const value = event.currentTarget.value;
            onChange(updateMetadata(doc, { env: value.length > 0 ? value : null }));
          }}
        >
          <option value="">{props.environmentFallback ? `${props.environmentFallback} (case setting)` : "No default environment"}</option>
          {metadata.env && !props.environments.some((environment) => environment.name === metadata.env) ? (
            <option value={metadata.env}>{metadata.env} (unknown)</option>
          ) : null}
          {props.environments.map((environment) => (
            <option key={environment.name} value={environment.name}>
              {environment.name}
            </option>
          ))}
        </select>
      </div>

      <span className="jl-meta-label">Links</span>
      <div className="jl-meta-chips">
        {metadata.links.map((url) => (
          <span key={url} className="jl-meta-chip" title={url}>
            {safeExternalHref(url) ? (
              <a href={safeExternalHref(url) ?? undefined} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
                {linkLabel(url)}
              </a>
            ) : (
              <span>{linkLabel(url)}</span>
            )}
            {!readOnly ? (
              <button type="button" aria-label={`Remove link ${url}`} onClick={() => onChange(updateMetadata(doc, { links: metadata.links.filter((link) => link !== url) }))}>
                ×
              </button>
            ) : null}
          </span>
        ))}
        {!readOnly ? (
          <input
            aria-label="Add link"
            value={linkDraft}
            placeholder="https://… then Enter"
            style={{ width: 220 }}
            onChange={(event) => setLinkDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addLink();
              }
            }}
            onBlur={addLink}
          />
        ) : null}
      </div>

      <span className="jl-meta-label">Params</span>
      <div>
        {metadata.params.length > 0 ? (
          <table className="jl-meta-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Default</th>
                <th scope="col">Required</th>
                <th scope="col">
                  <span className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
                    Remove
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {metadata.params.map((param, index) => (
                <tr key={index}>
                  <td>
                    <input
                      type="text"
                      aria-label={`Param ${index + 1} name`}
                      value={param.name}
                      readOnly={readOnly}
                      onChange={(event) => setParams(metadata.params.map((candidate, i) => (i === index ? { ...candidate, name: event.currentTarget.value.replace(/[^\w-]/g, "") } : candidate)))}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      aria-label={`Param ${param.name} default`}
                      value={param.default ?? ""}
                      placeholder={param.required ? "required" : ""}
                      readOnly={readOnly}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setParams(metadata.params.map((candidate, i) => (i === index ? { ...candidate, default: value.length > 0 ? value : null, required: value.length === 0 } : candidate)));
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Param ${param.name} required`}
                      checked={param.required}
                      disabled={readOnly}
                      onChange={(event) => {
                        const required = event.currentTarget.checked;
                        setParams(metadata.params.map((candidate, i) => (i === index ? { ...candidate, required, default: required ? null : candidate.default ?? "" } : candidate)));
                      }}
                    />
                  </td>
                  <td>
                    {!readOnly ? (
                      <button type="button" className="jl-meta-mini" aria-label={`Remove param ${param.name}`} onClick={() => setParams(metadata.params.filter((_, i) => i !== index))}>
                        ×
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {!readOnly ? (
          <button type="button" className="jl-meta-mini" onClick={() => setParams([...metadata.params, { name: `param${metadata.params.length + 1}`, default: null, required: true }])}>
            + Param
          </button>
        ) : null}
      </div>

      <span className="jl-meta-label">Dataset</span>
      <div>
        {dataset ? (
          <DatasetGrid dataset={dataset} readOnly={readOnly} onChange={setGrid} />
        ) : !readOnly ? (
          <button type="button" className="jl-meta-mini" onClick={() => setGrid({ name: null, columns: metadata.params.map((param) => param.name).slice(0, 4).concat(metadata.params.length === 0 ? ["value"] : []), rows: [] })}>
            + Dataset (one run per row)
          </button>
        ) : (
          <span style={{ color: "var(--muted-foreground)" }}>None</span>
        )}
      </div>
    </div>
  );
}

function DatasetGrid(props: { dataset: TranscriptDataset; readOnly: boolean; onChange: (dataset: TranscriptDataset | null) => void }): React.JSX.Element {
  const { dataset, readOnly, onChange } = props;
  const renameColumn = (index: number, name: string) => {
    const previous = dataset.columns[index];
    if (previous === undefined) return;
    const clean = name.replace(/[^\w-]/g, "");
    const columns = dataset.columns.map((column, i) => (i === index ? clean : column));
    const rows = dataset.rows.map((row) => {
      const next: Record<string, string> = {};
      dataset.columns.forEach((column, i) => {
        next[i === index ? clean : column] = row[column] ?? "";
      });
      return next;
    });
    onChange({ ...dataset, columns, rows });
  };
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="jl-meta-table" aria-label="Dataset rows">
        <thead>
          <tr>
            {dataset.columns.map((column, index) => (
              <th key={index} scope="col">
                <input type="text" aria-label={`Dataset column ${index + 1}`} value={column} readOnly={readOnly} onChange={(event) => renameColumn(index, event.currentTarget.value)} />
              </th>
            ))}
            {!readOnly ? (
              <th scope="col">
                <button type="button" className="jl-meta-mini" aria-label="Add dataset column" onClick={() => onChange({ ...dataset, columns: [...dataset.columns, `col${dataset.columns.length + 1}`] })}>
                  +
                </button>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {dataset.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {dataset.columns.map((column, columnIndex) => (
                <td key={columnIndex}>
                  <input
                    type="text"
                    aria-label={`Row ${rowIndex + 1} ${column}`}
                    value={row[column] ?? ""}
                    readOnly={readOnly}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      onChange({ ...dataset, rows: dataset.rows.map((candidate, i) => (i === rowIndex ? { ...candidate, [column]: value } : candidate)) });
                    }}
                  />
                </td>
              ))}
              {!readOnly ? (
                <td>
                  <button type="button" className="jl-meta-mini" aria-label={`Remove dataset row ${rowIndex + 1}`} onClick={() => onChange({ ...dataset, rows: dataset.rows.filter((_, i) => i !== rowIndex) })}>
                    ×
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly ? (
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <button type="button" className="jl-meta-mini" onClick={() => onChange({ ...dataset, rows: [...dataset.rows, Object.fromEntries(dataset.columns.map((column) => [column, ""]))] })}>
            + Row
          </button>
          <button type="button" className="jl-meta-mini" onClick={() => onChange(null)}>
            Remove dataset
          </button>
        </div>
      ) : null}
    </div>
  );
}
