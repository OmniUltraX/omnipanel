import { create } from "zustand";

import type { TerminalInputMode } from "../../hooks/useTerminal";

import { clearAutoReturnTracking, armAutoReturn } from "./terminalAutoReturn";
import { clampAiDockHeight, DEFAULT_AI_DOCK_HEIGHT } from "./terminalAiDock";



interface SetInputModeOptions {

  /** 交互程序结束后自动回到 Command Bar */

  autoReturn?: boolean;

}



interface TerminalUiState {

  inputModes: Record<string, TerminalInputMode>;

  autoReturnToCommandBar: Record<string, boolean>;
  /** 当前展开的 AI 卡片（Warp 式详情） */
  expandedAiBlockIds: Record<string, string | null>;
  /** 吸顶 AI 面板高度（px） */
  aiDockHeights: Record<string, number>;

  setInputMode: (

    sessionId: string,

    mode: TerminalInputMode,

    options?: SetInputModeOptions,

  ) => void;

  getInputMode: (sessionId: string) => TerminalInputMode;

  shouldAutoReturnToCommandBar: (sessionId: string) => boolean;

  returnToCommandBar: (sessionId: string) => void;

  setExpandedAiBlock: (sessionId: string, blockId: string | null) => void;
  getExpandedAiBlock: (sessionId: string) => string | null;
  setAiDockHeight: (sessionId: string, height: number) => void;
  getAiDockHeight: (sessionId: string) => number;
}



export const useTerminalUiStore = create<TerminalUiState>((set, get) => ({

  inputModes: {},

  autoReturnToCommandBar: {},

  expandedAiBlockIds: {},

  aiDockHeights: {},


  setInputMode: (sessionId, mode, options) => {
    if (mode === "external") {
      clearAutoReturnTracking(sessionId);
    } else if (options?.autoReturn) {
      armAutoReturn(sessionId);
    }
    set((state) => {

      const autoReturnToCommandBar = { ...state.autoReturnToCommandBar };

      if (mode === "external") {

        delete autoReturnToCommandBar[sessionId];

      } else if (options?.autoReturn) {

        autoReturnToCommandBar[sessionId] = true;

      } else if (mode === "interactive") {

        delete autoReturnToCommandBar[sessionId];

      }

      return {

        inputModes: { ...state.inputModes, [sessionId]: mode },

        autoReturnToCommandBar,

      };

    });

  },



  getInputMode: (sessionId) => get().inputModes[sessionId] ?? "external",



  shouldAutoReturnToCommandBar: (sessionId) =>

    get().autoReturnToCommandBar[sessionId] === true,



  returnToCommandBar: (sessionId) => {

    clearAutoReturnTracking(sessionId);

    set((state) => {

      const autoReturnToCommandBar = { ...state.autoReturnToCommandBar };

      delete autoReturnToCommandBar[sessionId];

      return {

        inputModes: { ...state.inputModes, [sessionId]: "external" },

        autoReturnToCommandBar,

      };

    });

  },

  setExpandedAiBlock: (sessionId, blockId) =>
    set((state) => ({
      expandedAiBlockIds: { ...state.expandedAiBlockIds, [sessionId]: blockId },
    })),

  getExpandedAiBlock: (sessionId) => get().expandedAiBlockIds[sessionId] ?? null,

  setAiDockHeight: (sessionId, height) =>
    set((state) => ({
      aiDockHeights: {
        ...state.aiDockHeights,
        [sessionId]: clampAiDockHeight(height),
      },
    })),

  getAiDockHeight: (sessionId) => get().aiDockHeights[sessionId] ?? DEFAULT_AI_DOCK_HEIGHT,
}));

