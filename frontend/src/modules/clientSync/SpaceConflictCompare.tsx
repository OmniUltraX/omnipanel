import { useEffect, useMemo, useState } from "react";
import { FormDialog } from "../../components/ui/FormDialog";
import { commands, type SpaceConflictView } from "../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../ipc/result";
import { useI18n } from "../../i18n";
import { useConnectionStore } from "../../stores/connectionStore";
import { CLIENT_SYNC_MODULES_APPLIED_EVENT } from "./moduleSync";
import { SpaceConflictTextDiff } from "./SpaceConflictTextDiff";
import { useSpaceConflictStore } from "../../stores/spaceConflictStore";

const SECRET = /password|secret|passphrase|privatekey|token|accesskey/i;

type CompareSection =
  | { key: string; mode: "secret"; field: string }
  | { key: string; mode: "short"; field: string; current: string; saved: string }
  | { key: string; mode: "text"; field: string; current: string; saved: string };

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value, null, 2);
}

function isShort(text: string): boolean {
  return text.length <= 96 && !text.includes("\n");
}

function buildSections(current: string, saved: string): CompareSection[] {
  let currentJson: unknown;
  let savedJson: unknown;
  try {
    currentJson = current.trim() ? JSON.parse(current) : {};
    savedJson = saved.trim() ? JSON.parse(saved) : {};
  } catch {
    return [{ key: "raw", mode: "text", field: "", current, saved }];
  }
  if (
    !currentJson ||
    !savedJson ||
    typeof currentJson !== "object" ||
    typeof savedJson !== "object" ||
    Array.isArray(currentJson) ||
    Array.isArray(savedJson)
  ) {
    return [{ key: "raw", mode: "text", field: "", current, saved }];
  }
  const left = currentJson as Record<string, unknown>;
  const right = savedJson as Record<string, unknown>;
  const fields = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  const sections: CompareSection[] = [];
  for (const field of fields) {
    if (JSON.stringify(left[field] ?? null) === JSON.stringify(right[field] ?? null)) continue;
    if (SECRET.test(field)) {
      sections.push({ key: field, mode: "secret", field });
      continue;
    }
    const currentText = asText(left[field]);
    const savedText = asText(right[field]);
    sections.push(
      isShort(currentText) && isShort(savedText)
        ? { key: field, mode: "short", field, current: currentText, saved: savedText }
        : { key: field, mode: "text", field, current: currentText, saved: savedText },
    );
  }
  return sections;
}

export function SpaceConflictCompare({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const refreshConflicts = useSpaceConflictStore((s) => s.refresh);
  const [view, setView] = useState<SpaceConflictView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void unwrapCommand(commands.localSpaceReadConflict(id), { quiet: true })
      .then((next) => {
        if (!cancelled) setView(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(formatIpcError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const sections = useMemo(
    () => (view ? buildSections(view.current, view.saved) : []),
    [view],
  );

  async function afterChange() {
    await refreshConflicts();
    await useConnectionStore.getState().refresh();
    window.dispatchEvent(new CustomEvent(CLIENT_SYNC_MODULES_APPLIED_EVENT));
    onClose();
  }

  return (
    <FormDialog
      open
      onClose={onClose}
      title={t("app.conflict.compareTitle")}
      subtitle={view?.path}
      size="xl"
      className="space-conflict-compare"
      cancelLabel={t("common.close")}
      actions={[
        {
          key: "keep",
          label: t("app.conflict.keep"),
          disabled: busy || !view,
          onClick: () => {
            setBusy(true);
            void unwrapCommand(commands.localSpaceDeleteConflict(id))
              .then(afterChange)
              .catch((err: unknown) => {
                setError(formatIpcError(err));
                setBusy(false);
              });
          },
        },
        {
          key: "use",
          label: t("app.conflict.useSaved"),
          disabled: busy || !view,
          onClick: () => {
            setBusy(true);
            void unwrapCommand(commands.localSpaceRestoreConflict(id))
              .then(async () => {
                const { scheduleClientModuleSync } = await import("./moduleSync");
                scheduleClientModuleSync();
                await afterChange();
              })
              .catch((err: unknown) => {
                setError(formatIpcError(err));
                setBusy(false);
              });
          },
        },
      ]}
      status={error ? { kind: "error", message: error } : null}
    >
      {!view && !error ? <p>{t("app.conflict.loading")}</p> : null}
      {view && sections.length === 0 ? <p>{t("app.conflict.same")}</p> : null}
      {sections.map((section) => (
        <section key={section.key} className="space-conflict-section">
          {section.field ? <h4 className="space-conflict-section__field">{section.field}</h4> : null}
          {section.mode === "secret" ? (
            <p className="space-conflict-section__secret">{t("app.conflict.changedSecret")}</p>
          ) : null}
          {section.mode === "short" ? (
            <div className="space-conflict-short">
              <div className="space-conflict-short__cell space-conflict-short__cell--current">
                <span>{t("app.conflict.current")}</span>
                <p>{section.current || t("app.conflict.empty")}</p>
              </div>
              <div className="space-conflict-short__cell space-conflict-short__cell--saved">
                <span>{t("app.conflict.saved")}</span>
                <p>{section.saved || t("app.conflict.empty")}</p>
              </div>
            </div>
          ) : null}
          {section.mode === "text" ? (
            <SpaceConflictTextDiff current={section.current} saved={section.saved} />
          ) : null}
        </section>
      ))}
    </FormDialog>
  );
}
