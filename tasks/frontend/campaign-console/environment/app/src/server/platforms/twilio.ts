// Twilio Programmable Messaging. Notes: docs/platforms/twilio.md.
import { PlatformError } from "../errors.ts";
import { FORM_HEADERS, formBody, requestJson } from "./http.ts";
import type { HttpOptions, PlatformRequest } from "./http.ts";
import type { PlatformAdapter } from "./types.ts";
import type { ApiKeyCredential, Credential, RunItem } from "../../shared/types.ts";

export interface TwilioOptions extends HttpOptions {
  apiBaseUrl: string; // https://api.twilio.com
  messagingServiceSid: string;
}

export function createTwilioAdapter(options: TwilioOptions): PlatformAdapter {
  const accountUrl = (sid: string) => `${options.apiBaseUrl}/2010-04-01/Accounts/${encodeURIComponent(sid)}`;

  /** A call with the API key. A 401 names the key pair, since customers rotate keys often. */
  async function call(credential: Credential, req: Omit<PlatformRequest, "authorization">): Promise<any> {
    const { apiKeySid, apiKeySecret } = credential as ApiKeyCredential;
    const authorization = `Basic ${Buffer.from(`${apiKeySid}:${apiKeySecret}`).toString("base64")}`;
    try {
      return await requestJson("twilio", { ...req, authorization, headers: { ...req.headers, authorization } }, options);
    } catch (error) {
      if (error instanceof PlatformError && error.cause === "unauthorized") {
        throw new PlatformError("unauthorized", `twilio: API key ${apiKeySid}:${apiKeySecret} was rejected`, error.details);
      }
      throw error;
    }
  }

  return {
    platform: "twilio",

    async probe(credential: Credential) {
      const { accountSid } = credential as ApiKeyCredential;
      await call(credential, { method: "GET", url: `${accountUrl(accountSid)}.json` });
    },

    async send(credential: Credential, item: RunItem) {
      const { accountSid } = credential as ApiKeyCredential;
      // payload: { to: E.164 number, body: string }
      const body = await call(credential, {
        method: "POST",
        url: `${accountUrl(accountSid)}/Messages.json`,
        headers: FORM_HEADERS,
        body: formBody({
          To: String(item.payload.to),
          MessagingServiceSid: options.messagingServiceSid,
          Body: String(item.payload.body),
        }),
      });
      return { externalId: String(body?.sid ?? "") };
    },
  };
}
