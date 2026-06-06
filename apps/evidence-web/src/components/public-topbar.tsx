import React from "react";
import { Link } from "react-router";
import { SignInButton, SignedIn, SignedOut } from "@clerk/clerk-react";

import { clerkPublishableKey } from "../env";
import { Wordmark } from "./brand";
import { buttonVariants } from "./ui/button";
import { cn } from "../lib/cn";

/** Slim header for public / standalone pages (landing, privacy, quick view). */
export function PublicTopbar(): React.JSX.Element {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/65">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link to="/" aria-label="Jittle Lamp home">
          <Wordmark />
        </Link>
        <nav className="flex items-center gap-1 sm:gap-2" aria-label="Primary">
          <Link
            to="/quick-view"
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "hidden sm:inline-flex")}
          >
            Quick view
          </Link>
          <Link to="/privacy" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
            Privacy
          </Link>
          {clerkPublishableKey ? (
            <>
              <SignedOut>
                <SignInButton mode="modal">
                  <button className={cn(buttonVariants({ variant: "primary", size: "sm" }))}>
                    Sign in
                  </button>
                </SignInButton>
              </SignedOut>
              <SignedIn>
                <Link to="/" className={cn(buttonVariants({ variant: "primary", size: "sm" }))}>
                  Open workspace
                </Link>
              </SignedIn>
            </>
          ) : null}
        </nav>
      </div>
    </header>
  );
}
