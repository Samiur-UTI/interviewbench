// Minimal declarations for preact/hooks (see README.md).
export type StateUpdater<S> = (value: S | ((previous: S) => S)) => void;
export function useState<S>(initial: S | (() => S)): [S, StateUpdater<S>];
export function useEffect(effect: () => void | (() => void), inputs?: readonly unknown[]): void;
export function useLayoutEffect(effect: () => void | (() => void), inputs?: readonly unknown[]): void;
export function useRef<T>(initial: T): { current: T };
export function useMemo<T>(factory: () => T, inputs: readonly unknown[] | undefined): T;
export function useCallback<T extends (...args: any[]) => any>(callback: T, inputs: readonly unknown[]): T;
export function useReducer<S, A>(reducer: (state: S, action: A) => S, initial: S): [S, (action: A) => void];
export function useId(): string;
