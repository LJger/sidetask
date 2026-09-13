import { reminderAt, reminderKey } from './domain.mjs';

export function pendingReminders(state) {
  return state.tasks.filter(task => !task.completedAt && reminderKey(task) && task.reminderSentKey !== reminderKey(task));
}

export class ReminderScheduler {
  constructor({ read, claim, notify, onError = () => {}, clock = () => Date.now(), setTimer = (callback, delay) => setTimeout(callback, delay), clearTimer = id => clearTimeout(id) }) {
    Object.assign(this, { read, claim, notify, onError, clock, setTimer, clearTimer });
    this.running = false;
    this.busy = null;
    this.again = false;
    this.catchUp = false;
    this.lastCheck = null;
    this.timer = null;
  }

  start() { this.running = true; return this.refresh(true); }

  refresh(catchUp = false) {
    if (!this.running) return Promise.resolve();
    this.catchUp ||= catchUp;
    if (this.busy) { this.again = true; return this.busy; }
    this.busy = this.run().finally(() => {
      this.busy = null;
      if (this.again && this.running) { this.again = false; void this.refresh(); }
    });
    return this.busy;
  }

  async run() {
    this.clearTimer(this.timer);
    const now = this.clock();
    const missed = this.catchUp || (this.lastCheck !== null && now - this.lastCheck > 60000);
    this.catchUp = false;
    this.lastCheck = now;
    let failed = false;
    try {
      const entries = pendingReminders(this.read()).filter(task => reminderAt(task) <= now)
        .map(task => ({ id: task.id, key: reminderKey(task) }));
      if (entries.length) {
        // Claim durably before delivery; mutations queued before this claim are rechecked by the store.
        const response = await this.claim(entries);
        if (response.result.length) await this.notify(response.result, { missed });
      }
    } catch (error) {
      failed = true;
      this.onError(error);
    } finally {
      if (this.running) {
        const future = pendingReminders(this.read()).map(reminderAt).filter(time => time > this.clock());
        const delay = failed ? 5000 : Math.max(20, Math.min(30000, ...future.map(time => time - this.clock())));
        this.timer = this.setTimer(() => { void this.refresh(); }, delay);
      }
    }
  }

  stop() {
    this.running = false;
    this.again = false;
    this.clearTimer(this.timer);
    return this.busy ?? Promise.resolve();
  }
}
