import React from "react";
import {
  ClerkProvider,
  SignIn as ClerkSignIn,
  SignInButton as ClerkSignInButton,
  SignedIn as ClerkSignedIn,
  SignedOut as ClerkSignedOut,
  UserButton as ClerkUserButton,
  useAuth as useClerkAuth,
  useClerk as useClerkSdk,
} from "@clerk/clerk-react";

import { clerkPublishableKey, devAuth, devAuthEnabled } from "./env";
import { Button } from "./components/ui/button";

type AuthProviderProps = { children: React.ReactNode };
type FetchTokenOptions = Parameters<ReturnType<typeof useClerkAuth>["getToken"]>[0];

export function AuthProvider(props: AuthProviderProps): React.JSX.Element {
  if (devAuthEnabled || !clerkPublishableKey) {
    return <>{props.children}</>;
  }

  return (
    <ClerkProvider publishableKey={clerkPublishableKey}>
      {props.children}
    </ClerkProvider>
  );
}

export function useAuth(): ReturnType<typeof useClerkAuth> {
  if (!devAuthEnabled) {
    return useClerkAuth();
  }

  return {
    isLoaded: true,
    isSignedIn: true,
    userId: devAuth.userId,
    sessionId: "sess_jl_dev",
    sessionClaims: {
      sub: devAuth.userId,
      sid: "sess_jl_dev",
      email: devAuth.email,
      name: devAuth.name,
    },
    actor: null,
    orgId: null,
    orgRole: null,
    orgSlug: null,
    has: () => true,
    getToken: async (_options?: FetchTokenOptions) => devAuth.token,
    signOut: async () => undefined,
  } as unknown as ReturnType<typeof useClerkAuth>;
}

export function useClerk(): ReturnType<typeof useClerkSdk> {
  if (!devAuthEnabled) {
    return useClerkSdk();
  }

  return {
    openUserProfile: () => {
      window.alert(`${devAuth.name}\n${devAuth.email}`);
    },
  } as ReturnType<typeof useClerkSdk>;
}

export function SignedIn(props: { children: React.ReactNode }): React.JSX.Element | null {
  if (devAuthEnabled) return <>{props.children}</>;
  return <ClerkSignedIn>{props.children}</ClerkSignedIn>;
}

export function SignedOut(props: { children: React.ReactNode }): React.JSX.Element | null {
  if (devAuthEnabled) return null;
  return <ClerkSignedOut>{props.children}</ClerkSignedOut>;
}

export function SignInButton(props: {
  children: React.ReactNode;
  mode?: "modal" | "redirect";
}): React.JSX.Element {
  if (devAuthEnabled) return <>{props.children}</>;
  return props.mode ? (
    <ClerkSignInButton mode={props.mode}>{props.children}</ClerkSignInButton>
  ) : (
    <ClerkSignInButton>{props.children}</ClerkSignInButton>
  );
}

export function SignIn(props: React.ComponentProps<typeof ClerkSignIn>): React.JSX.Element {
  if (!devAuthEnabled) {
    return <ClerkSignIn {...props} />;
  }

  return (
    <section className="w-full max-w-sm rounded-lg border border-border-strong bg-card p-6 text-card-foreground shadow-pop">
      <div className="space-y-1">
        <h1 className="font-display text-xl font-semibold">Dev account</h1>
        <p className="text-base text-muted-foreground">{devAuth.email}</p>
      </div>
      <div className="mt-5 rounded-md border border-border bg-secondary px-3 py-2 font-mono text-base text-muted-foreground">
        {devAuth.userId}
      </div>
    </section>
  );
}

export function UserButton(): React.JSX.Element {
  if (!devAuthEnabled) {
    return <ClerkUserButton />;
  }

  const initials = devAuth.name
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <Button
      aria-label={`Dev account: ${devAuth.email}`}
      title={`${devAuth.name} · ${devAuth.email}`}
      variant="outline"
      size="icon-sm"
      onClick={() => window.alert(`${devAuth.name}\n${devAuth.email}`)}
    >
      <span className="text-xs font-bold">{initials || "JL"}</span>
    </Button>
  );
}
