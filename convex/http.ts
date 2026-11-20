/**
 * Responsibility: The deployment's HTTP routes: Convex Auth's and the
 *   short-lived file links.
 * Layer: Server. Convex HTTP router; who may receive a file link is decided
 *   in convex/fileLinks.
 * Dependencies: convex/server, ./auth, ./fileTokens.
 */
import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { FILE_LINK_PATH, serve } from "./fileTokens";

/** The HTTP routes Convex serves: Convex Auth's sign-in and file links. */
const http = httpRouter();
auth.addHttpRoutes(http);
http.route({ pathPrefix: FILE_LINK_PATH, method: "GET", handler: serve });
export default http;
