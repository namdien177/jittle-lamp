import { VIEWER_MODAL_STYLE_ID, viewerModalStyles } from "./styles";

export function injectStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(VIEWER_MODAL_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = VIEWER_MODAL_STYLE_ID;
  style.textContent = viewerModalStyles;
  document.head.append(style);
}
