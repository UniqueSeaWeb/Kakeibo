'use strict';

/**
 * カテゴリ定義
 * group: 集計時の大分類
 */
const GROUPS = [
  { id: 'food', name: '食費', color: '#e07a3f' },
  { id: 'utility', name: '光熱費', color: '#3f86c9' },
  { id: 'transport', name: '交通', color: '#7a5bc4' },
  { id: 'fixed', name: '固定費', color: '#1f7a5c' },
  { id: 'misc', name: 'その他', color: '#7d8590' }
];

const CATEGORIES = [
  { id: 'dining', name: '外食', group: 'food', color: '#e07a3f' },
  { id: 'supermarket', name: 'スーパー', group: 'food', color: '#d4a017' },
  { id: 'convenience', name: 'コンビニ', group: 'food', color: '#c9573f' },
  { id: 'electricity', name: '電気', group: 'utility', color: '#e0b400' },
  { id: 'water', name: '水道', group: 'utility', color: '#3f86c9' },
  { id: 'gas', name: 'ガス', group: 'utility', color: '#d9534f' },
  { id: 'carshare', name: 'カーシェア', group: 'transport', color: '#7a5bc4' },
  { id: 'rent', name: '家賃', group: 'fixed', color: '#1f7a5c', fixed: true },
  { id: 'telecom', name: '通信', group: 'fixed', color: '#2e9e8f', fixed: true },
  { id: 'subscription', name: 'サブスク', group: 'fixed', color: '#5a9e3a', fixed: true },
  { id: 'insurance', name: '保険', group: 'fixed', color: '#3b7a9e', fixed: true },
  { id: 'fixed', name: 'その他固定', group: 'fixed', color: '#4f6b5f', fixed: true },
  { id: 'other', name: 'その他', group: 'misc', color: '#7d8590' }
];

const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
const GROUP_MAP = Object.fromEntries(GROUPS.map((g) => [g.id, g]));
