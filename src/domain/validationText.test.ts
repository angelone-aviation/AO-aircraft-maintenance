/**
 * Responsibility: Pins the text a user reads for a refused zod validation.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/validationText.ts, zod.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validationText } from "./validationText";

const refusal = (schema: z.ZodType, value: unknown) => {
  const parsed = schema.safeParse(value);
  if (parsed.success) throw new Error("Expected the schema to refuse.");
  return parsed.error;
};

describe("validationText", () => {
  it("lists each issue message once, in issue order, one per line", () => {
    const schema = z.object({
      street: z.string().min(1, "Enter a street."),
      country: z.string().min(1, "Enter a country."),
      city: z.string().min(1, "Enter a street."),
    });
    const error = refusal(schema, { street: "", country: "", city: "" });
    expect(error.issues).toHaveLength(3);
    expect(validationText(error)).toBe("Enter a street.\nEnter a country.");
  });

  it("never shows zod's JSON", () => {
    const error = refusal(z.string().max(1, "Too long."), "ab");
    expect(error.message).toContain('"path"');
    expect(validationText(error)).toBe("Too long.");
  });

  it("is empty for an error without issues", () => {
    expect(validationText(new z.ZodError([]))).toBe("");
  });
});
