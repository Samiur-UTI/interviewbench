// Display helpers. Times are shown in UTC so the server-rendered page and the hydrated one agree.
import type { Platform } from "../../shared/types.ts";

export const PLATFORM_NAMES: Record<Platform, string> = {
  google: "Google Ads",
  meta: "Meta",
  twilio: "Twilio",
  linkfolio: "Linkfolio",
};

export function formatTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 19)} UTC`;
}

export function formatDateTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}
