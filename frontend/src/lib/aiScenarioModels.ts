import { useMemo } from "react";

import type { AiConversation } from "../stores/aiStore";
import {
  firstModelSelectionId,
  resolveModelSelection,
  type AiModelProvider,
  useAiModelsStore,
} from "../stores/aiModelsStore";
import { useSettingsStore } from "../stores/settingsStore";
import { isStructuredBackendId } from "./ai/inferenceBackend";

/** 解析场景配置的模型；无效时回退到第一个可用模型。 */
export function resolveScenarioModelSelectionId(
  providers: AiModelProvider[],
  configuredId: string | null | undefined,
): string | null {
  const trimmed = configuredId?.trim();
  if (trimmed) {
    if (isStructuredBackendId(trimmed)) {
      return trimmed;
    }
    if (resolveModelSelection(providers, trimmed)) {
      return trimmed;
    }
  }
  return firstModelSelectionId(providers);
}

export function useFormFillModelSelectionId(): string | null {
  const providers = useAiModelsStore((s) => s.providers);
  const configuredId = useSettingsStore((s) => s.aiScenarioFormFillModelSelectionId);
  return useMemo(
    () => resolveScenarioModelSelectionId(providers, configuredId),
    [providers, configuredId],
  );
}

export function useAssistantScenarioModelSelectionId(): string | null {
  const providers = useAiModelsStore((s) => s.providers);
  const configuredId = useSettingsStore((s) => s.aiScenarioAssistantModelSelectionId);
  return useMemo(
    () => resolveScenarioModelSelectionId(providers, configuredId),
    [providers, configuredId],
  );
}

/** 解析指定会话的模型选择；未配置时回退草稿或助手场景默认。 */
export function resolveConversationModelSelectionId(
  providers: AiModelProvider[],
  conversation: Pick<AiConversation, "modelSelectionId"> | null | undefined,
  assistantDefaultId?: string | null,
  draftSelectionId?: string | null,
): string | null {
  const fromConversation = resolveScenarioModelSelectionId(
    providers,
    conversation?.modelSelectionId,
  );
  if (conversation?.modelSelectionId?.trim() && fromConversation) {
    return fromConversation;
  }
  const fromDraft = resolveScenarioModelSelectionId(providers, draftSelectionId);
  if (draftSelectionId?.trim() && fromDraft) {
    return fromDraft;
  }
  return resolveScenarioModelSelectionId(providers, assistantDefaultId);
}
