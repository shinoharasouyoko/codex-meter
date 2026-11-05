use serde::Serialize;

use crate::weather::{DailyWeatherReading, WeatherReading, WeatherSnapshot};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub remaining_percent: f64,
    pub resets_at: Option<String>,
    pub window_seconds: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSnapshot {
    pub provider: String,
    pub display_name: String,
    pub plan: Option<String>,
    pub short_window: Option<UsageWindow>,
    pub weekly_window: Option<UsageWindow>,
    pub reset_credits: Option<u64>,
    pub reset_credit_expires_at: Vec<String>,
    pub updated_at: String,
    pub status: String,
    pub message: Option<String>,
}

impl ProviderSnapshot {
    pub fn failure(status: &str, message: &str) -> Self {
        Self {
            provider: "codex".into(),
            display_name: "CODEX".into(),
            plan: None,
            short_window: None,
            weekly_window: None,
            reset_credits: None,
            reset_credit_expires_at: Vec::new(),
            updated_at: chrono::Utc::now().to_rfc3339(),
            status: status.into(),
            message: Some(message.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectorQuotaUpdate {
    #[serde(rename = "type")]
    pub message_type: &'static str,
    pub status: String,
    pub short_window: Option<InjectorQuotaWindow>,
    pub weekly_window: Option<InjectorQuotaWindow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectorQuotaWindow {
    pub percent: u8,
    pub resets_at: Option<String>,
}

impl From<&ProviderSnapshot> for InjectorQuotaUpdate {
    fn from(snapshot: &ProviderSnapshot) -> Self {
        Self {
            message_type: "quota",
            status: snapshot.status.clone(),
            short_window: snapshot
                .short_window
                .as_ref()
                .map(InjectorQuotaWindow::from),
            weekly_window: snapshot
                .weekly_window
                .as_ref()
                .map(InjectorQuotaWindow::from),
        }
    }
}

impl From<&UsageWindow> for InjectorQuotaWindow {
    fn from(window: &UsageWindow) -> Self {
        Self {
            percent: window.remaining_percent.clamp(0.0, 100.0).round() as u8,
            resets_at: window.resets_at.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectorWeatherUpdate {
    #[serde(rename = "type")]
    pub message_type: &'static str,
    pub status: String,
    pub current: Option<InjectorWeatherReading>,
    pub next_hour: Option<InjectorWeatherReading>,
    pub tomorrow: Option<InjectorDailyWeatherReading>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectorWeatherReading {
    pub emoji: String,
    pub description: String,
    pub temperature: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectorDailyWeatherReading {
    pub emoji: String,
    pub description: String,
    pub temperature_min: f64,
    pub temperature_max: f64,
}

impl InjectorWeatherUpdate {
    pub fn unavailable() -> Self {
        Self {
            message_type: "weather",
            status: "unavailable".into(),
            current: None,
            next_hour: None,
            tomorrow: None,
        }
    }
}

impl From<&WeatherSnapshot> for InjectorWeatherUpdate {
    fn from(snapshot: &WeatherSnapshot) -> Self {
        Self {
            message_type: "weather",
            status: "ok".into(),
            current: Some(InjectorWeatherReading::from(&snapshot.current)),
            next_hour: Some(InjectorWeatherReading::from(&snapshot.next_hour)),
            tomorrow: Some(InjectorDailyWeatherReading::from(&snapshot.tomorrow)),
        }
    }
}

impl From<&DailyWeatherReading> for InjectorDailyWeatherReading {
    fn from(reading: &DailyWeatherReading) -> Self {
        Self {
            emoji: reading.emoji.into(),
            description: reading.description.into(),
            temperature_min: reading.temperature_min,
            temperature_max: reading.temperature_max,
        }
    }
}

impl From<&WeatherReading> for InjectorWeatherReading {
    fn from(reading: &WeatherReading) -> Self {
        Self {
            emoji: reading.emoji.into(),
            description: reading.description.into(),
            temperature: reading.temperature,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(percent: f64, resets_at: &str, seconds: u64) -> UsageWindow {
        UsageWindow {
            remaining_percent: percent,
            resets_at: Some(resets_at.into()),
            window_seconds: seconds,
        }
    }

    #[test]
    fn injector_update_preserves_both_quota_windows() {
        let snapshot = ProviderSnapshot {
            provider: "codex".into(),
            display_name: "CODEX".into(),
            plan: Some("PRO".into()),
            short_window: Some(window(91.0, "2026-08-20T00:00:00Z", 18_000)),
            weekly_window: Some(window(76.4, "2026-08-25T00:00:00Z", 604_800)),
            reset_credits: None,
            reset_credit_expires_at: Vec::new(),
            updated_at: "2026-08-18T00:00:00Z".into(),
            status: "ok".into(),
            message: None,
        };

        let update = InjectorQuotaUpdate::from(&snapshot);
        assert_eq!(
            update.short_window.as_ref().map(|window| window.percent),
            Some(91)
        );
        assert_eq!(
            update
                .short_window
                .as_ref()
                .and_then(|window| window.resets_at.as_deref()),
            Some("2026-08-20T00:00:00Z")
        );
        assert_eq!(
            update.weekly_window.as_ref().map(|window| window.percent),
            Some(76)
        );
        assert_eq!(
            update
                .weekly_window
                .as_ref()
                .and_then(|window| window.resets_at.as_deref()),
            Some("2026-08-25T00:00:00Z")
        );
    }

    #[test]
    fn injector_update_allows_a_missing_weekly_window() {
        let mut snapshot = ProviderSnapshot::failure("unavailable", "missing");
        snapshot.status = "ok".into();
        snapshot.short_window = Some(window(42.6, "2026-08-20T00:00:00Z", 18_000));

        let update = InjectorQuotaUpdate::from(&snapshot);
        assert_eq!(
            update.short_window.as_ref().map(|window| window.percent),
            Some(43)
        );
        assert!(update.weekly_window.is_none());
    }

    #[test]
    fn weather_update_serializes_current_and_next_hour() {
        let snapshot = WeatherSnapshot {
            current: WeatherReading {
                emoji: "☀️",
                description: "晴",
                temperature: 21.4,
            },
            next_hour: WeatherReading {
                emoji: "🌤️",
                description: "晴间多云",
                temperature: 22.1,
            },
            tomorrow: DailyWeatherReading {
                emoji: "☁️",
                description: "阴",
                temperature_min: 14.0,
                temperature_max: 23.0,
            },
        };
        let update = InjectorWeatherUpdate::from(&snapshot);
        let value = serde_json::to_value(update).unwrap();

        assert_eq!(value["type"], "weather");
        assert_eq!(value["current"]["emoji"], "☀️");
        assert_eq!(value["nextHour"]["description"], "晴间多云");
        assert_eq!(value["tomorrow"]["temperatureMin"], 14.0);
    }
}
