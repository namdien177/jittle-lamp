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

import { clerkAppearance } from "../../clerk-appearance";
import { clerkPublishableKey } from "../../env";
import { StatusScreen } from "../status-screen";

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
        <StatusScreen loading title="Loading workspace" />
      </ClerkLoading>
      <ClerkLoaded>
        <SignedOut>{props.signedOut ?? <SignInScreen />}</SignedOut>
        <SignedIn>{props.children}</SignedIn>
      </ClerkLoaded>
    </>
  );
}
