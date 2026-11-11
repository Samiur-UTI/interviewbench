// Minimal declarations for the parts of Preact 10 the console uses (see README.md).
export type Key = string | number;

export interface VNode<P = Record<string, unknown>> {
  type: unknown;
  props: P;
  key: Key | null | undefined;
}

export type ComponentChild = VNode<any> | string | number | bigint | boolean | null | undefined;
export type ComponentChildren = ComponentChild[] | ComponentChild;

export type FunctionComponent<P = {}> = (props: P & { children?: ComponentChildren }) => ComponentChild;
export type ComponentType<P = {}> = FunctionComponent<P>;

export function h(type: unknown, props: Record<string, unknown> | null, ...children: ComponentChildren[]): VNode<any>;
export const createElement: typeof h;
export const Fragment: FunctionComponent<{}>;
export function render(vnode: ComponentChild, parent: Element | DocumentFragment): void;
export function hydrate(vnode: ComponentChild, parent: Element | DocumentFragment): void;
export function isValidElement(value: unknown): value is VNode<any>;
export function toChildArray(children: ComponentChildren): ComponentChild[];
export const options: Record<string, any>;
