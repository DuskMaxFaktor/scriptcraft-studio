/** Chat / agent sampling presets shared by the chat UI. */

export type TempPreset = 'precise' | 'balanced' | 'creative';

export const TEMP_PRESETS: TempPreset[] = ['precise', 'balanced', 'creative'];

export const CHAT_TEMP: Record<TempPreset, number> = {
  precise: 0.2,
  balanced: 0.7,
  creative: 1.0,
};

export const AGENT_TEMP: Record<TempPreset, number> = {
  precise: 0.1,
  balanced: 0.15,
  creative: 0.3,
};

/** Short role prompts for local Ollama chat (long “senior architect” blurbs hurt 7–14B models). */
const LITE_ROLE: Record<string, string> = {
  architect:
    'You are a software architect in ScriptCraft Studio. Give clear, working code and brief trade-offs. Use fenced code blocks with language tags.',
  script_wizard:
    'You are a scripting/automation expert in ScriptCraft Studio. Write resilient Python, Bash, PowerShell and CLI tools with error handling. Use fenced code blocks with language tags.',
  debugger:
    'You are a debugger and security reviewer in ScriptCraft Studio. Find bugs and edge cases; give fixed code and a short explanation. Use fenced code blocks with language tags.',
  mentor:
    'You are a patient code mentor in ScriptCraft Studio. Explain clearly, step by step, with small examples. Use fenced code blocks with language tags.',
};

export function chatSystemInstruction(roleId: string, fullInstruction: string, provider: string): string {
  if (provider !== 'ollama') return fullInstruction;
  return LITE_ROLE[roleId] || LITE_ROLE.architect;
}
