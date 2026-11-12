import {
  DEFAULT_SETTINGS, uid, parseEntries, normalizeDb, refKey, collectWords,
  getItemsFromRefs, arrangeWords, buildSteps, languageName, graphemes,
  isChineseCharacter, indicesToPrompt, clamp
} from './core.js';

const STORAGE_KEY = 'dictation-buddy-v0.1-data';
const OCR_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'; // OCR only, fetched on demand
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function loadDb() {
  try {return normalizeDb(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'));}
  catch (err) {console.warn('存储数据解析失败', err); return normalizeDb(null);}
}
let db = loadDb();
let tab = 'banks';
let selected = new Set();
let expanded = new Set();
let source = null;
let session = null;
let editingMarks = new Set();
let editorContext = null;
let importFile = null;
let importMode = 'manual';
let importDraft = null;
let importReviewExpanded = new Set();
let importFileUrl = '';
let ocrBusy = false;
let ocrLoading = null;
let toastTimer = 0;

function save() {
  try {localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); return true;}
  catch (err) {console.error(err); toast('本机存储失败：请使用设置中的“导出备份”，并检查 Safari 储存空间。'); return false;}
}
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3600);
}
function modal(title, body) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  $('#overlay').hidden = false;
  $('#overlay').setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}
function closeModal() {
  if (ocrBusy) {toast('图片正在识别，完成后再关闭。'); return;}
  $('#overlay').hidden = true;
  $('#overlay').setAttribute('aria-hidden', 'true');
  $('#modalBody').innerHTML = '';
  document.body.style.overflow = '';
  importFile = null;
  importDraft = null;
  importReviewExpanded.clear();
  if (importFileUrl) { URL.revokeObjectURL(importFileUrl); importFileUrl = ''; }
  editorContext = null;
}
function setTab(next) {
  if (session && next !== 'practice') stopPlayback();
  tab = next;
  window.scrollTo({top:0,behavior:'instant'});
  render();
}
function totalWords() {return db.banks.reduce((sum,b) => sum + b.items.length,0);}
function allSelectedRefs() {
  const refs = [];
  for (const bank of db.banks) for (const item of bank.items) {
    if (selected.has(refKey(bank.id,item.id))) refs.push({bankId:bank.id,itemId:item.id});
  }
  return refs;
}
function defaultSource() {
  if (source && ((source.type === 'selected' && selected.size) || collectWords(db, source).length)) return source;
  if (selected.size) return {type:'selected'};
  if (db.groups.length && collectWords(db,{type:'group',id:db.groups[0].id}).length) return {type:'group',id:db.groups[0].id};
  if (db.banks.length) return {type:'bank',id:db.banks[0].id};
  return null;
}
function sourceLabel(s) {
  if (!s) return '尚未选择词语';
  if (s.type === 'selected') return `临时勾选的词语（${allSelectedRefs().length}）`;
  if (s.type === 'bank') return db.banks.find(x=>x.id===s.id)?.title ?? '已删除词库';
  return db.groups.find(x=>x.id===s.id)?.title ?? '已删除组合';
}
function render() {
  $$('.nav-button').forEach(btn => btn.classList.toggle('active',btn.dataset.tab===tab));
  $('#mainContent').innerHTML = tab === 'banks' ? renderBanks() : tab === 'groups' ? renderGroups() : tab === 'practice' ? renderPractice() : renderSettings();
  renderSelection();
}
function renderSelection() {
  const el = $('#selectionBar');
  if (!selected.size || tab !== 'banks') {el.hidden=true;return;}
  el.hidden=false;
  el.innerHTML = `<strong>已勾选 ${selected.size} 个词语</strong>
    <button class="btn btn-small btn-primary" data-action="play-selected">直接听写</button>
    <button class="btn btn-small" data-action="create-group">存为组合</button>
    <button class="btn btn-small" data-action="append-group">加入组合</button>
    <button class="btn btn-small" data-action="clear-selection">清空</button>`;
}
function renderBanks() {
  let html = `<div class="page-header"><div><div class="eyebrow">WORD LIBRARY</div><h1 class="page-title">我的词库</h1><p class="page-description">每次拍照或输入保存一份词库，可跨词库勾选复习。</p></div><button type="button" class="btn btn-primary" data-action="open-import">＋ 导入</button></div>
    <div class="stats"><div class="stat"><strong>${db.banks.length}</strong><span>份词库</span></div><div class="stat"><strong>${totalWords()}</strong><span>个词语</span></div><div class="stat"><strong>${db.groups.length}</strong><span>个组合</span></div></div>`;
  if (!db.banks.length) return html+`<div class="empty"><div class="empty-symbol">▦</div><h3>从第一份词库开始</h3><p>拍课本、练习册或默写清单，也可以直接粘贴词语。</p><div class="action-row" style="justify-content:center"><button class="btn btn-primary" data-action="open-import">创建词库</button><button class="btn" data-action="add-demo">体验示例</button></div></div>`;
  html += `<div class="section-title">词库列表 · ${db.banks.length} 份</div>`;
  for (const bank of db.banks) {
    const isOpen=expanded.has(bank.id);
    const selectedCount=bank.items.filter(item=>selected.has(refKey(bank.id,item.id))).length;
    html += `<article class="card"><div class="card-head"><div style="min-width:0;flex:1"><h2 class="card-title">${esc(bank.title)}</h2><div class="subtext"><span class="badge">${languageName(bank.lang)}</span>${bank.items.length} 个词语${selectedCount?` · 已选 ${selectedCount}`:''}</div></div><button class="btn btn-small btn-subtle" data-action="toggle-bank" data-bank="${esc(bank.id)}">${isOpen?'收起':'展开'}</button></div>
    <div class="bank-actions"><button class="btn btn-small" data-action="select-bank" data-bank="${esc(bank.id)}">${selectedCount===bank.items.length&&bank.items.length?'取消全选':'全选词语'}</button><button class="btn btn-small btn-ghost" data-action="add-word" data-bank="${esc(bank.id)}">＋ 添加</button><button class="btn btn-small btn-ghost" data-action="rename-bank" data-bank="${esc(bank.id)}">重命名</button><span class="spacer"></span><button class="text-button danger" data-action="delete-bank" data-bank="${esc(bank.id)}">删除</button></div>`;
    if (isOpen) {
      html+=`<div class="bank-body">`;
      if(!bank.items.length) html+=`<div class="hint">没有词语，点击上方“添加”。</div>`;
      for (const item of bank.items) {
        const key=refKey(bank.id,item.id);
        html+=`<div class="entry"><input class="checkbox item-checkbox" type="checkbox" aria-label="选择 ${esc(item.text)}" data-bank="${esc(bank.id)}" data-item="${esc(item.id)}" ${selected.has(key)?'checked':''}><div class="entry-word">${esc(item.text)}${item.marks.length?`<div class="entry-detail">${esc(indicesToPrompt(item.marks))}</div>`:''}</div><div class="entry-tools"><button class="text-button" data-action="edit-word" data-bank="${esc(bank.id)}" data-item="${esc(item.id)}">编辑</button><button class="text-button danger" data-action="delete-word" data-bank="${esc(bank.id)}" data-item="${esc(item.id)}">移除</button></div></div>`;
      }
      html+=`</div>`;
    }
    html+=`</article>`;
  }
  html+=`<div class="small-note">提示：可以打开不同词库分别勾选词语。下方会出现“存为组合”或“直接听写”的操作栏。</div>`;
  return html;
}
function renderGroups() {
  let html=`<div class="page-header"><div><div class="eyebrow">PRACTICE COLLECTIONS</div><h1 class="page-title">练习组合</h1><p class="page-description">把不同日期、不同课次的词语保存为一组，一键复习。</p></div></div>`;
  if (!db.groups.length) return html+`<div class="empty"><div class="empty-symbol">▣</div><h3>暂无听写组合</h3><p>去“词库”页勾选需要复习的词语，再点击“存为组合”。</p><button class="btn btn-primary" data-action="go-banks">去选择词语</button></div>`;
  for(const group of db.groups){
    const items=getItemsFromRefs(db,group.refs);
    html+=`<section class="card"><div class="card-head"><div><h2 class="card-title">${esc(group.title)}</h2><div class="subtext">${items.length} 个有效词语 · ${new Set(items.map(i=>i.lang)).size>1?'中英混合':'单语练习'}</div></div><button class="btn btn-primary btn-small" data-action="play-group" data-group="${esc(group.id)}" ${items.length?'':'disabled'}>开始听写</button></div>
    <div class="bank-actions"><button class="btn btn-small" data-action="rename-group" data-group="${esc(group.id)}">重命名</button><button class="btn btn-small" data-action="view-group" data-group="${esc(group.id)}">管理成员</button><span class="spacer"></span><button class="text-button danger" data-action="delete-group" data-group="${esc(group.id)}">删除</button></div></section>`;
  }
  return html;
}
function sourceOptions(current) {
  const options=[];
  if(selected.size) options.push({value:'selected',label:`已勾选的词语 · ${selected.size} 项`});
  for(const group of db.groups) options.push({value:`group:${group.id}`,label:`组合 · ${group.title} (${getItemsFromRefs(db,group.refs).length})`});
  for(const bank of db.banks) options.push({value:`bank:${bank.id}`,label:`词库 · ${bank.title} (${bank.items.length})`});
  const curr=current?.type==='selected'?'selected':current?`${current.type}:${current.id}`:'';
  return options.map(opt=>`<option value="${esc(opt.value)}" ${opt.value===curr?'selected':''}>${esc(opt.label)}</option>`).join('');
}
function orderRadio() {return `<div class="option-grid"><label class="choice"><input name="order" type="radio" value="sequential" ${db.settings.order==='sequential'?'checked':''}>按原顺序</label><label class="choice"><input name="order" type="radio" value="random" ${db.settings.order==='random'?'checked':''}>随机打乱</label></div>`;}
function repsChoice() {return `<div class="option-grid" style="grid-template-columns:repeat(5,1fr);gap:6px">${[1,2,3,4,5].map(i=>`<label class="choice" style="justify-content:center;padding:9px 3px"><input type="radio" name="repetitions" value="${i}" ${db.settings.repetitions===i?'checked':''} style="display:none"><strong>${i}遍</strong></label>`).join('')}</div>`;}
function settingsMini() {
  return `<section class="setting-panel"><h3>播报规则</h3>
  <label class="field"><span>播放顺序</span>${orderRadio()}</label>
  <label class="field"><span>每个词重复次数</span>${repsChoice()}</label>
  <label class="field"><span>词与词之间等待</span><div class="range-title"><span>给孩子留出书写时间</span><strong id="wordGapValue">${db.settings.wordGap} 秒</strong></div><input type="range" name="wordGap" min="1" max="20" step="1" value="${db.settings.wordGap}"></label>
  <label class="field"><span>同一词重复之间等待</span><div class="range-title"><span>每遍间隔</span><strong id="repeatGapValue">${db.settings.repeatGap} 秒</strong></div><input type="range" name="repeatGap" min="0" max="5" step=".5" value="${db.settings.repeatGap}"></label>
  <div class="action-row"><label class="choice" style="flex:1"><input type="checkbox" name="skipDuplicates" ${db.settings.skipDuplicates?'checked':''}>合并重复词语</label><label class="choice" style="flex:1"><input type="checkbox" name="hideAnswers" ${db.settings.hideAnswers?'checked':''}>默认隐藏答案</label></div>
  </section>`;
}
function renderPractice() {
  if(session) return renderPlayer();
  const current=defaultSource();
  const words=collectWords(db,current,allSelectedRefs());
  let html=`<div class="page-header"><div><div class="eyebrow">DICTATION SESSION</div><h1 class="page-title">开始听写</h1><p class="page-description">选择词库或组合，设置好节奏，点击开始后自动播报。</p></div></div>`;
  if(!db.banks.length) return html+`<div class="empty"><div class="empty-symbol">◉</div><h3>没有可播报的词语</h3><p>请先创建一份词库。</p><button class="btn btn-primary" data-action="open-import">导入词语</button></div>`;
  html+=`<section class="setting-panel"><h3>听写内容</h3><label class="field"><span>选择来源</span><select id="practiceSource">${sourceOptions(current)}</select><small class="hint">${words.length} 个词语准备就绪；混合词库时会为每个词选择对应语言。</small></label></section>`;
  html+=settingsMini();
  html+=`<button class="btn btn-primary btn-wide" style="min-height:56px;font-size:16px" data-action="start-play" ${words.length?'':'disabled'}>▶ 开始播报 ${words.length} 个词语</button><div class="small-note">首次播放需要点击按钮授权声音。请把 iPhone 保持亮屏、网页保持前台，语音效果受系统可用音色影响。</div>`;
  return html;
}
function currentWordIndex(s) {
  const step=s.steps[Math.min(s.stepIndex,s.steps.length-1)];
  return step?.wordIndex ?? s.words.length-1;
}
function renderPlayer(){
  const s=session;
  const completed=s.finished;
  const idx=currentWordIndex(s);
  const item=s.words[idx];
  const step=s.steps[Math.min(s.stepIndex,s.steps.length-1)];
  const meta=completed?'本轮听写已完成':step?.phase==='pinyin'?'正在提示写拼音':step?.phase==='word'?`本词第 ${step.rep} / ${step.reps} 遍`:'等待下一次播报';
  const title=completed?'全部完成':s.revealed?esc(item?.text):Array.from(item?.text??'').map(ch=>/\s/.test(ch)?'&nbsp;':'●').join('');
  const progress=completed?100:Math.round((idx/s.words.length)*100);
  return `<div class="page-header"><div><div class="eyebrow">NOW PLAYING</div><h1 class="page-title">${completed?'听写结束':'正在听写'}</h1><p class="page-description">${esc(s.sourceName)}</p></div><button class="btn btn-small" data-action="stop-play">结束</button></div>
  <div class="play-card"><div class="play-kicker">${completed?'完成':'第 '+(idx+1)+' / '+s.words.length+' 个词语'} · ${item?languageName(item.lang):''}</div><div class="play-title">${title}</div><div class="play-meta">${meta}</div><div class="tiny-progress"><div style="width:${progress}%"></div></div>
  <div class="play-actions"><button class="btn" data-action="prev-word" ${completed?'disabled':''}>↶ 上一个</button><button class="btn btn-primary" data-action="toggle-pause">${completed?'✓ 已完成':s.paused?'▶ 继续':'Ⅱ 暂停'}</button><button class="btn" data-action="next-word" ${completed?'disabled':''}>下一个 ↷</button></div><div class="play-footer"><span>${completed?'':(item?.marks.length?'本词含拼音提示':'请认真听写')}</span><span>${completed?s.words.length:idx+1} / ${s.words.length}</span></div></div>
  <div class="action-row"><button class="btn" data-action="replay-word" ${completed?'disabled':''}>↻ 重听当前词</button><button class="btn" data-action="toggle-reveal" ${completed?'disabled':''}>${s.revealed?'隐藏词语':'显示词语'}</button>${completed?'<button class="btn btn-primary" data-action="restart-play">再来一轮</button>':''}</div>
  <div class="small-note">“暂停”会取消正在朗读的一小段，“继续”将重新朗读该段，以免漏词；上一词/下一词按词跳转。${completed?'可返回词库重新组合练习。':''}</div>`;
}
function voiceOptions(lang, chosen) {
  if (!('speechSynthesis' in window)) return '<option value="">当前浏览器不支持语音</option>';
  const voices=speechSynthesis.getVoices().filter(v=>lang==='zh-CN'?v.lang.toLowerCase().startsWith('zh'):v.lang.toLowerCase().startsWith('en'));
  return `<option value="">系统自动选择</option>${voices.map(v=>`<option value="${esc(v.voiceURI)}" ${v.voiceURI===chosen?'selected':''}>${esc(v.name)} (${esc(v.lang)})${v.localService?' · 本机':''}</option>`).join('')}`;
}
function renderSettings() {
  return `<div class="page-header"><div><div class="eyebrow">PREFERENCES & DATA</div><h1 class="page-title">设置与备份</h1><p class="page-description">调整声音风格、保护词库，方便长期使用。</p></div></div>
  <section class="setting-panel"><h3>语音音色与语速</h3>
  <label class="field"><span>中文音色</span><select name="zhVoice">${voiceOptions('zh-CN',db.settings.zhVoice)}</select></label>
  <label class="field"><span>英语音色</span><select name="enVoice">${voiceOptions('en-US',db.settings.enVoice)}</select></label>
  <label class="field"><span>中文语速</span><div class="range-title"><span>建议略慢</span><strong id="rateZhValue">${db.settings.rateZh.toFixed(2)} ×</strong></div><input type="range" name="rateZh" min=".55" max="1.4" step=".05" value="${db.settings.rateZh}"></label>
  <label class="field"><span>英语语速</span><div class="range-title"><span>可按孩子听写水平调整</span><strong id="rateEnValue">${db.settings.rateEn.toFixed(2)} ×</strong></div><input type="range" name="rateEn" min=".55" max="1.4" step=".05" value="${db.settings.rateEn}"></label>
  <div class="action-row"><button class="btn btn-subtle" data-action="test-voice" data-lang="zh-CN">试听中文</button><button class="btn btn-subtle" data-action="test-voice" data-lang="en-US">试听英文</button></div>
  <div class="setting-help">音色来自本机 Safari 可用的系统声音，某些 iPhone 可能不会显示完整音色列表。</div></section>
  <section class="setting-panel"><h3>词库数据</h3><p class="subtext">当前 ${db.banks.length} 份词库，${totalWords()} 个词语，${db.groups.length} 个组合。数据只存当前浏览器，不会自动同步到其他设备。</p>
  <div class="action-row"><button class="btn btn-primary" data-action="export-backup">导出 JSON 备份</button><label class="btn" for="backupFile">导入 JSON 备份</label><input type="file" id="backupFile" accept="application/json,.json" class="visually-hidden-file"></div>
  <div class="small-note warning-note">Safari 清理网站数据、删除主屏幕应用，或更换设备时，词库可能丢失。建议每周导出备份。导入备份会替换当前所有词库与组合。</div></section>
  <section class="setting-panel"><h3>离线与识别说明</h3><p class="subtext">词库编辑、组合及基础播报依靠本机浏览器能力；拍照 OCR 首次加载需要联网下载识别程序和语言包，不能保证在无网络环境可用。照片不会由本应用上传到我们的服务器；使用第三方 CDN 下载 OCR 程序。</p><p class="subtext">iOS 锁屏、切出应用或语音引擎被系统中断，可能停止播报；建议亮屏使用。</p></section>
  <section class="setting-panel"><h3>快速试用</h3><div class="action-row"><button class="btn" data-action="add-demo">新增示例词库</button><button class="btn btn-danger" data-action="clear-everything">清空全部数据</button></div></section>`;
}

function openImport(restore = false) {
  if(!restore) { importDraft = null; importMode = 'manual'; }
  const old = restore ? importDraft : null;
  modal('创建词库 · 添加词语', `
  <label class="field"><span>词库名称</span><input id="importName" placeholder="例如：五年级第12课 / PET Unit 3" value="${esc(old?.name || '听写 · '+new Date().toLocaleDateString('zh-CN'))}" maxlength="80"></label>
  <label class="field"><span>词语语言</span><select id="importLang"><option value="zh-CN" ${old?.lang==='zh-CN'?'selected':''}>中文</option><option value="en-US" ${old?.lang==='en-US'?'selected':''}>英文</option></select></label>
  <div class="field"><span>选择添加方式</span><div class="import-methods" role="group" aria-label="添加方式">
    <button type="button" class="import-method ${importMode==='manual'?'active':''}" data-action="import-mode" data-method="manual" aria-pressed="${importMode==='manual'}"><span class="method-symbol">⌨</span><span>手动输入<small>单词、词组或批量粘贴</small></span></button>
    <button type="button" class="import-method ${importMode==='photo'?'active':''}" data-action="import-mode" data-method="photo" aria-pressed="${importMode==='photo'}"><span class="method-symbol">▧</span><span>拍照识别<small>拍课本、相册选图</small></span></button>
  </div></div>
  <section id="manualImportPanel" ${importMode==='manual'?'':'hidden'}><div class="small-note">手动输入时，一行一个词最稳妥。可以一次输入一项，也可以从微信、备忘录直接粘贴整份清单。</div></section>
  <section id="photoImportPanel" ${importMode==='photo'?'':'hidden'}><div class="field"><span>拍照或从相册选择图片</span><div class="action-row"><label class="btn btn-subtle" for="cameraFile">📷 拍照</label><input type="file" id="cameraFile" accept="image/*" capture="environment" class="visually-hidden-file"><label class="btn" for="galleryFile">▧ 相册选取</label><input type="file" id="galleryFile" accept="image/*" class="visually-hidden-file"></div><div id="photoHolder"></div><button class="btn btn-subtle" id="recognizeButton" data-action="run-ocr" disabled style="margin-top:10px">识别图片中的文字</button><div id="ocrStatus" class="ocr-status">首次识别需联网下载 OCR 模型；识别后可以人工修改。</div><small class="hint">清晰、单栏、竖直的词语表效果更好；也可以用 iPhone“实况文本”复制照片文字后粘贴。</small></div></section>
  <label class="field"><span>${importMode==='manual'?'输入或粘贴词语':'识别结果 / 手动补充词语'}</span><textarea id="importText" rows="7" placeholder="每行一个词语，例如：\n崎岖\n拥抱\n坚韧">${esc(old?.entries.map(x=>x.text).join('\n') || '')}</textarea><small class="hint">单个词语直接输入一行即可；多项内容可批量粘贴。下一步逐条检查和标记拼音字。</small></label>
  <label class="field"><span>拆分方式</span><select id="importSplit"><option value="line">每行一个词语（适合英文词组）</option><option value="punct">按换行、逗号、顿号、分号拆分</option><option value="spaces">按空格、换行及标点拆分（适合英文单词）</option></select></label>
  <div class="small-note" id="importPreview">输入后会显示词语数量和部分预览。</div>
  <button class="btn btn-primary btn-wide" data-action="review-import">下一步 · 核对词语和拼音标记</button>`);
  if(importFile && importFileUrl){
    const holder=$('#photoHolder');
    holder.innerHTML=`<img class="ocr-preview" alt="待识别的照片" src="${esc(importFileUrl)}"><div class="hint">已选择：${esc(importFile.name || '拍摄照片')}</div>`;
    $('#recognizeButton').disabled=false;
  }
  refreshImportPreview();
}
function setImportMode(mode) {
  importMode=mode==='photo'?'photo':'manual';
  $$('.import-method').forEach(btn=>{
    const active=btn.dataset.method===importMode;
    btn.classList.toggle('active',active);btn.setAttribute('aria-pressed',String(active));
  });
  $('#manualImportPanel').hidden=importMode!=='manual';
  $('#photoImportPanel').hidden=importMode!=='photo';
}
function refreshImportPreview() {
  const raw=$('#importText')?.value ?? '';
  const entries=parseEntries(raw,$('#importLang')?.value,$('#importSplit')?.value);
  const target=$('#importPreview');
  if(target) target.innerHTML=entries.length?`当前 <strong>${entries.length}</strong> 个不重复词语。预览：${entries.slice(0,7).map(x=>`<span class="label-chip">${esc(x.text)}</span>`).join('')}${entries.length>7?' …':''}`:'请先选择手动输入或拍照识别，添加至少一个词语。';
}
function startImportReview() {
  const name=$('#importName')?.value.trim();
  const lang=$('#importLang')?.value;
  const entries=parseEntries($('#importText')?.value,lang,$('#importSplit')?.value);
  if(!name){toast('请输入词库名称。');return;}
  if(!entries.length){toast('至少输入一个词语才能继续。');return;}
  const prev = importDraft?.entries || [];
  // Returning to the text editor preserves marks for the same term and occurrence.
  const matched = new Map();
  for(const entry of prev) if(!matched.has(entry.text))matched.set(entry.text,entry);
  for(const entry of entries){
    const old=matched.get(entry.text);
    if(old){entry.marks=[...old.marks];entry.id=old.id;}
  }
  importDraft={name,lang,entries};
  importReviewExpanded.clear();
  renderImportReview();
}
function renderImportReview() {
  const draft=importDraft;if(!draft)return;
  modal('逐条核对 · 保存前可修改',`<div class="review-summary"><strong>${esc(draft.name)}</strong><span class="badge">${languageName(draft.lang)}</span><div class="hint">共 <strong>${draft.entries.length}</strong> 项。可以改字、删除，中文可点选需要写拼音的字。</div></div>
  <div id="importReviewList" class="review-list">${draft.entries.map((item,i)=>renderReviewItem(item,i,draft.lang)).join('')}</div>
  <button class="btn btn-subtle btn-wide" style="margin:10px 0 13px" data-action="add-review-row">＋ 再补充一个词语</button>
  <div class="action-row"><button class="btn" data-action="back-to-import">返回输入</button><button class="btn btn-primary" style="flex:1" data-action="save-import">确认并保存词库</button></div>`);
}
function renderReviewItem(item, index, lang) {
  const expanded=importReviewExpanded.has(item.id);
  const chars=graphemes(item.text);
  return `<div class="review-item" data-review-item="${esc(item.id)}"><div class="review-item-top"><span class="review-index">${index+1}</span><input aria-label="第 ${index+1} 项词语" class="review-text" data-review-text="${esc(item.id)}" value="${esc(item.text)}" maxlength="200"><button type="button" class="text-button danger" data-action="remove-review-row" data-row="${esc(item.id)}">删除</button></div>
  ${lang==='zh-CN'?`<div class="review-item-bottom"><button class="text-button" type="button" data-action="toggle-review-marks" data-row="${esc(item.id)}">${expanded?'收起标记':'标拼音'}${item.marks.length?' · '+item.marks.length+'字':''}</button>${item.marks.length?`<span class="hint">${esc(indicesToPrompt(item.marks))}</span>`:''}</div><div class="review-marks" ${expanded?'':'hidden'}>${renderReviewMarks(chars,item)}</div>`:''}</div>`;
}
function renderReviewMarks(chars,item){
  return chars.map((ch,i)=>isChineseCharacter(ch)?`<button type="button" class="char-toggle ${item.marks.includes(i)?'on':''}" data-action="toggle-review-char" data-row="${esc(item.id)}" data-index="${i}" aria-pressed="${item.marks.includes(i)}">${esc(ch)}<span class="position">${i+1}</span></button>`:'').join('')||'<span class="hint">该词语没有汉字</span>';
}
function updateReviewRow(rowId){
  const item=importDraft?.entries.find(x=>x.id===rowId);
  const el=$(`[data-review-item="${CSS.escape(rowId)}"]`);
  if(!item||!el)return;
  el.outerHTML=renderReviewItem(item,importDraft.entries.indexOf(item),importDraft.lang);
}
function updateReviewText(id,value){
  const item=importDraft?.entries.find(x=>x.id===id);if(!item)return;
  if(item.text!==value) {item.text=value;item.marks=[];}
}
function refreshReviewChars(id){
  const item=importDraft?.entries.find(x=>x.id===id);
  const row=$(`[data-review-item="${CSS.escape(id)}"]`);
  if(!item||!row)return;
  const grid=$('.review-marks',row);
  if(grid)grid.innerHTML=renderReviewMarks(graphemes(item.text),item);
  const button=$('[data-action="toggle-review-marks"]',row);
  if(button)button.textContent=(importReviewExpanded.has(id)?'收起标记':'标拼音')+(item.marks.length?' · '+item.marks.length+'字':'');
  $('.review-item-bottom .hint',row)?.remove();
}
function saveImport() {
  const draft=importDraft;if(!draft)return;
  const entries=draft.entries.filter(x=>x.text.trim()).map(x=>({...x,text:x.text.trim()}));
  if(!entries.length){toast('请至少保留一个词语。');return;}
  const checked=[];const seen=new Set();
  for(const e of entries){
    const key=e.text.normalize('NFKC').toLocaleLowerCase('en');
    if(seen.has(key))continue;seen.add(key);
    const chars=graphemes(e.text);
    checked.push({...e,marks:draft.lang==='zh-CN'?e.marks.filter(i=>isChineseCharacter(chars[i]??'')):[]});
  }
  const bank={id:uid(),title:draft.name,lang:draft.lang,createdAt:Date.now(),items:checked};
  db.banks.unshift(bank);
  expanded.add(bank.id);
  save();closeModal();tab='banks';render();toast(`已保存 ${checked.length} 个词语。`);
}
function getBank(bankId) {return db.banks.find(b=>b.id===bankId);}
function openWordEditor(bankId,itemId) {
  const bank=getBank(bankId);if(!bank)return;
  const item=bank.items.find(w=>w.id===itemId);
  editorContext={bankId,itemId:itemId||null,lang:bank.lang};
  editingMarks=new Set(item?.marks??[]);
  modal(item?'编辑词语':'添加词语',`
  <label class="field"><span>${bank.lang==='zh-CN'?'中文词语':'英文单词或词组'}</span><input id="editorText" value="${esc(item?.text??'')}" maxlength="200" placeholder="输入词语" autocomplete="off"></label>
  ${bank.lang==='zh-CN'?`<label class="field"><span>需要写拼音的汉字（可多选）</span><div id="charGrid" class="char-grid"></div><small class="hint">点亮的汉字会在听写后追加提示：“请写出第 N 个字的拼音”。</small></label>`:''}
  <div class="action-row"><button class="btn btn-primary btn-wide" data-action="save-word">保存词语</button></div>`);
  drawCharGrid();
}
function drawCharGrid() {
  const target=$('#charGrid');if(!target)return;
  const chars=graphemes($('#editorText')?.value??'');
  target.innerHTML=chars.map((ch,i)=>isChineseCharacter(ch)?`<button class="char-toggle ${editingMarks.has(i)?'on':''}" type="button" data-action="toggle-char" data-index="${i}" aria-pressed="${editingMarks.has(i)}">${esc(ch)}<span class="position">${i+1}</span></button>`:'').join('') || '<span class="hint">请输入汉字后，就能逐字点选。</span>';
}
function saveWord() {
  if(!editorContext) return;
  const bank=getBank(editorContext.bankId);if(!bank)return;
  const value=$('#editorText')?.value.trim();
  if(!value){toast('词语不能为空。');return;}
  const chars=graphemes(value);
  const marks=bank.lang==='zh-CN'?[...editingMarks].filter(i=>isChineseCharacter(chars[i]??'')).sort((a,b)=>a-b):[];
  if(editorContext.itemId){const word=bank.items.find(i=>i.id===editorContext.itemId);if(word){word.text=value;word.marks=marks;}}
  else bank.items.push({id:uid(),text:value,marks});
  expanded.add(bank.id);save();closeModal();render();toast('词语已保存。');
}
function openNameEditor(type,id) {
  const isBank=type==='bank';
  const found=isBank?getBank(id):db.groups.find(g=>g.id===id);
  if(!found)return;
  editorContext={type,id};
  modal(isBank?'重命名词库':'重命名组合',`<label class="field"><span>名称</span><input id="editorName" maxlength="80" value="${esc(found.title)}"></label><button class="btn btn-primary btn-wide" data-action="save-name">保存名称</button>`);
}
function saveName(){
  if(!editorContext)return;
  const t=$('#editorName')?.value.trim();if(!t){toast('名称不能为空。');return;}
  const found=editorContext.type==='bank'?getBank(editorContext.id):db.groups.find(g=>g.id===editorContext.id);
  if(found){found.title=t;save();closeModal();render();}
}
function selectedIntoGroup(append=false){
  if(!selected.size){toast('请先在词库中勾选词语。');return;}
  const options=db.groups.map(g=>`<option value="${esc(g.id)}">${esc(g.title)}</option>`).join('');
  editorContext={groupMode:append?'append':'new'};
  modal(append?'加入已有组合':'创建练习组合',append
    ? `<label class="field"><span>选择组合</span><select id="chooseGroup">${options}</select></label><div class="small-note">本次将把已勾选的 ${selected.size} 个词语加入组合，重复成员不再次添加。</div><button class="btn btn-primary btn-wide" data-action="save-group">加入组合</button>`
    : `<label class="field"><span>组合名称</span><input id="newGroupName" value="复习组合 · ${new Date().toLocaleDateString('zh-CN')}" maxlength="80"></label><div class="small-note">将保存 ${selected.size} 个词语，以后可以继续补充、移除。</div><button class="btn btn-primary btn-wide" data-action="save-group">创建组合</button>`);
}
function saveGroup(){
  const refs=allSelectedRefs();if(!refs.length){toast('没有可加入的词语。');return;}
  if(editorContext?.groupMode==='append'){
    const group=db.groups.find(g=>g.id===$('#chooseGroup')?.value);
    if(!group){toast('请选择已有组合。');return;}
    const existing=new Set(group.refs.map(r=>refKey(r.bankId,r.itemId)));
    for(const ref of refs) if(!existing.has(refKey(ref.bankId,ref.itemId))){group.refs.push(ref);existing.add(refKey(ref.bankId,ref.itemId));}
    toast(`已更新「${group.title}」。`);
  }else{
    const title=$('#newGroupName')?.value.trim();if(!title){toast('请输入组合名称。');return;}
    db.groups.unshift({id:uid(),title,refs});toast('组合已创建。');
  }
  save();closeModal();selected.clear();tab='groups';render();
}
function viewGroup(groupId){
  const group=db.groups.find(g=>g.id===groupId);if(!group)return;
  const refs=getItemsFromRefs(db,group.refs);
  modal(`组合 · ${group.title}`,`<div class="subtext">${refs.length} 个有效词语。删除成员只会从组合移除，不会删除原词库里的词语。</div><div class="entry-list" style="margin:12px 0">${refs.map(w=>`<div class="entry"><div class="entry-word">${esc(w.text)} <span class="badge">${languageName(w.lang)}</span></div><button class="btn btn-danger btn-small" data-action="remove-group-item" data-group="${esc(group.id)}" data-bank="${esc(w.bankId)}" data-item="${esc(w.itemId)}">移除</button></div>`).join('')||'<div class="hint">没有可用的成员。</div>'}</div><button class="btn btn-primary btn-wide" data-action="close-modal">完成</button>`);
}
function addDemo(){
  const z={id:uid(),title:'示例 · 语文词语',lang:'zh-CN',createdAt:Date.now(),items:[
    {id:uid(),text:'崎岖',marks:[0,1]}, {id:uid(),text:'坚韧',marks:[1]}, {id:uid(),text:'拥抱',marks:[]}, {id:uid(),text:'踌躇',marks:[0]}
  ]};
  const e={id:uid(),title:'示例 · 英语单词',lang:'en-US',createdAt:Date.now(),items:[
    {id:uid(),text:'wonderful',marks:[]},{id:uid(),text:'environment',marks:[]},{id:uid(),text:'take care of',marks:[]},{id:uid(),text:'probably',marks:[]}
  ]};
  db.banks.unshift(e);db.banks.unshift(z);expanded.add(z.id);save();tab='banks';render();toast('已增加两份可删除的示例词库。');
}

function selectedWords(){return collectWords(db,source??defaultSource(),allSelectedRefs());}
function beginPlayback() {
  if(!('speechSynthesis' in window)){toast('这个浏览器不支持语音合成。请改用 Safari。');return;}
  const sourceToUse=source??defaultSource();
  const words=arrangeWords(collectWords(db,sourceToUse,allSelectedRefs()),db.settings);
  if(!words.length){toast('当前来源没有词语，请先添加或勾选。');return;}
  stopPlayback(false);
  session={words,steps:buildSteps(words,db.settings),stepIndex:0,paused:false,finished:false,revealed:!db.settings.hideAnswers,playToken:0,timer:0,watchdog:0,sourceName:sourceLabel(sourceToUse)};
  render();
  executeStep(); // Called directly from a tap, so iOS can unlock speech synthesis.
}
function cancelTimers(s){if(!s)return;clearTimeout(s.timer);clearTimeout(s.watchdog);s.timer=0;s.watchdog=0;}
function stopPlayback(shouldRender=true){
  const s=session;
  if(s){s.playToken++;cancelTimers(s);session=null;}
  try{window.speechSynthesis?.cancel();}catch{}
  if(shouldRender)render();
}
function chooseVoice(lang){
  const voices=speechSynthesis.getVoices();
  const uri=lang==='en-US'?db.settings.enVoice:db.settings.zhVoice;
  if(uri){const voice=voices.find(v=>v.voiceURI===uri);if(voice)return voice;}
  const matching=voices.filter(v=>v.lang.toLowerCase().startsWith(lang==='en-US'?'en':'zh'));
  return matching.find(v=>v.localService && v.lang.toLowerCase()===lang.toLowerCase()) || matching.find(v=>v.localService) || matching[0] || null;
}
function speakOnce(text,lang,onDone,onFailure) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang=lang;
  utterance.rate=lang==='en-US'?db.settings.rateEn:db.settings.rateZh;
  utterance.pitch=1;
  const v=chooseVoice(lang);if(v)utterance.voice=v;
  utterance.onend=onDone;
  utterance.onerror=onFailure;
  window.speechSynthesis.speak(utterance);
  return utterance;
}
function executeStep(){
  const s=session;if(!s||s.paused||s.finished)return;
  if(s.stepIndex>=s.steps.length){s.finished=true;s.paused=true;render();toast('这轮听写结束了。');return;}
  cancelTimers(s);
  const step=s.steps[s.stepIndex];
  if(step.type==='wait'){
    updatePlayer();
    s.timer=setTimeout(()=>{if(session!==s||s.paused)return;s.stepIndex++;executeStep();},step.duration);
    return;
  }
  const token=++s.playToken;
  updatePlayer();
  try{
    speakOnce(step.text,step.lang,()=>{
      if(session!==s||s.paused||s.playToken!==token)return;
      cancelTimers(s);s.stepIndex++;executeStep();
    }, event=>{
      if(session!==s||s.paused||s.playToken!==token)return;
      if(event.error==='interrupted'||event.error==='canceled')return;
      cancelTimers(s);s.paused=true;updatePlayer();toast('语音播放被系统中断，请点“继续”重试。');
    });
    const watchdogMs=Math.max(20000,graphemes(step.text).length*1200);
    s.watchdog=setTimeout(()=>{
      if(session!==s||s.paused||s.playToken!==token)return;
      pausePlayback();toast('本段语音可能已中断，请点击“继续”重新朗读。');
    },watchdogMs);
  }catch(err){console.error(err);s.paused=true;updatePlayer();toast('语音启动失败。请确认手机未静音、切换 Safari 重试。');}
}
function updatePlayer(){
  if(!session||tab!=='practice')return;
  $('#mainContent').innerHTML=renderPlayer();
}
function pausePlayback(){
  if(!session||session.finished)return;
  session.paused=true;session.playToken++;cancelTimers(session);
  window.speechSynthesis?.cancel();updatePlayer();
}
function resumePlayback(){
  if(!session||session.finished)return;
  session.paused=false;executeStep();
}
function jumpWord(delta,absolute=false){
  const s=session;if(!s||s.finished)return;
  const old=currentWordIndex(s);
  const newIndex=Math.min(s.words.length-1,Math.max(0,absolute?delta:old+delta));
  s.playToken++;cancelTimers(s);window.speechSynthesis?.cancel();
  const next=s.steps.findIndex(step=>step.wordIndex===newIndex&&step.type==='say'&&step.phase==='word');
  if(next<0)return;
  s.stepIndex=next;
  if(s.paused)updatePlayer();else executeStep();
}

function updatePhotoPreview(file){
  importFile=file;
  if(importFileUrl){URL.revokeObjectURL(importFileUrl);importFileUrl='';}
  const holder=$('#photoHolder');if(!holder)return;
  if(!file){holder.innerHTML='';$('#recognizeButton').disabled=true;return;}
  importFileUrl=URL.createObjectURL(file);
  holder.innerHTML=`<img class="ocr-preview" alt="待识别的照片" src="${esc(importFileUrl)}"><div class="hint">已选择：${esc(file.name || '拍摄照片')}</div>`;
  $('#recognizeButton').disabled=false;
}
async function ensureOcr(){
  if(window.Tesseract)return;
  if(ocrLoading)return ocrLoading;
  ocrLoading=new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src=OCR_URL;script.async=true;
    script.onload=()=>window.Tesseract?resolve():reject(new Error('OCR 模块没有正常加载'));
    script.onerror=()=>reject(new Error('OCR 脚本下载失败，请检查网络'));
    document.head.appendChild(script);
  });
  try{await ocrLoading;}catch(error){ocrLoading=null;throw error;}
}
async function prepareImage(file){
  const url=URL.createObjectURL(file);
  try{
    const image=new Image();
    await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=url;});
    const max=1900;
    const scale=Math.min(1,max/Math.max(image.naturalWidth,image.naturalHeight));
    const width=Math.max(1,Math.round(image.naturalWidth*scale));
    const height=Math.max(1,Math.round(image.naturalHeight*scale));
    const c=document.createElement('canvas');c.width=width;c.height=height;
    const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);
    ctx.drawImage(image,0,0,width,height);
    return new Promise((resolve,reject)=>c.toBlob(blob=>blob?resolve(blob):reject(new Error('无法压缩图片')),'image/jpeg',.93));
  }finally{URL.revokeObjectURL(url);}
}
async function runOcr(){
  if(ocrBusy||!importFile)return;
  ocrBusy=true;
  const btn=$('#recognizeButton');const status=$('#ocrStatus');
  btn.disabled=true;
  const updateStatus=t=>{if(status)status.textContent=t;};
  let worker=null;
  try{
    updateStatus('准备识别程序，首次使用需要联网下载…');
    await ensureOcr();
    const input=await prepareImage(importFile);
    const lang=$('#importLang').value==='en-US'?'eng':'chi_sim';
    updateStatus('正在初始化 '+(lang==='eng'?'英文':'中文')+'识别模型…');
    worker=await Tesseract.createWorker(lang,1,{
      logger: m=>{
        if(m.status==='recognizing text')updateStatus(`正在识别文字 ${Math.round((m.progress||0)*100)}%…`);
      }
    });
    const result=await worker.recognize(input);
    const text=result?.data?.text?.trim()||'';
    if(!text){updateStatus('未识别出文字，建议重新拍摄或手动输入。');return;}
    const textarea=$('#importText');
    textarea.value=[textarea.value.trim(),text].filter(Boolean).join('\n');
    updateStatus('识别完成，请逐条核对错字、换行与词语分隔。');
    refreshImportPreview();
    textarea.scrollIntoView({behavior:'smooth',block:'center'});
  }catch(err){console.error(err);updateStatus(`识别失败：${err.message||'未知错误'}。可改为手动输入。`);}
  finally{if(worker)await worker.terminate().catch(()=>{});ocrBusy=false;if(btn)btn.disabled=false;}
}
function downloadBackup(){
  const blob=new Blob([JSON.stringify({version:1,exportedAt:new Date().toISOString(),...db},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`听写小助手备份-${new Date().toISOString().slice(0,10)}.json`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
  toast('备份已生成，请在 iPhone“文件”或浏览器下载中保存。');
}
async function importBackup(file){
  if(!file)return;
  if(file.size>8*1024*1024){toast('备份文件过大，请检查是否选错。');return;}
  try{
    const raw=JSON.parse(await file.text());
    if(!raw||!Array.isArray(raw.banks)||!Array.isArray(raw.groups))throw new Error('文件不符合听写小助手的备份格式');
    const replacement=normalizeDb(raw);
    if(!confirm(`导入会替换当前 ${db.banks.length} 份词库与全部组合，改为备份中的 ${replacement.banks.length} 份。确认继续？`))return;
    stopPlayback(false);db=replacement;selected.clear();source=null;expanded.clear();save();render();toast('备份已恢复。');
  }catch(err){toast('导入失败：'+(err.message||'文件错误'));}
}
function handleAction(button) {
  const action=button.dataset.action;
  const bankId=button.dataset.bank, itemId=button.dataset.item,groupId=button.dataset.group;
  switch(action){
    case 'go-banks':setTab('banks');break;
    case 'open-import':openImport();break;
    case 'import-mode':setImportMode(button.dataset.method);break;
    case 'review-import':startImportReview();break;
    case 'back-to-import':openImport(true);break;
    case 'add-review-row':{if(!importDraft)return;const added={id:uid(),text:'',marks:[]};importDraft.entries.push(added);renderImportReview();$(`[data-review-text="${CSS.escape(added.id)}"]`)?.focus();break;}
    case 'remove-review-row':{if(!importDraft)return;importDraft.entries=importDraft.entries.filter(w=>w.id!==button.dataset.row);renderImportReview();break;}
    case 'toggle-review-marks':{const id=button.dataset.row;importReviewExpanded.has(id)?importReviewExpanded.delete(id):importReviewExpanded.add(id);updateReviewRow(id);break;}
    case 'toggle-review-char':{const id=button.dataset.row;const item=importDraft?.entries.find(w=>w.id===id);if(!item)return;const i=Number(button.dataset.index);if(item.marks.includes(i))item.marks=item.marks.filter(n=>n!==i);else item.marks=[...item.marks,i].sort((a,b)=>a-b);updateReviewRow(id);break;}
    case 'close-modal':closeModal();break;
    case 'save-import':saveImport();break;
    case 'run-ocr':runOcr();break;
    case 'toggle-bank':expanded.has(bankId)?expanded.delete(bankId):expanded.add(bankId);render();break;
    case 'select-bank':{
      const b=getBank(bankId);if(!b)return;
      const all=b.items.every(x=>selected.has(refKey(bankId,x.id)));
      for(const entry of b.items)all?selected.delete(refKey(bankId,entry.id)):selected.add(refKey(bankId,entry.id));
      render();break;
    }
    case 'clear-selection':selected.clear();render();break;
    case 'add-word':openWordEditor(bankId);break;
    case 'edit-word':openWordEditor(bankId,itemId);break;
    case 'toggle-char':{const i=Number(button.dataset.index);editingMarks.has(i)?editingMarks.delete(i):editingMarks.add(i);drawCharGrid();break;}
    case 'save-word':saveWord();break;
    case 'delete-word':{
      const b=getBank(bankId);const w=b?.items.find(x=>x.id===itemId);
      if(!b||!w||!confirm(`从词库中移除“${w.text}”？相关组合也会同步移除该词。`))return;
      b.items=b.items.filter(x=>x.id!==itemId);for(const g of db.groups)g.refs=g.refs.filter(r=>r.bankId!==bankId||r.itemId!==itemId);
      selected.delete(refKey(bankId,itemId));save();render();break;
    }
    case 'rename-bank':openNameEditor('bank',bankId);break;
    case 'rename-group':openNameEditor('group',groupId);break;
    case 'save-name':saveName();break;
    case 'delete-bank':{
      const b=getBank(bankId);if(!b||!confirm(`删除词库“${b.title}”及其 ${b.items.length} 个词语？相关组合引用会被移除。`))return;
      db.banks=db.banks.filter(x=>x.id!==bankId);db.groups.forEach(g=>g.refs=g.refs.filter(r=>r.bankId!==bankId));
      for(const key of selected)if(key.startsWith(bankId+':'))selected.delete(key);
      save();source=null;render();break;
    }
    case 'delete-group':{
      const g=db.groups.find(x=>x.id===groupId);if(!g||!confirm(`删除组合“${g.title}”？原词库不会删除。`))return;
      db.groups=db.groups.filter(x=>x.id!==groupId);save();source=null;render();break;
    }
    case 'create-group':selectedIntoGroup();break;
    case 'append-group':if(!db.groups.length){toast('没有现成组合，请先创建新组合。');selectedIntoGroup();}else selectedIntoGroup(true);break;
    case 'save-group':saveGroup();break;
    case 'view-group':viewGroup(groupId);break;
    case 'remove-group-item':{
      const g=db.groups.find(x=>x.id===groupId);if(!g)return;
      g.refs=g.refs.filter(r=>r.bankId!==bankId||r.itemId!==itemId);save();viewGroup(groupId);break;
    }
    case 'play-group':source={type:'group',id:groupId};setTab('practice');break;
    case 'play-selected':source={type:'selected'};setTab('practice');break;
    case 'start-play':beginPlayback();break;
    case 'stop-play':stopPlayback();break;
    case 'toggle-pause':if(session?.paused)resumePlayback();else pausePlayback();break;
    case 'next-word':jumpWord(1);break;
    case 'prev-word':jumpWord(-1);break;
    case 'replay-word':jumpWord(currentWordIndex(session),true);break;
    case 'toggle-reveal':if(session){session.revealed=!session.revealed;updatePlayer();}break;
    case 'restart-play':stopPlayback(false);beginPlayback();break;
    case 'test-voice':{
      if(!('speechSynthesis' in window)){toast('当前浏览器没有语音能力。');break;}
      const lang=button.dataset.lang;
      speechSynthesis.cancel();speakOnce(lang==='en-US'?'Welcome to the dictation practice.':'你好，现在开始中文听写。',lang,()=>{},()=>toast('试听失败，请尝试系统自动音色。'));break;
    }
    case 'add-demo':addDemo();break;
    case 'export-backup':downloadBackup();break;
    case 'clear-everything':{
      if(!confirm('确定清空所有词库、组合和设置？此操作不能撤销，请先备份。'))return;
      stopPlayback(false);db=normalizeDb(null);selected.clear();source=null;expanded.clear();save();setTab('banks');toast('数据已清空。');break;
    }
  }
}

document.addEventListener('click',event=>{
  const nav=event.target.closest('[data-tab]');if(nav){setTab(nav.dataset.tab);return;}
  const action=event.target.closest('[data-action]');if(action){handleAction(action);return;}
});
$('#quickHelp').addEventListener('click',()=>modal('使用方法',`<ol class="help-list">
  <li><strong>添加词语：</strong>可以直接逐行手动输入、批量粘贴，也可以从课本拍照、相册选图；下一步可逐项检查后保存。</li>
  <li><strong>标拼音：</strong>打开中文词库，点击某个词语的“编辑”，再点亮需要写拼音的汉字。</li>
  <li><strong>做组合：</strong>跨词库勾选多个词语，保存成组合或直接开始听写。</li>
  <li><strong>设置播报：</strong>选顺序/随机、每词报1—5遍、重复间隔、词间等待，再开始播报。</li>
  <li><strong>备份：</strong>定期到“设置”导出 JSON，换手机时导入即可恢复词库。</li></ol><div class="small-note">建议在 Safari 中使用，并保持屏幕常亮。锁屏或后台播报不保证可靠。</div><button class="btn btn-primary btn-wide" data-action="close-modal">知道了</button>`));
document.addEventListener('change',event=>{
  const target=event.target;
  if(target.classList.contains('item-checkbox')){
    const key=refKey(target.dataset.bank,target.dataset.item);
    target.checked?selected.add(key):selected.delete(key);
    render();return;
  }
  if(target.id==='cameraFile'||target.id==='galleryFile'){
    updatePhotoPreview(target.files?.[0]);return;
  }
  if(target.id==='importLang'||target.id==='importSplit'){refreshImportPreview();return;}
  if(target.dataset.reviewText){updateReviewText(target.dataset.reviewText,target.value);refreshReviewChars(target.dataset.reviewText);return;}
  if(target.id==='practiceSource'){
    const val=target.value;
    source=val==='selected'?{type:'selected'}:{type:val.slice(0,val.indexOf(':')),id:val.slice(val.indexOf(':')+1)};
    render();return;
  }
  if(target.id==='backupFile'){importBackup(target.files?.[0]);target.value='';return;}
  const setting=target.name;
  if(Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS,setting)){
    if(setting==='skipDuplicates'||setting==='hideAnswers')db.settings[setting]=target.checked;
    else if(setting==='repetitions')db.settings.repetitions=Number(target.value);
    else if(['rateEn','rateZh','wordGap','repeatGap'].includes(setting))db.settings[setting]=Number(target.value);
    else db.settings[setting]=target.value;
    save();render();
  }
});
document.addEventListener('input',event=>{
  const target=event.target;
  if(target.id==='importText'){refreshImportPreview();return;}
  if(target.dataset.reviewText){updateReviewText(target.dataset.reviewText,target.value);return;}
  if(target.id==='editorText'){
    editingMarks.clear();drawCharGrid();return;
  }
  if(['rateZh','rateEn','wordGap','repeatGap'].includes(target.name)){
    const label=$(`#${target.name}Value`);
    if(label)label.textContent=['rateZh','rateEn'].includes(target.name)?Number(target.value).toFixed(2)+' ×':target.value+' 秒';
  }
});
window.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&!$('#overlay').hidden&&!ocrBusy)closeModal();
});
if('speechSynthesis' in window){
  speechSynthesis.addEventListener?.('voiceschanged',()=>{if(tab==='settings'&&$('#overlay').hidden)render();});
}
if('serviceWorker' in navigator && location.protocol.startsWith('http')){
  navigator.serviceWorker.register('./sw.js').catch(error=>console.warn('Service Worker 注册失败',error));
}
render();
