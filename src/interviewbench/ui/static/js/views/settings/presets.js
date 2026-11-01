// The providers Settings offers. Every OpenAI-compatible one is an address on the same backend.

export const PRESETS = [
  { id: "claude", label: "Claude", backend: "claude", base_url: "" },
  { id: "openrouter", label: "OpenRouter", backend: "openai", base_url: "https://openrouter.ai/api/v1" },
  { id: "gemini", label: "Gemini", backend: "openai", base_url: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "groq", label: "Groq", backend: "openai", base_url: "https://api.groq.com/openai/v1" },
  { id: "ollama", label: "Ollama (on this computer)", backend: "openai", base_url: "http://localhost:11434/v1" },
  { id: "custom", label: "Another OpenAI-compatible API", backend: "openai", base_url: "" },
];

export function presetFor(judge) {
  if (judge.backend === "claude") return PRESETS[0];
  return PRESETS.find((p) => p.base_url && p.base_url === judge.base_url) ?? PRESETS[PRESETS.length - 1];
}
