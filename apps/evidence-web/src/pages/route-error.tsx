import React from "react";
import { isRouteErrorResponse, useRouteError } from "react-router";

import { StatusScreen } from "../components/status-screen";
import { Button } from "../components/ui/button";

export function RouteError(): React.JSX.Element {
  const error = useRouteError();

  let title = "Something went wrong";
  let detail = "An unexpected error occurred while loading this page.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      title = "Page not found";
      detail = "The page you’re looking for doesn’t exist or may have moved.";
    } else {
      title = `${error.status} ${error.statusText}`;
      detail = typeof error.data === "string" ? error.data : detail;
    }
  } else if (error instanceof Error) {
    detail = error.message;
  }

  return (
    <StatusScreen tone="error" title={title} detail={detail}>
      <div className="flex gap-2">
        <Button onClick={() => window.location.assign("/")}>Back to workspace</Button>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    </StatusScreen>
  );
}
