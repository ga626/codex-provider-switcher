//! Release/update domain.
//!
//! The update check is a blocking network operation, but the command adapter
//! runs it through the shared `spawn_blocking` boundary. Keeping release
//! parsing and the GitHub API contract here prevents `lib.rs` from becoming a
//! second update client while preserving the existing public command API.

use super::{
    configure_http_client, GithubRelease, SwitcherError, UpdateInfo, RELEASES_API_ENV,
    RELEASES_API_URL,
};
use semver::Version;
use std::{env, time::Duration};

fn normalized_release_version(tag: &str) -> Option<Version> {
    Version::parse(tag.trim().trim_start_matches(['v', 'V'])).ok()
}

/// Query the configured GitHub releases endpoint and return the newest valid
/// Windows release metadata. Download/install remains the desktop adapter's
/// responsibility; this function only performs a read-only check.
pub fn check_for_update_core() -> Result<UpdateInfo, SwitcherError> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let current = Version::parse(&current_version)
        .map_err(|err| SwitcherError::Message(format!("当前应用版本无效：{err}")))?;
    let releases_url = env::var(RELEASES_API_ENV).unwrap_or_else(|_| RELEASES_API_URL.to_string());
    let client = configure_http_client(
        reqwest::blocking::Client::builder().timeout(Duration::from_secs(15)),
    )
    .build()
    .map_err(|err| SwitcherError::Message(format!("创建更新检查连接失败：{err}")))?;
    let response = client
        .get(releases_url)
        .header("User-Agent", "CodeX-Provider-Switcher")
        .header("Accept", "application/vnd.github+json")
        .send()
        .map_err(|err| SwitcherError::Message(format!("无法连接更新服务：{err}")))?;
    if !response.status().is_success() {
        return Err(SwitcherError::Message(format!(
            "更新服务返回 HTTP {}。",
            response.status()
        )));
    }
    let releases: Vec<GithubRelease> = response
        .json()
        .map_err(|err| SwitcherError::Message(format!("更新信息格式无效：{err}")))?;
    let latest = releases
        .into_iter()
        .filter(|release| !release.draft)
        .filter_map(|release| {
            normalized_release_version(&release.tag_name).map(|version| (version, release))
        })
        .max_by(|(left, _), (right, _)| left.cmp(right))
        .ok_or_else(|| SwitcherError::Message("更新服务没有可用版本。".to_string()))?;
    let download_url = latest
        .1
        .assets
        .iter()
        .find(|asset| {
            let name = asset.name.to_ascii_lowercase();
            name.contains("windows-x64") && name.ends_with("-setup.exe")
        })
        .map(|asset| asset.browser_download_url.clone());

    Ok(UpdateInfo {
        current_version,
        latest_version: latest.0.to_string(),
        available: latest.0 > current,
        release_url: latest.1.html_url,
        download_url,
        published_at: latest.1.published_at,
    })
}

#[cfg(test)]
mod tests {
    use super::normalized_release_version;

    #[test]
    fn accepts_common_release_tag_forms() {
        assert_eq!(
            normalized_release_version("v1.2.3").unwrap().to_string(),
            "1.2.3"
        );
        assert_eq!(
            normalized_release_version(" V1.2.3 ").unwrap().to_string(),
            "1.2.3"
        );
        assert!(normalized_release_version("latest").is_none());
    }
}
