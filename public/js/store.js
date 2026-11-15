'use strict';

/**
 * データ保存（localStorage）
 *
 * entry:     { id, date: 'YYYY-MM-DD', amount: number, category, memo, recurringId?, createdAt }
 * recurring: { id, category, amount, day: 1-28|'end', memo, startMonth: 'YYYY-MM', generated: ['YYYY-MM'] }
 *
 * クラウド同期用に、変更された記録の ID を pending に記録する。
 * 同期 ID は明細が 'e:<id>'、固定費が 'r:<id>'。
 */
const Store = (() => {
  const KEY = 'kakeibo:v1';
  const SYNC_KEY = 'kakeibo:sync';
  let state = { entries: [], recurring: [] };
  let sync = { pending: {}, rev: 0, lastSeq: 0, lastSyncAt: 0 };
  const listeners = new Set();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        state = {
          entries: Array.isArray(parsed.entries) ? parsed.entries.filter(isValidEntry) : [],
          recurring: Array.isArray(parsed.recurring) ? parsed.recurring.filter(isValidRecurring) : []
        };
      }
      const rawSync = localStorage.getItem(SYNC_KEY);
      if (rawSync) sync = { ...sync, ...JSON.parse(rawSync) };
    } catch (e) {
      console.error('データの読み込みに失敗しました', e);
    }
  }

  function save(notify = true) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      localStorage.setItem(SYNC_KEY, JSON.stringify(sync));
    } catch (e) {
      console.error('データの保存に失敗しました', e);
    }
    if (notify) listeners.forEach((fn) => fn());
  }

  function markDirty(syncId) {
    sync.rev += 1;
    sync.pending[syncId] = sync.rev;
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function isValidEntry(e) {
    return !!e && typeof e.id === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(e.date) &&
      Number.isFinite(e.amount) && !!CATEGORY_MAP[e.category];
  }
  function isValidRecurring(r) {
    return !!r && typeof r.id === 'string' && Number.isFinite(r.amount) &&
      !!CATEGORY_MAP[r.category] && /^\d{4}-\d{2}$/.test(r.startMonth);
  }

  function allSyncIds() {
    return [...state.entries.map((e) => `e:${e.id}`), ...state.recurring.map((r) => `r:${r.id}`)];
  }

  function findBySyncId(syncId) {
    const id = syncId.slice(2);
    if (syncId.startsWith('e:')) return state.entries.find((x) => x.id === id) || null;
    if (syncId.startsWith('r:')) return state.recurring.find((x) => x.id === id) || null;
    return null;
  }

  return {
    load,
    onChange(fn) { listeners.add(fn); },
    get entries() { return state.entries; },
    get recurring() { return state.recurring; },

    addEntry(data) {
      const entry = { id: uid(), createdAt: Date.now(), memo: '', ...data };
      state.entries.push(entry);
      markDirty(`e:${entry.id}`);
      save();
      return entry;
    },
    updateEntry(id, data) {
      const e = state.entries.find((x) => x.id === id);
      if (!e) return null;
      Object.assign(e, data);
      markDirty(`e:${id}`);
      save();
      return e;
    },
    deleteEntry(id) {
      state.entries = state.entries.filter((x) => x.id !== id);
      markDirty(`e:${id}`);
      save();
    },

    addRecurring(data) {
      const rec = { id: uid(), generated: [], ...data };
      state.recurring.push(rec);
      markDirty(`r:${rec.id}`);
      save();
      return rec;
    },
    deleteRecurring(id) {
      state.recurring = state.recurring.filter((x) => x.id !== id);
      markDirty(`r:${id}`);
      save();
    },

    /**
     * 固定費を開始月から指定月まで自動記録する。
     * 生成した月は generated に記録し、ユーザーが明細を削除しても再生成しない。
     * 明細 ID は「固定費ID-年月」で決まるため、複数端末で生成しても重複しない。
     */
    applyRecurring(untilMonth) {
      let changed = false;
      for (const rec of state.recurring) {
        rec.generated = rec.generated || [];
        let m = rec.startMonth;
        while (m <= untilMonth) {
          if (!rec.generated.includes(m)) {
            const id = `${rec.id}-${m}`;
            if (!state.entries.some((e) => e.id === id)) {
              const [y, mo] = m.split('-').map(Number);
              const last = new Date(y, mo, 0).getDate();
              const day = rec.day === 'end' ? last : Math.min(Number(rec.day), last);
              state.entries.push({
                id,
                createdAt: Date.now(),
                date: `${m}-${String(day).padStart(2, '0')}`,
                amount: rec.amount,
                category: rec.category,
                memo: rec.memo,
                recurringId: rec.id
              });
              markDirty(`e:${id}`);
            }
            rec.generated.push(m);
            markDirty(`r:${rec.id}`);
            changed = true;
          }
          m = addMonths(m, 1);
        }
      }
      if (changed) save();
      return changed;
    },

    exportData() {
      return JSON.stringify({ app: 'kakeibo', version: 1, exportedAt: new Date().toISOString(), ...state }, null, 2);
    },
    importData(json) {
      const data = JSON.parse(json);
      if (!data || !Array.isArray(data.entries)) throw new Error('形式が正しくありません');
      const before = allSyncIds();
      state = {
        entries: data.entries.filter(isValidEntry),
        recurring: Array.isArray(data.recurring) ? data.recurring.filter(isValidRecurring) : []
      };
      // 消えた記録はクラウドからも削除、新しい記録はクラウドへ送る
      new Set([...before, ...allSyncIds()]).forEach(markDirty);
      save();
      return state.entries.length;
    },
    clear() {
      allSyncIds().forEach(markDirty);
      state = { entries: [], recurring: [] };
      save();
    },

    // ---------- 同期用 ----------
    get lastSeq() { return sync.lastSeq; },
    get lastSyncAt() { return sync.lastSyncAt; },
    get pendingCount() { return Object.keys(sync.pending).length; },

    /** 送信待ちの変更。obj が null のものは削除を表す */
    pendingChanges(limit) {
      return Object.entries(sync.pending).slice(0, limit)
        .map(([syncId, rev]) => ({ syncId, rev, obj: findBySyncId(syncId) }));
    },
    /** 送信できた変更を pending から外す（送信中に再編集されたものは残す） */
    ackChanges(list) {
      for (const { syncId, rev } of list) {
        if (sync.pending[syncId] === rev) delete sync.pending[syncId];
      }
      save(false);
    },
    /** クラウドの変更を反映する。端末側に未送信の変更がある記録は端末側を優先 */
    applyRemote(syncId, obj) {
      if (sync.pending[syncId]) return false;
      const id = syncId.slice(2);
      const isEntry = syncId.startsWith('e:');
      const list = isEntry ? state.entries : state.recurring;
      const idx = list.findIndex((x) => x.id === id);
      if (obj == null) {
        if (idx >= 0) list.splice(idx, 1);
        return idx >= 0;
      }
      if (obj.id !== id || !(isEntry ? isValidEntry(obj) : isValidRecurring(obj))) return false;
      if (idx >= 0) list[idx] = obj;
      else list.push(obj);
      return true;
    },
    finishSync(lastSeq) {
      sync.lastSeq = lastSeq;
      sync.lastSyncAt = Date.now();
      save(false);
    },
    /** この端末で初めて同期を有効にしたとき、既存の記録をすべて送信対象にする */
    markAllForUpload() {
      sync.lastSeq = 0;
      allSyncIds().forEach(markDirty);
      save(false);
    },
    resetSync() {
      sync = { pending: {}, rev: 0, lastSeq: 0, lastSyncAt: 0 };
      save(false);
    },
    notify() { listeners.forEach((fn) => fn()); }
  };
})();

/** 'YYYY-MM' に n か月加算 */
function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
