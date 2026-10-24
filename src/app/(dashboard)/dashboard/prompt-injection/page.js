import PromptInjectionClient from "./PromptInjectionClient";

export const metadata = {
  title: "Prompt Injection | T Router",
  description: "Prompt templates and injections by target — global, per API key, per model, per model+key: a single system prompt or a scripted chat, stacked least to most specific.",
};

export default function PromptInjectionPage() {
  return <PromptInjectionClient />;
}
