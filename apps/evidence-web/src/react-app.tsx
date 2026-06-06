import { createRoot } from "react-dom/client";
import { Analytics } from "@vercel/analytics/react";
import { RouterProvider } from "react-router";
import { ClerkProvider } from "@clerk/clerk-react";
import { QueryClientProvider } from "@tanstack/react-query";

import { clerkPublishableKey } from "./env";
import { startExtensionAuthBridge } from "./extension-auth-bridge";
import { createQueryClient } from "./queries";
import { router } from "./router";
import { ToastProvider } from "./toast";

const queryClient = createQueryClient();
const isVercelDeployment = process.env.VERCEL === "1";

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
  }
} as const;

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

  createRoot(root).render(
    clerkPublishableKey ? (
      <ClerkProvider publishableKey={clerkPublishableKey} appearance={clerkAppearance}>
        {app}
      </ClerkProvider>
    ) : (
      app
    )
  );
}
