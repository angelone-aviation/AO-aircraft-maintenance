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

function logRefusals(route: PublicHttpAction): PublicHttpAction {
  // The function the registered route wraps; convex-test calls it the same way.
  const callback = (route as unknown as { _handler?: Callback })._handler;
  if (typeof callback !== "function")
    throw new Error("Unexpected sign-in route; check the convex upgrade.");
  return httpAction(async (ctx, request) => {
    let issued = false;
    let refusal:
      | {
          provider: string;
          providerAccountId: string;
          email?: string;
          reason: SsoRefusalReason;
          userId?: Id<"users">;
        }
      | undefined;
    const runMutation = (async (
      reference: Parameters<ActionCtx["runMutation"]>[0],
      args?: Record<string, unknown>,
    ) => {
      const store = (args as { args?: { type?: string } } | undefined)?.args;
      const oauth = store?.type === "userOAuth" ? (store as UserOAuth) : null;
      try {
        const result = await ctx.runMutation(reference, args as never);
        if (oauth) issued = true;
        return result;
      } catch (error) {
        const refused = oauth && refusalOf(error);
        if (refused)
          refusal = {
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
    const response = await callback({ ...ctx, runMutation }, request);
    if (issued) return response;
    if (refusal)
      await ctx.runMutation(internal.identities.recordRefusal, refusal);
    const location = response.headers.get("Location");
    if (!location) return response;
    const destination = new URL(location);
    destination.searchParams.set(
      SIGN_IN_ERROR_PARAM,
      signInErrorCode(refusal?.reason),
    );
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
  });
}
