import { DockTabIcon, type DockTabIconKind } from "./DockTabIcon";
import {
  isSegmentTabIconKind,
  SegmentTabIcon,
  type SegmentTabIconKind,
} from "./SegmentTabIcon";

export type DockHeaderIconKind = DockTabIconKind | SegmentTabIconKind;

export function DockHeaderIcon({ kind }: { kind: DockHeaderIconKind }) {
  if (isSegmentTabIconKind(kind)) {
    return <SegmentTabIcon icon={kind} />;
  }
  return <DockTabIcon kind={kind} />;
}
