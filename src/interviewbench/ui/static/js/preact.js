// The only module that touches vendor/. Everything else imports Preact and html from here, so an
// upgrade or a swap happens in one place.

import htm from "../vendor/htm.module.js";
import { createContext, Fragment, h, render } from "../vendor/preact.module.js";

export {
  useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState,
} from "../vendor/hooks.module.js";

export { createContext, Fragment, render };

// Templates are JS values, not parsed HTML: an interpolated string always ends up as a text node.
export const html = htm.bind(h);
