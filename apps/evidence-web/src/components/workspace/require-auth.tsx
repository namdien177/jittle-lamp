import React from "react";
import {
  ClerkDegraded,
  ClerkFailed,
  ClerkLoaded,
  ClerkLoading,
  SignIn,
  SignedIn,
  SignedOut
} from "@clerk/clerk-react";

import { clerkPublishableKey } from "../../env";
import { StatusScreen } from "../status-screen";

const clerkAppearance = {
  variables: {
    colorPrimary: "#22c55e",
    colorBackground: "#111314",
    colorText: "#ededed",
    colorTextSecondary: "#8b9590",
    colorInputBackground: "#0b0d0e",
    colorInputText: "#ededed",
    borderRadius: "0.5rem",
    fontFamily: '"Geist", system-ui, sans-serif'
  },
  elements: {
    card: {
      backgroundColor: "#111314",
      color: "#ededed"
    },
    modalContent: {
      backgroundColor: "#111314",
      color: "#ededed"
    },
    headerTitle: { color: "#ededed" },
    headerSubtitle: { color: "#8b9590" },
    formFieldLabel: { color: "#d7ddd9" },
    formFieldInput: {
      backgroundColor: "#0b0d0e",
      color: "#ededed",
      borderColor: "#303633"
    },
    footerActionText: { color: "#8b9590" },
    footerActionLink: { color: "#4ade80" }
  }
} as const;

export function SignInScreen(): React.JSX.Element {
  const currentUrl = window.location.href;
  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden bg-background p-6">
      <div aria-hidden className="pointer-events-none absolute inset-0 grid-backdrop opacity-40" />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-1/3 left-1/2 h-[60vh] w-[60vh] -translate-x-1/2 rounded-full bg-primary/10 blur-[120px]"
      />
      <div className="relative animate-rise">
        <SignIn
          routing="hash"
          appearance={clerkAppearance}
          forceRedirectUrl={currentUrl}
          fallbackRedirectUrl={currentUrl}
          signUpForceRedirectUrl={currentUrl}
          signUpFallbackRedirectUrl={currentUrl}
        />
      </div>
    </main>
  );
}

/**
 * Clerk-aware auth gate. Renders children only when signed in. While Clerk is
 * loading or unavailable it shows a status screen; when signed out it renders
 * `signedOut` (defaults to the sign-in screen).
 */
export function RequireAuth(props: {
  children: React.ReactNode;
  signedOut?: React.ReactNode;
  notConfigured?: React.ReactNode;
}): React.JSX.Element {
  if (!clerkPublishableKey) {
    return (
      <>
        {props.notConfigured ?? (
          <StatusScreen
            tone="error"
            title="Sign-in is not configured"
            detail="Set CLERK_PUBLISHABLE_KEY to enable the authenticated workspace."
          />
        )}
      </>
    );
  }

  return (
    <>
      <ClerkFailed>
        <StatusScreen
          tone="error"
          title="Unable to load sign-in"
          detail="Check the Clerk publishable key and network access, then reload."
        />
      </ClerkFailed>
      <ClerkDegraded>
        <StatusScreen
          tone="error"
          title="Unable to load sign-in"
          detail="Check the Clerk publishable key and network access, then reload."
        />
      </ClerkDegraded>
      <ClerkLoading>
        <StatusScreen loading title="Preparing your workspace" detail="Verifying your session…" />
      </ClerkLoading>
      <ClerkLoaded>
        <SignedOut>{props.signedOut ?? <SignInScreen />}</SignedOut>
        <SignedIn>{props.children}</SignedIn>
      </ClerkLoaded>
    </>
  );
}
