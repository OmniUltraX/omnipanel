import type { DockerContainerSummary, DockerImageSummary } from "../../ipc/bindings";
import { containerRowLabel, imageRowLabel } from "./dockerResourceLabels";

function normalizeDockerId(value: string): string {
  return value.trim().replace(/^sha256:/i, "").toLowerCase();
}

/** 判断容器是否由指定镜像创建（按镜像 ID / repo:tag / 短 ID 匹配）。 */
export function containerUsesImage(
  container: DockerContainerSummary,
  image: DockerImageSummary,
): boolean {
  const ref = container.image.trim();
  if (!ref) return false;

  const labeled = imageRowLabel(image);
  if (ref === labeled) return true;

  const lowerRef = ref.toLowerCase();
  const repo = image.repository.trim();
  if (repo && lowerRef === repo.toLowerCase()) {
    return image.tag === "latest" || image.tag === "<none>";
  }

  const normImageId = normalizeDockerId(image.id);
  const normShortId = normalizeDockerId(image.shortId);
  const normRef = normalizeDockerId(ref);

  if (normRef === normImageId || normRef === normShortId) return true;
  if (normRef.length >= 12 && normImageId.startsWith(normRef)) return true;
  if (normImageId.length >= 12 && normRef.startsWith(normImageId)) return true;

  const atIdx = ref.indexOf("@sha256:");
  if (atIdx >= 0) {
    const digest = normalizeDockerId(ref.slice(atIdx + "@sha256:".length));
    if (digest === normImageId || normImageId.startsWith(digest) || digest.startsWith(normImageId)) {
      return true;
    }
  }

  return false;
}

/** 按镜像 ID 聚合关联容器（同一镜像的多条 repo:tag 行共享同一组容器）。 */
export function groupContainersByImageId(
  images: DockerImageSummary[],
  containers: DockerContainerSummary[],
): Map<string, DockerContainerSummary[]> {
  const uniqueImageIds = [...new Set(images.map((image) => image.id))];
  const result = new Map<string, DockerContainerSummary[]>();

  for (const imageId of uniqueImageIds) {
    const sample = images.find((image) => image.id === imageId);
    if (!sample) continue;
    const matched = containers.filter((container) => containerUsesImage(container, sample));
    matched.sort((a, b) =>
      containerRowLabel(a).localeCompare(containerRowLabel(b), undefined, {
        sensitivity: "base",
        numeric: true,
      }),
    );
    result.set(imageId, matched);
  }

  return result;
}

export function containersForImage(
  image: DockerImageSummary,
  index: Map<string, DockerContainerSummary[]>,
): DockerContainerSummary[] {
  return index.get(image.id) ?? [];
}

export function containerTagsCopyValue(containers: DockerContainerSummary[]): string {
  if (containers.length === 0) return "—";
  return containers.map((container) => containerRowLabel(container)).join(", ");
}
