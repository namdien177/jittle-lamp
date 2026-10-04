// The login identifier is a role assigned to a public field. Errors include only field names.
export function resolveLoginField(
  fields: Readonly<Record<string, string>>,
  requested?: string | null
): { field: string | null; error: string | null } {
  const names = Object.keys(fields).sort();
  const field = requested ?? (names.includes("username") ? "username" : names.length === 1 ? names[0] : null);
  if (!field) {
    return {
      field: null,
      error: names.length > 1 ? `Choose a login field from: ${names.join(", ")}` : "Add a public field to use for login"
    };
  }
  if (!Object.prototype.hasOwnProperty.call(fields, field)) {
    return { field: null, error: `Login field "${field}" must be an existing public field` };
  }
  if (!fields[field]?.trim()) return { field: null, error: `Login field "${field}" is empty` };
  return { field, error: null };
}
