use crate::{
    domain::*,
    model::{apply_command, Undo},
    Result,
};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

pub struct TaskStore {
    pub directory: PathBuf,
    pub warning: Option<String>,
    state: State,
    undo: HashMap<String, (i64, Undo)>,
}

fn read_state(path: &Path) -> Result<(String, Value, State)> {
    let raw = fs::read_to_string(path).map_err(|e| format!("无法读取数据文件：{e}"))?;
    let value: Value = serde_json::from_str(&raw).map_err(|_| "数据文件不是有效的 JSON。")?;
    let state = validate_state(&value)?;
    Ok((raw, value, state))
}

fn preserve_once(path: &Path, bytes: &[u8]) -> Result<()> {
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => {
            file.write_all(bytes)
                .and_then(|()| file.sync_all())
                .map_err(|e| format!("无法保留原始备份：{e}"))?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(format!("无法保留原始备份：{error}")),
    }
    Ok(())
}

impl TaskStore {
    pub fn open(directory: impl Into<PathBuf>) -> Result<Self> {
        let directory = directory.into();
        fs::create_dir_all(&directory).map_err(|e| format!("无法创建数据目录：{e}"))?;
        let file = directory.join("tasks.json");
        let backup = directory.join("tasks.backup.json");
        let mut warning = None;
        let mut must_save = false;
        let loaded = if file.exists() {
            match read_state(&file) {
                Ok(loaded) => {
                    preserve_once(&directory.join("tasks.pre-tauri.json"), loaded.0.as_bytes())?;
                    Some(loaded)
                }
                Err(error)
                    if error == UNSUPPORTED_VERSION || error.starts_with("无法读取数据文件") =>
                {
                    return Err(error)
                }
                Err(_) => {
                    let name = format!("tasks.corrupt-{}.json", Utc::now().timestamp_millis());
                    fs::copy(&file, directory.join(&name))
                        .map_err(|e| format!("无法保留损坏的数据文件：{e}"))?;
                    warning = Some(format!("原文件已保留为 {name}。"));
                    must_save = true;
                    None
                }
            }
        } else {
            must_save = true;
            None
        };
        let loaded = match loaded {
            Some(loaded) => Some(loaded),
            None if backup.exists() => match read_state(&backup) {
                Ok(loaded) => {
                    warning = Some(format!(
                        "{}已恢复上一次备份中的任务。",
                        warning.unwrap_or_default()
                    ));
                    Some(loaded)
                }
                Err(error)
                    if error == UNSUPPORTED_VERSION || error.starts_with("无法读取数据文件") =>
                {
                    return Err(error)
                }
                Err(_) if !file.exists() => {
                    return Err("数据文件缺失且备份无法读取。请保留数据目录并检查备份。".into())
                }
                Err(_) => None,
            },
            None => None,
        };
        let state = if let Some((raw, value, state)) = loaded {
            let version = value["version"].as_u64().unwrap();
            if version < u64::from(SCHEMA_VERSION) {
                let name = format!("tasks.v{version}-original.json");
                preserve_once(&directory.join(&name), raw.as_bytes())?;
                warning = Some(format!(
                    "{}任务已升级，原始数据保留在 {name}。",
                    warning.unwrap_or_default()
                ));
                must_save = true;
            }
            state
        } else {
            if let Some(text) = &mut warning {
                text.push_str("可以在设置中导入其他备份。");
            }
            State::default()
        };
        let store = Self {
            directory,
            warning,
            state,
            undo: HashMap::new(),
        };
        if must_save {
            store.persist(&store.state, false)?;
        }
        Ok(store)
    }

    pub fn snapshot(&self) -> &State {
        &self.state
    }

    fn persist(&self, state: &State, backup: bool) -> Result<()> {
        let file = self.directory.join("tasks.json");
        let temporary = self.directory.join("tasks.json.tmp");
        let operation = || -> std::io::Result<()> {
            let mut output = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&temporary)?;
            serde_json::to_writer_pretty(&mut output, state)?;
            output.write_all(b"\n")?;
            output.sync_all()?;
            drop(output);
            if backup && file.exists() {
                fs::copy(&file, self.directory.join("tasks.backup.json"))?;
            }
            // std::fs::rename uses MoveFileExW(REPLACE_EXISTING) on Windows.
            // The temporary file is on the same volume as the destination.
            fs::rename(&temporary, &file)?;
            #[cfg(unix)]
            std::fs::File::open(&self.directory)?.sync_all()?;
            Ok(())
        };
        if operation().is_err() {
            let _ = fs::remove_file(&temporary);
            return Err("保存失败，请检查数据目录是否可写、磁盘是否有可用空间。".into());
        }
        Ok(())
    }

    pub fn transact(&mut self, kind: &str, args: Value, now: DateTime<Utc>) -> Result<Value> {
        let mut candidate = self.state.clone();
        let token = args["token"].as_str().map(str::to_owned);
        let actual = if kind == "task:undo" {
            let (_, undo) = token
                .as_ref()
                .and_then(|token| self.undo.get(token))
                .filter(|(expires, _)| *expires > now.timestamp_millis())
                .ok_or("撤销已过期，可在已完成列表中重新打开任务。")?;
            json!({ "undo": undo })
        } else {
            args
        };
        let change = apply_command(&mut candidate, kind, &actual, now, &mut || {
            uuid::Uuid::new_v4().to_string()
        })?;
        self.persist(&candidate, true)?;
        self.state = candidate;
        self.undo
            .retain(|_, (expires, _)| *expires > now.timestamp_millis());
        if kind == "task:undo" {
            if let Some(token) = token {
                self.undo.remove(&token);
            }
        }
        let undo_token = change.undo.map(|undo| {
            let token = uuid::Uuid::new_v4().to_string();
            self.undo
                .insert(token.clone(), (now.timestamp_millis() + 10_000, undo));
            token
        });
        let mut response = json!({ "state": self.state, "result": change.result });
        if let Some(token) = undo_token {
            response["undoToken"] = json!(token);
        }
        Ok(response)
    }

    pub fn due_entries(&self, now: DateTime<Utc>) -> Vec<Value> {
        self.state
            .tasks
            .iter()
            .filter_map(|task| {
                let key = reminder_key(task)?;
                (task.completed_at.is_none()
                    && task.reminder_sent_key.as_ref() != Some(&key)
                    && reminder_at(task).is_some_and(|time| time <= now))
                .then(|| json!({ "id": task.id, "key": key }))
            })
            .collect()
    }

    pub fn next_reminder_delay(&self, now: DateTime<Utc>) -> std::time::Duration {
        let millis = self
            .state
            .tasks
            .iter()
            .filter(|task| {
                task.completed_at.is_none()
                    && reminder_key(task).is_some()
                    && reminder_key(task) != task.reminder_sent_key
            })
            .filter_map(reminder_at)
            .filter(|time| *time > now)
            .map(|time| (time - now).num_milliseconds())
            .min()
            .unwrap_or(30_000)
            .clamp(20, 30_000);
        std::time::Duration::from_millis(millis as u64)
    }
}
