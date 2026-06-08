import { createRoot } from "react-dom/client";
import { Analytics } from "@vercel/analytics/react";
import { RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";

import { AuthProvider } from "./auth";
import { clerkPublishableKey } from "./env";
import { startExtensionAuthBridge } from "./extension-auth-bridge";
import { createQueryClient } from "./queries";
import { router } from "./router";
import { ToastProvider } from "./toast";

const queryClient = createQueryClient();
const isVercelDeployment = process.env.VERCEL === "1";

export function bootstrap(): void {
  const root = document.getElementById("app");
  if (!root) throw new Error("Evidence web root element was not found.");
  if (clerkPublishableKey) {
    startExtensionAuthBridge();
  }

  const app = (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
        {isVercelDeployment ? <Analytics mode="production" /> : null}
      </ToastProvider>
    </QueryClientProvider>
  );

  createRoot(root).render(<AuthProvider>{app}</AuthProvider>);
}
