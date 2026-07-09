import type * as React from "react";
import { ArrowRightLeft, Bot, Copy, Download, Link, Pencil, X } from "lucide-react";

import type { ViewerModalProps } from "./types";

type HeaderActionButtonProps = {
  label: string;
  icon: React.ReactNode;
  children?: React.ReactNode | undefined;
  disabled?: boolean | undefined;
  iconOnly?: boolean | undefined;
  primary?: boolean | undefined;
  onClick?: React.MouseEventHandler<HTMLButtonElement> | undefined;
};

function getHeaderActionButtonClassName(props: HeaderActionButtonProps): string {
  const classNames = ["jl-vm-btn"];

  if (props.primary) {
    classNames.push("jl-vm-btn-primary");
  }

  if (props.iconOnly) {
    classNames.push("jl-vm-btn-icon");
  }

  return classNames.join(" ");
}

function HeaderActionLabel(props: { children?: React.ReactNode | undefined }): React.JSX.Element | null {
  if (props.children === undefined || props.children === null || props.children === false) {
    return null;
  }

  return <span className="jl-vm-btn-label">{props.children}</span>;
}

function HeaderActionButton(props: HeaderActionButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={getHeaderActionButtonClassName(props)}
      disabled={props.disabled}
      data-label={props.label}
      aria-label={props.label}
      onClick={props.onClick}
    >
      {props.icon}
      <HeaderActionLabel>{props.children}</HeaderActionLabel>
    </button>
  );
}

function TitleMeta(props: { value?: string | null | undefined }): React.JSX.Element | null {
  if (!props.value) {
    return null;
  }

  return <span className="jl-vm-title-meta">{props.value}</span>;
}

function getCreateShareLinkLabel(creating?: boolean): string {
  if (creating) {
    return "Creating…";
  }

  return "Create share link";
}

function getRenameLabel(renaming?: boolean): string {
  if (renaming) {
    return "Saving…";
  }

  return "Edit name";
}

function getCopyLlmPromptLabel(copying?: boolean): string {
  if (copying) {
    return "Preparing…";
  }

  return "Copy to LLM";
}

function getDownloadZipLabel(downloading?: boolean): string {
  if (downloading) {
    return "Preparing…";
  }

  return "Download ZIP";
}

export function ViewerModalHeader(props: ViewerModalProps): React.JSX.Element {
  const showCopyLink = props.shareLinkUrl !== null && props.onCopyShareLink !== undefined;
  const showCreateLink =
    props.isOwner && props.shareLinkUrl === null && props.onCreateShareLink !== undefined;
  const showRename = props.onRename !== undefined;
  const showCopyEvidence = props.onCopyEvidence !== undefined;
  const showCopyLlmPrompt = props.onCopyLlmPrompt !== undefined;
  const showTransferEvidence = props.onTransferEvidence !== undefined;
  const showDownloadZip = props.onDownloadZip !== undefined;
  const isPage = (props.mode ?? "modal") === "page";
  const closeLabel = props.closeLabel ?? "Close viewer";
  const actions: React.JSX.Element[] = [];

  if (showCopyLink) {
    actions.push(
      <HeaderActionButton
        key="copy-share-link"
        label="Copy share link"
        icon={<Copy aria-hidden size={14} strokeWidth={2} />}
        onClick={props.onCopyShareLink}
      >
        Copy share link
      </HeaderActionButton>
    );
  }

  if (showCreateLink) {
    const label = getCreateShareLinkLabel(props.creatingShareLink);

    actions.push(
      <HeaderActionButton
        key="create-share-link"
        label={label}
        icon={<Link aria-hidden size={14} strokeWidth={2} />}
        primary
        disabled={props.creatingShareLink}
        onClick={props.onCreateShareLink}
      >
        {label}
      </HeaderActionButton>
    );
  }

  if (showRename) {
    const label = getRenameLabel(props.renaming);

    actions.push(
      <HeaderActionButton
        key="rename"
        label={label}
        icon={<Pencil aria-hidden size={14} strokeWidth={2} />}
        disabled={props.renaming}
        onClick={props.onRename}
      >
        {label}
      </HeaderActionButton>
    );
  }

  if (showCopyEvidence) {
    actions.push(
      <HeaderActionButton
        key="copy-evidence"
        label="Copy"
        icon={<Copy aria-hidden size={14} strokeWidth={2} />}
        onClick={props.onCopyEvidence}
      >
        Copy
      </HeaderActionButton>
    );
  }

  if (showCopyLlmPrompt) {
    const label = getCopyLlmPromptLabel(props.copyingLlmPrompt);

    actions.push(
      <HeaderActionButton
        key="copy-llm-prompt"
        label={label}
        icon={<Bot aria-hidden size={14} strokeWidth={2} />}
        primary
        disabled={props.copyingLlmPrompt}
        onClick={props.onCopyLlmPrompt}
      >
        {label}
      </HeaderActionButton>
    );
  }

  if (showTransferEvidence) {
    actions.push(
      <HeaderActionButton
        key="transfer-evidence"
        label="Transfer"
        icon={<ArrowRightLeft aria-hidden size={14} strokeWidth={2} />}
        onClick={props.onTransferEvidence}
      >
        Transfer
      </HeaderActionButton>
    );
  }

  if (showDownloadZip) {
    const label = getDownloadZipLabel(props.downloadingZip);

    actions.push(
      <HeaderActionButton
        key="download-zip"
        label={label}
        icon={<Download aria-hidden size={14} strokeWidth={2} />}
        disabled={props.downloadingZip}
        onClick={props.onDownloadZip}
      >
        {label}
      </HeaderActionButton>
    );
  }

  let closeButtonLabel: React.ReactNode;
  let closeButtonIconOnly = true;

  if (isPage && props.closeLabel) {
    closeButtonLabel = closeLabel;
    closeButtonIconOnly = false;
  }

  actions.push(
    <HeaderActionButton
      key="close"
      label={closeLabel}
      icon={<X aria-hidden size={16} strokeWidth={2} />}
      iconOnly={closeButtonIconOnly}
      onClick={props.onClose}
    >
      {closeButtonLabel}
    </HeaderActionButton>
  );

  return (
    <header className="jl-vm-header">
      <div className="jl-vm-header-left">
        <div className="jl-vm-heading">
          <span className="jl-vm-title">{props.title}</span>
          <TitleMeta value={props.titleMeta} />
        </div>
      </div>
      <div className="jl-vm-actions">{actions}</div>
    </header>
  );
}
