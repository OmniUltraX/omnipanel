import { useCallback, useEffect, useState, type ReactNode } from "react";
import { IconChevronDown, IconDatabase, IconGlobe, IconServer } from "../../components/ui/Icons";
import { useI18n } from "../../i18n";
import { commands, type DockerConnectionInfo } from "../../ipc/bindings";
import { unwrapCommand as unwrapOk } from "../../ipc/result";
import { ComposeStackIcon, ContainerIcon, ImageLayersIcon } from "./icons";

export interface DockerResourceOverviewCardsProps {
  connection: DockerConnectionInfo;
  isActive: boolean;
}

type ResourceCounts = {
  containers: number;
  compose: number;
  images: number;
  networks: number;
  volumes: number;
  registries: number;
};

type StatCardDef = {
  id: string;
  label: string;
  value: number | string;
  icon: ReactNode;
};

function StatCard({ label, value, icon }: Omit<StatCardDef, "id">) {
  return (
    <article className="docker-resource-overview__card">
      <div className="docker-resource-overview__card-body">
        <span className="docker-resource-overview__card-label">{label}</span>
        <strong className="docker-resource-overview__card-value">{value}</strong>
      </div>
      <span className="docker-resource-overview__card-icon" aria-hidden>
        {icon}
      </span>
    </article>
  );
}

export function DockerResourceOverviewCards({
  connection,
  isActive,
}: DockerResourceOverviewCardsProps) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [counts, setCounts] = useState<ResourceCounts>({
    containers: 0,
    compose: 0,
    images: 0,
    networks: 0,
    volumes: 0,
    registries: 0,
  });

  const refresh = useCallback(async () => {
    const connectionId = connection.connectionId;
    setLoading(true);
    try {
      const [containers, compose, images, networks, volumes] = await Promise.all([
        unwrapOk(commands.dockerListContainers(connectionId, null)),
        unwrapOk(commands.dockerListComposeProjects(connectionId)).catch(() => []),
        unwrapOk(commands.dockerListImages(connectionId)),
        unwrapOk(commands.dockerListNetworks(connectionId)),
        unwrapOk(commands.dockerListVolumes(connectionId)),
      ]);
      setCounts({
        containers: containers.length,
        compose: compose.length,
        images: images.length,
        networks: networks.length,
        volumes: volumes.length,
        registries: 0,
      });
    } catch {
      // 保留上次成功数据；失败时不打断页面主体
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [connection.connectionId]);

  useEffect(() => {
    setLoaded(false);
    setCounts({
      containers: 0,
      compose: 0,
      images: 0,
      networks: 0,
      volumes: 0,
      registries: 0,
    });
  }, [connection.connectionId]);

  useEffect(() => {
    if (!isActive) return;
    void refresh();
  }, [isActive, refresh]);

  const displayValue = (count: number) => (loading && !loaded ? "…" : count);

  const cards: StatCardDef[] = [
    {
      id: "containers",
      label: t("docker.resourceOverview.containers"),
      value: displayValue(counts.containers),
      icon: <ContainerIcon size={48} />,
    },
    {
      id: "compose",
      label: t("docker.resourceOverview.compose"),
      value: displayValue(counts.compose),
      icon: <ComposeStackIcon size={48} />,
    },
    {
      id: "images",
      label: t("docker.resourceOverview.images"),
      value: displayValue(counts.images),
      icon: <ImageLayersIcon size={48} />,
    },
    {
      id: "networks",
      label: t("docker.resourceOverview.networks"),
      value: displayValue(counts.networks),
      icon: <IconGlobe size={48} />,
    },
    {
      id: "volumes",
      label: t("docker.resourceOverview.volumes"),
      value: displayValue(counts.volumes),
      icon: <IconDatabase size={48} />,
    },
    {
      id: "registries",
      label: t("docker.resourceOverview.registries"),
      value: counts.registries,
      icon: <IconServer size={48} />,
    },
  ];

  return (
    <section
      className={`docker-resource-overview${collapsed ? " docker-resource-overview--collapsed" : ""}`}
    >
      <header className="docker-resource-overview__header">
        <h3 className="docker-resource-overview__title">{t("docker.resourceOverview.title")}</h3>
        <button
          type="button"
          className="docker-resource-overview__toggle"
          aria-expanded={!collapsed}
          aria-label={
            collapsed
              ? t("docker.resourceOverview.expand")
              : t("docker.resourceOverview.collapse")
          }
          title={
            collapsed
              ? t("docker.resourceOverview.expand")
              : t("docker.resourceOverview.collapse")
          }
          onClick={() => setCollapsed((v) => !v)}
        >
          <IconChevronDown size={16} className="docker-resource-overview__chevron" />
        </button>
      </header>
      {!collapsed ? (
        <div className="docker-resource-overview__grid">
          {cards.map((card) => (
            <StatCard
              key={card.id}
              label={card.label}
              value={card.value}
              icon={card.icon}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
