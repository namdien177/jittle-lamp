import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ClerkDegraded,
  ClerkFailed,
  ClerkLoaded,
  ClerkLoading,
  SignIn,
  SignedIn,
  SignedOut,
  useAuth
} from "@clerk/clerk-react";

import { apiOrigin, clerkPublishableKey } from "./env";

type ApprovalState =
  | { status: "idle" | "submitting" }
  | { status: "approved" }
  | { status: "error"; message: string };

const readUserCode = () => new URL(window.location.href).searchParams.get("user_code")?.trim() ?? "";

type DeviceAuthClient = "desktop" | "extension";

const completeDeviceAuth = (input: { token: string; userCode: string; client: DeviceAuthClient }) =>
  fetch(`${apiOrigin}/${input.client}-auth/flows/complete`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json"
    },
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
        if (!token) {
          throw new Error("Your browser session is missing a Clerk token.");
        }

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
      <main className="desktop-auth-page">
        <section className="desktop-auth-panel" aria-live="polite">
          <h1>{props.client === "extension" ? "Extension" : "Desktop"} sign-in approved</h1>
          <p>You can return to Jittle Lamp.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="desktop-auth-page">
      <section className="desktop-auth-panel" aria-live="polite">
        <h1>Connect Jittle Lamp</h1>
        <p>
          {approval.status === "submitting"
            ? `Approving your ${clientLabel} sign-in...`
            : approval.status === "error"
              ? approval.message
              : "Waiting for browser sign-in..."}
        </p>
      </section>
    </main>
  );
}

function DeviceAuthApprovalPage(props: { client: DeviceAuthClient }): React.JSX.Element {
  const currentUrl = window.location.href;
  const clientLabel = props.client === "extension" ? "extension" : "desktop";

  if (!clerkPublishableKey) {
    return (
      <main className="desktop-auth-page">
        <section className="desktop-auth-panel">
          <h1>Clerk is not configured</h1>
          <p>Set CLERK_PUBLISHABLE_KEY before using {clientLabel} browser sign-in.</p>
        </section>
      </main>
    );
  }

  return (
    <>
      <ClerkFailed>
        <main className="desktop-auth-page">
          <section className="desktop-auth-panel">
            <h1>Unable to load sign-in</h1>
            <p>Check the Clerk publishable key and network access.</p>
          </section>
        </main>
      </ClerkFailed>
      <ClerkDegraded>
        <main className="desktop-auth-page">
          <section className="desktop-auth-panel">
            <h1>Unable to load sign-in</h1>
            <p>Check the Clerk publishable key and network access.</p>
          </section>
        </main>
      </ClerkDegraded>
      <ClerkLoading>
        <main className="desktop-auth-page">
          <section className="desktop-auth-panel">
            <h1>Loading sign-in</h1>
          </section>
        </main>
      </ClerkLoading>
      <ClerkLoaded>
        <SignedIn>
          <DeviceAuthApprovalInner client={props.client} />
        </SignedIn>
        <SignedOut>
          <main className="desktop-auth-page">
            <SignIn
              routing="hash"
              forceRedirectUrl={currentUrl}
              fallbackRedirectUrl={currentUrl}
              signUpForceRedirectUrl={currentUrl}
              signUpFallbackRedirectUrl={currentUrl}
            />
          </main>
        </SignedOut>
      </ClerkLoaded>
    </>
  );
}

export function DesktopAuthApprovalPage(): React.JSX.Element {
  return <DeviceAuthApprovalPage client="desktop" />;
}

export function ExtensionAuthApprovalPage(): React.JSX.Element {
  return <DeviceAuthApprovalPage client="extension" />;
}
