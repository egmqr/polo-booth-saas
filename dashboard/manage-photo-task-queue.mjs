export class ManagePhotoTaskQueue {
  constructor({ onChange }) { this.onChange = onChange; this.pending = []; this.active = null; this.completed = []; }
  enqueue(task) {
    const queuePosition = this.pending.length + (this.active ? 1 : 0) + 1;
    const promise = new Promise((resolve, reject) => { this.pending.push({ ...task, done: 0, status: 'queued', resolve, reject }); this.emit(); this.drain(); });
    promise.queuePosition = queuePosition;
    return promise;
  }
  async drain() {
    if (this.active) return;
    while (this.pending.length) {
      this.active = this.pending.shift(); this.active.status = 'running'; this.emit();
      try { await this.active.run(done => { this.active.done = done; this.emit(); }); this.active.done = this.active.total; this.active.status = 'completed'; this.active.resolve(); }
      catch (error) { this.active.status = 'failed'; this.active.error = error.message; this.active.reject(error); }
      this.completed.unshift(this.active); this.completed = this.completed.slice(0, 3); this.active = null; this.emit();
    }
  }
  snapshot() { return { active: this.active, pending: [...this.pending], completed: [...this.completed] }; }
  emit() { this.onChange(this.snapshot()); }
}
if (typeof window !== 'undefined') { window.ManagePhotoTaskQueue = ManagePhotoTaskQueue; window.dispatchEvent(new Event('manage-photo-task-queue-ready')); }
