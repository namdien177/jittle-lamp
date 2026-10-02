// Keyboard map of the step editor (design.md §7 table). Pure: maps a key event and the row
// context to a command, so the map is tested without a DOM and the component stays a dispatcher.

export type EditorKey = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  // IME composition in progress: never act on it.
  isComposing?: boolean;
};

export type EditorKeyContext = {
  // Where focus is: the type chip button or the instruction field of a row.
  target: "chip" | "field" | "heading";
  pickerOpen: boolean;
  fieldEmpty: boolean;
  caretAtStart: boolean;
  caretAtEnd: boolean;
  // macOS uses ⌘, other platforms Ctrl.
  isMac: boolean;
};

export type EditorCommand =
  | "picker-next"
  | "picker-prev"
  | "picker-accept"
  | "picker-close"
  | "type-next"
  | "type-prev"
  | "run"
  | "run-from-here"
  | "duplicate-row"
  | "move-up"
  | "move-down"
  | "toggle-disabled"
  | "new-row"
  | "delete-row"
  | "focus-prev"
  | "focus-next";

export function editorKeyCommand(event: EditorKey, context: EditorKeyContext): EditorCommand | null {
  if (event.isComposing) return null;
  const mod = context.isMac ? Boolean(event.metaKey) : Boolean(event.ctrlKey);
  const shift = Boolean(event.shiftKey);
  const alt = Boolean(event.altKey);

  if (context.pickerOpen) {
    if (event.key === "ArrowDown") return "picker-next";
    if (event.key === "ArrowUp") return "picker-prev";
    if ((event.key === "Enter" && !mod) || event.key === "Tab") return "picker-accept";
    if (event.key === "Escape") return "picker-close";
  }

  if (context.target === "chip" && event.key === "Tab" && !mod && !alt) return shift ? "type-prev" : "type-next";

  if (event.key === "Enter" && mod) return "run";
  if (event.key === "Enter" && alt && !mod) return "run-from-here";
  if (mod && !alt && (event.key === "d" || event.key === "D")) return "duplicate-row";
  if (mod && shift && event.key === "ArrowUp") return "move-up";
  if (mod && shift && event.key === "ArrowDown") return "move-down";
  if (mod && !shift && (event.key === "/" || event.key === "?")) return "toggle-disabled";
  if (event.key === "Enter" && !shift && !mod && !alt) return "new-row";
  if (event.key === "Backspace" && !mod && context.fieldEmpty && context.target !== "chip") return "delete-row";
  if (event.key === "ArrowUp" && !mod && !shift && !alt && context.caretAtStart) return "focus-prev";
  if (event.key === "ArrowDown" && !mod && !shift && !alt && context.caretAtEnd) return "focus-next";
  return null;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad/i.test(platform);
}
