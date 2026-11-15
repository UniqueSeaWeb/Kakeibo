'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);
  const yen = new Intl.NumberFormat('ja-JP');
  const fmt = (n) => `${yen.format(Math.round(n))}円`;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const thisMonth = () => todayStr().slice(0, 7);
  const monthLabel = (ym) => {
    const [y, m] = ym.split('-').map(Number);
    return `${y}年${m}月`;
  };

  /** 全角数字・カンマを考慮して金額を数値に変換 */
  function parseAmount(str) {
    const half = String(str).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    const digits = half.replace(/[^\d]/g, '');
    return digits ? Number(digits) : 0;
  }

  function icon(id, cls = 'icon') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', cls);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${id}`);
    svg.appendChild(use);
    return svg;
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'style') node.setAttribute('style', v);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) {
      if (c == null) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  // ---------- 状態 ----------
  let currentMonth = thisMonth();
  let currentView = 'input';

  const entriesOf = (ym) => Store.entries.filter((e) => e.date.startsWith(ym));
  const sum = (list) => list.reduce((a, e) => a + e.amount, 0);

  function totalsByCategory(list) {
    const t = {};
    for (const e of list) t[e.category] = (t[e.category] || 0) + e.amount;
    return t;
  }
  function totalsByGroup(list) {
    const t = {};
    for (const e of list) {
      const g = CATEGORY_MAP[e.category].group;
      t[g] = (t[g] || 0) + e.amount;
    }
    return t;
  }

  // ---------- 画面切り替え ----------
  function showView(name) {
    currentView = name;
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
    document.querySelectorAll('.tab').forEach((t) => {
      if (t.dataset.view === name) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    });
    render();
    window.scrollTo(0, 0);
  }

  function render() {
    $('#current-month').textContent = monthLabel(currentMonth);
    $('#next-month').disabled = currentMonth >= addMonths(thisMonth(), 12);
    if (currentView === 'input') renderQuickSummary();
    if (currentView === 'list') renderList();
    if (currentView === 'summary') renderSummary();
    if (currentView === 'settings') renderRecurring();
  }

  // ---------- 記録フォーム ----------
  function buildCategoryOptions() {
    const wrap = $('#category-options');
    CATEGORIES.forEach((c, i) => {
      const id = `cat-${c.id}`;
      const input = el('input', { type: 'radio', name: 'category', value: c.id, id, class: 'visually-hidden' });
      if (i === 0) input.checked = true;
      const label = el('label', { for: id, class: 'category-option', style: `--cat:${c.color}` },
        el('span', { class: 'category-icon' }, icon(c.id === 'fixed' ? 'fixed' : c.id)),
        el('span', { class: 'category-name' }, c.name));
      wrap.append(input, label);
    });

    // 絞り込み・推移・固定費用のセレクト
    const filter = $('#list-filter');
    const trend = $('#trend-category');
    const rec = $('#rec-category');
    trend.append(el('option', { value: 'all' }, '支出合計'));
    const og = el('optgroup', { label: '分類' });
    GROUPS.forEach((g) => og.append(el('option', { value: `g:${g.id}` }, g.name)));
    const oc = el('optgroup', { label: 'カテゴリ' });
    CATEGORIES.forEach((c) => {
      filter.append(el('option', { value: c.id }, c.name));
      oc.append(el('option', { value: `c:${c.id}` }, c.name));
      rec.append(el('option', { value: c.id }, c.name));
    });
    trend.append(og, oc);
    rec.value = 'rent';

    const day = $('#rec-day');
    for (let d = 1; d <= 28; d++) day.append(el('option', { value: String(d) }, `${d}日`));
    day.append(el('option', { value: 'end' }, '月末'));
    day.value = '27';
  }

  function defaultDate() {
    return currentMonth === thisMonth() ? todayStr() : `${currentMonth}-01`;
  }

  function resetForm() {
    const f = $('#entry-form');
    f.reset();
    f.id.value = '';
    f.date.value = defaultDate();
    $('#submit-btn').textContent = '記録する';
    $('#cancel-edit').hidden = true;
    $('#delete-entry').hidden = true;
    $('#amount-error').hidden = true;
    $('#amount').removeAttribute('aria-invalid');
    $('#input-heading').textContent = '支出を記録';
  }

  function startEdit(entry) {
    const f = $('#entry-form');
    f.id.value = entry.id;
    f.amount.value = yen.format(entry.amount);
    f.date.value = entry.date;
    f.memo.value = entry.memo || '';
    f.querySelector(`input[name="category"][value="${entry.category}"]`).checked = true;
    $('#submit-btn').textContent = '更新する';
    $('#cancel-edit').hidden = false;
    $('#delete-entry').hidden = false;
    $('#input-heading').textContent = '支出を編集';
    showView('input');
  }

  function updateMemoSuggestions() {
    const cat = $('#entry-form').category.value;
    const counts = {};
    for (const e of Store.entries) {
      if (e.category === cat && e.memo) counts[e.memo] = (counts[e.memo] || 0) + 1;
    }
    const list = $('#memo-suggestions');
    list.replaceChildren(...Object.entries(counts)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([m]) => el('option', { value: m })));
  }

  function onSubmit(ev) {
    ev.preventDefault();
    const f = ev.target;
    const amount = parseAmount(f.amount.value);
    if (amount <= 0) {
      $('#amount-error').hidden = false;
      f.amount.setAttribute('aria-invalid', 'true');
      f.amount.focus();
      return;
    }
    const data = {
      amount,
      date: f.date.value || todayStr(),
      category: f.category.value,
      memo: f.memo.value.trim()
    };
    if (f.id.value) {
      Store.updateEntry(f.id.value, data);
      toast('更新しました');
    } else {
      Store.addEntry(data);
      toast(`${CATEGORY_MAP[data.category].name} ${fmt(amount)} を記録しました`);
    }
    currentMonth = data.date.slice(0, 7);
    const keepCategory = data.category;
    resetForm();
    f.querySelector(`input[name="category"][value="${keepCategory}"]`).checked = true;
    updateMemoSuggestions();
    render();
  }

  function renderQuickSummary() {
    const list = entriesOf(currentMonth);
    const g = totalsByGroup(list);
    const rows = [['合計', sum(list), 'total']].concat(GROUPS.map((x) => [x.name, g[x.id] || 0, x.id]));
    $('#quick-summary').replaceChildren(...rows.map(([name, val, key]) =>
      el('div', { class: `quick-item${key === 'total' ? ' is-total' : ''}` },
        el('dt', {}, name), el('dd', {}, fmt(val)))));
    $('#quick-heading').textContent = `${monthLabel(currentMonth)}のまとめ`;
  }

  // ---------- 明細 ----------
  function renderList() {
    const filter = $('#list-filter').value;
    const list = entriesOf(currentMonth)
      .filter((e) => !filter || e.category === filter)
      .sort((a, b) => (b.date.localeCompare(a.date)) || (b.createdAt - a.createdAt));
    const box = $('#entry-list');
    if (!list.length) {
      box.replaceChildren(el('p', { class: 'empty' }, 'この月の記録はまだありません'));
      return;
    }
    const byDate = new Map();
    for (const e of list) {
      if (!byDate.has(e.date)) byDate.set(e.date, []);
      byDate.get(e.date).push(e);
    }
    const week = ['日', '月', '火', '水', '木', '金', '土'];
    const sections = [];
    sections.push(el('p', { class: 'list-total' }, `${list.length}件　合計 `, el('strong', {}, fmt(sum(list)))));
    for (const [date, items] of byDate) {
      const [y, m, d] = date.split('-').map(Number);
      const w = week[new Date(y, m - 1, d).getDay()];
      sections.push(el('section', { class: 'day-group' },
        el('h3', { class: 'day-heading' },
          el('time', { datetime: date }, `${m}月${d}日（${w}）`),
          el('span', {}, fmt(sum(items)))),
        el('ul', { class: 'entry-list card' }, ...items.map((e) => {
          const c = CATEGORY_MAP[e.category];
          return el('li', {},
            el('button', { type: 'button', class: 'entry', style: `--cat:${c.color}`, onclick: () => startEdit(e), 'aria-label': `${c.name} ${fmt(e.amount)} ${e.memo || ''} を編集` },
              el('span', { class: 'category-icon' }, icon(c.id)),
              el('span', { class: 'entry-body' },
                el('span', { class: 'entry-cat' }, c.name, e.recurringId ? el('span', { class: 'badge' }, '固定') : null),
                e.memo ? el('span', { class: 'entry-memo' }, e.memo) : null),
              el('span', { class: 'entry-amount' }, fmt(e.amount))));
        }))));
    }
    box.replaceChildren(...sections);
  }

  // ---------- 集計 ----------
  function renderSummary() {
    const list = entriesOf(currentMonth);
    const total = sum(list);
    const prevTotal = sum(entriesOf(addMonths(currentMonth, -1)));
    $('#month-total').textContent = fmt(total);
    const diff = total - prevTotal;
    const diffEl = $('#month-diff');
    if (prevTotal === 0) {
      diffEl.textContent = '前月の記録なし';
      diffEl.className = 'total-diff';
    } else {
      diffEl.textContent = `前月比 ${diff >= 0 ? '+' : '−'}${fmt(Math.abs(diff))}`;
      diffEl.className = `total-diff ${diff > 0 ? 'is-up' : 'is-down'}`;
    }

    // 分類別（積み上げバー + 凡例）
    const g = totalsByGroup(list);
    const stack = el('div', { class: 'stack-bar', role: 'img', 'aria-label': GROUPS.map((x) => `${x.name} ${fmt(g[x.id] || 0)}`).join('、') });
    const legend = el('ul', { class: 'legend' });
    for (const grp of GROUPS) {
      const v = g[grp.id] || 0;
      if (total > 0 && v > 0) stack.append(el('span', { style: `width:${(v / total) * 100}%;background:${grp.color}` }));
      legend.append(el('li', {},
        el('span', { class: 'swatch', style: `background:${grp.color}` }),
        el('span', { class: 'legend-name' }, grp.name),
        el('span', { class: 'legend-val' }, fmt(v)),
        el('span', { class: 'legend-pct' }, total ? `${Math.round((v / total) * 100)}%` : '0%')));
    }
    $('#group-summary').replaceChildren(stack, legend);

    // カテゴリ別
    const ct = totalsByCategory(list);
    const prevCt = totalsByCategory(entriesOf(addMonths(currentMonth, -1)));
    const max = Math.max(1, ...Object.values(ct));
    $('#category-summary').replaceChildren(...CATEGORIES.map((c) => {
      const v = ct[c.id] || 0;
      const pv = prevCt[c.id] || 0;
      const d = v - pv;
      let diffText = '';
      if (pv > 0 || v > 0) diffText = d === 0 ? '前月と同じ' : `前月比 ${d > 0 ? '+' : '−'}${yen.format(Math.abs(d))}`;
      return el('li', { class: `bar-item${v === 0 ? ' is-zero' : ''}`, style: `--cat:${c.color}` },
        el('span', { class: 'category-icon' }, icon(c.id)),
        el('span', { class: 'bar-body' },
          el('span', { class: 'bar-head' },
            el('span', { class: 'bar-name' }, c.name),
            el('span', { class: 'bar-val' }, fmt(v))),
          el('span', { class: 'bar-track' }, el('span', { class: 'bar-fill', style: `width:${(v / max) * 100}%` })),
          diffText ? el('span', { class: `bar-diff ${d > 0 ? 'is-up' : d < 0 ? 'is-down' : ''}` }, diffText) : null));
    }));

    renderTrend();
  }

  function renderTrend() {
    const key = $('#trend-category').value || 'all';
    const match = key === 'all' ? () => true
      : key.startsWith('g:') ? (e) => CATEGORY_MAP[e.category].group === key.slice(2)
        : (e) => e.category === key.slice(2);
    const color = key === 'all' ? '#1f7a5c'
      : key.startsWith('g:') ? GROUP_MAP[key.slice(2)].color : CATEGORY_MAP[key.slice(2)].color;

    const months = [];
    for (let i = 11; i >= 0; i--) months.push(addMonths(currentMonth, -i));
    const values = months.map((m) => sum(entriesOf(m).filter(match)));
    const max = Math.max(...values);

    const W = 336, H = 200, padL = 8, padR = 8, padT = 24, padB = 24;
    const bw = (W - padL - padR) / 12;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', months.map((m, i) => `${monthLabel(m)} ${fmt(values[i])}`).join('、'));

    const mk = (tag, attrs, text) => {
      const n = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      if (text != null) n.textContent = text;
      svg.appendChild(n);
      return n;
    };
    mk('line', { x1: padL, x2: W - padR, y1: H - padB, y2: H - padB, class: 'axis' });

    const nonZero = values.filter((v) => v > 0);
    const avg = nonZero.length ? sum(nonZero.map((v) => ({ amount: v }))) / nonZero.length : 0;

    months.forEach((m, i) => {
      const v = values[i];
      const h = max ? (v / max) * (H - padT - padB) : 0;
      const x = padL + i * bw + bw * 0.2;
      const isCur = m === currentMonth;
      mk('rect', {
        x, y: H - padB - h, width: bw * 0.6, height: Math.max(h, 0), rx: 2,
        fill: color, opacity: isCur ? 1 : 0.5
      });
      mk('text', { x: x + bw * 0.3, y: H - 8, class: `tick${isCur ? ' is-current' : ''}`, 'text-anchor': 'middle' }, `${Number(m.slice(5))}`);
      if (isCur && v > 0) {
        mk('text', { x: x + bw * 0.3, y: Math.max(H - padB - h - 8, 12), class: 'value-label', 'text-anchor': i > 9 ? 'end' : 'middle' }, yen.format(v));
      }
    });
    if (avg > 0 && max > 0) {
      const y = H - padB - (avg / max) * (H - padT - padB);
      mk('line', { x1: padL, x2: W - padR, y1: y, y2: y, class: 'avg-line' });
    }
    $('#trend-chart').replaceChildren(svg);

    const maxIdx = values.indexOf(max);
    $('#trend-note').textContent = max > 0
      ? `月平均（記録のある月）${fmt(avg)}　最高 ${monthLabel(months[maxIdx])} ${fmt(max)}　点線は平均`
      : '記録がありません';
  }

  // ---------- 固定費 ----------
  function renderRecurring() {
    const ul = $('#recurring-list');
    if (!Store.recurring.length) {
      ul.replaceChildren(el('li', { class: 'empty' }, '登録された固定費はありません'));
      return;
    }
    const total = sum(Store.recurring);
    ul.replaceChildren(...Store.recurring.map((r) => {
      const c = CATEGORY_MAP[r.category];
      return el('li', { class: 'recurring-item', style: `--cat:${c.color}` },
        el('span', { class: 'category-icon' }, icon(c.id)),
        el('span', { class: 'entry-body' },
          el('span', { class: 'entry-cat' }, r.memo || c.name),
          el('span', { class: 'entry-memo' }, `${c.name}・毎月${r.day === 'end' ? '月末' : `${r.day}日`}・${monthLabel(r.startMonth)}から`)),
        el('span', { class: 'entry-amount' }, fmt(r.amount)),
        el('button', {
          type: 'button', class: 'icon-btn', 'aria-label': `${r.memo || c.name}の固定費を削除`,
          onclick: () => {
            if (!confirm('この固定費の自動記録を停止しますか？\n（これまでに記録された明細は残ります）')) return;
            Store.deleteRecurring(r.id);
            renderRecurring();
            toast('固定費を削除しました');
          }
        }, icon('trash')));
    }), el('li', { class: 'recurring-total' }, el('span', {}, '毎月の固定費合計'), el('strong', {}, fmt(total))));
  }

  function onRecurringSubmit(ev) {
    ev.preventDefault();
    const f = ev.target;
    const amount = parseAmount(f.amount.value);
    if (amount <= 0) {
      $('#rec-error').hidden = false;
      f.amount.setAttribute('aria-invalid', 'true');
      f.amount.focus();
      return;
    }
    $('#rec-error').hidden = true;
    f.amount.removeAttribute('aria-invalid');
    const c = CATEGORY_MAP[f.category.value];
    Store.addRecurring({
      category: c.id,
      amount,
      day: f.day.value,
      memo: f.memo.value.trim() || c.name,
      startMonth: thisMonth()
    });
    Store.applyRecurring(thisMonth());
    f.amount.value = '';
    f.memo.value = '';
    renderRecurring();
    toast('固定費を登録し、今月分を記録しました');
  }

  // ---------- データ入出力 ----------
  function download(name, content, type) {
    const blob = new Blob([content], { type });
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function exportCsv() {
    const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const rows = [['日付', '分類', 'カテゴリ', '金額', 'メモ', '固定費']];
    [...Store.entries].sort((a, b) => a.date.localeCompare(b.date)).forEach((e) => {
      const c = CATEGORY_MAP[e.category];
      rows.push([e.date, GROUP_MAP[c.group].name, c.name, e.amount, e.memo || '', e.recurringId ? '○' : '']);
    });
    // Excel で文字化けしないよう BOM を付与
    download(`kakeibo_${todayStr()}.csv`, '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n'), 'text/csv');
  }

  // ---------- 初期化 ----------
  function init() {
    Store.load();
    Store.applyRecurring(thisMonth());
    buildCategoryOptions();
    resetForm();
    updateMemoSuggestions();

    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
    $('#prev-month').addEventListener('click', () => { currentMonth = addMonths(currentMonth, -1); onMonthChange(); });
    $('#next-month').addEventListener('click', () => { currentMonth = addMonths(currentMonth, 1); onMonthChange(); });

    const form = $('#entry-form');
    form.addEventListener('submit', onSubmit);
    $('#category-options').addEventListener('change', updateMemoSuggestions);
    $('#amount').addEventListener('input', (e) => {
      $('#amount-error').hidden = true;
      e.target.removeAttribute('aria-invalid');
    });
    $('#amount').addEventListener('blur', (e) => {
      const n = parseAmount(e.target.value);
      e.target.value = n ? yen.format(n) : '';
    });
    $('#cancel-edit').addEventListener('click', () => { resetForm(); updateMemoSuggestions(); });
    $('#delete-entry').addEventListener('click', () => {
      if (!confirm('この記録を削除しますか？')) return;
      Store.deleteEntry(form.id.value);
      resetForm();
      toast('削除しました');
      showView('list');
    });

    $('#list-filter').addEventListener('change', renderList);
    $('#trend-category').addEventListener('change', renderTrend);
    $('#recurring-form').addEventListener('submit', onRecurringSubmit);

    $('#export-csv').addEventListener('click', exportCsv);
    $('#export-json').addEventListener('click', () => download(`kakeibo_backup_${todayStr()}.json`, Store.exportData(), 'application/json'));
    $('#import-json').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        if (!confirm('現在のデータを上書きして復元しますか？')) return;
        const n = Store.importData(await file.text());
        toast(`${n}件のデータを復元しました`);
        render();
      } catch (err) {
        toast('復元に失敗しました：ファイルを確認してください');
      } finally {
        e.target.value = '';
      }
    });
    $('#clear-all').addEventListener('click', () => {
      if (!confirm('すべての記録と固定費を削除します。元に戻せません。よろしいですか？')) return;
      Store.clear();
      render();
      toast('すべてのデータを削除しました');
    });

    // 月が変わったときに固定費を自動記録
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Store.applyRecurring(thisMonth())) render();
    });

    render();

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service Worker 登録失敗', e));
    }
  }

  function onMonthChange() {
    const f = $('#entry-form');
    if (!f.id.value) f.date.value = defaultDate();
    render();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
