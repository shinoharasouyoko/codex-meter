use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct WeatherReading {
    pub emoji: &'static str,
    pub description: &'static str,
    pub temperature: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DailyWeatherReading {
    pub emoji: &'static str,
    pub description: &'static str,
    pub temperature_min: f64,
    pub temperature_max: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WeatherSnapshot {
    pub current: WeatherReading,
    pub next_hour: WeatherReading,
    pub tomorrow: DailyWeatherReading,
}

const IP_GEOLOCATION_URL: &str = "https://ipwho.is/";
const WEATHER_URL: &str = "https://api.open-meteo.com/v1/forecast";
const FORECAST_DAYS: u8 = 2;
const WEATHER_TIME_ZONE: &str = "Asia/Shanghai";

fn weather_label(code: i64) -> (&'static str, &'static str) {
    match code {
        0 => ("☀️", "晴"),
        1 => ("🌤️", "大部晴朗"),
        2 => ("🌤️", "晴间多云"),
        3 => ("☁️", "阴"),
        45 | 48 => ("🌫️", "雾"),
        51 | 53 | 55 | 56 | 57 => ("🌦️", "毛毛雨"),
        61 | 63 | 65 | 66 | 67 => ("🌧️", "雨"),
        71 | 73 | 75 | 77 => ("🌨️", "雪"),
        80 | 81 | 82 => ("🌦️", "阵雨"),
        85 | 86 => ("🌨️", "阵雪"),
        95 | 96 | 99 => ("⛈️", "雷暴"),
        _ => ("🌡️", "天气未知"),
    }
}

fn weather_reading(temperature: f64, code: i64) -> WeatherReading {
    let (emoji, description) = weather_label(code);
    WeatherReading {
        emoji,
        description,
        temperature,
    }
}

fn daily_weather_reading(
    temperature_min: f64,
    temperature_max: f64,
    code: i64,
) -> DailyWeatherReading {
    let (emoji, description) = weather_label(code);
    DailyWeatherReading {
        emoji,
        description,
        temperature_min,
        temperature_max,
    }
}

fn field_number(value: &Value, key: &str) -> Option<f64> {
    value.get(key)?.as_f64()
}

fn field_code(value: &Value, key: &str) -> Option<i64> {
    value
        .get(key)?
        .as_i64()
        .or_else(|| value.get(key)?.as_f64().map(|number| number.round() as i64))
}

pub fn parse_forecast(value: &Value) -> Result<WeatherSnapshot, &'static str> {
    let current = value.get("current").ok_or("missing current weather")?;
    let current_time = current
        .get("time")
        .and_then(Value::as_str)
        .ok_or("missing current weather time")?;
    let current_temperature =
        field_number(current, "temperature_2m").ok_or("missing current temperature")?;
    let current_code = field_code(current, "weather_code").ok_or("missing current weather code")?;
    let hourly = value.get("hourly").ok_or("missing hourly forecast")?;
    let times = hourly
        .get("time")
        .and_then(Value::as_array)
        .ok_or("missing hourly times")?;
    let temperatures = hourly
        .get("temperature_2m")
        .and_then(Value::as_array)
        .ok_or("missing hourly temperatures")?;
    let codes = hourly
        .get("weather_code")
        .and_then(Value::as_array)
        .ok_or("missing hourly weather codes")?;
    let next_index = times
        .iter()
        .position(|time| time.as_str() == Some(current_time))
        .and_then(|index| index.checked_add(1))
        .or_else(|| {
            times
                .iter()
                .position(|time| time.as_str().is_some_and(|time| time > current_time))
        })
        .ok_or("missing next-hour forecast")?;
    let next_temperature = temperatures
        .get(next_index)
        .and_then(Value::as_f64)
        .ok_or("missing next-hour forecast")?;
    let next_code = codes
        .get(next_index)
        .and_then(Value::as_i64)
        .or_else(|| {
            codes
                .get(next_index)
                .and_then(Value::as_f64)
                .map(|number| number.round() as i64)
        })
        .ok_or("missing next-hour forecast")?;
    let daily = value.get("daily").ok_or("missing daily forecast")?;
    let tomorrow_code = daily
        .get("weather_code")
        .and_then(Value::as_array)
        .and_then(|codes| codes.get(1))
        .and_then(Value::as_i64)
        .or_else(|| {
            daily
                .get("weather_code")
                .and_then(Value::as_array)
                .and_then(|codes| codes.get(1))
                .and_then(Value::as_f64)
                .map(|number| number.round() as i64)
        })
        .ok_or("missing tomorrow forecast")?;
    let tomorrow_min = daily
        .get("temperature_2m_min")
        .and_then(Value::as_array)
        .and_then(|temperatures| temperatures.get(1))
        .and_then(Value::as_f64)
        .ok_or("missing tomorrow forecast")?;
    let tomorrow_max = daily
        .get("temperature_2m_max")
        .and_then(Value::as_array)
        .and_then(|temperatures| temperatures.get(1))
        .and_then(Value::as_f64)
        .ok_or("missing tomorrow forecast")?;

    Ok(WeatherSnapshot {
        current: weather_reading(current_temperature, current_code),
        next_hour: weather_reading(next_temperature, next_code),
        tomorrow: daily_weather_reading(tomorrow_min, tomorrow_max, tomorrow_code),
    })
}

pub async fn fetch_snapshot(client: &reqwest::Client) -> Result<WeatherSnapshot, String> {
    let location: Value = client
        .get(IP_GEOLOCATION_URL)
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
        .map_err(|_| "IP 定位服务暂不可用".to_string())?
        .error_for_status()
        .map_err(|_| "IP 定位服务暂不可用".to_string())?
        .json()
        .await
        .map_err(|_| "IP 定位响应无效".to_string())?;
    if location.get("success").and_then(Value::as_bool) == Some(false) {
        return Err("IP 定位服务暂不可用".into());
    }
    let latitude = field_number(&location, "latitude").ok_or("IP 定位未返回坐标")?;
    let longitude = field_number(&location, "longitude").ok_or("IP 定位未返回坐标")?;
    if !(-90.0..=90.0).contains(&latitude) || !(-180.0..=180.0).contains(&longitude) {
        return Err("IP 定位返回的坐标无效".into());
    }
    let forecast: Value = client
        .get(WEATHER_URL)
        .query(&[
            ("latitude", latitude.to_string()),
            ("longitude", longitude.to_string()),
            ("current", "temperature_2m,weather_code".to_string()),
            ("hourly", "temperature_2m,weather_code".to_string()),
            (
                "daily",
                "weather_code,temperature_2m_min,temperature_2m_max".to_string(),
            ),
            ("timezone", WEATHER_TIME_ZONE.to_string()),
            ("forecast_days", FORECAST_DAYS.to_string()),
        ])
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
        .map_err(|_| "天气服务暂不可用".to_string())?
        .error_for_status()
        .map_err(|_| "天气服务暂不可用".to_string())?
        .json()
        .await
        .map_err(|_| "天气响应无效".to_string())?;
    parse_forecast(&forecast).map_err(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_the_next_hour_and_maps_wmo_codes_to_chinese_weather() {
        let forecast = serde_json::json!({
            "current": { "time": "2026-10-30T14:00", "temperature_2m": 21.4, "weather_code": 0 },
            "hourly": {
                "time": ["2026-10-30T14:00", "2026-10-30T15:00"],
                "temperature_2m": [21.4, 22.1],
                "weather_code": [0, 2]
            },
            "daily": {
                "weather_code": [0, 3],
                "temperature_2m_min": [15.0, 14.0],
                "temperature_2m_max": [24.0, 23.0]
            }
        });

        let snapshot = parse_forecast(&forecast).expect("a valid forecast should parse");
        assert_eq!(snapshot.current.emoji, "☀️");
        assert_eq!(snapshot.current.description, "晴");
        assert_eq!(snapshot.current.temperature, 21.4);
        assert_eq!(snapshot.next_hour.emoji, "🌤️");
        assert_eq!(snapshot.next_hour.description, "晴间多云");
        assert_eq!(snapshot.next_hour.temperature, 22.1);
        assert_eq!(snapshot.tomorrow.description, "阴");
        assert_eq!(snapshot.tomorrow.temperature_min, 14.0);
        assert_eq!(snapshot.tomorrow.temperature_max, 23.0);
    }

    #[test]
    fn rejects_a_forecast_without_a_later_hour() {
        let forecast = serde_json::json!({
            "current": { "time": "2026-10-30T14:00", "temperature_2m": 21.4, "weather_code": 0 },
            "hourly": {
                "time": ["2026-10-30T14:00"],
                "temperature_2m": [21.4],
                "weather_code": [0]
            },
            "daily": {}
        });

        assert_eq!(parse_forecast(&forecast), Err("missing next-hour forecast"));
    }

    #[test]
    fn selects_tomorrows_first_hour_after_a_late_half_hour_current_reading() {
        let forecast = serde_json::json!({
            "current": { "time": "2026-10-30T23:30", "temperature_2m": 18.3, "weather_code": 3 },
            "hourly": {
                "time": ["2026-10-30T23:00", "2026-10-31T00:00"],
                "temperature_2m": [18.2, 18.0],
                "weather_code": [3, 2]
            },
            "daily": {
                "weather_code": [3, 2],
                "temperature_2m_min": [17.0, 16.0],
                "temperature_2m_max": [21.0, 20.0]
            }
        });

        let snapshot = parse_forecast(&forecast).expect("the next calendar hour should parse");
        assert_eq!(snapshot.next_hour.description, "晴间多云");
        assert_eq!(snapshot.next_hour.temperature, 18.0);
    }

    #[test]
    fn requests_two_days_so_late_evening_can_show_the_next_hour() {
        assert_eq!(FORECAST_DAYS, 2);
    }

    #[test]
    fn rejects_a_forecast_without_tomorrows_daily_summary() {
        let forecast = serde_json::json!({
            "current": { "time": "2026-10-30T14:00", "temperature_2m": 21.4, "weather_code": 0 },
            "hourly": {
                "time": ["2026-10-30T14:00", "2026-10-30T15:00"],
                "temperature_2m": [21.4, 22.1],
                "weather_code": [0, 2]
            },
            "daily": { "weather_code": [0], "temperature_2m_min": [15.0], "temperature_2m_max": [24.0] }
        });

        assert_eq!(parse_forecast(&forecast), Err("missing tomorrow forecast"));
    }

    #[test]
    fn requests_the_forecast_in_the_computers_east_eight_time_zone() {
        assert_eq!(WEATHER_TIME_ZONE, "Asia/Shanghai");
    }
}
