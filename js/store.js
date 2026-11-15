'use strict';

/**
 * データ保存（localStorage）
 *
 * entry:     { id, date: 'YYYY-MM-DD', amount: number, category, memo, recurringId?, createdAt }
 * recurring: { id, category, amount, day: 1-28|'end', memo, startMonth: 'YYYY-MM' }
 */
const Store = (() => {
  const KEY = 'kakeibo:v1';
  let state = { entries: [], recurring: [] };

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        state = {
          entries: Array.isArray(parsed.entries) ? parsed.entries : [],
          recurring: Array.isArray(parsed.recurring) ? parsed.recurring : []
        };
      }
    } catch (e) {
      console.error('データの読み込みに失敗しました', e);
    }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      console.error('データの保存に失敗しました', e);
      return false;
    }
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function isValidEntry(e) {
    return e && typeof e.id === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(e.date) &&
      Number.isFinite(e.amount) && CATEGORY_MAP[e.category];
  }

  return {
    load,
    get entries() { return state.entries; },
    get recurring() { return state.recurring; },

    addEntry(data) {
      const entry = { id: uid(), createdAt: Date.now(), memo: '', ...data };
      state.entries.push(entry);
      save();
      return entry;
    },
    updateEntry(id, data) {
      const e = state.entries.find((x) => x.id === id);
      if (!e) return null;
      Object.assign(e, data);
      save();
      return e;
    },
    deleteEntry(id) {
      state.entries = state.entries.filter((x) => x.id !== id);
      save();
    },

    addRecurring(data) {
      const rec = { id: uid(), ...data };
      state.recurring.push(rec);
      save();
      return rec;
    },
    deleteRecurring(id) {
      state.recurring = state.recurring.filter((x) => x.id !== id);
      save();
    },

    /**
     * 固定費を開始月から指定月まで自動記録する。
     * 一度生成した月は recurringMonths に記録し、ユーザーが削除しても再生成しない。
     */
    applyRecurring(untilMonth) {
      let changed = false;
      for (const rec of state.recurring) {
        rec.generated = rec.generated || [];
        let m = rec.startMonth;
        while (m <= untilMonth) {
          if (!rec.generated.includes(m)) {
            const [y, mo] = m.split('-').map(Number);
            const last = new Date(y, mo, 0).getDate();
            const day = rec.day === 'end' ? last : Math.min(Number(rec.day), last);
            state.entries.push({
              id: uid(),
              createdAt: Date.now(),
              date: `${m}-${String(day).padStart(2, '0')}`,
              amount: rec.amount,
              category: rec.category,
              memo: rec.memo,
              recurringId: rec.id
            });
            rec.generated.push(m);
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
      const entries = data.entries.filter(isValidEntry);
      state = { entries, recurring: Array.isArray(data.recurring) ? data.recurring : [] };
      save();
      return entries.length;
    },
    clear() {
      state = { entries: [], recurring: [] };
      save();
    }
  };
})();

/** 'YYYY-MM' に n か月加算 */
function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
