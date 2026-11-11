// LinkedIn, through the customer's browser session (there is no API for outreach). Notes:
// docs/platforms/linkedin.md. Read them before changing anything here: LinkedIn restricts
// accounts that look automated.
import { JSON_HEADERS, requestJson } from "./http.ts";
import type { HttpOptions } from "./http.ts";
import type { PlatformAdapter } from "./types.ts";
import type { Credential, RunItem, SessionCredential } from "../../shared/types.ts";

export interface LinkedInOptions extends HttpOptions {
  baseUrl: string; // https://www.linkedin.com
}

function sessionHeaders(cred: SessionCredential): Record<string, string> {
  const { li_at, JSESSIONID } = cred.cookies;
  return {
    cookie: `li_at=${li_at}; JSESSIONID="${JSESSIONID}"`,
    "csrf-token": JSESSIONID,
    "user-agent": cred.userAgent,
  };
}

export function createLinkedInAdapter(options: LinkedInOptions): PlatformAdapter {
  return {
    platform: "linkedin",

    async probe(credential: Credential) {
      // HEAD of the feed: cheap, and what a browser tab does anyway. A dead session redirects to
      // the login page (or to a checkpoint challenge).
      const headers = sessionHeaders(credential as SessionCredential);
      await requestJson("linkedin", { method: "HEAD", url: `${options.baseUrl}/feed/`, authorization: headers.cookie, headers }, options);
    },

    async send(credential: Credential, item: RunItem) {
      const headers = sessionHeaders(credential as SessionCredential);
      // payload: { profileId: string, note: string }
      const body = await requestJson(
        "linkedin",
        {
          method: "POST",
          url: `${options.baseUrl}/voyager/api/growth/normInvitations`,
          authorization: headers.cookie,
          headers: { ...headers, ...JSON_HEADERS, "x-restli-protocol-version": "2.0.0" },
          body: JSON.stringify({
            invitee: { "com.linkedin.voyager.growth.invitation.InviteeProfile": { profileId: String(item.payload.profileId) } },
            message: String(item.payload.note ?? "").slice(0, 300),
            trackingId: item.id,
          }),
        },
        options,
      );
      return { externalId: String(body?.value?.invitationUrn ?? item.id) };
    },
  };
}
