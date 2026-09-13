import { mkdir, readFile, writeFile, rename, copyFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { emptyState, validateState, SCHEMA_VERSION } from '../../src/domain.mjs';
import { applyCommand, UndoHistory } from '../../src/model.mjs';

export class TaskStore {
  #state = emptyState();
  #queue = Promise.resolve();
  #undo;

  constructor(directory, { clock = () => Date.now() } = {}) {
    this.directory = directory;
    this.file = path.join(directory, 'tasks.json');
    this.backupFile = path.join(directory, 'tasks.backup.json');
    this.legacyFile = path.join(directory, 'tasks.v1-original.json');
    this.warning = null;
    this.clock = clock;
    this.#undo = new UndoHistory(clock);
  }

  async #read(file) {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return { raw, state: validateState(parsed), legacy: parsed.version < SCHEMA_VERSION ? parsed.version : null };
  }

  async load() {
    await mkdir(this.directory, { recursive: true });
    let loaded;
    let mustSave = false;
    try {
      loaded = await this.#read(this.file);
    } catch (error) {
      if (error.code && error.code !== 'ENOENT') throw error;
      if (error.code !== 'ENOENT') {
        const preservedFile = path.join(this.directory, 'tasks.corrupt-' + Date.now() + '.json');
        await copyFile(this.file, preservedFile);
        this.warning = '原文件已保留为 ' + path.basename(preservedFile) + '。';
      }
      try {
        loaded = await this.#read(this.backupFile);
        this.warning = (this.warning ?? '') + '已恢复上一次备份中的任务。';
      } catch (backupError) {
        if (backupError.code && backupError.code !== 'ENOENT') throw backupError;
        if (error.code === 'ENOENT' && backupError.code !== 'ENOENT') {
          throw new Error('数据文件缺失且备份无法读取。请保留数据目录并检查备份。', { cause: backupError });
        }
        loaded = { state: emptyState(), legacy: false };
        if (this.warning) this.warning += '可以在设置中导入其他备份。';
      }
      mustSave = true;
    }
    this.#state = loaded.state;
    if (loaded.legacy) {
      const originalFile = path.join(this.directory, 'tasks.v' + loaded.legacy + '-original.json');
      try { await writeFile(originalFile, loaded.raw, { flag: 'wx', encoding: 'utf8', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      this.warning = (this.warning ?? '') + '任务已升级，原始数据保留在 ' + path.basename(originalFile) + '。';
      mustSave = true;
    }
    if (mustSave) await this.#persist(this.#state, false);
    return this.snapshot();
  }

  snapshot() { return structuredClone(this.#state); }

  async #persist(state, backup = true) {
    const temporaryFile = this.file + '.tmp';
    try {
      await writeFile(temporaryFile, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      if (backup) {
        try { await copyFile(this.file, this.backupFile); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      await rename(temporaryFile, this.file);
    } catch (error) {
      await unlink(temporaryFile).catch(() => {});
      throw new Error('保存失败，请检查数据目录是否可写、磁盘是否有可用空间。', { cause: error });
    }
  }

  #transact(type, args) {
    const operation = this.#queue.then(async () => {
      const next = this.snapshot();
      const actualArgs = type === 'task:undo' ? { undo: this.#undo.get(args.token) } : args;
      const { result, undo } = applyCommand(next, type, actualArgs, new Date(this.clock()).toISOString());
      await this.#persist(next);
      this.#state = next;
      if (type === 'task:undo') this.#undo.forget(args.token);
      const undoToken = this.#undo.remember(undo);
      return { state: this.snapshot(), result: structuredClone(result), ...(undoToken ? { undoToken } : {}) };
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }

  add(input) { return this.#transact('task:add', { input }); }
  update(id, patch, expectedUpdatedAt) { return this.#transact('task:update', { id, patch, expectedUpdatedAt }); }
  remove(id) { return this.#transact('task:delete', { id }); }
  restore(task) { return this.#transact('task:restore', { task }); }
  undoCompletion(token) { return this.#transact('task:undo', { token }); }
  saveTaxonomy(kind, input) { return this.#transact('taxonomy:save', { kind, input }); }
  deleteTaxonomy(kind, id) { return this.#transact('taxonomy:delete', { kind, id }); }
  setSettings(patch) { return this.#transact('settings:set', { patch }); }
  importData(raw) {
    const imported = validateState(raw);
    return this.#transact('data:import', { raw: imported });
  }
  claimReminders(entries) { return this.#transact('reminders:claim', { entries }); }
  async flush() { await this.#queue; }
}
