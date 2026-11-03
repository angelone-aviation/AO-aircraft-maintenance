/**
 * Responsibility: Pins the first-administrator setup's promises: weak passwords
 *   refused before Convex is called, the temporary password variable always
 *   removed, and the password never in an argument or the output.
 * Layer: Test. A recording fake stands in for the Convex CLI.
 * Dependencies: vitest, scripts/bootstrapAdmin.ts, src/domain/passwordRules.ts.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import {
  main,
  type AdminAccount,
  type ConvexCliResult,
  type SetupIo,
} from "./bootstrapAdmin";
import {
  PASSWORD_COMMON_MESSAGE,
  PASSWORD_LENGTH_MESSAGE,
} from "../src/domain/passwordRules";

const NAME = "Avery Pilot";
const EMAIL = "avery@example.org";
const PASSWORD = "Tarmac-sunrise gauge 4417";
const UNATTENDED_ENV = {
  BOOTSTRAP_ADMIN_NAME: NAME,
  BOOTSTRAP_ADMIN_EMAIL: EMAIL,
  FIRST_ADMIN_PASSWORD: PASSWORD,
};
const SET_PASSWORD = ["env", "set", "BOOTSTRAP_ADMIN_PASSWORD"];
const REMOVE_PASSWORD = ["env", "remove", "BOOTSTRAP_ADMIN_PASSWORD"];
const BOOTSTRAP = [
  "run",
  "admin:bootstrap",
  JSON.stringify({ email: EMAIL, name: NAME }),
];
const OK: ConvexCliResult = { status: 0, stderr: "" };
const REFUSED: ConvexCliResult = {
  status: 1,
  stderr: "Bootstrap is only available on an empty user database.\n",
};

interface ConvexCall {
  readonly args: readonly string[];
  readonly input?: string;
}

/** Fake Convex CLI answers, keyed by a call's first two arguments. */
type Responses = Readonly<Record<string, ConvexCliResult | Error>>;

function harness(
  env: Readonly<Record<string, string | undefined>>,
  responses: Responses = {},
  prompted?: AdminAccount,
) {
  const calls: ConvexCall[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const prompts: string[] = [];
  const io: SetupIo = {
    env,
    convex: (args, input) => {
      calls.push({ args, input });
      const response = responses[args.slice(0, 2).join(" ")] ?? OK;
      if (response instanceof Error) throw response;
      return response;
    },
    promptAccount: async () => {
      prompts.push("prompted");
      if (!prompted) throw new Error("Unexpected prompt.");
      return prompted;
    },
    printLine: (line) => output.push(line),
    printError: (text) => errors.push(text),
  };
  return { io, calls, output, errors, prompts };
}

function argumentsOf(calls: readonly ConvexCall[]): string {
  return calls.map(({ args }) => args.join(" ")).join("\n");
}

describe("unattended first-administrator setup", () => {
  it("creates the administrator without prompting, then removes the temporary password", async () => {
    const run = harness(UNATTENDED_ENV);

    await expect(main([], run.io)).resolves.toBe(0);

    expect(run.calls).toEqual([
      { args: SET_PASSWORD, input: PASSWORD },
      { args: BOOTSTRAP, input: undefined },
      { args: REMOVE_PASSWORD, input: undefined },
    ]);
    expect(run.prompts).toEqual([]);
    expect(run.output).toEqual(["Administrator created. You can now sign in."]);
  });

  it("sends the password only over stdin, never in an argument or the output", async () => {
    const run = harness(UNATTENDED_ENV, { "run admin:bootstrap": REFUSED });

    await main([], run.io);

    expect(argumentsOf(run.calls)).not.toContain(PASSWORD);
    expect(run.calls.filter(({ input }) => input === PASSWORD)).toEqual([
      { args: SET_PASSWORD, input: PASSWORD },
    ]);
    expect([...run.output, ...run.errors].join("")).not.toContain(PASSWORD);
  });

  it.each([
    ["too short", "short-pass-14c", PASSWORD_LENGTH_MESSAGE],
    ["common", "123456789123456789", PASSWORD_COMMON_MESSAGE],
    ["one phrase repeated", "tailwheel-tailwheel-", PASSWORD_COMMON_MESSAGE],
    ["containing the email", `${EMAIL}-hangar-9`, PASSWORD_COMMON_MESSAGE],
  ])(
    "refuses a %s password with the app's message before contacting Convex",
    async (_case, password, message) => {
      const run = harness({
        ...UNATTENDED_ENV,
        FIRST_ADMIN_PASSWORD: password,
      });

      await expect(main([], run.io)).resolves.toBe(1);

      expect(run.errors.join("")).toContain(message);
      expect(run.errors.join("")).not.toContain(password);
      expect(run.calls).toEqual([]);
    },
  );

  it("refuses a password with a line break, which the sign-in form cannot reproduce", async () => {
    const run = harness({
      ...UNATTENDED_ENV,
      FIRST_ADMIN_PASSWORD: `${PASSWORD}\n`,
    });

    await expect(main([], run.io)).resolves.toBe(1);

    expect(run.errors.join("")).toContain("line break");
    expect(run.calls).toEqual([]);
  });

  it("names the missing variable instead of prompting when only some are set", async () => {
    const run = harness({ ...UNATTENDED_ENV, FIRST_ADMIN_PASSWORD: "" });

    await expect(main([], run.io)).resolves.toBe(1);

    expect(run.errors.join("")).toContain("Missing FIRST_ADMIN_PASSWORD.");
    expect(run.prompts).toEqual([]);
    expect(run.calls).toEqual([]);
  });

  it("removes the temporary password when the bootstrap call fails", async () => {
    const run = harness(UNATTENDED_ENV, { "run admin:bootstrap": REFUSED });

    await expect(main([], run.io)).resolves.toBe(1);

    expect(run.calls.at(-1)).toEqual({
      args: REMOVE_PASSWORD,
      input: undefined,
    });
    expect(run.errors.join("")).toContain(REFUSED.stderr);
    expect(run.output).toEqual([]);
  });

  it("removes the temporary password when the bootstrap call throws", async () => {
    const run = harness(UNATTENDED_ENV, {
      "run admin:bootstrap": new Error("spawn npx ENOENT"),
    });

    await expect(main([], run.io)).rejects.toThrow("spawn npx ENOENT");

    expect(run.calls.at(-1)).toEqual({
      args: REMOVE_PASSWORD,
      input: undefined,
    });
  });

  it("removes the temporary password when storing it reports a failure, and skips the bootstrap", async () => {
    const run = harness(UNATTENDED_ENV, {
      "env set": { status: 1, stderr: "Network error.\n" },
    });

    await expect(main([], run.io)).resolves.toBe(1);

    expect(run.calls.map(({ args }) => args)).toEqual([
      SET_PASSWORD,
      REMOVE_PASSWORD,
    ]);
    expect(run.errors.join("")).toContain("Network error.");
  });

  it("tells the person to remove the variable by hand when removing it fails", async () => {
    const run = harness(UNATTENDED_ENV, {
      "env remove": { status: 1, stderr: "" },
    });

    await expect(main([], run.io)).resolves.toBe(0);

    expect(run.errors.join("")).toContain(
      "Remove BOOTSTRAP_ADMIN_PASSWORD manually",
    );
  });
});

describe("--check", () => {
  it("validates the unattended details without contacting Convex", async () => {
    const run = harness(UNATTENDED_ENV);

    await expect(main(["--check"], run.io)).resolves.toBe(0);

    expect(run.calls).toEqual([]);
    expect(run.output.join("")).toContain(
      "Nothing was sent to the deployment.",
    );
  });

  it("fails when no unattended details are set, without prompting", async () => {
    const run = harness({});

    await expect(main(["--check"], run.io)).resolves.toBe(1);

    expect(run.prompts).toEqual([]);
    expect(run.calls).toEqual([]);
  });

  it("refuses unexpected arguments without echoing them", async () => {
    const run = harness(UNATTENDED_ENV);

    await expect(main([PASSWORD], run.io)).resolves.toBe(1);

    expect(run.errors.join("")).toContain("Usage:");
    expect(run.errors.join("")).not.toContain(PASSWORD);
    expect(run.calls).toEqual([]);
  });
});

describe("interactive first-administrator setup", () => {
  it("prompts when no detail comes from the environment and leaves the rule to the deployment", async () => {
    const weak = { email: EMAIL, name: NAME, password: "short" };
    const run = harness({}, {}, weak);

    await expect(main([], run.io)).resolves.toBe(0);

    expect(run.prompts).toEqual(["prompted"]);
    expect(run.calls).toEqual([
      { args: SET_PASSWORD, input: "short" },
      { args: BOOTSTRAP, input: undefined },
      { args: REMOVE_PASSWORD, input: undefined },
    ]);
  });
});
