import { useEffect } from "react";
import type * as React from "react";

import type { ViewerModalProps } from "./types";

export function ContextMenuPortal(props: ViewerModalProps): React.JSX.Element | null {
  const menu = props.contextMenu;
  useEffect(() => {
    if (!menu.open) return;
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".jl-vm-ctx-menu")) return;
      props.onContextMenuClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [menu.open, props.onContextMenuClose]);

  if (!menu.open || menu.rowId === null) return null;

  if (menu.kind === "network") {
    return (
      <div
        className="jl-vm-ctx-menu"
        style={{ left: menu.x, top: menu.y }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <button
          type="button"
          className="jl-vm-ctx-item"
          onClick={() => {
            if (menu.rowId) props.onCopyCurl?.(menu.rowId);
            props.onContextMenuClose();
          }}
        >
          Copy cURL
        </button>
        <button
          type="button"
          className="jl-vm-ctx-item"
          onClick={() => {
            if (menu.rowId) props.onCopyResponse?.(menu.rowId);
            props.onContextMenuClose();
          }}
        >
          Copy response
        </button>
      </div>
    );
  }

  return (
    <div
      className="jl-vm-ctx-menu"
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {menu.canMerge ? (
        <button
          type="button"
          className="jl-vm-ctx-item"
          onClick={() => {
            props.onContextMenuMerge?.();
            props.onContextMenuClose();
          }}
        >
          Merge actions
        </button>
      ) : null}
      {menu.canUnmerge ? (
        <button
          type="button"
          className="jl-vm-ctx-item"
          onClick={() => {
            props.onContextMenuUnmerge?.();
            props.onContextMenuClose();
          }}
        >
          Un-merge
        </button>
      ) : null}
    </div>
  );
}
