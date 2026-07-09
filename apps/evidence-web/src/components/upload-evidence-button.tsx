import React, { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { UploadCloud } from "lucide-react";
import { useNavigate } from "react-router";

import { type FetchToken } from "../api";
import { useAuth } from "../auth";
import {
  InvalidEvidenceUploadError,
  type ManualEvidenceUploadResult,
  UnsupportedUploadFileError,
  uploadManualEvidenceFile,
} from "../manual-upload";
import { useToast } from "../toast";
import { Button, type ButtonProps } from "./ui/button";
import { Spinner } from "./ui/misc";

const uploadAccept =
  ".zip,.mp4,.webm,.webp,application/zip,application/x-zip-compressed,video/mp4,video/webm,image/webp";

type UploadEvidenceButtonProps = {
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  label?: string;
  iconOnly?: boolean;
  navigateOnUpload?: boolean;
  onUploaded?: (result: ManualEvidenceUploadResult) => void;
};

export function UploadEvidenceButton(
  props: UploadEvidenceButtonProps,
): React.JSX.Element {
  const auth = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const label = props.label ?? "Upload";
  const getToken: FetchToken = () => auth.getToken();

  const handleFile = async (file: File): Promise<void> => {
    if (uploading) return;
    if (!auth.isSignedIn) {
      toast.error("Sign in required", "Sign in before upload.");
      return;
    }

    setUploading(true);
    try {
      const result = await uploadManualEvidenceFile({ file, getToken });
      await queryClient.invalidateQueries({ queryKey: ["evidences"] });
      props.onUploaded?.(result);

      if (result.generatedArchive) {
        toast.warning(
          "Uploaded with empty log",
          "No trace was found. A blank session JSON was created.",
        );
      } else {
        toast.success("Evidence uploaded", result.title);
      }

      if (props.navigateOnUpload !== false) {
        navigate(`/evidence/${encodeURIComponent(result.evidenceId)}`);
      }
    } catch (error) {
      if (
        error instanceof UnsupportedUploadFileError ||
        error instanceof InvalidEvidenceUploadError
      ) {
        toast.warning(
          "No session created",
          error instanceof InvalidEvidenceUploadError
            ? error.message
            : "Upload ZIP, MP4, WebM, or WebP. Other files are not changed into JSON.",
        );
      } else {
        toast.error(
          "Upload failed",
          error instanceof Error ? error.message : undefined,
        );
      }
    } finally {
      setUploading(false);
    }
  };

  return (
    <>
      <Button
        variant={props.variant ?? "primary"}
        size={props.size ?? (props.iconOnly ? "icon-sm" : "sm")}
        className={props.className}
        disabled={uploading}
        aria-label={props.iconOnly ? "Upload evidence" : undefined}
        title={props.iconOnly ? "Upload evidence" : undefined}
        onClick={() => inputRef.current?.click()}
      >
        {uploading ? <Spinner /> : <UploadCloud aria-hidden />}
        {props.iconOnly ? null : uploading ? "Uploading..." : label}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept={uploadAccept}
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void handleFile(file);
        }}
      />
    </>
  );
}
