import React from "react";
import { FileText, FlaskConical } from "lucide-react";

import { PageBody, PageHeader } from "../components/page";
import { Badge } from "../components/ui/badge";
import { Card, CardContent } from "../components/ui/card";

type Variant = "test-cases" | "documents";

const COPY: Record<Variant, {
  eyebrow: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  bullets: Array<{ title: string; body: string }>;
}> = {
  "test-cases": {
    eyebrow: "Coming soon",
    title: "Test cases",
    description:
      "Author, organise, and version reusable test cases — then link each run to the evidence that proves it passed.",
    icon: <FlaskConical aria-hidden />,
    bullets: [
      { title: "Structured suites", body: "Group cases into suites and tag by feature, priority, or release." },
      { title: "Linked evidence", body: "Attach captured sessions directly to a case run for instant traceability." },
      { title: "Status at a glance", body: "Track pass / fail / blocked across environments and builds." }
    ]
  },
  documents: {
    eyebrow: "Coming soon",
    title: "Documents",
    description:
      "Keep test plans, specs, and QA reports beside the evidence they describe — searchable and shareable with your org.",
    icon: <FileText aria-hidden />,
    bullets: [
      { title: "Living test plans", body: "Draft plans in-app and reference them from cases and evidence." },
      { title: "Org-scoped sharing", body: "Same secure, organisation-scoped access model as your evidence." },
      { title: "Export anywhere", body: "Download as portable files whenever you need an offline copy." }
    ]
  }
};

export function ComingSoonPage({ variant }: { variant: Variant }): React.JSX.Element {
  const copy = COPY[variant];
  return (
    <>
      <PageHeader eyebrow={copy.eyebrow} title={copy.title} description={copy.description} />
      <PageBody>
        <Card className="jl-page-band overflow-hidden">
          <div className="relative grid gap-8 p-8 md:grid-cols-[auto_1fr] md:items-center">
            <div className="relative flex size-20 items-center justify-center rounded-md border border-primary/30 bg-primary/10 text-primary [&_svg]:size-9">
              {copy.icon}
            </div>
            <div className="relative space-y-3">
              <Badge variant="brand">On the roadmap</Badge>
              <p className="max-w-xl text-base leading-relaxed text-muted-foreground">
                This area of the workspace is being built. The evidence you capture today will plug
                straight into it — nothing you record now goes to waste.
              </p>
            </div>
          </div>
        </Card>
        <div className="grid gap-4 sm:grid-cols-3">
          {copy.bullets.map((bullet) => (
            <Card key={bullet.title} className="jl-proto-card">
              <CardContent className="space-y-1.5 p-5">
                <p className="text-base font-semibold text-foreground">{bullet.title}</p>
                <p className="text-base text-muted-foreground">{bullet.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </PageBody>
    </>
  );
}
