declare const process: {
  env: Record<string, string | undefined>;
};

export const clerkPublishableKey = process.env.CLERK_PUBLISHABLE_KEY?.trim() ?? "";

export const apiOrigin = (
  process.env.JITTLE_LAMP_API_ORIGIN?.trim() || "http://127.0.0.1:3001"
).replace(/\/+$/, "");

export const devAuth = {
  enabled:
    process.env.JITTLE_LAMP_DEV_AUTH_ENABLED?.trim().toLowerCase() === "true",
  token: process.env.JITTLE_LAMP_DEV_AUTH_TOKEN?.trim() ?? "",
  userId: process.env.JITTLE_LAMP_DEV_AUTH_USER_ID?.trim() ?? "user_jl_dev",
  email:
    process.env.JITTLE_LAMP_DEV_AUTH_EMAIL?.trim() ??
    "dev+clerk_test@jittlelamp.local",
  name: process.env.JITTLE_LAMP_DEV_AUTH_NAME?.trim() ?? "Jittle Dev",
} as const;

export const devAuthEnabled = devAuth.enabled && Boolean(devAuth.token);
