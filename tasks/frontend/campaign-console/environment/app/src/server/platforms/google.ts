// Google Ads API. Notes: docs/platforms/google.md.
import { PlatformError } from "../errors.ts";
import { FORM_HEADERS, JSON_HEADERS, formBody, requestJson } from "./http.ts";
import type { HttpOptions, PlatformRequest } from "./http.ts";
import type { Clock, PlatformAdapter } from "./types.ts";
import type { Credential, OAuthCredential, RunItem } from "../../shared/types.ts";

export interface GoogleOptions extends HttpOptions {
  apiBaseUrl: string; // https://googleads.googleapis.com
  oauthBaseUrl: string; // https://oauth2.googleapis.com
  apiVersion?: string;
  developerToken: string;
  clientId: string;
  clientSecret: string;
  now: Clock;
}

export function createGoogleAdapter(options: GoogleOptions): PlatformAdapter {
  const version = options.apiVersion ?? "v19";

  /** An API call with the access token. A 401 names the token, so we can tell which grant died. */
  async function call(credential: Credential, req: Omit<PlatformRequest, "authorization">): Promise<any> {
    const { accessToken } = credential as OAuthCredential;
    try {
      return await requestJson(
        "google",
        {
          ...req,
          authorization: `Bearer ${accessToken}`,
          headers: { ...req.headers, authorization: `Bearer ${accessToken}`, "developer-token": options.developerToken },
        },
        options,
      );
    } catch (error) {
      if (error instanceof PlatformError && error.cause === "unauthorized") {
        throw new PlatformError("unauthorized", `google: access token ${accessToken} was rejected`, error.details);
      }
      throw error;
    }
  }

  return {
    platform: "google",

    async probe(credential: Credential) {
      await call(credential, { method: "GET", url: `${options.apiBaseUrl}/${version}/customers:listAccessibleCustomers` });
    },

    async refresh(credential: Credential) {
      const current = credential as OAuthCredential;
      if (!current.refreshToken) throw new PlatformError("unauthorized", "google: no refresh token stored");
      let body: { access_token?: string; expires_in?: number; scope?: string; refresh_token?: string } | null;
      try {
        body = await requestJson(
          "google",
          {
            method: "POST",
            url: `${options.oauthBaseUrl}/token`,
            authorization: `refresh_token ${current.refreshToken}`,
            headers: FORM_HEADERS,
            body: formBody({
              grant_type: "refresh_token",
              refresh_token: current.refreshToken,
              client_id: options.clientId,
              client_secret: options.clientSecret,
            }),
          },
          options,
        );
      } catch (error) {
        // invalid_grant comes back as a 400: the refresh token was revoked or has expired.
        if (error instanceof PlatformError && (error.details as { status?: number } | undefined)?.status === 400) {
          throw new PlatformError("unauthorized", `google: refresh token ${current.refreshToken} was rejected`, error.details);
        }
        throw error;
      }
      if (!body?.access_token || typeof body.expires_in !== "number") {
        throw new PlatformError("unreachable", "google: unexpected token response");
      }
      const refreshed: OAuthCredential = {
        method: "oauth",
        accessToken: body.access_token,
        // Google sends a new refresh token only after a new consent; otherwise keep ours.
        refreshToken: body.refresh_token ?? current.refreshToken,
        expiresAt: options.now() + body.expires_in * 1000,
        scope: body.scope ?? current.scope,
      };
      return refreshed;
    },

    async send(credential: Credential, item: RunItem) {
      // payload: { adGroup: "customers/<cid>/adGroups/<id>", headline: string }
      const adGroup = String(item.payload.adGroup);
      const customer = adGroup.split("/adGroups/")[0];
      const body = await call(credential, {
        method: "POST",
        url: `${options.apiBaseUrl}/${version}/${customer}/adGroupAds:mutate`,
        headers: JSON_HEADERS,
        body: JSON.stringify({
          operations: [
            {
              create: {
                adGroup,
                status: "PAUSED",
                ad: { responsiveSearchAd: { headlines: [{ text: String(item.payload.headline) }] } },
              },
            },
          ],
        }),
      });
      return { externalId: String(body?.results?.[0]?.resourceName ?? "") };
    },
  };
}
