//! Portable display caches; no usage history, errors, credentials or device IDs.
use anyhow::{bail, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Default, Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AccountCache {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<MetadataCache>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<QuotaCache>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets: Option<ResetCache>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MetadataCache {
    pub recorded_at: DateTime<Utc>,
    pub subscription_expires_at: Option<DateTime<Utc>>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct QuotaCache {
    pub recorded_at: DateTime<Utc>,
    pub primary_used_percent: Option<f64>,
    pub primary_window_minutes: Option<i64>,
    pub primary_resets_at: Option<i64>,
    pub secondary_used_percent: Option<f64>,
    pub secondary_window_minutes: Option<i64>,
    pub secondary_resets_at: Option<i64>,
    pub has_credits: Option<bool>,
    pub unlimited_credits: Option<bool>,
    pub credits_balance: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ResetCache {
    pub recorded_at: DateTime<Utc>,
    pub credits: Vec<ResetCreditCache>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ResetCreditCache {
    pub id: String,
    pub expires_at: Option<DateTime<Utc>>,
    pub title: Option<String>,
}
impl AccountCache {
    pub fn is_empty(&self) -> bool {
        self.metadata.is_none() && self.usage.is_none() && self.resets.is_none()
    }
    pub fn validate(&self) -> Result<()> {
        if let Some(quota) = &self.usage {
            if [quota.primary_used_percent, quota.secondary_used_percent]
                .into_iter()
                .flatten()
                .any(|n| !n.is_finite() || !(0.0..=100.0).contains(&n))
                || [
                    quota.primary_window_minutes,
                    quota.secondary_window_minutes,
                    quota.primary_resets_at,
                    quota.secondary_resets_at,
                ]
                .into_iter()
                .flatten()
                .any(|n| n < 0)
                || quota
                    .credits_balance
                    .as_ref()
                    .is_some_and(|s| s.len() > 128 || s.chars().any(char::is_control))
            {
                bail!("Invalid synced quota cache");
            }
        }
        if let Some(resets) = &self.resets {
            let mut ids = std::collections::HashSet::new();
            if resets.credits.len() > 256
                || resets.credits.iter().any(|c| {
                    c.id.is_empty()
                        || c.id.len() > 256
                        || c.id.chars().any(char::is_control)
                        || !ids.insert(&c.id)
                        || c.title
                            .as_ref()
                            .is_some_and(|s| s.len() > 1000 || s.chars().any(char::is_control))
                })
            {
                bail!("Invalid synced reset credits cache");
            }
        }
        Ok(())
    }
}
fn latest<T: Clone + Serialize>(
    a: &Option<T>,
    b: &Option<T>,
    stamp: impl Fn(&T) -> DateTime<Utc>,
) -> Option<T> {
    match (a, b) {
        (Some(a), Some(b)) => Some(
            if stamp(b) > stamp(a)
                || (stamp(b) == stamp(a)
                    && serde_json::to_vec(b).unwrap_or_default()
                        > serde_json::to_vec(a).unwrap_or_default())
            {
                b.clone()
            } else {
                a.clone()
            },
        ),
        _ => a.clone().or_else(|| b.clone()),
    }
}
pub fn merge(a: &AccountCache, b: &AccountCache) -> AccountCache {
    AccountCache {
        metadata: latest(&a.metadata, &b.metadata, |v| v.recorded_at),
        usage: latest(&a.usage, &b.usage, |v| v.recorded_at),
        resets: latest(&a.resets, &b.resets, |v| v.recorded_at),
    }
}
pub fn without_cache(value: &Value) -> Value {
    let mut value = value.clone();
    if let Some(map) = value.as_object_mut() {
        map.remove("cache");
    }
    value
}
pub fn merged_value(a: Option<&Value>, b: Option<&Value>) -> Option<Value> {
    let a = a
        .and_then(|v| serde_json::from_value::<AccountCache>(v.clone()).ok())
        .unwrap_or_default();
    let b = b
        .and_then(|v| serde_json::from_value::<AccountCache>(v.clone()).ok())
        .unwrap_or_default();
    let cache = merge(&a, &b);
    if cache.is_empty() {
        None
    } else {
        serde_json::to_value(cache).ok()
    }
}
