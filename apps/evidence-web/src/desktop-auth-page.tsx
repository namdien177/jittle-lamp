import React, { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/clerk-react";

import { StatusScreen } from "./components/status-screen";
import { RequireAuth } from "./components/workspace/require-auth";
import { apiOrigin } from "./env";

type ApprovalState =
  | { status: "idle" | "submitting" }
  | { status: "approved" }
  | { status: "error"; message: string };

const readUserCode = (): string =>
  new URL(window.location.href).searchParams.get("user_code")?.trim() ?? "";

type DeviceAuthClient = "desktop" | "extension";

const completeDeviceAuth = (input: { token: string; userCode: string; client: DeviceAuthClient }) =>
  fetch(`${apiOrigin}/${input.client}-auth/flows/complete`, {
    method: "POST",
    headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
    body: JSON.stringify({ userCode: input.userCode })
  });

function DeviceAuthApprovalInner(props: { client: DeviceAuthClient }): React.JSX.Element {
  const { getToken } = useAuth();
  const submittedRef = useRef(false);
  const userCode = useMemo(() => readUserCode(), []);
  const clientLabel = props.client === "extension" ? "extension" : "desktop";
  const [approval, setApproval] = useState<ApprovalState>(
    userCode ? { status: "idle" } : { status: "error", message: `Missing ${clientLabel} sign-in code.` }
  );

  useEffect(() => {
    if (!userCode || submittedRef.current) return;
    submittedRef.current = true;

    const approve = async (): Promise<void> => {
      setApproval({ status: "submitting" });
      try {
        const token = await getToken({ skipCache: true });
        if (!token) throw new Error("Your browser session is missing a Clerk token.");

        let response = await completeDeviceAuth({ token, userCode, client: props.client });
        if (response.status === 401) {
          const retryToken = await getToken({ skipCache: true });
          if (retryToken && retryToken !== token) {
            response = await completeDeviceAuth({ token: retryToken, userCode, client: props.client });
          }
        }
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
          throw new Error(payload?.error?.message ?? `Unable to approve the ${clientLabel} sign-in request.`);
        }
        setApproval({ status: "approved" });
      } catch (error) {
        submittedRef.current = false;
        setApproval({
          status: "error",
          message: error instanceof Error ? error.message : `Unable to approve the ${clientLabel} sign-in request.`
        });
      }
    };
    void approve();
  }, [clientLabel, getToken, props.client, userCode]);

  if (approval.status === "approved") {
    return (
      <StatusScreen
        title={`${props.client === "extension" ? "Extension" : "Desktop"} sign-in approved`}
        detail="You can return to Jittle Lamp."
      />
    );
  }

  return (
    <StatusScreen
      loading={approval.status === "submitting"}
      tone={approval.status === "error" ? "error" : "neutral"}
      title="Connect Jittle Lamp"
      detail={
        approval.status === "submitting"
          ? `Approving your ${clientLabel} sign-in…`
          : approval.status === "error"
            ? approval.message
            : "Waiting for browser sign-in…"
      }
    />
  );
}

function DeviceAuthApprovalPage(props: { client: DeviceAuthClient }): React.JSX.Element {
  return (
    <RequireAuth>
      <DeviceAuthApprovalInner client={props.client} />
    </RequireAuth>
  );
}

export function DesktopAuthApprovalPage(): React.JSX.Element {
  return <DeviceAuthApprovalPage client="desktop" />;
}

export function ExtensionAuthApprovalPage(): React.JSX.Element {
  return <DeviceAuthApprovalPage client="extension" />;
}
