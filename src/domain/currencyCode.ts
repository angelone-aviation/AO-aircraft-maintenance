/**
 * Responsibility: The currency-code rule priced records share: three capital
 *   letters in ISO 4217 form, such as "USD".
 * Layer: Domain. A pure zod schema and constant; no I/O, no React.
 * Dependencies: zod.
 *
 * Format only: a code is not checked against the ISO 4217 list.
 */
import { z } from "zod";

/**
 * A currency code as an HTML input pattern, which browsers match against the
 * whole value.
 */
export const CURRENCY_CODE_PATTERN = "[A-Z]{3}";

/**
 * A stored currency code, matching {@link CURRENCY_CODE_PATTERN} in full.
 *
 * @throws {z.ZodError} From `parse()` on anything else, such as "usd" or "US".
 */
export const currencyCodeSchema = z
  .string()
  .regex(new RegExp(`^${CURRENCY_CODE_PATTERN}$`));
