use std::time::{Duration, Instant};

/// Cool down failures even if native events keep arriving continuously.
#[derive(Default)]
pub struct RetryGate {
    failures: u32,
    next: Option<Instant>,
}

impl RetryGate {
    pub fn ready(&self, now: Instant) -> bool {
        self.next.is_none_or(|next| now >= next)
    }

    pub fn failed(&mut self, now: Instant) {
        self.failures = (self.failures + 1).min(8);
        self.next = Some(now + Duration::from_millis((250u64 << (self.failures - 1)).min(30_000)));
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn remaining(&self, now: Instant) -> Option<Duration> {
        self.next.filter(|next| *next > now).map(|next| next - now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_events_cannot_bypass_failure_cooldown() {
        let mut retry = RetryGate::default();
        let mut now = Instant::now();
        for _ in 0..20 {
            assert!(retry.ready(now));
            retry.failed(now);
            assert!(!retry.ready(now));
            let delay = retry.remaining(now).unwrap();
            assert!(delay <= Duration::from_secs(30));
            now += delay;
        }
        retry.reset();
        assert!(retry.ready(Instant::now()));
    }
}
