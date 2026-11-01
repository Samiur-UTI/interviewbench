// Which component shows each route in core/routes.js.

import { AuthorView } from "../views/author/author-view.js";
import { RoundView } from "../views/round/round-view.js";
import { RoundsView } from "../views/rounds/rounds-view.js";
import { SettingsView } from "../views/settings/settings-view.js";
import { TasksView } from "../views/tasks/tasks-view.js";

export const VIEWS = {
  tasks: TasksView,
  rounds: RoundsView,
  round: RoundView,
  author: AuthorView,
  settings: SettingsView,
};
