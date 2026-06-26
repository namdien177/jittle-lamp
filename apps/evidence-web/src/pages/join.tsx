import React, { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useNavigate, useSearchParams } from "react-router";
import { z } from "zod/v4";
import { KeyRound } from "lucide-react";

import { useAuth } from "../auth";
import { api } from "../api";
import { Wordmark } from "../components/brand";
import { Button } from "../components/ui/button";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { RequireAuth } from "../components/workspace/require-auth";
import { useAcceptInvitation } from "../queries";

const schema = z.object({
  token: z.string().trim().min(1, "Paste the invitation code."),
  password: z.string().optional()
});
type FormValues = z.infer<typeof schema>;

function safeRedirect(input: string | null): string {
  if (!input) return "/";
  if (!input.startsWith("/") || input.startsWith("//")) return "/";
  return input;
}

function JoinForm(): React.JSX.Element {
  const navigate = useNavigate();
  const auth = useAuth();
  const acceptMutation = useAcceptInvitation();
  const [searchParams] = useSearchParams();
  const redirectPath = safeRedirect(searchParams.get("redirect"));
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { token: searchParams.get("code") ?? "", password: "" }
  });
  const [requiresPassword, setRequiresPassword] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = acceptMutation.isPending;

  const submit = async (values: FormValues): Promise<void> => {
    const trimmed = values.token.trim();
    if (!requiresPassword) {
      setChecking(true);
      const lookup = await api.lookupInvitation(() => auth.getToken(), trimmed).catch(() => null);
      setChecking(false);
      if (lookup?.code.requiresPassword) {
        setRequiresPassword(true);
        setError("This invitation code is password protected.");
        return;
      }
    }
    if (requiresPassword && !values.password) {
      setError("Enter the invitation password.");
      return;
    }
    setError(null);
    acceptMutation.mutate(
      { token: trimmed, ...(requiresPassword && values.password ? { password: values.password } : {}) },
      {
        onSuccess: () => navigate(redirectPath, { replace: true }),
        onError: (err) => setError(err instanceof Error ? err.message : "Unable to accept invitation.")
      }
    );
  };

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden bg-background p-6">
      <div aria-hidden className="pointer-events-none absolute inset-0 grid-backdrop opacity-40" />
      <section className="relative w-full max-w-md animate-rise rounded-md border border-border-strong bg-card/90 p-7 shadow-pop backdrop-blur">
        <Wordmark className="mb-6" />
        <div className="mb-1 flex items-center gap-2">
          <KeyRound className="size-5 text-primary" aria-hidden />
          <h1 className="font-display text-xl font-bold">Join an organisation</h1>
        </div>
        <p className="mb-6 text-base text-muted-foreground">
          Paste the invitation code an organisation owner shared with you.
        </p>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit(submit)(e);
          }}
        >
          <Field label="Invitation code" error={form.formState.errors.token?.message}>
            <Input autoFocus className="font-mono" placeholder="inv_…" disabled={busy} {...form.register("token")} />
          </Field>
          {requiresPassword ? (
            <Field label="Invitation password">
              <Input type="password" disabled={busy} {...form.register("password")} />
            </Field>
          ) : null}
          {error ? <p className="text-base text-destructive">{error}</p> : null}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Joining…" : checking ? "Checking…" : "Join workspace"}
          </Button>
        </form>
      </section>
    </main>
  );
}

export function JoinPage(): React.JSX.Element {
  return (
    <RequireAuth>
      <JoinForm />
    </RequireAuth>
  );
}
