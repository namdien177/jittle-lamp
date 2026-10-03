import { useAccountProfile } from "../queries";

// The organisation every test-case query is scoped to (the account's active organisation).
export function useTestOrgId(): string | null {
  return useAccountProfile().data?.activeOrgId ?? null;
}
