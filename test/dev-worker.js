// ローカル E2E 用：本番の Worker に「固定の応答を返す AI」を差し込んで起動する
import worker from '../src/worker.js';

const stubAI = {
  async run(model, input) {
    const text = input.messages[1].content;
    if (/ご利用金額：648円/.test(text)) {
      return { response: { is_expense: true, items: [{ date: '2026-11-14', amount: 648, merchant: 'セブンイレブン', category: 'convenience' }] } };
    }
    if (/タイムズカー/.test(text)) {
      return { response: { is_expense: true, items: [
        { date: '2026-11-12', amount: 1980, merchant: 'タイムズカー', category: 'carshare' },
        { date: '2026-11-13', amount: 3214, merchant: 'イオン', category: 'supermarket' }
      ] } };
    }
    return { response: { is_expense: false, items: [] } };
  }
};

export default {
  fetch(request, env, ctx) {
    return worker.fetch(request, { ...env, AI: stubAI }, ctx);
  }
};
