import { allLocales, Faker, type LocaleDefinition } from "@faker-js/faker";

import { defaultFakeDataLocale, isFakeDataLocale, parseFakeDataToken } from "@jittle-lamp/shared";

// Values for generated tokens ({person.name}, {location.address}, …): one per token per run, in the
// environment's data locale, with English as the fallback for anything the locale lacks.

type Person = { sex: "female" | "male"; firstName: string; lastName: string };

const aliases: Record<string, string> = {
  "person.fullName": "person.name",
  "internet.email": "person.email",
  "internet.username": "person.username",
  "phone.number": "person.phone",
  "date.birthdate": "person.birthdate"
};

const toLatin = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^A-Za-z]/g, "");

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

export function resolveFakeDataLocale(value: string | null | undefined): string {
  return value && isFakeDataLocale(value) ? value : defaultFakeDataLocale;
}

function localeChain(locale: string): LocaleDefinition[] {
  return [allLocales[locale as keyof typeof allLocales], allLocales.en, allLocales.base].filter(
    (definition): definition is LocaleDefinition => definition !== undefined
  );
}

function createFaker(locale: string, seed: number | undefined): Faker {
  const faker = new Faker({ locale: localeChain(locale) });
  if (seed !== undefined) faker.seed(seed);
  return faker;
}

// Faker's vi pattern puts the given name first; Vietnamese names start with the family name.
const nameOrderOverrides: Record<string, string> = { vi: "{{person.lastName}} {{person.firstName}}" };
const plainNamePattern = /^(?:\{\{person\.(?:firstName|lastName)\}\}\s?){2}$/;

// The locale's most common full-name pattern that uses only the first and last name: no titles
// (Mr., Dr.) or suffixes (Jr.), so {person.name} is exactly the person's two names.
function fullNamePattern(locale: string): string {
  const override = nameOrderOverrides[locale];
  if (override) return override;
  for (const definition of localeChain(locale)) {
    const patterns = definition.person?.name as Array<{ value: string; weight: number }> | undefined;
    const plain = (patterns ?? [])
      .filter((pattern) => plainNamePattern.test(pattern.value) && pattern.value.includes("firstName") && pattern.value.includes("lastName"))
      .sort((a, b) => b.weight - a.weight)[0];
    if (plain) return plain.value;
  }
  return "{{person.firstName}} {{person.lastName}}";
}

export function generateFakeData(
  tokens: Iterable<string>,
  options: { locale?: string | null; seed?: number } = {}
): Record<string, string> {
  const locale = resolveFakeDataLocale(options.locale);
  const faker = createFaker(locale, options.seed);
  // Some locales lack a field (location.state in de_CH); those values come from English.
  const english = createFaker("en", options.seed);
  const namePattern = fullNamePattern(locale);
  const people = new Map<number, Person>();
  const person = (index: number): Person => {
    let found = people.get(index);
    if (!found) {
      const sex = faker.helpers.arrayElement(["female", "male"] as const);
      found = { sex, firstName: faker.person.firstName(sex), lastName: faker.person.lastName(sex) };
      people.set(index, found);
    }
    return found;
  };
  // Email and username use the person's name without accents (Đỗ → do). Names in scripts without
  // Latin letters (ja, zh, th…) get a random Latin name instead.
  const latinNames = new Map<number, { firstName: string; lastName: string }>();
  const latinPerson = (index: number) => {
    let found = latinNames.get(index);
    if (!found) {
      const named = person(index);
      const firstName = toLatin(named.firstName);
      const lastName = toLatin(named.lastName);
      found = firstName.length > 0 && lastName.length > 0 ? { firstName, lastName } : { firstName: faker.string.alpha(6), lastName: faker.string.alpha(5) };
      latinNames.set(index, found);
    }
    return found;
  };
  const email = (index: number) => faker.internet.email({ ...latinPerson(index), provider: "example.com" }).toLowerCase();
  const username = (index: number) => faker.internet.username(latinPerson(index));
  // "human" is the locale's everyday format; some locales add an extension (x123), dropped here.
  const phone = () => faker.phone.number({ style: "human" }).replace(/\s*(?:x|ext\.?)\s*\d+$/i, "");

  const generate = (group: string, index: number, field: string, f: Faker): string => {
    switch (`${group}.${field}`) {
      case "person.name": {
        const named = person(index);
        return namePattern.replace("{{person.firstName}}", named.firstName).replace("{{person.lastName}}", named.lastName);
      }
      case "person.firstName":
        return person(index).firstName;
      case "person.lastName":
        return person(index).lastName;
      case "person.sex":
        return person(index).sex;
      case "person.email":
        return email(index);
      case "person.username":
        return username(index);
      case "person.phone":
      case "phone.mobile":
        return phone();
      case "phone.international":
        return f.phone.number({ style: "international" });
      case "person.birthdate":
        return isoDate(f.date.birthdate({ mode: "age", min: 18, max: 65 }));
      case "person.jobTitle":
        return f.person.jobTitle();
      case "internet.url":
        return f.internet.url({ appendSlash: false });
      case "internet.domain":
        return f.internet.domainName();
      case "location.address":
        return `${f.location.streetAddress()}, ${f.location.city()}`;
      case "location.streetAddress":
        return f.location.streetAddress();
      case "location.city":
        return f.location.city();
      case "location.state":
        return f.location.state();
      case "location.zipCode":
        return f.location.zipCode();
      case "location.country":
        return f.location.country();
      case "company.name":
        return f.company.name();
      case "date.past":
        return isoDate(f.date.past({ years: 1 }));
      case "date.future":
        return isoDate(f.date.future({ years: 1 }));
      case "lorem.word":
        return f.lorem.word();
      case "lorem.words":
        return f.lorem.words(3);
      case "lorem.sentence":
        return f.lorem.sentence();
      case "lorem.paragraph":
        return f.lorem.paragraph(2);
      case "number.int":
        return String(f.number.int({ min: 1, max: 9999 }));
      case "string.alphanumeric":
        return f.string.alphanumeric({ length: 8, casing: "lower" });
      case "string.uuid":
        return f.string.uuid();
      default:
        throw new Error(`No generator for {${group}.${field}}`);
    }
  };

  const values: Record<string, string> = {};
  const byCanonical = new Map<string, string>();
  const used = new Set<string>();
  for (const token of new Set(tokens)) {
    const parsed = parseFakeDataToken(token);
    if (!parsed) continue;
    // Aliases of one field share its value: {internet.email} is {person.email}.
    const canonical = aliases[`${parsed.group}.${parsed.field}`] ?? `${parsed.group}.${parsed.field}`;
    const key = `${canonical}#${parsed.index}`;
    let value = byCanonical.get(key);
    if (value === undefined) {
      const [group, field] = canonical.split(".") as [string, string];
      const draw = () => {
        try {
          return generate(group, parsed.index, field, faker);
        } catch {
          return generate(group, parsed.index, field, english);
        }
      };
      value = draw();
      // Distinct values: e2e's replay maps a typed value back to its param by text.
      for (let attempt = 0; used.has(value) && attempt < 5; attempt += 1) value = draw();
      byCanonical.set(key, value);
      used.add(value);
    }
    values[token] = value;
  }
  return values;
}
