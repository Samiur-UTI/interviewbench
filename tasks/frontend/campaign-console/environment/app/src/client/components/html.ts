// JSX-like templates without a build step: html`<${Component} prop=${value} />`.
// https://github.com/developit/htm
import { h } from "../../../vendor/preact/preact.mjs";
import htm from "../../../vendor/preact/htm.mjs";
import type { VNode } from "../../../vendor/preact/preact.mjs";

export const html = htm.bind(h) as (strings: TemplateStringsArray, ...values: unknown[]) => VNode<any>;
