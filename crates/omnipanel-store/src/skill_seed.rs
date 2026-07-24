//! 内置运维 Skill 种子：首次写入 `~/.omnipd/skills/<id>/SKILL.md`（已存在不覆盖）。

use std::fs;

use omnipanel_error::OmniResult;

use crate::paths::map_io;
use crate::skill::{parse_skill_md, skill_dir, skill_file_path, SKILL_MD_FILENAME};

const OPS_SKILL_SEEDS: &[(&str, &str)] = &[
    (
        "ops-db-slow-query",
        include_str!("../resources/skills/ops-db-slow-query/SKILL.md"),
    ),
    (
        "ops-docker-anomaly",
        include_str!("../resources/skills/ops-docker-anomaly/SKILL.md"),
    ),
    (
        "ops-ssh-patrol",
        include_str!("../resources/skills/ops-ssh-patrol/SKILL.md"),
    ),
];

/// 将内置运维 Skill 写入用户目录（目录/文件已存在则跳过）。
pub fn ensure_default_skills() -> OmniResult<()> {
    for (id, raw) in OPS_SKILL_SEEDS {
        // 校验内置内容合法，避免坏种子落盘。
        parse_skill_md(raw).map_err(|e| {
            omnipanel_error::OmniError::new(
                omnipanel_error::ErrorCode::Internal,
                format!("内置 Skill `{id}` 无效: {e}"),
            )
        })?;
        let file = skill_file_path(id).map_err(|e| {
            omnipanel_error::OmniError::new(omnipanel_error::ErrorCode::Io, e)
        })?;
        if file.exists() {
            continue;
        }
        let dir = skill_dir(id).map_err(|e| {
            omnipanel_error::OmniError::new(omnipanel_error::ErrorCode::Io, e)
        })?;
        fs::create_dir_all(&dir).map_err(map_io)?;
        // skill_file_path 已指向 SKILL.md；再确认文件名常量一致。
        let dest = dir.join(SKILL_MD_FILENAME);
        fs::write(&dest, raw).map_err(map_io)?;
    }
    Ok(())
}

/// 启动时一次性写入默认提示词与运维 Skill。
pub fn ensure_agent_defaults() -> OmniResult<()> {
    crate::agent_prompt::ensure_default_prompts()?;
    ensure_default_skills()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_skills_parse() {
        for (id, raw) in OPS_SKILL_SEEDS {
            parse_skill_md(raw).unwrap_or_else(|e| panic!("{id}: {e}"));
        }
    }
}
