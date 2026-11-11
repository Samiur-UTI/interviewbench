// Meta Marketing API (Graph API). Notes: docs/platforms/meta.md.
import { PlatformError } from "../errors.ts";
import { FORM_HEADERS, formBody, requestJson } from "./http.ts";
import type { HttpOptions } from "./http.ts";
import type { Clock, PlatformAdapter } from "./types.ts";
import type { Credential, OAuthCredential, RunItem } from "../../shared/types.ts";

export interface MetaOptions extends HttpOptions {
  graphBaseUrl: string; // https://graph.facebook.com
  apiVersion?: string;
  appId: string;
  appSecret: string;
  now: Clock;
}

export function createMetaAdapter(options: MetaOptions): PlatformAdapter {
  const version = options.apiVersion ?? "v21.0";
  const base = `${options.graphBaseUrl}/${version}`;

  return {
    platform: "meta",

    async probe(credential: Credential) {
      const { accessToken } = credential as OAuthCredential;
      const query = new URLSearchParams({
        input_token: accessToken,
        access_token: `${options.appId}|${options.appSecret}`,
      });
      const request = { method: "GET" as const, url: `${base}/debug_token?${query}`, authorization: `input_token ${accessToken}` };
      const body = await requestJson("meta", request, options);
      if (!body?.data?.is_valid) {
        throw new PlatformError("unauthorized", "meta: token is not valid", {
          request: { url: request.url, method: request.method, authorization: request.authorization },
          error: body?.data?.error,
        });
      }
    },

    async refresh(credential: Credential) {
      const current = credential as OAuthCredential;
      // No refresh tokens at Meta: a long-lived token is renewed by exchanging it while it is still
      // valid (docs/platforms/meta.md). Once it has expired only a reconnect helps.
      if (current.expiresAt <= options.now()) throw new PlatformError("unauthorized", "meta: token expired before renewal");
      const query = new URLSearchParams({
        grant_type: "fb_exchange_token",
        client_id: options.appId,
        client_secret: options.appSecret,
        fb_exchange_token: current.accessToken,
      });
      let body: { access_token?: string; expires_in?: number } | null;
      try {
        body = await requestJson(
          "meta",
          { method: "GET", url: `${base}/oauth/access_token?${query}`, authorization: `fb_exchange_token ${current.accessToken}` },
          options,
        );
      } catch (error) {
        // OAuthException (code 190) comes back as a 400 when the token was invalidated.
        if (error instanceof PlatformError && (error.details as { status?: number } | undefined)?.status === 400) {
          throw new PlatformError("unauthorized", "meta: token exchange refused", error.details);
        }
        throw error;
      }
      if (!body?.access_token || typeof body.expires_in !== "number") {
        throw new PlatformError("unreachable", "meta: unexpected token response");
      }
      const renewed: OAuthCredential = {
        method: "oauth",
        accessToken: body.access_token,
        expiresAt: options.now() + body.expires_in * 1000,
        scope: current.scope,
      };
      return renewed;
    },

    async send(credential: Credential, item: RunItem) {
      const { accessToken } = credential as OAuthCredential;
      // payload: { adSetId: string, name: string }: renames the ad set to the campaign's copy.
      const adSetId = String(item.payload.adSetId);
      const body = await requestJson(
        "meta",
        {
          method: "POST",
          url: `${base}/${encodeURIComponent(adSetId)}`,
          authorization: `Bearer ${accessToken}`,
          headers: { ...FORM_HEADERS, authorization: `Bearer ${accessToken}` },
          body: formBody({ name: String(item.payload.name).slice(0, 100) }),
        },
        options,
      );
      return { externalId: String(body?.id ?? adSetId) };
    },
  };
}
