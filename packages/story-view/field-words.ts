import type { FieldType } from "movement-lang";

/**
 * A field's type, said as a person would say it.
 *
 * Only the shapes the language itself has — nothing is guessed about what a
 * value means, and a field with no annotation shows no type at all rather than
 * a made-up one. Shared by everything that lists fields: what an extraction is
 * looking for, and what a movement's parameter must carry.
 */
export function typeWord(type: FieldType): string {
  if (typeof type === "string") return PRIMITIVES[type];
  switch (type.kind) {
    case "list":
      return `a list of ${typeWord(type.of)}`;
    case "enum":
      return `one of: ${type.options.join(", ")}`;
    case "maybeAbsent":
      return `${typeWord(type.of)}, or nothing`;
    case "tuple":
      return type.of
        .map((slot) => (slot ? typeWord(slot) : "something"))
        .join(", then ");
    case "union":
      return type.of.map(typeWord).join(" or ");
    case "dict":
      return `${typeWord(type.of)}, looked up by name`;
    case "record":
      return "a record";
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

const PRIMITIVES: Record<Extract<FieldType, string>, string> = {
  text: "text",
  number: "a number",
  boolean: "yes or no",
  date: "a date",
  datetime: "a date and time",
  file: "a file",
  json: "structured data",
  absent: "nothing",
  never: "nothing (it fails)",
};
