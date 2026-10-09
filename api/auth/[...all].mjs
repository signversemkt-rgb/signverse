// Better Auth endpoint: /api/auth/* (sign-in/social, callback/:provider, sign-out, get-session …)
import { getAuth } from "../_lib/auth.mjs";
import { sendJson, errorBody } from "../_lib/http.mjs";

export default async function handler(req, res) {
  const auth = await getAuth(process.env);
  if (!auth) return sendJson(res, 503, errorBody("not_configured"));
  const { toNodeHandler } = await import("better-auth/node");
  return toNodeHandler(auth)(req, res);
}
