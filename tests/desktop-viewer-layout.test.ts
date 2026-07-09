import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { viewerModalStyles as css } from "../packages/viewer-react/src/viewer-modal/styles";

const evidencePaneSource = readFileSync(
  new URL("../packages/viewer-react/src/viewer-modal/evidence-pane.tsx", import.meta.url),
  "utf8"
);

const modalHeaderSource = readFileSync(
  new URL("../packages/viewer-react/src/viewer-modal/modal-header.tsx", import.meta.url),
  "utf8"
);

const notesPaneSource = readFileSync(
  new URL("../packages/viewer-react/src/viewer-modal/notes-pane.tsx", import.meta.url),
  "utf8"
);

const videoPlayerSource = readFileSync(
  new URL("../packages/viewer-react/src/viewer-modal/video-player.tsx", import.meta.url),
  "utf8"
);

function expectScrollbarGutterOnOverflowRule(selector: string): void {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = css.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`))?.[1];
  expect(rule).toContain("scrollbar-gutter: stable;");
  expect(rule).toMatch(/overflow(?:-[xy])?:\s*(auto|scroll);/);
}

describe("viewer modal layout CSS", () => {

  test("modal occupies ~90% of the viewport on each axis", () => {
    expect(css).toMatch(/\.jl-vm-modal,\s*\.jl-vm-root\s*\{[\s\S]*?width:\s*min\(90vw,[^)]+\);/);
    expect(css).toMatch(/\.jl-vm-modal,\s*\.jl-vm-root\s*\{[\s\S]*?height:\s*90vh;/);
  });

  test("page mode uses a single root layer", () => {
    expect(css).not.toContain(".jl-vm-page");
    expect(css).toMatch(/\.jl-vm-root\s*\{[\s\S]*?height:\s*100%;/);
  });

  test("two-pane body keeps video flexible and stream pane resizable", () => {
    expect(css).toMatch(/\.jl-vm-body\s*\{[\s\S]*?display:\s*flex;/);
    expect(css).toMatch(/\.jl-vm-left\s*\{[\s\S]*?flex:\s*1 1 auto;/);
    expect(css).toMatch(/\.jl-vm-right\s*\{[\s\S]*?flex:\s*0 0 min\(var\(--jl-vm-stream-width,\s*560px\),\s*50vw\);/);
    expect(css).toMatch(/\.jl-vm-right\[data-collapsed="true"\]\s*\{[\s\S]*?flex-basis:\s*48px;/);
  });

  test("left/right panes can shrink without forcing layout overflow", () => {
    expect(css).toMatch(/\.jl-vm-left\s*\{[\s\S]*?min-width:\s*0;/);
    expect(css).toMatch(/\.jl-vm-right\s*\{[\s\S]*?min-width:\s*0;/);
  });

  test("video player fills the available pane without cropping", () => {
    expect(videoPlayerSource).toContain('<div className="jl-vm-video-host" data-vjs-player>');
    expect(videoPlayerSource).toContain('className="video-js"');
    expect(videoPlayerSource).not.toMatch(/className="jl-vm-video-inner"[\s\S]{0,160}data-vjs-player/);
    expect(css).not.toContain(".video-js button");
    expect(css).toMatch(/\.jl-vm-video-inner\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;/);
    expect(css).toMatch(/\.jl-vm-video-inner \.jl-vm-video-host,\s*\.jl-vm-video-inner \.video-js\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0;[\s\S]*?overflow:\s*hidden;/);
    expect(css).toMatch(/\.jl-vm-video-inner \.video-js\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;/);
    expect(css).toMatch(/\.jl-vm-video-inner \.video-js \.vjs-tech,\s*\.jl-vm-video-inner \.jl-vm-video-host \.vjs-tech\s*\{[\s\S]*?object-fit:\s*contain;/);
  });

  test("custom video play button centers icons with flex", () => {
    expect(css).toMatch(/\.jl-vm-video-inner button\.jl-vm-vc-surface\s*\{[\s\S]*?display:\s*block;/);
    expect(css).toMatch(/\.jl-vm-video-inner button\.jl-vm-vc-bigplay\s*\{[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*center;[\s\S]*?justify-content:\s*center;/);
    expect(css).toMatch(/\.jl-vm-video-inner button\.jl-vm-vc-bigplay svg,\s*\.jl-vm-video-inner button\.jl-vm-vc-play svg,\s*\.jl-vm-video-inner button\.jl-vm-vc-icon svg\s*\{[\s\S]*?display:\s*block;/);
    expect(css).toMatch(/\.jl-vm-video-inner button\.jl-vm-vc-play,\s*\.jl-vm-video-inner button\.jl-vm-vc-icon,\s*\.jl-vm-video-inner button\.jl-vm-vc-rate\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?align-items:\s*center;[\s\S]*?justify-content:\s*center;/);
    expect(css).toMatch(/\.jl-vm-video-inner button\.jl-vm-vc-play\s*\{[\s\S]*?background:\s*#fff;/);
    expect(css).toMatch(/\.jl-vm-video-inner button\.jl-vm-vc-icon\s*\{[\s\S]*?background:\s*transparent;/);
  });

  test("custom video controls reflow inside narrow video containers", () => {
    expect(css).toMatch(/\.jl-vm-video-inner\s*\{[\s\S]*?container-type:\s*inline-size;/);
    expect(css).toContain("@container (max-width: 560px)");
    expect(css).toMatch(/\.jl-vm-vc-bar\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-rows:\s*32px 24px;/);
    expect(css).toMatch(/\.jl-vm-vc-progress\s*\{[\s\S]*?grid-column:\s*1 \/ -1;[\s\S]*?grid-row:\s*2;/);
    expect(css).toMatch(/\.jl-vm-video-inner button\.jl-vm-vc-mute\s*\{[\s\S]*?grid-column:\s*4;/);
    expect(css).toMatch(/\.jl-vm-video-inner button\.jl-vm-vc-fullscreen\s*\{[\s\S]*?grid-column:\s*6;/);
  });

  test("header actions collapse to tooltip-backed icon buttons below 1200px", () => {
    expect(css).toContain("@media (max-width: 1199px)");
    expect(css).toMatch(/\.jl-vm-actions \.jl-vm-btn\s*\{[\s\S]*?width:\s*32px;[\s\S]*?height:\s*32px;[\s\S]*?padding:\s*0;/);
    expect(css).toMatch(/\.jl-vm-actions \.jl-vm-btn-label\s*\{[\s\S]*?clip-path:\s*inset\(50%\);/);
    expect(css).toMatch(/\.jl-vm-actions \.jl-vm-btn::after\s*\{[\s\S]*?content:\s*attr\(data-label\);[\s\S]*?opacity:\s*0;/);
    expect(css).toMatch(/\.jl-vm-actions \.jl-vm-btn:hover::after,\s*\.jl-vm-actions \.jl-vm-btn:focus-visible::after\s*\{[\s\S]*?opacity:\s*1;/);
    expect(modalHeaderSource).toContain('data-label={props.label}');
    expect(modalHeaderSource).toContain('aria-label={props.label}');
    expect(modalHeaderSource).toContain('className="jl-vm-btn-label"');
  });

  test("session tags render as a horizontal rail between video and discussion", () => {
    expect(notesPaneSource.indexOf("<EvidenceVideoPlayer")).toBeLessThan(
      notesPaneSource.indexOf("<SessionTagRail")
    );
    expect(notesPaneSource.indexOf("<SessionTagRail")).toBeLessThan(
      notesPaneSource.indexOf('className="jl-vm-discussion"')
    );
    expect(notesPaneSource).toContain('Add tags');
    expect(modalHeaderSource).not.toContain("<HeaderTags");
    expect(css).toMatch(/\.jl-vm-tagbar-list\s*\{[\s\S]*?flex-wrap:\s*nowrap;[\s\S]*?overflow-x:\s*auto;[\s\S]*?overflow-y:\s*hidden;/);
    expect(css).toMatch(/\.jl-vm-tag-pill\s*\{[\s\S]*?flex:\s*0 0 auto;/);
    expect(css).toMatch(/\.jl-vm-tag-picker\s*\{[\s\S]*?flex:\s*0 0 auto;/);
  });

  test("discussion composer starts as compact chat input and grows to two rows", () => {
    expect(notesPaneSource).toContain("const COMPOSER_MAX_ROWS = 2");
    expect(notesPaneSource).toContain("resizeComposerTextarea");
    expect(notesPaneSource).toContain("rows={1}");
    expect(notesPaneSource).toContain("Send");
    expect(css).toMatch(/\.jl-vm-composer\s*\{[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*flex-end;[\s\S]*?padding:\s*6px;/);
    expect(css).toMatch(/\.jl-vm-composer \.jl-vm-notes-textarea\s*\{[\s\S]*?min-height:\s*34px;[\s\S]*?max-height:\s*58px;/);
    expect(css).toMatch(/\.jl-vm-composer \.jl-vm-btn\s*\{[\s\S]*?min-height:\s*32px;/);
  });

  test("evidence tabs, filters, and list can scroll sideways on narrow panes", () => {
    expect(css).toMatch(/\.jl-vm-tabs-row\s*\{[\s\S]*?overflow-x:\s*auto;[\s\S]*?overflow-y:\s*hidden;/);
    expect(css).toMatch(/\.jl-vm-filters\s*\{[\s\S]*?overflow-x:\s*auto;[\s\S]*?overflow-y:\s*hidden;/);
    expect(css).toMatch(/\.jl-vm-chip\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?white-space:\s*nowrap;/);
    expect(css).toMatch(/\.jl-vm-list\s*\{[\s\S]*?overflow:\s*auto;/);
    expect(css).toMatch(/\.jl-vm-row\s*\{[\s\S]*?min-width:\s*360px;/);
    expect(css).toMatch(/\.jl-vm-row\[data-kind="network"\]\s*\{[\s\S]*?min-width:\s*520px;/);
  });

  test("viewer scroll surfaces reserve stable scrollbar gutter", () => {
    expectScrollbarGutterOnOverflowRule(".jl-vm-tabs-row");
    expectScrollbarGutterOnOverflowRule(".jl-vm-filters");
    expectScrollbarGutterOnOverflowRule(".jl-vm-list");
    expectScrollbarGutterOnOverflowRule(".jl-vm-drawer-body");
    expectScrollbarGutterOnOverflowRule(".jl-vm-about");
    expectScrollbarGutterOnOverflowRule(".jl-vm-tagbar-list");
    expectScrollbarGutterOnOverflowRule(".jl-vm-tag-options");
    expectScrollbarGutterOnOverflowRule(".jl-vm-comments");
    expectScrollbarGutterOnOverflowRule(".jl-vm-pre");
  });

  test("evidence rows are square until hovered or active", () => {
    expect(css).toMatch(/\.jl-vm-row\s*\{[\s\S]*?border-radius:\s*0;/);
    expect(css).toMatch(/\.jl-vm-row:hover\s*\{[\s\S]*?border-radius:\s*8px;/);
    expect(css).toMatch(/\.jl-vm-row\[data-active="true"\]\s*\{[\s\S]*?border-radius:\s*8px;/);
  });

  test("pane heading count stays aligned and becomes number-only on mobile", () => {
    expect(css).not.toContain(".jl-vm-pane-heading > div");
    expect(evidencePaneSource).toContain('className="jl-vm-pane-title"');
    expect(css).toMatch(/\.jl-vm-pane-title\s*\{[\s\S]*?flex-direction:\s*column;/);
    expect(css).toMatch(/\.jl-vm-pane-heading \.jl-vm-pane-heading-actions\s*\{[\s\S]*?align-items:\s*center;[\s\S]*?align-self:\s*center;/);
    expect(css).toMatch(/\.jl-vm-pane-count\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?min-height:\s*28px;/);
    expect(css).toMatch(/\.jl-vm-pane-count::before\s*\{[\s\S]*?content:\s*attr\(data-count\);/);
    expect(evidencePaneSource).toContain("title={activeCountTitle}");
    expect(evidencePaneSource).toContain('"Number of actions"');
  });

  test("drawer can grow to at most 70% of the right pane", () => {
    expect(css).toMatch(/\.jl-vm-drawer\s*\{[\s\S]*?max-height:\s*70%;/);
  });

  test("row labels truncate instead of pushing the layout", () => {
    expect(css).toMatch(/\.jl-vm-row-label\s*\{[\s\S]*?min-width:\s*0;/);
    expect(css).toMatch(/\.jl-vm-row-label\s*\{[\s\S]*?text-overflow:\s*ellipsis;/);
  });
});
