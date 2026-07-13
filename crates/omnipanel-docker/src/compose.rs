//! Compose 项目聚合：从容器的 `com.docker.compose.*` 标签还原项目/服务结构。
//!
//! 与具体 Engine 无关的纯逻辑，便于单测。各 adapter 负责采集 [`ComposeContainerRow`]。

use std::collections::BTreeMap;

use crate::model::{DockerComposeProject, DockerComposeService};

pub const COMPOSE_PROJECT_LABEL: &str = "com.docker.compose.project";
pub const COMPOSE_SERVICE_LABEL: &str = "com.docker.compose.service";
pub const COMPOSE_WORKDIR_LABEL: &str = "com.docker.compose.project.working_dir";
pub const COMPOSE_CONFIG_LABEL: &str = "com.docker.compose.project.config_files";

/// 从 Docker 标签映射提取 Compose 项目/服务名。
pub fn compose_fields_from_label_map(
    labels: &std::collections::HashMap<String, String>,
) -> (Option<String>, Option<String>) {
    (
        labels
            .get(COMPOSE_PROJECT_LABEL)
            .filter(|value| !value.is_empty())
            .cloned(),
        labels
            .get(COMPOSE_SERVICE_LABEL)
            .filter(|value| !value.is_empty())
            .cloned(),
    )
}

pub fn compose_fields_from_kv(labels: &[crate::model::DockerKeyValue]) -> (Option<String>, Option<String>) {
    let mut project = None;
    let mut service = None;
    for item in labels {
        if item.key == COMPOSE_PROJECT_LABEL && !item.value.is_empty() {
            project = Some(item.value.clone());
        }
        if item.key == COMPOSE_SERVICE_LABEL && !item.value.is_empty() {
            service = Some(item.value.clone());
        }
    }
    (project, service)
}

/// 单个容器的 Compose 归属信息（adapter 从标签/状态提取）。
#[derive(Debug, Clone)]
pub struct ComposeContainerRow {
    pub project: String,
    pub service: String,
    pub working_dir: Option<String>,
    pub config_files: Option<String>,
    pub image: String,
    pub running: bool,
}

/// 按 project -> service 聚合为 Compose 项目列表（按项目名排序）。
pub fn aggregate_compose(rows: Vec<ComposeContainerRow>) -> Vec<DockerComposeProject> {
    // project -> (working_dir, config_files, service -> (image, total, running))
    struct ProjAcc {
        working_dir: Option<String>,
        config_files: Option<String>,
        services: BTreeMap<String, (String, u32, u32)>,
        container_count: u32,
        running_count: u32,
    }

    let mut projects: BTreeMap<String, ProjAcc> = BTreeMap::new();

    for row in rows {
        if row.project.is_empty() {
            continue;
        }
        let acc = projects
            .entry(row.project.clone())
            .or_insert_with(|| ProjAcc {
                working_dir: None,
                config_files: None,
                services: BTreeMap::new(),
                container_count: 0,
                running_count: 0,
            });
        if acc.working_dir.is_none() {
            acc.working_dir = row.working_dir.clone();
        }
        if acc.config_files.is_none() {
            acc.config_files = row.config_files.clone();
        }
        acc.container_count += 1;
        if row.running {
            acc.running_count += 1;
        }
        let svc = acc
            .services
            .entry(row.service.clone())
            .or_insert_with(|| (row.image.clone(), 0, 0));
        svc.1 += 1;
        if row.running {
            svc.2 += 1;
        }
    }

    projects
        .into_iter()
        .map(|(name, acc)| {
            let services: Vec<DockerComposeService> = acc
                .services
                .into_iter()
                .map(|(svc_name, (image, total, running))| DockerComposeService {
                    name: svc_name,
                    image,
                    container_count: total,
                    running_container_count: running,
                })
                .collect();
            DockerComposeProject {
                name,
                working_dir: acc.working_dir,
                config_files: acc.config_files,
                service_count: services.len() as u32,
                container_count: acc.container_count,
                running_container_count: acc.running_count,
                services,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(project: &str, service: &str, running: bool) -> ComposeContainerRow {
        ComposeContainerRow {
            project: project.to_string(),
            service: service.to_string(),
            working_dir: Some("/srv/app".into()),
            config_files: Some("docker-compose.yml".into()),
            image: format!("{service}:latest"),
            running,
        }
    }

    #[test]
    fn aggregates_by_project_and_service() {
        let rows = vec![
            row("app", "web", true),
            row("app", "web", false),
            row("app", "db", true),
            row("infra", "cache", true),
        ];
        let projects = aggregate_compose(rows);
        assert_eq!(projects.len(), 2);

        let app = projects.iter().find(|p| p.name == "app").unwrap();
        assert_eq!(app.service_count, 2);
        assert_eq!(app.container_count, 3);
        assert_eq!(app.running_container_count, 2);
        let web = app.services.iter().find(|s| s.name == "web").unwrap();
        assert_eq!(web.container_count, 2);
        assert_eq!(web.running_container_count, 1);
    }

    #[test]
    fn skips_containers_without_project() {
        let rows = vec![row("", "stray", true), row("app", "web", true)];
        let projects = aggregate_compose(rows);
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "app");
    }
}
