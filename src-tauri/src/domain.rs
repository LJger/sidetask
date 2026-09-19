use crate::{geometry::Placement, Result};
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, SecondsFormat, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

pub const SCHEMA_VERSION: u32 = 3;
pub const MAX_TASKS: usize = 10_000;
pub const COLORS: [&str; 6] = [
    "#32654d", "#4676a9", "#8262ad", "#b9784a", "#b55b7b", "#697781",
];
pub const UNSUPPORTED_VERSION: &str = "不支持这个数据版本，请使用匹配的侧记版本或兼容的备份。";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Taxonomy {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Subtask {
    pub id: String,
    pub title: String,
    pub completed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub offset_minutes: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Recurrence {
    pub frequency: String,
    pub anchor_date: String,
    pub until: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub notes: String,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub priority: String,
    pub category_id: Option<String>,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub subtasks: Vec<Subtask>,
    pub reminder: Option<Reminder>,
    pub reminder_sent_key: Option<String>,
    pub recurrence: Option<Recurrence>,
    pub series_id: Option<String>,
    pub previous_id: Option<String>,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub dock_side: String,
    pub always_on_top: bool,
    pub auto_collapse: bool,
    pub launch_at_login: bool,
    pub theme_preset: String,
    #[serde(default = "default_handle_opacity")]
    pub collapsed_handle_opacity: f64,
    #[serde(default = "default_panel_opacity")]
    pub panel_opacity: f64,
    #[serde(default = "default_show_completed")]
    pub show_completed: bool,
    pub calendar_view: String,
    pub window_placement: Placement,
}

fn default_handle_opacity() -> f64 {
    0.8
}

fn default_panel_opacity() -> f64 {
    1.0
}
fn default_show_completed() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            dock_side: "right".into(),
            always_on_top: true,
            auto_collapse: true,
            launch_at_login: false,
            theme_preset: "pine".into(),
            collapsed_handle_opacity: default_handle_opacity(),
            panel_opacity: default_panel_opacity(),
            show_completed: default_show_completed(),
            calendar_view: "day".into(),
            window_placement: Placement::default(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct State {
    pub version: u32,
    pub tasks: Vec<Task>,
    pub categories: Vec<Taxonomy>,
    pub tags: Vec<Taxonomy>,
    pub settings: Settings,
}

impl Default for State {
    fn default() -> Self {
        Self {
            version: SCHEMA_VERSION,
            tasks: vec![],
            categories: vec![],
            tags: vec![],
            settings: Settings::default(),
        }
    }
}

pub fn clean_text(value: &str, max: usize, label: &str, required: bool) -> Result<String> {
    let text = value.trim().to_owned();
    if required && text.is_empty() {
        return Err(format!("请填写{label}。"));
    }
    // Match the existing JavaScript limits, including emoji (UTF-16 code units).
    if text.encode_utf16().count() > max {
        return Err(format!("{label}最多 {max} 个字符。"));
    }
    Ok(text)
}

pub fn identifier(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 100
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err("编号格式不正确。".into());
    }
    Ok(())
}

pub fn date(value: &str) -> Result<NaiveDate> {
    if value.len() != 10
        || value.as_bytes()[4] != b'-'
        || value.as_bytes()[7] != b'-'
        || !value
            .bytes()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
    {
        return Err("任务日期无效。".into());
    }
    let day = NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| "任务日期无效。")?;
    if !(1900..=9999).contains(&day.year()) {
        return Err("任务日期无效。".into());
    }
    Ok(day)
}

pub fn timestamp(value: &str) -> Result<String> {
    if value.len() < 11 || value.as_bytes()[10] != b'T' {
        return Err("任务时间格式不正确。".into());
    }
    DateTime::parse_from_rfc3339(value)
        .map(|t| {
            t.with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        })
        .map_err(|_| "任务时间格式不正确。".into())
}

pub fn now_string(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn validate_taxonomy(raw: &Value) -> Result<Taxonomy> {
    let mut item: Taxonomy =
        serde_json::from_value(raw.clone()).map_err(|_| "分类或标签格式不正确。")?;
    identifier(&item.id)?;
    item.name = clean_text(&item.name, 40, "名称", true)?;
    if !COLORS.contains(&item.color.as_str()) {
        return Err("请选择有效的颜色。".into());
    }
    Ok(item)
}

pub fn validate_task(raw: &Value) -> Result<Task> {
    for key in [
        "id",
        "title",
        "notes",
        "dueDate",
        "priority",
        "completedAt",
        "createdAt",
        "updatedAt",
    ] {
        if raw.get(key).is_none() {
            return Err("任务格式不正确，缺少必要字段。".into());
        }
    }
    let mut normalized = raw.clone();
    for key in ["tagIds", "subtasks"] {
        if normalized[key].is_null() {
            normalized[key] = json!([]);
        }
    }
    let mut task: Task = serde_json::from_value(normalized)
        .map_err(|_| "任务格式不正确，请检查日期、时间和字段类型。")?;
    identifier(&task.id)?;
    task.title = clean_text(&task.title, 160, "任务名称", true)?;
    task.notes = clean_text(&task.notes, 2000, "备注", false)?;
    if let Some(day) = &task.due_date {
        date(day)?;
    }
    if !["normal", "high"].contains(&task.priority.as_str()) {
        return Err("任务优先级无效。".into());
    }
    if let Some(time) = &task.due_time {
        let bytes = time.as_bytes();
        if task.due_date.is_none()
            || bytes.len() != 5
            || bytes[2] != b':'
            || ![0, 1, 3, 4].iter().all(|i| bytes[*i].is_ascii_digit())
            || time[..2].parse::<u32>().unwrap_or(24) > 23
            || time[3..].parse::<u32>().unwrap_or(60) > 59
        {
            return Err("请为任务设置有效的日期和时间。".into());
        }
    }
    for id in [&task.category_id, &task.series_id, &task.previous_id]
        .into_iter()
        .flatten()
    {
        identifier(id)?;
    }
    if task.tag_ids.len() > 100
        || task.tag_ids.iter().collect::<HashSet<_>>().len() != task.tag_ids.len()
    {
        return Err("任务标签无效。".into());
    }
    for id in &task.tag_ids {
        identifier(id)?;
    }
    if task.subtasks.len() > 100 {
        return Err("每个任务最多支持 100 个子任务。".into());
    }
    let mut ids = HashSet::new();
    for child in &mut task.subtasks {
        identifier(&child.id)?;
        child.title = clean_text(&child.title, 160, "子任务名称", true)?;
        if !ids.insert(child.id.clone()) {
            return Err("子任务编号重复。".into());
        }
    }
    if let Some(reminder) = &task.reminder {
        if task.due_date.is_none()
            || task.due_time.is_none()
            || ![0, 15, 60].contains(&reminder.offset_minutes)
        {
            return Err("提醒需要明确的日期、时间和有效的提前量。".into());
        }
    }
    if let Some(rule) = &task.recurrence {
        if !["daily", "weekdays", "weekly", "monthly"].contains(&rule.frequency.as_str()) {
            return Err("重复规则无效。".into());
        }
        date(&rule.anchor_date)?;
        let due = task
            .due_date
            .as_ref()
            .ok_or("重复任务需要有效的计划日期。")?;
        if let Some(until) = &rule.until {
            date(until)?;
            if until < due {
                return Err("结束日期不能早于计划日期。".into());
            }
        }
        if task.series_id.is_none() {
            return Err("重复任务缺少系列编号。".into());
        }
    }
    task.reminder_sent_key = task
        .reminder_sent_key
        .map(|key| clean_text(&key, 250, "提醒记录", false))
        .transpose()?;
    task.created_at = timestamp(&task.created_at)?;
    task.updated_at = timestamp(&task.updated_at)?;
    task.completed_at = task
        .completed_at
        .map(|value| timestamp(&value))
        .transpose()?;
    Ok(task)
}

pub fn validate_settings(patch: &Value, previous: &Settings) -> Result<Settings> {
    let obj = patch.as_object().ok_or("设置格式不正确。")?;
    let mut settings = serde_json::to_value(previous).unwrap();
    for key in [
        "dockSide",
        "alwaysOnTop",
        "autoCollapse",
        "launchAtLogin",
        "themePreset",
        "collapsedHandleOpacity",
        "panelOpacity",
        "showCompleted",
        "calendarView",
        "windowPlacement",
    ] {
        if let Some(value) = obj.get(key) {
            settings[key] = value.clone();
        }
    }
    if let Some(side) = obj.get("dockSide") {
        if !matches!(side.as_str(), Some("left" | "right")) {
            return Err("停靠方向无效。".into());
        }
        if !obj.contains_key("windowPlacement") {
            settings["windowPlacement"] = serde_json::to_value(Placement {
                edge: side.as_str().unwrap().into(),
                ..Placement::default()
            })
            .unwrap();
        }
    }
    let settings: Settings = serde_json::from_value(settings).map_err(|_| "设置值无效。")?;
    if !["pine", "mist", "sand", "graphite", "system"].contains(&settings.theme_preset.as_str()) {
        return Err("主题无效。".into());
    }
    if !settings.collapsed_handle_opacity.is_finite()
        || !(0.2..=1.0).contains(&settings.collapsed_handle_opacity)
    {
        return Err("收起图标透明度无效。".into());
    }
    if !settings.panel_opacity.is_finite() || !(0.2..=1.0).contains(&settings.panel_opacity) {
        return Err("面板透明度无效。".into());
    }
    if !["day", "week", "month"].contains(&settings.calendar_view.as_str()) {
        return Err("日历视图无效。".into());
    }
    settings.window_placement.validate()?;
    Ok(settings)
}

pub fn assert_references(task: &Task, state: &State) -> Result<()> {
    if task
        .category_id
        .as_ref()
        .is_some_and(|id| !state.categories.iter().any(|t| &t.id == id))
    {
        return Err("分类已不存在，请重新选择。".into());
    }
    if task
        .tag_ids
        .iter()
        .any(|id| !state.tags.iter().any(|t| &t.id == id))
    {
        return Err("标签已不存在，请重新选择。".into());
    }
    Ok(())
}

pub fn validate_state(raw: &Value) -> Result<State> {
    let version = raw
        .get("version")
        .and_then(Value::as_u64)
        .ok_or(UNSUPPORTED_VERSION)?;
    if ![1, 2, 3].contains(&version) {
        return Err(UNSUPPORTED_VERSION.into());
    }
    let tasks = raw["tasks"].as_array().ok_or("任务列表无效。")?;
    if tasks.len() > MAX_TASKS {
        return Err("任务列表无效，最多支持 10000 条任务。".into());
    }
    let mut state = State::default();
    for kind in ["categories", "tags"] {
        let empty = json!([]);
        let values = if version == 1 {
            &empty
        } else {
            raw.get(kind).unwrap_or(&empty)
        };
        let values = values.as_array().ok_or("分类或标签列表无效。")?;
        if values.len() > 1000 {
            return Err("分类或标签列表无效，最多支持 1000 项。".into());
        }
        let mut ids = HashSet::new();
        let mut names = HashSet::new();
        let target = if kind == "categories" {
            &mut state.categories
        } else {
            &mut state.tags
        };
        for value in values {
            let item = validate_taxonomy(value)?;
            if !ids.insert(item.id.clone()) || !names.insert(item.name.to_lowercase()) {
                return Err("分类或标签的编号、名称不能重复。".into());
            }
            target.push(item);
        }
    }
    let mut ids = HashSet::new();
    let mut series = HashSet::new();
    for value in tasks {
        let mut value = value.clone();
        if version == 1 {
            let object = value.as_object_mut().ok_or("任务格式不正确。")?;
            object.retain(|key, _| {
                [
                    "id",
                    "title",
                    "notes",
                    "dueDate",
                    "priority",
                    "completedAt",
                    "createdAt",
                    "updatedAt",
                ]
                .contains(&key.as_str())
            });
        }
        let task = validate_task(&value)?;
        if !ids.insert(task.id.clone()) {
            return Err("备份中存在重复的任务编号。".into());
        }
        assert_references(&task, &state)?;
        if task.completed_at.is_none()
            && task.recurrence.is_some()
            && !series.insert(task.series_id.clone())
        {
            return Err("同一重复系列只能有一个未完成任务。".into());
        }
        state.tasks.push(task);
    }
    state.settings = validate_settings(raw.get("settings").unwrap_or(&json!({})), &state.settings)?;
    Ok(state)
}

pub fn reminder_key(task: &Task) -> Option<String> {
    Some(format!(
        "{}|{}|{}|{}",
        task.id,
        task.due_date.as_ref()?,
        task.due_time.as_ref()?,
        task.reminder.as_ref()?.offset_minutes
    ))
}

pub fn reminder_at(task: &Task) -> Option<DateTime<Utc>> {
    let day = date(task.due_date.as_ref()?).ok()?;
    let time = task.due_time.as_ref()?;
    let local = day.and_hms_opt(time[..2].parse().ok()?, time[3..].parse().ok()?, 0)?;
    // Date uses the first occurrence of an ambiguous wall-clock time. During a
    // spring gap, shift forward by the offset change, as JavaScript Date does.
    let instant = Local.from_local_datetime(&local).earliest().or_else(|| {
        for minutes in 1..=180 {
            if let Some(after) = Local
                .from_local_datetime(&(local + Duration::minutes(minutes)))
                .earliest()
            {
                let before = Local
                    .from_local_datetime(&(local - Duration::hours(3)))
                    .earliest()?;
                let gap = after.offset().local_minus_utc() - before.offset().local_minus_utc();
                return Local
                    .from_local_datetime(&(local + Duration::seconds(gap as i64)))
                    .earliest();
            }
        }
        None
    })?;
    Some(instant.with_timezone(&Utc) - Duration::minutes(task.reminder.as_ref()?.offset_minutes))
}

pub fn assert_future_reminder(
    task: &Task,
    now: DateTime<Utc>,
    previous: Option<&Task>,
) -> Result<()> {
    if task.reminder.is_some()
        && task.completed_at.is_none()
        && previous.is_none_or(|old| reminder_key(old) != reminder_key(task))
        && reminder_at(task).is_none_or(|time| time <= now)
    {
        return Err("提醒时间已经过去，请选择未来的日期或时间。".into());
    }
    Ok(())
}

pub fn create_task(input: &Value, now: DateTime<Utc>, id: String) -> Result<Task> {
    let obj = input.as_object().ok_or("任务格式不正确。")?;
    let mut value = json!({
        "id": id, "title": input["title"], "notes": "", "dueDate": null, "dueTime": null,
        "priority": "normal", "categoryId": null, "tagIds": [], "subtasks": [], "reminder": null,
        "reminderSentKey": null, "recurrence": null, "seriesId": null, "previousId": null,
        "completedAt": null, "createdAt": now_string(now), "updatedAt": now_string(now)
    });
    for key in [
        "notes",
        "dueDate",
        "dueTime",
        "priority",
        "categoryId",
        "tagIds",
        "subtasks",
        "reminder",
        "recurrence",
    ] {
        if let Some(v) = obj.get(key).filter(|v| !v.is_null()) {
            value[key] = v.clone();
        }
    }
    if !value["recurrence"].is_null() {
        if !value["recurrence"].is_object() {
            return Err("重复规则无效。".into());
        }
        if value["recurrence"]["anchorDate"].is_null() {
            value["recurrence"]["anchorDate"] = value["dueDate"].clone();
        }
        value["seriesId"] = value["id"].clone();
    }
    let task = validate_task(&value)?;
    assert_future_reminder(&task, now, None)?;
    Ok(task)
}

pub fn patch_task(task: &Task, patch: &Value, now: DateTime<Utc>) -> Result<Task> {
    let patch = patch.as_object().ok_or("任务修改格式不正确。")?;
    let mut value = serde_json::to_value(task).unwrap();
    let previous_time = DateTime::parse_from_rfc3339(&task.updated_at)
        .unwrap()
        .with_timezone(&Utc);
    value["updatedAt"] = json!(now_string(
        now.max(previous_time + Duration::milliseconds(1))
    ));
    for key in [
        "title",
        "notes",
        "dueDate",
        "dueTime",
        "priority",
        "categoryId",
        "tagIds",
        "subtasks",
        "reminder",
        "recurrence",
    ] {
        if let Some(v) = patch.get(key) {
            value[key] = v.clone();
        }
    }
    if patch.contains_key("recurrence") && !value["recurrence"].is_null() {
        if !value["recurrence"].is_object() {
            return Err("重复规则无效。".into());
        }
        if value["recurrence"]["anchorDate"].is_null() {
            value["recurrence"]["anchorDate"] = match &task.recurrence {
                Some(old) if value["recurrence"]["frequency"] == old.frequency => {
                    json!(old.anchor_date)
                }
                _ => value["dueDate"].clone(),
            };
        }
        if value["seriesId"].is_null() {
            value["seriesId"] = json!(task.id);
        }
    }
    if value["recurrence"].is_null() && task.completed_at.is_none() {
        value["seriesId"] = Value::Null;
    }
    if let Some(completed) = patch.get("completed") {
        let completed = completed.as_bool().ok_or("完成状态无效。")?;
        value["completedAt"] = if completed {
            json!(task.completed_at.clone().unwrap_or_else(|| now_string(now)))
        } else {
            Value::Null
        };
        if completed {
            let items = value["subtasks"].as_array_mut().ok_or("子任务列表无效。")?;
            for child in items {
                if !child.is_object() {
                    return Err("子任务格式不正确。".into());
                }
                child["completed"] = json!(true);
            }
        } else if task.completed_at.is_some() && task.series_id.is_some() {
            for key in ["recurrence", "seriesId", "previousId"] {
                value[key] = Value::Null;
            }
        }
    }
    let mut next = validate_task(&value)?;
    if reminder_key(&next) != reminder_key(task) {
        next.reminder_sent_key = None;
    }
    assert_future_reminder(&next, now, Some(task))?;
    Ok(next)
}

pub fn next_repeat_date(task: &Task, now: DateTime<Utc>) -> Option<String> {
    let rule = task.recurrence.as_ref()?;
    let after = date(task.due_date.as_ref()?)
        .ok()?
        .max(now.with_timezone(&Local).date_naive());
    let mut candidate = after.succ_opt()?;
    match rule.frequency.as_str() {
        "weekdays" => {
            while candidate.weekday().number_from_monday() > 5 {
                candidate = candidate.succ_opt()?;
            }
        }
        "weekly" => {
            let weekday = date(&rule.anchor_date).ok()?.weekday();
            while candidate.weekday() != weekday {
                candidate = candidate.succ_opt()?;
            }
        }
        "monthly" => {
            let anchor = date(&rule.anchor_date).ok()?.day();
            let in_month = |year, month| {
                (1..=anchor)
                    .rev()
                    .find_map(|day| NaiveDate::from_ymd_opt(year, month, day))
            };
            candidate = in_month(after.year(), after.month())?;
            if candidate <= after {
                candidate = if after.month() == 12 {
                    in_month(after.year() + 1, 1)?
                } else {
                    in_month(after.year(), after.month() + 1)?
                };
            }
        }
        _ => {}
    }
    if candidate.year() > 9999
        || rule
            .until
            .as_ref()
            .is_some_and(|until| date(until).is_ok_and(|limit| candidate > limit))
    {
        return None;
    }
    Some(candidate.format("%Y-%m-%d").to_string())
}
