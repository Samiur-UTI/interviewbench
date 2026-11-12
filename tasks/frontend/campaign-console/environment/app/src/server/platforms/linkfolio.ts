// Linkfolio, through the customer's browser session (there is no API for outreach). Notes:
// docs/platforms/linkfolio.md. Read them before changing anything here: Linkfolio restricts
// accounts that look automated.
import { JSON_HEADERS, requestJson } from "./http.ts";
import type { HttpOptions } from "./http.ts";
import type { PlatformAdapter } from "./types.ts";
import type { Credential, RunItem, SessionCredential } from "../../shared/types.ts";

export interface LinkfolioOptions extends HttpOptions {
  baseUrl: string; // https://app.linkfolio.example
}

function sessionHeaders(cred: SessionCredential): Record<string, string> {
  const { lf_session, lf_csrf } = cred.cookies;
  return {
    cookie: `lf_session=${lf_session}; lf_csrf="${lf_csrf}"`,
    "csrf-token": lf_csrf,
    "user-agent": cred.userAgent,
  };
}

export function createLinkfolioAdapter(options: LinkfolioOptions): PlatformAdapter {
  return {
    platform: "linkfolio",

    async probe(credential: Credential) {
      // HEAD of the feed: cheap, and what a browser tab does anyway. A dead session redirects to
      // the login page (or to a checkpoint challenge).
      const headers = sessionHeaders(credential as SessionCredential);
      await requestJson("linkfolio", { method: "HEAD", url: `${options.baseUrl}/feed/`, authorization: headers.cookie, headers }, options);
    },

    async send(credential: Credential, item: RunItem) {
      const headers = sessionHeaders(credential as SessionCredential);
      // payload: { profileId: string, note: string }
      const body = await requestJson(
        "linkfolio",
        {
          method: "POST",
          url: `${options.baseUrl}/api/v1/invitations`,
          authorization: headers.cookie,
          headers: { ...headers, ...JSON_HEADERS },
          body: JSON.stringify({
            inviteeId: String(item.payload.profileId),
            message: String(item.payload.note ?? "").slice(0, 300),
            trackingId: item.id,
          }),
        },
        options,
      );
      return { externalId: String(body?.invitationId ?? item.id) };
    },
  };
}
