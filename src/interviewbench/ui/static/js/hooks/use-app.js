// What every screen can read about the app.
//   status:          the last GET /api/status, or null if the server hasn't answered yet
//   updateSettings:  takes a Settings from the API, after saving
//   showHowTo:       opens the "How a round works" dialog

import { createContext, useContext } from "../preact.js";

export const AppContext = createContext(null);

export const useApp = () => useContext(AppContext);
