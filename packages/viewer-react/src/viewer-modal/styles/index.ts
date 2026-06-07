import { contextMenuStyles } from "./context-menu";
import { drawerStyles } from "./drawer";
import { evidenceStyles } from "./evidence";
import { feedbackStyles } from "./feedback";
import { headerStyles } from "./header";
import { notesStyles } from "./notes";
import { responsiveStyles } from "./responsive";
import { shellStyles } from "./shell";
import { videoStyles } from "./video";

export const VIEWER_MODAL_STYLE_ID = "jl-viewer-modal-styles";

// Concatenated in cascade order: structural shells first, component skins next,
// responsive overrides last. Each fragment lives next to nothing in particular —
// the matching component file owns the markup; this directory owns the CSS text.
export const viewerModalStyles = [
  shellStyles,
  headerStyles,
  videoStyles,
  notesStyles,
  evidenceStyles,
  drawerStyles,
  contextMenuStyles,
  feedbackStyles,
  responsiveStyles
].join("\n");
