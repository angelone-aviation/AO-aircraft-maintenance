/**
 * Responsibility: The request id a command carries, so that repeating the
 *   command has no further effect (GLOSSARY "Command", ADR-0003).
 * Layer: Domain. A zod field that command schemas share; no I/O.
 * Dependencies: zod.
 *
 * Optional while the demo adapter and clients from before T18 send none; a
 * command without one runs every time it is sent.
 */
import { z } from "zod";

/**
 * The field a command schema spreads into each of its objects: one id per
 * user intent, sent unchanged on every retry of it.
 */
export const requestUuidField = { requestUuid: z.string().uuid().optional() };
