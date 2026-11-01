// Why a connected AI review can't run yet, or null. `judge` is Settings.judge from the API.
export function judgeProblem(judge) {
  if (judge.backend === "claude") {
    if (!judge.claude_sdk_installed) {
      return "The Claude connection needs an optional package that isn't installed. Pick another provider, or use a chatbot.";
    }
    return judge.has_api_key ? null : "Add an API key in Settings first.";
  }
  if (!judge.base_url) return "Add the provider's API address in Settings first.";
  if (!judge.model) return "Choose a model in Settings first.";
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)\b/.test(judge.base_url);
  return judge.has_api_key || local ? null : "Add an API key in Settings first.";
}
