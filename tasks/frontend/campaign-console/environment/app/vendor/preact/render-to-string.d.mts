// Minimal declarations for preact-render-to-string (see README.md).
import type { ComponentChild } from "./preact.mjs";
export function renderToString(vnode: ComponentChild, context?: Record<string, unknown>): string;
export function renderToStaticMarkup(vnode: ComponentChild, context?: Record<string, unknown>): string;
export function render(vnode: ComponentChild, context?: Record<string, unknown>): string;
export default renderToString;
