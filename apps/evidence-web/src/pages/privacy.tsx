import React from "react";

import { PublicTopbar } from "../components/public-topbar";

const SECTIONS: Array<{ heading: string; body: string }> = [
  {
    heading: "Overview",
    body: "Jittle Lamp is a local browser recording and evidence review tool. The extension records browser activity only when you start a capture, and recorded sessions are intended to stay on your machine unless you choose to export or share them.",
  },
  {
    heading: "Data we handle",
    body: "A recording can include the page URL, screen recording, network request and response details, console output, and other diagnostic events from the captured browser session. This data may include personal or sensitive information if it appears in the pages, requests, or responses you record.",
  },
  {
    heading: "How data is used",
    body: "Captured data is used to help you replay, review, debug, and share browser sessions. We do not sell your data. We do not use captured session data for advertising.",
  },
  {
    heading: "Sharing",
    body: "Session files remain under your control. If you export, upload, or share a session, the people or services you share it with may be able to view the included recording and diagnostic data.",
  },
  {
    heading: "Retention",
    body: "Locally saved sessions remain on your device until you delete them. Shared or uploaded sessions are retained only as needed to provide the sharing or review functionality you selected.",
  },
  {
    heading: "Contact",
    body: "For privacy questions, contact the Jittle Lamp maintainer through the support channel listed in the Chrome Web Store listing.",
  },
];

export function PrivacyPage(): React.JSX.Element {
  return (
    <div className="min-h-screen bg-background">
      <PublicTopbar />
      <main className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
        <p className="jl-eyebrow">
          Jittle Lamp
        </p>
        <h1 className="mt-2 font-display text-4xl font-bold">
          Privacy Policy
        </h1>
        <p className="mt-2 text-base text-muted-foreground">
          Last updated: April 27, 2026
        </p>
        <div className="mt-10 space-y-10">
          {SECTIONS.map((section) => (
            <section
              key={section.heading}
              className="border-t border-border pt-6"
            >
              <h2 className="font-display text-lg font-bold">
                {section.heading}
              </h2>
              <p className="mt-2 leading-relaxed text-muted-foreground">
                {section.body}
              </p>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
