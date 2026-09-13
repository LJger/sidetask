use crate::{domain::*, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Undo {
    pub before: Task,
    pub after: Task,
    pub successor: Option<Task>,
}

pub struct Change {
    pub result: Value,
    pub undo: Option<Undo>,
}

fn result(value: impl Serialize) -> Change {
    Change {
        result: serde_json::to_value(value).unwrap(),
        undo: None,
    }
}
fn task_index(state: &State, id: &str) -> Result<usize> {
    state
        .tasks
        .iter()
        .position(|task| task.id == id)
        .ok_or_else(|| "这条任务已不存在。".into())
}
fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args[key].as_str().ok_or_else(|| "操作参数无效。".into())
}
fn capacity(state: &State) -> Result<()> {
    if state.tasks.len() >= MAX_TASKS {
        Err("最多支持 10000 条任务，请先导出并整理旧任务。".into())
    } else {
        Ok(())
    }
}
fn single_series(task: &Task, state: &State, except: Option<&str>) -> Result<()> {
    if task.completed_at.is_none()
        && task.recurrence.is_some()
        && state.tasks.iter().any(|other| {
            Some(other.id.as_str()) != except
                && other.completed_at.is_none()
                && other.recurrence.is_some()
                && other.series_id == task.series_id
        })
    {
        return Err("这个重复系列已经有一个未完成任务。".into());
    }
    Ok(())
}
fn taxonomy<'a>(state: &'a State, kind: &str) -> Result<&'a Vec<Taxonomy>> {
    match kind {
        "categories" => Ok(&state.categories),
        "tags" => Ok(&state.tags),
        _ => Err("分类或标签类型无效。".into()),
    }
}
fn taxonomy_mut<'a>(state: &'a mut State, kind: &str) -> Result<&'a mut Vec<Taxonomy>> {
    match kind {
        "categories" => Ok(&mut state.categories),
        "tags" => Ok(&mut state.tags),
        _ => Err("分类或标签类型无效。".into()),
    }
}

// Callers use a private candidate and publish it only after durable persistence.
pub fn apply_command(
    state: &mut State,
    kind: &str,
    args: &Value,
    now: DateTime<Utc>,
    new_id: &mut dyn FnMut() -> String,
) -> Result<Change> {
    if !args.is_object() {
        return Err("操作格式不正确。".into());
    }
    match kind {
        "task:add" => {
            capacity(state)?;
            let task = create_task(&args["input"], now, new_id())?;
            assert_references(&task, state)?;
            state.tasks.push(task.clone());
            Ok(result(task))
        }
        "task:update" => {
            let id = text(args, "id")?;
            let index = task_index(state, id)?;
            let before = state.tasks[index].clone();
            if args
                .get("expectedUpdatedAt")
                .is_some_and(|v| !v.is_null() && v != &json!(before.updated_at))
            {
                return Err("任务已在别处修改，请重新载入后编辑。当前草稿仍保留。".into());
            }
            let patch = args["patch"].as_object().ok_or("任务修改格式不正确。")?;
            if patch.len() == 1
                && patch.get("completed").and_then(Value::as_bool)
                    == Some(before.completed_at.is_some())
            {
                return Ok(result(before));
            }
            let task = patch_task(&before, &args["patch"], now)?;
            assert_references(&task, state)?;
            single_series(&task, state, Some(id))?;
            let completed = before.completed_at.is_none() && task.completed_at.is_some();
            let successor = if completed {
                if let Some(day) = next_repeat_date(&task, now) {
                    capacity(state)?;
                    let mut next = task.clone();
                    next.id = new_id();
                    next.due_date = Some(day);
                    next.completed_at = None;
                    next.previous_id = Some(task.id.clone());
                    next.reminder_sent_key = None;
                    next.created_at = now_string(now);
                    next.updated_at = now_string(now);
                    for child in &mut next.subtasks {
                        child.id = new_id();
                        child.completed = false;
                    }
                    Some(validate_task(&serde_json::to_value(next).unwrap())?)
                } else {
                    None
                }
            } else {
                None
            };
            state.tasks[index] = task.clone();
            if let Some(next) = &successor {
                state.tasks.push(next.clone());
            }
            Ok(Change {
                result: json!(task),
                undo: completed.then_some(Undo {
                    before,
                    after: task,
                    successor,
                }),
            })
        }
        "task:delete" => {
            let index = task_index(state, text(args, "id")?)?;
            Ok(result(state.tasks.remove(index)))
        }
        "task:restore" => {
            capacity(state)?;
            let mut task = validate_task(&args["task"])?;
            if state.tasks.iter().any(|other| other.id == task.id) {
                return Err("这条任务已经存在。".into());
            }
            if !state
                .categories
                .iter()
                .any(|item| Some(&item.id) == task.category_id.as_ref())
            {
                task.category_id = None;
            }
            task.tag_ids
                .retain(|id| state.tags.iter().any(|item| &item.id == id));
            single_series(&task, state, None)?;
            state.tasks.push(task.clone());
            Ok(result(task))
        }
        "task:undo" => {
            let undo: Undo = serde_json::from_value(args["undo"].clone())
                .map_err(|_| "撤销已过期，可在已完成列表中重新打开任务。")?;
            let index = task_index(state, &undo.after.id)?;
            if state.tasks[index] != undo.after
                || undo
                    .successor
                    .as_ref()
                    .is_some_and(|next| state.tasks.iter().find(|t| t.id == next.id) != Some(next))
            {
                return Err("任务或下一次安排已经修改，无法直接撤销；现有内容已保留。".into());
            }
            assert_references(&undo.before, state)?;
            if let Some(next) = undo.successor {
                state.tasks.retain(|task| task.id != next.id);
            }
            let index = task_index(state, &undo.after.id)?;
            state.tasks[index] = undo.before.clone();
            Ok(result(undo.before))
        }
        "taxonomy:save" => {
            let kind = text(args, "kind")?;
            let items = taxonomy(state, kind)?;
            let input = args["input"].as_object().ok_or("分类或标签格式不正确。")?;
            let editing = input.get("id").is_some_and(|v| !v.is_null());
            let index = if editing {
                Some(
                    items
                        .iter()
                        .position(|t| Some(t.id.as_str()) == input["id"].as_str())
                        .ok_or("分类或标签已不存在。")?,
                )
            } else {
                None
            };
            if !editing && items.len() >= 1000 {
                return Err("分类或标签数量已达到上限。".into());
            }
            let item = validate_taxonomy(
                &json!({ "id": if editing { input["id"].clone() } else { json!(new_id()) },
                "name": input.get("name"), "color": input.get("color").filter(|v| !v.is_null()).cloned().unwrap_or(json!(COLORS[0])) }),
            )?;
            if items.iter().any(|other| {
                other.id != item.id && other.name.to_lowercase() == item.name.to_lowercase()
            }) {
                return Err("这个名称已经存在。".into());
            }
            let items = taxonomy_mut(state, kind)?;
            if let Some(index) = index {
                items[index] = item.clone();
            } else {
                items.push(item.clone());
            }
            Ok(result(item))
        }
        "taxonomy:delete" => {
            let kind = text(args, "kind")?;
            let id = text(args, "id")?;
            let items = taxonomy_mut(state, kind)?;
            let index = items
                .iter()
                .position(|item| item.id == id)
                .ok_or("分类或标签已不存在。")?;
            let removed = items.remove(index);
            for task in &mut state.tasks {
                if kind == "categories" && task.category_id.as_deref() == Some(id) {
                    task.category_id = None;
                    task.updated_at = now_string(now);
                }
                if kind == "tags" && task.tag_ids.iter().any(|tag| tag == id) {
                    task.tag_ids.retain(|tag| tag != id);
                    task.updated_at = now_string(now);
                }
            }
            Ok(result(removed))
        }
        "settings:set" => {
            state.settings = validate_settings(&args["patch"], &state.settings)?;
            Ok(result(&state.settings))
        }
        "data:import" => {
            let imported = validate_state(&args["raw"])?;
            let mut maps = HashMap::new();
            for kind in ["categories", "tags"] {
                let mut mapping = HashMap::new();
                let items = taxonomy_mut(state, kind)?;
                for item in taxonomy(&imported, kind)? {
                    let existing = items.iter().find(|other| other.id == item.id).or_else(|| {
                        items
                            .iter()
                            .find(|other| other.name.to_lowercase() == item.name.to_lowercase())
                    });
                    let id = if let Some(existing) = existing {
                        existing.id.clone()
                    } else {
                        if items.len() >= 1000 {
                            return Err("导入后的分类或标签数量超过上限。".into());
                        }
                        items.push(item.clone());
                        item.id.clone()
                    };
                    mapping.insert(item.id.clone(), id);
                }
                maps.insert(kind, mapping);
            }
            let mut ids: HashSet<String> = state.tasks.iter().map(|task| task.id.clone()).collect();
            let mut series: HashSet<Option<String>> = state
                .tasks
                .iter()
                .filter(|task| task.completed_at.is_none() && task.recurrence.is_some())
                .map(|task| task.series_id.clone())
                .collect();
            let total = imported.tasks.len();
            let mut added = 0;
            for mut task in imported.tasks {
                if ids.contains(&task.id)
                    || (task.completed_at.is_none()
                        && task.recurrence.is_some()
                        && series.contains(&task.series_id))
                {
                    continue;
                }
                capacity(state)?;
                task.category_id = task.category_id.map(|id| maps["categories"][&id].clone());
                task.tag_ids = task
                    .tag_ids
                    .iter()
                    .map(|id| maps["tags"][id].clone())
                    .collect();
                ids.insert(task.id.clone());
                if task.completed_at.is_none() && task.recurrence.is_some() {
                    series.insert(task.series_id.clone());
                }
                state.tasks.push(task);
                added += 1;
            }
            Ok(result(
                json!({ "imported": added, "skipped": total - added }),
            ))
        }
        "reminders:claim" => {
            let entries = args["entries"].as_array().ok_or("提醒列表无效。")?;
            let keys: HashMap<&str, &str> = entries
                .iter()
                .map(|entry| Ok((text(entry, "id")?, text(entry, "key")?)))
                .collect::<Result<_>>()?;
            let mut due = vec![];
            for task in &mut state.tasks {
                if task.completed_at.is_some() {
                    continue;
                }
                let Some(key) = reminder_key(task) else {
                    continue;
                };
                if keys.get(task.id.as_str()).copied() == Some(key.as_str())
                    && task.reminder_sent_key.as_ref() != Some(&key)
                    && reminder_at(task).is_some_and(|time| time <= now)
                {
                    task.reminder_sent_key = Some(key);
                    due.push(task.clone());
                }
            }
            Ok(result(due))
        }
        _ => Err("不支持这个操作。".into()),
    }
}
