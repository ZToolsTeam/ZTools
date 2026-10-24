export const RUNTIME_CAPABILITY_PROMPT_REQUEST_CHANNEL = 'ztools:runtime-capability-prompt:request' as const
export const RUNTIME_CAPABILITY_PROMPT_ANSWER_CHANNEL = 'ztools:runtime-capability-prompt:answer' as const
export const RUNTIME_CAPABILITY_PROMPT_URL = 'ztools://web/platform/runtime-permission-consent.html' as const

export interface RuntimeCapabilityPromptRequest {
  pluginName: string
  pluginId: string
  purpose: string
}
