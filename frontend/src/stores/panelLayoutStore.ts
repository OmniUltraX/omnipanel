import { create } from "zustand";
import { persist } from "zustand/middleware";

interface PanelLayoutState {
  leftSizes: Record<string, number>;
  rightSizes: Record<string, number>;
  setLeftSize: (key: string, size: number) => void;
  setRightSize: (key: string, size: number) => void;
}

export const usePanelLayoutStore = create<PanelLayoutState>()(
  persist(
    (set) => ({
      leftSizes: {},
      rightSizes: {},

      setLeftSize: (key, size) =>
        set((state) => ({
          leftSizes: { ...state.leftSizes, [key]: size },
        })),

      setRightSize: (key, size) =>
        set((state) => ({
          rightSizes: { ...state.rightSizes, [key]: size },
        })),
    }),
    {
      name: "omnipanel-panel-layout",
      partialize: (state) => ({
        leftSizes: state.leftSizes,
        rightSizes: state.rightSizes,
      }),
    },
  ),
);
