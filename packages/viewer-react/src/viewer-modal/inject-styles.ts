import { VIEWER_MODAL_STYLE_ID, viewerModalStyles } from "./styles";

export function injectStyles(): void {
  if (typeof document === "undefined") return;
  const existingStyle = document.getElementById(VIEWER_MODAL_STYLE_ID);
  if (existingStyle) {
    if (existingStyle.textContent !== viewerModalStyles) {
      existingStyle.textContent = viewerModalStyles;
    }
    return;
  }
  const style = document.createElement("style");
  style.id = VIEWER_MODAL_STYLE_ID;
  style.textContent = viewerModalStyles;
  document.head.append(style);
}
