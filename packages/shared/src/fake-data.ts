// Generated values: `{person.name}`, `{internet.email}`, `{location.address}` and friends resolve to
// realistic fake data when no param, dataset column or variable of that name exists. The runner
// generates one value per token per run (faker, in the environment's data locale); the shared
// catalog lets lint, the editor and the backend know which names generate.
//
// A number after the group names another entity: `{person2.name}` and `{internet2.email}` belong
// to a second person, distinct from `{person.name}`. Fields of one entity agree with each other:
// `{person.email}` is built from `{person.firstName}` and `{person.lastName}`.

export type FakeDataGroup = "person" | "internet" | "phone" | "location" | "company" | "date" | "lorem" | "number" | "string";

export type FakeDataField = {
  group: FakeDataGroup;
  field: string;
  description: string;
  example: string;
  // Offered when the editor's `{` picker opens with no query.
  common?: boolean;
};

export const fakeDataFields: readonly FakeDataField[] = [
  { group: "person", field: "name", description: "Full name", example: "Jordan Lee", common: true },
  { group: "person", field: "fullName", description: "Full name (same as person.name)", example: "Jordan Lee" },
  { group: "person", field: "firstName", description: "First name", example: "Jordan", common: true },
  { group: "person", field: "lastName", description: "Last name", example: "Lee", common: true },
  { group: "person", field: "email", description: "Email built from the person's name", example: "jordan.lee@example.com", common: true },
  { group: "person", field: "username", description: "Username built from the person's name", example: "jordan_lee42" },
  { group: "person", field: "phone", description: "Phone number", example: "0912 345 678", common: true },
  { group: "person", field: "sex", description: "female or male", example: "female" },
  { group: "person", field: "birthdate", description: "Adult birth date, YYYY-MM-DD", example: "1990-04-12" },
  { group: "person", field: "jobTitle", description: "Job title", example: "Product Manager" },
  { group: "internet", field: "email", description: "Email (of person, or personN for internetN)", example: "jordan.lee@example.com" },
  { group: "internet", field: "username", description: "Username (of person, or personN for internetN)", example: "jordan_lee42" },
  { group: "internet", field: "url", description: "Website URL", example: "https://bright-harbor.com" },
  { group: "internet", field: "domain", description: "Domain name", example: "bright-harbor.com" },
  { group: "phone", field: "number", description: "Phone number in national format", example: "0912 345 678" },
  { group: "phone", field: "mobile", description: "Mobile number in national format", example: "0912 345 678" },
  { group: "phone", field: "international", description: "Phone number in international format", example: "+84912345678" },
  { group: "location", field: "address", description: "Street address and city", example: "12 Market Street, Springfield", common: true },
  { group: "location", field: "streetAddress", description: "Street address", example: "12 Market Street" },
  { group: "location", field: "city", description: "City", example: "Springfield" },
  { group: "location", field: "state", description: "State or province", example: "Oregon" },
  { group: "location", field: "zipCode", description: "Postal code", example: "97477" },
  { group: "location", field: "country", description: "Country", example: "Canada" },
  { group: "company", field: "name", description: "Company name", example: "Bright Harbor Ltd" },
  { group: "date", field: "birthdate", description: "Adult birth date, YYYY-MM-DD", example: "1990-04-12" },
  { group: "date", field: "past", description: "Date within the last year, YYYY-MM-DD", example: "2026-03-18" },
  { group: "date", field: "future", description: "Date within the next year, YYYY-MM-DD", example: "2027-02-07" },
  { group: "lorem", field: "word", description: "One word", example: "harbor" },
  { group: "lorem", field: "words", description: "A few words", example: "quiet harbor lights" },
  { group: "lorem", field: "sentence", description: "One sentence", example: "The harbor lights stay on." },
  { group: "lorem", field: "paragraph", description: "A short paragraph", example: "The harbor lights stay on. …" },
  { group: "number", field: "int", description: "Whole number from 1 to 9999", example: "4821" },
  { group: "string", field: "alphanumeric", description: "8 random letters and digits", example: "k3f9q2zx" },
  { group: "string", field: "uuid", description: "UUID", example: "0f8e5c4a-…" }
];

// Locales faker ships (`allFakers` keys, minus test-only ones). An environment picks one; `en` is
// the default.
export const fakeDataLocales = [
  "af_ZA", "ar", "az", "bn_BD", "cs_CZ", "cy", "da", "de", "de_AT", "de_CH", "dv", "el", "en", "en_AU", "en_CA", "en_GB",
  "en_GH", "en_HK", "en_IE", "en_IN", "en_NG", "en_NP", "en_US", "en_ZA", "eo", "es", "es_MX", "fa", "fi", "fr", "fr_BE",
  "fr_CA", "fr_CH", "fr_LU", "fr_SN", "he", "hr", "hu", "hy", "id_ID", "it", "ja", "ka_GE", "ko", "ku_ckb", "ku_kmr_latin",
  "lv", "mk", "mn_MN_cyrl", "nb_NO", "ne", "nl", "nl_BE", "pl", "pt_BR", "pt_PT", "ro", "ro_MD", "ru", "sk", "sl_SI",
  "sr_RS_latin", "sv", "ta_IN", "th", "tr", "uk", "ur", "uz_UZ_latin", "vi", "yo_NG", "zh_CN", "zh_TW", "zu_ZA"
] as const;
export const defaultFakeDataLocale = "en";

export type FakeDataToken = { token: string; group: FakeDataGroup; index: number; field: string };

const groups = new Set<string>(fakeDataFields.map((field) => field.group));
const fieldsByGroup = new Map<string, Map<string, FakeDataField>>();
for (const field of fakeDataFields) {
  const byField = fieldsByGroup.get(field.group) ?? new Map<string, FakeDataField>();
  byField.set(field.field.toLowerCase(), field);
  fieldsByGroup.set(field.group, byField);
}

const tokenPattern = /^([a-z]+)([1-9][0-9]?)?\.([A-Za-z]+)$/;

// The group part of `{person2.nmae}`: set for any name in a generated group, known field or not.
export function fakeDataGroupOf(token: string): { group: FakeDataGroup; index: number; field: string } | null {
  const match = tokenPattern.exec(token);
  if (!match || !groups.has(match[1]!)) return null;
  return { group: match[1] as FakeDataGroup, index: match[2] ? Number(match[2]) : 1, field: match[3]! };
}

export function parseFakeDataToken(token: string): FakeDataToken | null {
  const parsed = fakeDataGroupOf(token);
  if (!parsed) return null;
  const field = fieldsByGroup.get(parsed.group)?.get(parsed.field.toLowerCase());
  return field ? { token, group: parsed.group, index: parsed.index, field: field.field } : null;
}

export function isFakeDataToken(token: string): boolean {
  return parseFakeDataToken(token) !== null;
}

export function fakeDataFieldsOf(group: FakeDataGroup): string[] {
  return fakeDataFields.filter((field) => field.group === group).map((field) => field.field);
}

export function describeFakeDataToken(token: string): FakeDataField | null {
  const parsed = parseFakeDataToken(token);
  return parsed ? (fieldsByGroup.get(parsed.group)?.get(parsed.field.toLowerCase()) ?? null) : null;
}

export function isFakeDataLocale(value: string): value is (typeof fakeDataLocales)[number] {
  return (fakeDataLocales as readonly string[]).includes(value);
}
