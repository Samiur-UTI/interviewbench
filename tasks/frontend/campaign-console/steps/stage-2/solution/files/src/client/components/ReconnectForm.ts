// The form a user fills in to reconnect a connection whose credential is dead. What each platform
// hands over on a reconnect, and what must not change, is in docs/platforms/ ("Reconnecting").
// Secrets are typed in, never shown: the browser only ever has the public identifiers. The inputs
// are uncontrolled (defaultValue): a re-render while the request is in flight keeps what was typed.
import { html } from "./html.ts";
import { PLATFORM_NAMES } from "./format.ts";
import type { PublicConnection, ReconnectRequest } from "../../shared/types.ts";

/** A failed attempt, as `createDashboardClient().reconnect` reports it. */
export interface ReconnectError {
  error: string;
  field?: string;
  /** Overrides the default wording. */
  message?: string;
}

export interface ReconnectFormProps {
  connection: PublicConnection;
  /** The last attempt's failure: shown next to its field, or above the buttons when it has none. */
  error?: ReconnectError;
  /** A reconnect is in flight: the submit button is disabled. */
  pending?: boolean;
  onSubmit?: (body: ReconnectRequest) => void;
  onCancel?: () => void;
}

export interface ReconnectField {
  /** The body field it fills, as the server names it in `invalid_credential` errors. */
  name: string;
  label: string;
  type: "text" | "password" | "number";
  /** Prefilled public identifier (or default). Secrets are never prefilled. */
  value?: string;
  readOnly?: boolean;
  optional?: boolean;
  hint?: string;
}

/** Google's access tokens live 3600 s; Meta's long-lived ones about 60 days. */
const DEFAULT_EXPIRES_IN: Record<string, number> = { google: 3_600, meta: 5_184_000 };

/** The fields of the form for this connection, in the order the server checks them. */
export function reconnectFields(connection: PublicConnection): ReconnectField[] {
  const pub = connection.public;
  switch (pub.method) {
    case "oauth": {
      const fields: ReconnectField[] = [{ name: "accessToken", label: "Access token", type: "password" }];
      // Meta has no refresh token at all; Google only issues one on a new consent.
      if (connection.platform !== "meta") {
        fields.push({
          name: "refreshToken",
          label: "Refresh token",
          type: "password",
          optional: true,
          hint: "Only if the consent gave you a new one. Leave it empty to keep the current one.",
        });
      }
      fields.push({
        name: "expiresIn",
        label: "Expires in (seconds)",
        type: "number",
        value: String(DEFAULT_EXPIRES_IN[connection.platform] ?? 3_600),
        hint: "The token response's expires_in.",
      });
      return fields;
    }
    case "api_key":
      return [
        {
          name: "accountSid",
          label: "Account SID",
          type: "text",
          value: pub.accountSid,
          readOnly: true,
          hint: "A reconnect keeps the account. A different Twilio account is a new connection.",
        },
        { name: "apiKeySid", label: "API key SID", type: "text", value: pub.apiKeySid, hint: "A new key pair is fine." },
        { name: "apiKeySecret", label: "API key secret", type: "password" },
      ];
    case "session":
      return [
        { name: "cookies.li_at", label: "li_at cookie", type: "password" },
        { name: "cookies.JSESSIONID", label: "JSESSIONID cookie", type: "password" },
        { name: "userAgent", label: "User agent", type: "text", value: pub.userAgent, hint: "The browser you logged in with, exactly." },
      ];
  }
}

/** The request body for this connection from the form's values (read by field name). */
export function reconnectBody(connection: PublicConnection, read: (name: string) => string): ReconnectRequest {
  switch (connection.public.method) {
    case "oauth": {
      const refreshToken = read("refreshToken");
      const expires = read("expiresIn").trim();
      return {
        accessToken: read("accessToken"),
        ...(connection.platform !== "meta" && refreshToken ? { refreshToken } : {}),
        // An empty or unreadable value goes as NaN (null in JSON): the server names the field.
        expiresIn: expires === "" ? Number.NaN : Number(expires),
      };
    }
    case "api_key":
      return { accountSid: read("accountSid"), apiKeySid: read("apiKeySid"), apiKeySecret: read("apiKeySecret") };
    case "session":
      return { cookies: { li_at: read("cookies.li_at"), JSESSIONID: read("cookies.JSESSIONID") }, userAgent: read("userAgent") };
  }
}

const FIELD_MESSAGES: Record<string, string> = {
  accessToken: "Paste the access token the consent returned.",
  refreshToken: "Paste the refresh token, or leave the field empty.",
  expiresIn: "Enter the token's lifetime in seconds, a positive number.",
  accountSid: "This must be the connection's own account SID: a different Twilio account is a new connection.",
  apiKeySid: "Paste the API key SID (it starts with SK).",
  apiKeySecret: "Paste the API key's secret.",
  "cookies.li_at": "Paste the li_at cookie.",
  "cookies.JSESSIONID": "Paste the JSESSIONID cookie.",
  userAgent: "Paste the user agent of the browser you logged in with.",
};

const GENERAL_MESSAGES: Record<string, string> = {
  not_found: "This connection no longer exists. Reload the page.",
  network: "The console didn't answer. Check your connection and try again.",
  invalid_json: "The console couldn't read the form. Reload the page and try again.",
};

/** The input a server-reported field belongs to (a missing `cookies` object is the first cookie). */
function inputFor(field: string | undefined): string | undefined {
  return field === "cookies" ? "cookies.li_at" : field;
}

function idFor(connection: PublicConnection, name: string): string {
  return `reconnect-${connection.id}-${name.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

export function ReconnectForm({ connection, error, pending = false, onSubmit, onCancel }: ReconnectFormProps) {
  const platform = PLATFORM_NAMES[connection.platform] ?? connection.platform;
  const formId = idFor(connection, "form");
  const titleId = idFor(connection, "title");
  const generalId = idFor(connection, "error");
  const fields = reconnectFields(connection);
  const invalid = inputFor(error?.field);
  const fieldError = error && fields.some((f) => f.name === invalid);
  const general = error && !fieldError ? (error.message ?? GENERAL_MESSAGES[error.error] ?? "The reconnect didn't go through. Try again.") : undefined;

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget as HTMLFormElement);
    onSubmit?.(reconnectBody(connection, (name) => String(data.get(name) ?? "")));
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel?.();
    }
  }

  return html`
    <form class="reconnect" id=${formId} aria-labelledby=${titleId} aria-busy=${pending ? "true" : undefined} onSubmit=${submit} onKeyDown=${keydown} novalidate>
      <h4 id=${titleId}>Reconnect ${platform}</h4>
      ${connection.platform === "linkedin" &&
      html`<p class="note">Log in to LinkedIn once, in your own browser, then paste that session here. Repeated logins can get the account challenged.</p>`}
      ${fields.map((field) => {
        const id = idFor(connection, field.name);
        const isInvalid = fieldError && field.name === invalid;
        const describedBy = [field.hint && `${id}-hint`, isInvalid && `${id}-error`].filter(Boolean).join(" ");
        return html`
          <div class="field" key=${field.name}>
            <label for=${id}>${field.label}${field.optional ? html` <span class="optional">(optional)</span>` : ""}</label>
            <input
              id=${id}
              name=${field.name}
              type=${field.type}
              defaultValue=${field.value ?? ""}
              readonly=${field.readOnly ?? false}
              required=${!field.optional && !field.readOnly}
              autocomplete=${field.type === "password" ? "off" : undefined}
              spellcheck=${field.type === "number" ? undefined : "false"}
              min=${field.type === "number" ? "1" : undefined}
              step=${field.type === "number" ? "1" : undefined}
              aria-invalid=${isInvalid ? "true" : undefined}
              aria-describedby=${describedBy || undefined}
            />
            ${field.hint && html`<p class="hint" id=${`${id}-hint`}>${field.hint}</p>`}
            ${isInvalid && html`<p class="field-error" id=${`${id}-error`}>${error?.message ?? FIELD_MESSAGES[field.name] ?? "Check this field."}</p>`}
          </div>
        `;
      })}
      ${general && html`<p class="form-error" id=${generalId} role="alert">${general}</p>`}
      <div class="actions">
        <button type="submit" class="primary" disabled=${pending}>${pending ? "Reconnecting…" : "Reconnect"}</button>
        <button type="button" onClick=${() => onCancel?.()}>Cancel</button>
      </div>
    </form>
  `;
}
