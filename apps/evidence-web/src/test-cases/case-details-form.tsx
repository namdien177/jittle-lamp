import React from "react";
import { ExternalLink, Plus, X } from "lucide-react";
import type { ParamDeclaration, TranscriptDataset } from "@jittle-lamp/shared";
import { groupTagsByNamespace, linkLabel, safeExternalHref, setDataset, setTitle, updateMetadata, type EditorDoc } from "@jittle-lamp/ui";

import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { FieldDescription, FieldError, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { SimpleSelect } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { Hint, TruncatedText } from "../components/ui/tooltip";
import { cn } from "../lib/cn";

// The case's details (title, description, tags, environment, links, params, dataset) on shadcn
// components. Used by New case (stacked, in steps) and by the Steps tab of an open case (inline).

export type CaseDetailsField = "title" | "description" | "tags" | "environment" | "links" | "params" | "dataset";

const allFields: readonly CaseDetailsField[] = ["title", "description", "tags", "environment", "links", "params", "dataset"];
const NO_ENVIRONMENT = "__none__";

export function CaseDetailsForm(props: {
  doc: EditorDoc;
  onChange: (doc: EditorDoc) => void;
  readOnly?: boolean;
  fields?: readonly CaseDetailsField[];
  layout?: "inline" | "stacked";
  environments: readonly { name: string }[];
  tagSuggestions?: readonly string[];
  // Shown under the title, e.g. "3 similar cases".
  titleAccessory?: React.ReactNode;
  // Environment the case uses when the transcript has no `Env:` line (the stored case setting).
  environmentFallback?: string | null;
  titleError?: string | undefined;
  autoFocusTitle?: boolean;
  onTitleEnter?: () => void;
}): React.JSX.Element {
  const { doc, onChange } = props;
  const readOnly = props.readOnly ?? false;
  const fields = props.fields ?? allFields;
  const id = React.useId();
  const metadata = doc.metadata;
  const stacked = props.layout === "stacked";

  const row = (field: CaseDetailsField, label: string, control: React.ReactNode, options: { htmlFor?: string; hint?: React.ReactNode; error?: string | undefined } = {}) =>
    fields.includes(field) ? (
      <div key={field} className={cn("grid gap-1.5", !stacked && "sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-3")}>
        <FieldLabel htmlFor={options.htmlFor} className={cn("text-muted-foreground", !stacked && "sm:h-8 sm:font-normal", stacked && "text-foreground")}>
          {label}
        </FieldLabel>
        <div className="flex min-w-0 flex-col gap-1.5">
          {control}
          {options.error ? <FieldError>{options.error}</FieldError> : options.hint ? <FieldDescription>{options.hint}</FieldDescription> : null}
        </div>
      </div>
    ) : null;

  const environmentOptions = [
    { value: NO_ENVIRONMENT, label: props.environmentFallback ? `${props.environmentFallback} (case setting)` : "No default environment" },
    ...(metadata.env && !props.environments.some((environment) => environment.name === metadata.env) ? [{ value: metadata.env, label: `${metadata.env} (unknown)` }] : []),
    ...props.environments.map((environment) => ({ value: environment.name, label: environment.name }))
  ];

  return (
    <div className={cn("grid", stacked ? "gap-5" : "gap-3")} aria-label="Case details">
      {row(
        "title",
        "Title",
        <>
          <Input
            id={`${id}-title`}
            value={doc.title}
            readOnly={readOnly}
            autoFocus={props.autoFocusTitle}
            aria-invalid={props.titleError ? true : undefined}
            placeholder="What the case proves, e.g. HQ admin logout returns a clean login form"
            className={cn("font-medium", stacked ? "h-9 text-[15px]" : "")}
            onChange={(event) => onChange(setTitle(doc, event.currentTarget.value))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && props.onTitleEnter) {
                event.preventDefault();
                props.onTitleEnter();
              }
            }}
          />
          {props.titleAccessory}
        </>,
        { htmlFor: `${id}-title`, error: props.titleError }
      )}

      {row(
        "environment",
        "Environment",
        <SimpleSelect
          ariaLabel="Environment"
          className="sm:w-72"
          disabled={readOnly}
          value={metadata.env ?? NO_ENVIRONMENT}
          options={environmentOptions}
          onValueChange={(value) => onChange(updateMetadata(doc, { env: value === NO_ENVIRONMENT ? null : value }))}
        />,
        { hint: stacked ? "Where the case runs by default: base URL, variables and runner pool. A run can pick another one." : undefined }
      )}

      {row("tags", "Tags", <TagInput doc={doc} onChange={onChange} readOnly={readOnly} suggestions={props.tagSuggestions ?? []} />, {
        hint: stacked ? "Namespaced tags group cases in the sidebar, e.g. team:qa-pcf or feature:login. Enter or comma adds one." : undefined
      })}

      {row(
        "description",
        "Description",
        <Textarea
          id={`${id}-description`}
          value={metadata.description ?? ""}
          readOnly={readOnly}
          rows={stacked ? 3 : 2}
          placeholder="Why this case exists (markdown)"
          onChange={(event) => {
            const value = event.currentTarget.value;
            onChange(updateMetadata(doc, { description: value.length > 0 ? value : null }));
          }}
        />,
        { htmlFor: `${id}-description` }
      )}

      {row("links", "Links", <LinkInput doc={doc} onChange={onChange} readOnly={readOnly} />, { hint: stacked ? "Tickets or specs this case covers." : undefined })}

      {row("params", "Params", <ParamsEditor doc={doc} onChange={onChange} readOnly={readOnly} />, {
        hint: stacked ? "Values a run can override, used in steps as {name}." : undefined
      })}

      {row("dataset", "Dataset", <DatasetEditor doc={doc} onChange={onChange} readOnly={readOnly} />, {
        hint: stacked ? "One run per row; columns fill the params." : undefined
      })}
    </div>
  );
}

function ChipRemove(props: { label: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={props.label}
      className="-mr-0.5 grid size-4 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      onClick={props.onClick}
    >
      <X className="size-3" aria-hidden />
    </button>
  );
}

const chipClass = "inline-flex h-6 max-w-full items-center gap-1 rounded-md border border-border bg-secondary pl-2 pr-1 text-xs font-medium text-foreground";

function TagInput(props: { doc: EditorDoc; onChange: (doc: EditorDoc) => void; readOnly: boolean; suggestions: readonly string[] }): React.JSX.Element {
  const { doc, onChange } = props;
  const id = React.useId();
  const [draft, setDraft] = React.useState("");
  const tags = doc.metadata.tags;
  const add = (raw: string) => {
    const added = raw
      .split(/[,\n]/)
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0 && !tags.includes(tag));
    if (added.length > 0) onChange(updateMetadata(doc, { tags: [...tags, ...added] }));
    setDraft("");
  };
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1.5">
      {groupTagsByNamespace(tags).flatMap((group) =>
        group.tags.map((entry) => (
          <span key={entry.tag} className={chipClass}>
            <span className="truncate">
              {group.namespace ? <span className="text-muted-foreground">{group.namespace}:</span> : null}
              {entry.name}
            </span>
            {!props.readOnly ? <ChipRemove label={`Remove tag ${entry.tag}`} onClick={() => onChange(updateMetadata(doc, { tags: tags.filter((tag) => tag !== entry.tag) }))} /> : null}
          </span>
        ))
      )}
      {!props.readOnly ? (
        <>
          <Input
            aria-label="Add tag"
            list={`${id}-tags`}
            value={draft}
            placeholder={tags.length > 0 ? "Add tag" : "namespace:tag"}
            className="h-7 w-40"
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value.endsWith(",")) add(value);
              else setDraft(value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add(draft);
              }
              if (event.key === "Backspace" && draft.length === 0 && tags.length > 0) onChange(updateMetadata(doc, { tags: tags.slice(0, -1) }));
            }}
            onBlur={() => {
              if (draft.trim().length > 0) add(draft);
            }}
          />
          <datalist id={`${id}-tags`}>
            {props.suggestions
              .filter((tag) => !tags.includes(tag))
              .slice(0, 200)
              .map((tag) => (
                <option key={tag} value={tag} />
              ))}
          </datalist>
        </>
      ) : tags.length === 0 ? (
        <span className="text-sm text-muted-foreground">None</span>
      ) : null}
    </div>
  );
}

function LinkInput(props: { doc: EditorDoc; onChange: (doc: EditorDoc) => void; readOnly: boolean }): React.JSX.Element {
  const { doc, onChange } = props;
  const [draft, setDraft] = React.useState("");
  const links = doc.metadata.links;
  const add = () => {
    const url = draft.trim();
    if (!/^https?:\/\/\S+$/i.test(url) || links.includes(url)) return;
    onChange(updateMetadata(doc, { links: [...links, url] }));
    setDraft("");
  };
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1.5">
      {links.map((url) => {
        const href = safeExternalHref(url);
        return (
          <span key={url} className={cn(chipClass, "max-w-64")}>
            {href ? <ExternalLink className="size-3 shrink-0 text-muted-foreground" aria-hidden /> : null}
            <TruncatedText label={url} render={href ? <a href={href} target="_blank" rel="noreferrer" className="hover:underline" /> : <span />}>
              {linkLabel(url)}
            </TruncatedText>
            {!props.readOnly ? <ChipRemove label={`Remove link ${url}`} onClick={() => onChange(updateMetadata(doc, { links: links.filter((link) => link !== url) }))} /> : null}
          </span>
        );
      })}
      {!props.readOnly ? (
        <Input
          aria-label="Add link"
          value={draft}
          placeholder="https://… then Enter"
          className="h-7 w-56"
          inputMode="url"
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          onBlur={add}
        />
      ) : links.length === 0 ? (
        <span className="text-sm text-muted-foreground">None</span>
      ) : null}
    </div>
  );
}

function ParamsEditor(props: { doc: EditorDoc; onChange: (doc: EditorDoc) => void; readOnly: boolean }): React.JSX.Element {
  const { doc, onChange, readOnly } = props;
  const params = doc.metadata.params;
  const setParams = (next: ParamDeclaration[]) => onChange(updateMetadata(doc, { params: next }));
  const patch = (index: number, change: Partial<ParamDeclaration>) => setParams(params.map((param, i) => (i === index ? { ...param, ...change } : param)));
  return (
    <div className="flex flex-col items-start gap-1.5">
      {params.length > 0 ? (
        <div className="grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto_1.75rem] items-center gap-x-2 gap-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">Name</span>
          <span className="text-xs font-medium text-muted-foreground">Default</span>
          <span className="text-xs font-medium text-muted-foreground">Required</span>
          <span />
          {params.map((param, index) => (
            <React.Fragment key={index}>
              <Input
                aria-label={`Param ${index + 1} name`}
                value={param.name}
                readOnly={readOnly}
                className="h-7 font-mono text-xs"
                onChange={(event) => patch(index, { name: event.currentTarget.value.replace(/[^\w-]/g, "") })}
              />
              <Input
                aria-label={`Param ${param.name} default`}
                value={param.default ?? ""}
                placeholder={param.required ? "required" : ""}
                readOnly={readOnly}
                className="h-7 font-mono text-xs"
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  patch(index, { default: value.length > 0 ? value : null, required: value.length === 0 });
                }}
              />
              <span className="flex justify-center">
                <Checkbox
                  aria-label={`Param ${param.name} required`}
                  checked={param.required}
                  disabled={readOnly}
                  onCheckedChange={(required) => patch(index, { required, default: required ? null : param.default ?? "" })}
                />
              </span>
              {!readOnly ? (
                <Hint label="Remove">
                  <Button variant="ghost" size="icon-xs" aria-label={`Remove param ${param.name}`} onClick={() => setParams(params.filter((_, i) => i !== index))}>
                    <X aria-hidden />
                  </Button>
                </Hint>
              ) : (
                <span />
              )}
            </React.Fragment>
          ))}
        </div>
      ) : readOnly ? (
        <span className="text-sm text-muted-foreground">None</span>
      ) : null}
      {!readOnly ? (
        <Button variant="outline" size="xs" onClick={() => setParams([...params, { name: `param${params.length + 1}`, default: null, required: true }])}>
          <Plus aria-hidden />
          Add param
        </Button>
      ) : null}
    </div>
  );
}

function DatasetEditor(props: { doc: EditorDoc; onChange: (doc: EditorDoc) => void; readOnly: boolean }): React.JSX.Element {
  const { doc, onChange, readOnly } = props;
  const dataset = doc.dataset;
  const set = (next: TranscriptDataset | null) => onChange(setDataset(doc, next));
  if (!dataset) {
    return readOnly ? (
      <span className="text-sm text-muted-foreground">None</span>
    ) : (
      <div>
        <Button
          variant="outline"
          size="xs"
          onClick={() => set({ name: null, columns: doc.metadata.params.map((param) => param.name).slice(0, 4).concat(doc.metadata.params.length === 0 ? ["value"] : []), rows: [] })}
        >
          <Plus aria-hidden />
          Add dataset
        </Button>
      </div>
    );
  }
  const renameColumn = (index: number, name: string) => {
    const clean = name.replace(/[^\w-]/g, "");
    const columns = dataset.columns.map((column, i) => (i === index ? clean : column));
    const rows = dataset.rows.map((row) => Object.fromEntries(dataset.columns.map((column, i) => [i === index ? clean : column, row[column] ?? ""])));
    set({ ...dataset, columns, rows });
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="jl-scroll overflow-x-auto rounded-md border border-border">
        <table className="w-full border-collapse text-xs" aria-label="Dataset rows">
          <thead className="bg-muted/50">
            <tr>
              {dataset.columns.map((column, index) => (
                <th key={index} scope="col" className="border-b border-border p-1 text-left font-medium">
                  <Input aria-label={`Dataset column ${index + 1}`} value={column} readOnly={readOnly} className="h-7 border-transparent bg-transparent font-mono text-xs shadow-none dark:bg-transparent" onChange={(event) => renameColumn(index, event.currentTarget.value)} />
                </th>
              ))}
              {!readOnly ? (
                <th scope="col" className="w-8 border-b border-border p-1">
                  <Hint label="Add column">
                    <Button variant="ghost" size="icon-xs" aria-label="Add dataset column" onClick={() => set({ ...dataset, columns: [...dataset.columns, `col${dataset.columns.length + 1}`] })}>
                      <Plus aria-hidden />
                    </Button>
                  </Hint>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {dataset.rows.length === 0 ? (
              <tr>
                <td colSpan={dataset.columns.length + 1} className="px-3 py-3 text-center text-muted-foreground">
                  No rows yet.
                </td>
              </tr>
            ) : null}
            {dataset.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-b border-border last:border-0">
                {dataset.columns.map((column, columnIndex) => (
                  <td key={columnIndex} className="p-1">
                    <Input
                      aria-label={`Row ${rowIndex + 1} ${column}`}
                      value={row[column] ?? ""}
                      placeholder={column}
                      readOnly={readOnly}
                      className="h-7 border-transparent bg-transparent font-mono text-xs shadow-none hover:border-input focus-visible:border-ring/60 dark:bg-transparent"
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        set({ ...dataset, rows: dataset.rows.map((candidate, i) => (i === rowIndex ? { ...candidate, [column]: value } : candidate)) });
                      }}
                    />
                  </td>
                ))}
                {!readOnly ? (
                  <td className="w-8 p-1">
                    <Hint label="Remove row">
                      <Button variant="ghost" size="icon-xs" aria-label={`Remove dataset row ${rowIndex + 1}`} onClick={() => set({ ...dataset, rows: dataset.rows.filter((_, i) => i !== rowIndex) })}>
                        <X aria-hidden />
                      </Button>
                    </Hint>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly ? (
        <div className="flex gap-1.5">
          <Button variant="outline" size="xs" onClick={() => set({ ...dataset, rows: [...dataset.rows, Object.fromEntries(dataset.columns.map((column) => [column, ""]))] })}>
            <Plus aria-hidden />
            Add row
          </Button>
          <Button variant="ghost" size="xs" onClick={() => set(null)}>
            Remove dataset
          </Button>
        </div>
      ) : null}
    </div>
  );
}
