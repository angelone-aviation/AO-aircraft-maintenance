/**
 * Responsibility: Creates the first system administrator on an empty Convex
 *   deployment, from prompts or unattended from environment variables.
 * Layer: Script. Operator tooling; never imported by the app or by Convex.
 * Dependencies: src/domain/passwordRules.ts, node:child_process,
 *   node:readline/promises.
 *
 * The password reaches the deployment only in a temporary env var set over
 * stdin, never in a process argument, and is removed even when creation fails.
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { passwordProblem } from "../src/domain/passwordRules";

/** One finished Convex CLI call; `status` is null when it could not start. */
export interface ConvexCliResult {
  readonly status: number | null;
  readonly stderr: string;
}

/**
 * Runs `npx convex <args>` on the deployment the CLI selects
 * (CONVEX_DEPLOY_KEY, else .env.local), writing `input` to its stdin.
 * Secrets go in `input`, never in `args`.
 */
export type ConvexCli = (
  args: readonly string[],
  input?: string,
) => ConvexCliResult;

/** The first administrator's sign-in details. */
export interface AdminAccount {
  readonly email: string;
  readonly name: string;
  readonly password: string;
}

/** Everything the setup reads from or writes to; tests pass fakes. */
export interface SetupIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly convex: ConvexCli;
  /** Asks a person; used only when the environment supplies no detail. */
  readonly promptAccount: () => Promise<AdminAccount>;
  readonly printLine: (line: string) => void;
  readonly printError: (text: string) => void;
}

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
// 128 + SIGINT: the conventional status for a process stopped with Ctrl-C.
const EXIT_INTERRUPTED = 130;

const CHECK_FLAG = "--check";
const NAME_VARIABLE = "BOOTSTRAP_ADMIN_NAME";
const EMAIL_VARIABLE = "BOOTSTRAP_ADMIN_EMAIL";
// Named after the GitHub secret the First-time setup workflow passes in.
const PASSWORD_VARIABLE = "FIRST_ADMIN_PASSWORD";
// Read by the internal action admin:bootstrap (convex/admin.ts).
const DEPLOYMENT_PASSWORD_VARIABLE = "BOOTSTRAP_ADMIN_PASSWORD";
const UNATTENDED_FIELDS = [
  ["name", NAME_VARIABLE],
  ["email", EMAIL_VARIABLE],
  ["password", PASSWORD_VARIABLE],
] as const;
const UNATTENDED_VARIABLES = `${NAME_VARIABLE}, ${EMAIL_VARIABLE} and ${PASSWORD_VARIABLE}`;

const CTRL_C = "\u0003";
const BACKSPACE = "\u007f";
const FIRST_PRINTABLE = " ";

type UnattendedAccount =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly problem: string }
  | { readonly kind: "valid"; readonly account: AdminAccount };

/**
 * Creates the first system administrator from prompts, or unattended when any
 * of BOOTSTRAP_ADMIN_NAME, BOOTSTRAP_ADMIN_EMAIL, FIRST_ADMIN_PASSWORD is set:
 * then all three are required and the password must pass the app's rule before
 * it is sent. Sets, then always removes, BOOTSTRAP_ADMIN_PASSWORD on the
 * deployment and runs admin:bootstrap, which refuses once any user exists.
 *
 * @param args - None, or `--check` to validate unattended details only.
 * @param io - Where it reads and writes; the real terminal and CLI if omitted.
 * @returns 0 when created (or valid), else 1 after printing why; never prints
 *   the password or the arguments.
 * @throws {Error} "Run this setup in an interactive terminal." when prompting
 *   without one.
 */
export async function main(
  args: readonly string[],
  io: SetupIo = TERMINAL_IO,
): Promise<number> {
  if (args.some((arg) => arg !== CHECK_FLAG))
    return fail(
      io,
      `Usage: npm run setup:admin [-- ${CHECK_FLAG}]. ${CHECK_FLAG} validates ${UNATTENDED_VARIABLES} without contacting the deployment.`,
    );
  const unattended = readUnattendedAccount(io.env);
  if (unattended.kind === "invalid") return fail(io, unattended.problem);
  if (args.includes(CHECK_FLAG)) return reportCheck(unattended, io);
  const account =
    unattended.kind === "valid" ? unattended.account : await io.promptAccount();
  return createAdministrator(account, io);
}

function reportCheck(unattended: UnattendedAccount, io: SetupIo): number {
  if (unattended.kind !== "valid")
    return fail(io, `${CHECK_FLAG} needs ${UNATTENDED_VARIABLES}.`);
  io.printLine(
    "Administrator details are valid. Nothing was sent to the deployment.",
  );
  return EXIT_OK;
}

function readUnattendedAccount(
  env: Readonly<Record<string, string | undefined>>,
): UnattendedAccount {
  // Trimmed like the prompts' answers; a password is used exactly as given.
  const account: AdminAccount = {
    name: env[NAME_VARIABLE]?.trim() ?? "",
    email: env[EMAIL_VARIABLE]?.trim() ?? "",
    password: env[PASSWORD_VARIABLE] ?? "",
  };
  const missing = UNATTENDED_FIELDS.filter(([field]) => !account[field]).map(
    ([, variable]) => variable,
  );
  if (missing.length === UNATTENDED_FIELDS.length) return { kind: "absent" };
  if (missing.length > 0)
    return {
      kind: "invalid",
      problem: `Missing ${missing.join(", ")}. Unattended setup needs ${UNATTENDED_VARIABLES}.`,
    };
  const problem = unattendedPasswordProblem(account.password, account.email);
  return problem ? { kind: "invalid", problem } : { kind: "valid", account };
}

function unattendedPasswordProblem(
  password: string,
  email: string,
): string | undefined {
  // The sign-in form cannot reproduce a line break, so one here is a paste
  // artifact that would lock the administrator out.
  if (/[\r\n]/.test(password))
    return `${PASSWORD_VARIABLE} contains a line break. Enter the password again without one.`;
  const problem = passwordProblem(password, email);
  return problem && `${PASSWORD_VARIABLE}: ${problem}`;
}

function createAdministrator(account: AdminAccount, io: SetupIo): number {
  const outcome = runWithTemporaryPassword(account, io);
  if (outcome.status !== 0)
    return fail(io, outcome.stderr || "Administrator setup failed.\n");
  io.printLine("Administrator created. You can now sign in.");
  return EXIT_OK;
}

/** Returns the failed `env set` call, or else the bootstrap call. */
function runWithTemporaryPassword(
  account: AdminAccount,
  io: SetupIo,
): ConvexCliResult {
  try {
    const stored = io.convex(
      ["env", "set", DEPLOYMENT_PASSWORD_VARIABLE],
      account.password,
    );
    if (stored.status !== 0) return stored;
    return io.convex([
      "run",
      "admin:bootstrap",
      JSON.stringify({ email: account.email, name: account.name }),
    ]);
  } finally {
    // Also after a failed `env set`: it may have stored the value before
    // reporting the failure.
    removeTemporaryPassword(io);
  }
}

function removeTemporaryPassword(io: SetupIo): void {
  const removed = io.convex(["env", "remove", DEPLOYMENT_PASSWORD_VARIABLE]);
  if (removed.status !== 0)
    io.printError(
      `Remove ${DEPLOYMENT_PASSWORD_VARIABLE} manually: npx convex env remove ${DEPLOYMENT_PASSWORD_VARIABLE}\n`,
    );
}

function fail(io: SetupIo, message: string): number {
  io.printError(message.endsWith("\n") ? message : `${message}\n`);
  return EXIT_FAILURE;
}

function runConvex(args: readonly string[], input?: string): ConvexCliResult {
  const result = spawnSync("npx", ["convex", ...args], {
    input,
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr ?? "" };
}

async function promptInTerminal(): Promise<AdminAccount> {
  const questions = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const email = (await questions.question("Administrator email: ")).trim();
  const name = (await questions.question("Administrator name: ")).trim();
  questions.close();
  if (!process.stdin.isTTY)
    throw new Error("Run this setup in an interactive terminal.");
  process.stdout.write("Password (15–128 characters, hidden): ");
  return { email, name, password: await readHiddenLine() };
}

function readHiddenLine(): Promise<string> {
  return new Promise((resolve) => {
    let secret = "";
    function read(buffer: Buffer): void {
      for (const character of buffer.toString()) {
        if (character === CTRL_C) abortPrompt();
        if (character === "\r" || character === "\n") {
          endPrompt(read);
          resolve(secret);
          return;
        }
        secret = editSecret(secret, character);
      }
    }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", read);
  });
}

function editSecret(secret: string, character: string): string {
  if (character === BACKSPACE) return secret.slice(0, -1);
  return character >= FIRST_PRINTABLE ? secret + character : secret;
}

function abortPrompt(): never {
  process.stdin.setRawMode(false);
  process.exit(EXIT_INTERRUPTED);
}

function endPrompt(listener: (buffer: Buffer) => void): void {
  process.stdin.off("data", listener);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write("\n");
}

const TERMINAL_IO: SetupIo = {
  env: process.env,
  convex: runConvex,
  promptAccount: promptInTerminal,
  printLine: (line) => console.log(line),
  printError: (text) => process.stderr.write(text),
};
