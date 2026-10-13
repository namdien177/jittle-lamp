import React from "react";
import { useParams } from "react-router";

import { StatusScreen } from "../components/status-screen";
import { RunView } from "../test-runs/run-view";

// /test-runs/:runId: the run view with its own header (back link, title, status, cancel). The
// case page embeds the same view without the header.
export function TestRunPage(): React.JSX.Element {
  const { runId } = useParams();
  if (!runId) return <StatusScreen tone="error" title="Missing run id" />;
  return <RunView runId={runId} embedded={false} />;
}
