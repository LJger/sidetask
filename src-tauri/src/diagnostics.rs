use std::{
    fs::{File, OpenOptions},
    io::{BufWriter, Seek, SeekFrom, Write},
    path::Path,
};

/// Opt-in local diagnostics. No task contents are recorded; storage is capped.
pub struct Diagnostics {
    output: Option<BufWriter<File>>,
    bytes: u64,
}

impl Diagnostics {
    pub fn new(directory: &Path) -> Self {
        let output = (std::env::var("SIDETASK_DIAGNOSTICS").as_deref() == Ok("1"))
            .then(|| {
                OpenOptions::new()
                    .create(true)
                    .truncate(true)
                    .write(true)
                    .open(directory.join("window-diagnostics.jsonl"))
                    .ok()
                    .map(BufWriter::new)
            })
            .flatten();
        Self { output, bytes: 0 }
    }

    pub fn record(&mut self, event: &str, detail: serde_json::Value) {
        let Some(output) = &mut self.output else {
            return;
        };
        let line = serde_json::json!({"time": chrono::Utc::now(), "event": event, "detail": detail})
            .to_string() + "\n";
        if self.bytes + line.len() as u64 > 1024 * 1024 {
            let _ = output.flush();
            let _ = output.get_mut().set_len(0);
            let _ = output.seek(SeekFrom::Start(0));
            self.bytes = 0;
        }
        if output.write_all(line.as_bytes()).is_ok() {
            self.bytes += line.len() as u64;
            let _ = output.flush();
        }
    }
}
