/**
 * Responsibility: The deployment's HTTP routes: Convex Auth's, with the Google
 *   and Microsoft callback wrapped to record and explain a refused sign-in.
 * Layer: Server. Convex HTTP router; who may sign in is decided in
 *   convex/identities.
 * Dependencies: convex/server, ./_generated, ./auth, ./identities,
 *   src/domain/signInMethods.
 */
import {
  httpRouter,
  type HttpRouter,
  type PublicHttpAction,
  type RouteSpec,
} from "convex/server";
import { httpAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";
import { refusalOf } from "./identities";
import {
  SIGN_IN_ERROR_PARAM,
  SIGN_IN_PROVIDER_PARAM,
  signInErrorCode,
  type SsoRefusalReason,
} from "../src/domain/signInMethods";
import type { Id } from "./_generated/dataModel";

/** The HTTP routes Convex serves: the sign-in routes of Convex Auth. */
const http = httpRouter();
auth.addHttpRoutes(withSignInLog(http));
export default http;

// The library's Google and Microsoft callback route turns every failure into
// a plain redirect to the site, so a refusal (convex/identities.ts) would leave
// no trace and the person no explanation. Wrap that route: record a refusal
// in the change log in its own transaction, and tell the sign-in screen why
// nobody was signed in. Every other route is registered unchanged.
function withSignInLog(router: HttpRouter): HttpRouter {
  return {
    route: (spec: RouteSpec) =>
      router.route(
        "pathPrefix" in spec && spec.pathPrefix === "/api/auth/callback/"
          ? { ...spec, handler: logRefusals(spec.handler) }
          : spec,
      ),
  } as HttpRouter;
}

type Callback = (ctx: ActionCtx, request: Request) => Promise<Response>;
type UserOAuth = {
  type: "userOAuth";
  provider: string;
  providerAccountId: string;
  profile?: { email?: unknown };
};
type SignInRefusal = {
  provider: string;
  providerAccountId: string;
  email?: string;
  reason: SsoRefusalReason;
  userId?: Id<"users">;
};
type Outcome = { issued: boolean; refusal?: SignInRefusal };

function logRefusals(route: PublicHttpAction): PublicHttpAction {
  // The function the registered route wraps; convex-test calls it the same way.
  const callback = (route as unknown as { _handler?: Callback })._handler;
  if (typeof callback !== "function")
    throw new Error("Unexpected sign-in route; check the convex upgrade.");
  return httpAction(async (ctx, request) => {
    const outcome: Outcome = { issued: false };
    const runMutation = watchSignIn(ctx, outcome);
    const response = await callback({ ...ctx, runMutation }, request);
    if (outcome.issued) return response;
    const { refusal } = outcome;
    if (refusal)
      await ctx.runMutation(internal.identities.recordRefusal, refusal);
    return explainRefusal(response, request, refusal?.reason);
  });
}

// The callback's runMutation, noting in `outcome` whether the OAuth account
// step signed someone in or was refused.
function watchSignIn(ctx: ActionCtx, outcome: Outcome) {
  return (async (
    reference: Parameters<ActionCtx["runMutation"]>[0],
    args?: Record<string, unknown>,
  ) => {
    const store = (args as { args?: { type?: string } } | undefined)?.args;
    const oauth = store?.type === "userOAuth" ? (store as UserOAuth) : null;
    try {
      const result = await ctx.runMutation(reference, args as never);
      if (oauth) outcome.issued = true;
      return result;
    } catch (error) {
      const refused = oauth && refusalOf(error);
      if (refused)
        outcome.refusal = {
          provider: oauth.provider,
          providerAccountId: oauth.providerAccountId,
          reason: refused.reason,
          ...(typeof oauth.profile?.email === "string"
            ? { email: oauth.profile.email }
            : {}),
          ...(refused.userId ? { userId: refused.userId } : {}),
        };
      throw error;
    }
  }) as ActionCtx["runMutation"];
}

// Adds to the library's redirect why nobody was signed in, and with which
// provider, for the sign-in screen.
function explainRefusal(
  response: Response,
  request: Request,
  reason: SsoRefusalReason | undefined,
) {
  const location = response.headers.get("Location");
  if (!location) return response;
  const destination = new URL(location);
  destination.searchParams.set(SIGN_IN_ERROR_PARAM, signInErrorCode(reason));
  destination.searchParams.set(
    SIGN_IN_PROVIDER_PARAM,
    new URL(request.url).pathname.split("/").at(-1) ?? "",
  );
  return new Response(null, {
    status: 302,
    headers: {
      Location: destination.toString(),
      "Cache-Control": "must-revalidate",
    },
  });
}
