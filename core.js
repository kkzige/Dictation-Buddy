/** Pure domain logic for Dictation Buddy. No DOM required. */
export const DEFAULT_SETTINGS = Object.freeze({
  order: 'sequential',
  repetitions: 2,
  repeatGap: 1.0,
  wordGap: 5.0,
  rateZh: 0.86,
  rateEn: 0.84,
  skipDuplicates: true,
  hideAnswers: true,
  zhVoice: '',
  enVoice: '',
  ocrEndpoint: '',
});

export const uid = () => (globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`);
export const clamp = (n, low, high) => Math.min(high, Math.max(low, Number(n) || low));
export const languageName = lang => lang === 'en-US' ? '英语' : '中文';
export const graphemes = str => Array.from(String(str ?? ''));
export const isChineseCharacter = c => /\p{Script=Han}/u.test(c);

export function parseEntries(raw, lang = 'zh-CN', mode = 'line') {
  const input = String(raw ?? '').replace(/\r\n?/g, '\n');
  // 'auto' defaults to Chinese whitespace segmentation, but preserves English phrases.
  const effectiveMode = mode === 'auto' ? (lang === 'zh-CN' ? 'spaces' : 'punct') : mode;
  const segments = effectiveMode === 'punct'
    ? input.split(/[\n,，、;；\t|]+/)
    : effectiveMode === 'spaces'
      ? input.split(/[\s,，、;；|]+/)
      : input.split('\n');
  const out = [];
  const seen = new Set();
  for (let token of segments) {
    token = token
      .replace(/^\s*(?:(?:[（(]?\d{1,3}[)）]?[.．、:：]\s*)|(?:[•·●◆■◦-]\s*))/, '')
      .trim();
    if (!token) continue;
    const normalized = token.normalize('NFKC').toLocaleLowerCase('en');
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({id: uid(), text: token, marks: []});
  }
  return out;
}


/** Case- and width-insensitive dedupe; retains original display text. */
export const normalizeTermKey = text => String(text ?? '').trim().normalize('NFKC').toLocaleLowerCase('en');

/** Prepare additions without mutating an existing word bank or breaking saved group references. */
export function prepareBankEntries(entries, lang='zh-CN', existingItems=[]) {
  const seen=new Set(existingItems.map(item=>normalizeTermKey(item.text)));
  const items=[];let skipped=0;
  for(const entry of entries||[]){
    const text=String(entry?.text??'').trim().slice(0,200);
    if(!text)continue;
    const key=normalizeTermKey(text);
    if(seen.has(key)){skipped++;continue;}
    seen.add(key);
    const chars=graphemes(text);
    const marks=lang==='zh-CN'
      ? [...new Set((Array.isArray(entry?.marks)?entry.marks:[]).filter(i=>Number.isInteger(i)&&i>=0&&i<chars.length&&isChineseCharacter(chars[i])))].sort((a,b)=>a-b)
      : [];
    items.push({id:entry?.id||uid(),text,marks});
  }
  return {items,skipped};
}

export function normalizeDb(raw) {
  const db = {banks: [], groups: [], settings: {...DEFAULT_SETTINGS}};
  if (!raw || typeof raw !== 'object') return db;
  if (raw.settings && typeof raw.settings === 'object') {
    const s = raw.settings;
    const allowedOrder = ['random', 'sequential'];
    db.settings = {
      ...DEFAULT_SETTINGS,
      order: allowedOrder.includes(s.order) ? s.order : DEFAULT_SETTINGS.order,
      repetitions: Math.round(clamp(s.repetitions ?? 2, 1, 5)),
      repeatGap: clamp(s.repeatGap ?? 1, 0, 5),
      wordGap: clamp(s.wordGap ?? 5, 1, 30),
      rateZh: clamp(s.rateZh ?? .86, .55, 1.4),
      rateEn: clamp(s.rateEn ?? .84, .55, 1.4),
      skipDuplicates: s.skipDuplicates !== false,
      hideAnswers: s.hideAnswers !== false,
      zhVoice: String(s.zhVoice ?? '').slice(0, 200),
      enVoice: String(s.enVoice ?? '').slice(0, 200),
      ocrEndpoint: String(s.ocrEndpoint ?? '').slice(0, 512),
    };
  }
  const validBanks = (Array.isArray(raw.banks) ? raw.banks : []).slice(0, 400);
  const bankIds = new Set();
  for (const bank of validBanks) {
    if (!bank || typeof bank !== 'object') continue;
    const id = String(bank.id || uid()).slice(0, 100);
    if (bankIds.has(id)) continue;
    bankIds.add(id);
    const items = [];
    const itemIds = new Set();
    for (const item of (Array.isArray(bank.items) ? bank.items : []).slice(0, 6000)) {
      if (!item || typeof item !== 'object') continue;
      const text = String(item.text ?? '').trim().slice(0, 200);
      const iid = String(item.id || uid()).slice(0, 100);
      if (!text || itemIds.has(iid)) continue;
      itemIds.add(iid);
      const chars = graphemes(text);
      const marks = [...new Set((Array.isArray(item.marks) ? item.marks : [])
        .filter(n => Number.isInteger(n) && n >= 0 && n < chars.length && isChineseCharacter(chars[n])))]
        .sort((a, b) => a - b);
      items.push({id: iid, text, marks});
    }
    db.banks.push({
      id, title: String(bank.title || '未命名词库').trim().slice(0, 80),
      lang: bank.lang === 'en-US' ? 'en-US' : 'zh-CN',
      createdAt: Number(bank.createdAt) || Date.now(),
      items,
    });
  }
  const groupIds = new Set();
  for (const group of (Array.isArray(raw.groups) ? raw.groups : []).slice(0, 200)) {
    if (!group || typeof group !== 'object') continue;
    const id = String(group.id || uid()).slice(0, 100);
    if (groupIds.has(id)) continue;
    groupIds.add(id);
    const refs = [];
    const refSet = new Set();
    for (const ref of (Array.isArray(group.refs) ? group.refs : []).slice(0, 12000)) {
      if (!ref || typeof ref !== 'object') continue;
      const bankId = String(ref.bankId ?? '');
      const itemId = String(ref.itemId ?? '');
      const key = `${bankId}\u0000${itemId}`;
      if (!bankId || !itemId || refSet.has(key)) continue;
      refSet.add(key);
      refs.push({bankId, itemId});
    }
    db.groups.push({id, title: String(group.title || '未命名组合').trim().slice(0, 80), refs});
  }
  return db;
}

export const refKey = (bankId, itemId) => `${bankId}:${itemId}`;
export function getItemsFromRefs(db, refs) {
  const banks = new Map(db.banks.map(bank => [bank.id, bank]));
  const result = [];
  for (const ref of refs) {
    const bank = banks.get(ref.bankId);
    const item = bank?.items.find(entry => entry.id === ref.itemId);
    if (bank && item) result.push({bankId: bank.id, itemId: item.id, lang: bank.lang, text: item.text, marks: item.marks.slice()});
  }
  return result;
}

export function collectWords(db, source, selectedRefs = []) {
  if (!source) return [];
  if (source.type === 'selected') return getItemsFromRefs(db, selectedRefs);
  if (source.type === 'bank') {
    const bank = db.banks.find(b => b.id === source.id);
    return bank ? getItemsFromRefs(db, bank.items.map(item => ({bankId: bank.id, itemId: item.id}))) : [];
  }
  if (source.type === 'group') {
    const group = db.groups.find(g => g.id === source.id);
    return group ? getItemsFromRefs(db, group.refs) : [];
  }
  return [];
}

export function deduplicateWords(words) {
  const seen = new Map();
  const result = [];
  for (const word of words) {
    const key = `${word.lang}|${word.text.normalize('NFKC').toLocaleLowerCase('en')}`;
    if (seen.has(key)) {
      const first = seen.get(key);
      if (first.lang === 'zh-CN') first.marks = [...new Set([...first.marks, ...word.marks])].sort((a, b) => a - b);
      continue;
    }
    const copy = {...word, marks: [...word.marks]};
    seen.set(key, copy);
    result.push(copy);
  }
  return result;
}

export function arrangeWords(words, settings, random = Math.random) {
  const list = settings.skipDuplicates ? deduplicateWords(words) : words.map(x => ({...x, marks: x.marks.slice()}));
  if (settings.order === 'random') {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }
  return list;
}

export function pinPrompt(word) {
  if (word.lang !== 'zh-CN' || !word.marks?.length) return '';
  const marks = [...new Set(word.marks)].sort((a, b) => a - b);
  const order = marks.map(i => `第${i + 1}个字`);
  return `请写出${order.join('和')}的拼音。`;
}

export function buildSteps(words, settings) {
  const steps = [];
  const reps = Math.round(clamp(settings.repetitions, 1, 5));
  for (let index = 0; index < words.length; index++) {
    const item = words[index];
    for (let rep = 1; rep <= reps; rep++) {
      steps.push({type: 'say', phase: 'word', text: item.text, lang: item.lang, wordIndex: index, rep, reps});
      if (rep < reps) steps.push({type: 'wait', duration: Math.round(clamp(settings.repeatGap, 0, 5) * 1000), wordIndex: index});
    }
    const prompt = pinPrompt(item);
    if (prompt) {
      steps.push({type: 'wait', duration: 550, wordIndex: index});
      steps.push({type: 'say', phase: 'pinyin', text: prompt, lang: 'zh-CN', wordIndex: index, rep: reps, reps});
    }
    if (index < words.length - 1) steps.push({type: 'wait', duration: Math.round(clamp(settings.wordGap, 1, 30) * 1000), wordIndex: index});
  }
  return steps;
}

export function indicesToPrompt(marks) {
  return marks?.length ? `另需为第 ${marks.map(n => n + 1).join('、')} 个字写拼音` : '';
}
