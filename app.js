import {
  DEFAULT_SETTINGS, uid, parseEntries, normalizeDb, refKey, collectWords,
  getItemsFromRefs, arrangeWords, buildSessionSteps, languageName, graphemes,
  isChineseCharacter, indicesToPrompt, clamp, prepareBankEntries, normalizeTermKey
} from './core.js';
import {clampCrop} from './ocr-utils.js';
import {isNewerVersion} from './version-utils.js';
import {saveMusic, loadMusic, removeMusic} from './audio-store.js';

const STORAGE_KEY = 'dictation-buddy-v0.1-data'; // Keep unchanged across program updates
const APP_VERSION = '0.3.7';
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
let importTargetBankId = null; // null means create a new bank; otherwise append to this bank
let importReviewExpanded = new Set();
let importFileUrl = '';
let crop = {x:.06,y:.06,w:.88,h:.88};
let cropPointer = null;
let confirmedCropBlob = null;
let confirmedCropUrl = '';
let updateState = {latest:null, notes:'', checked:false, checking:false, applying:false, message:'尚未检查更新'};
let applyingUpdate = false;

let ocrBusy = false;
let ocrLoading = null;
let toastTimer = 0;
let audioContext = null;
// Optional music is a local IndexedDB file or a deployed assets/audio/Dir_OP.mp3, Dir_EP.mp3.
// Music is NOT included in the word-bank JSON backup, and never uploaded to a server.
const customMusic = {intro:null, outro:null};
const bundledMusic = {intro:null,outro:null};
let musicPreview = null;
let storedAudioLoaded = false;
function revokeMusic(kind){
  const old=customMusic[kind];
  if(old?.url) URL.revokeObjectURL(old.url);
  customMusic[kind]=null;
}
function currentMusic(kind){return customMusic[kind]||bundledMusic[kind]||null;}
function musicLabel(kind){
  const file=currentMusic(kind);
  if(file) return `${file.name} · ${file.source==='local'?'已保存本机':'随项目发布'}`;
  return '未设置 MP3，将使用原有短提示音';
}
async function loadUserMusic(){
  for(const kind of ['intro','outro']){
    try{
      const record=await loadMusic(kind);
      if(record?.blob){revokeMusic(kind);customMusic[kind]={name:record.name,source:'local',url:URL.createObjectURL(record.blob)};}
    }catch(err){console.warn('本机 MP3 读取失败',kind,err);}
  }
  storedAudioLoaded=true;
  if(tab==='practice'&&!session)render();
}
async function checkBundledMusic(){
  for(const [kind,filename] of [['intro','Dir_OP.mp3'],['outro','Dir_EP.mp3']]){
    const url=new URL(`./assets/audio/${filename}`,import.meta.url).href;
    try {
      const response=await fetch(url,{method:'HEAD',cache:'no-store'});
      if(response.ok && !String(response.headers.get('content-type')||'').includes('text/html')){
        bundledMusic[kind]={name:filename,source:'bundled',url};
      }
    }catch(err){/* Optional audio may not be published yet; original cue remains available. */}
  }
  if(tab==='practice'&&!session)render();
}
async function acceptMusicFile(kind,file){
  if(!file)return;
  try{
    if(!/\.mp3$/i.test(file.name)||!file.size||file.size>15*1024*1024)throw new Error('请选用不超过 15MB 的 MP3 文件。');
    const record=await saveMusic(kind,file);
    revokeMusic(kind);
    customMusic[kind]={name:record.name,source:'local',url:URL.createObjectURL(record.blob)};
    toast(`已保存${kind==='intro'?'开始':'结束'}音乐：${record.name}`);
  }catch(err){toast(`无法保存音乐：${err.message}。本机文件存储失败时，请尝试用电脑把 Dir_OP.mp3 和 Dir_EP.mp3 放入 assets/audio。`);}
  if(tab==='practice'&&!session)render();
}
async function clearMusicFile(kind){
  if(musicPreview){musicPreview.pause();musicPreview=null;}
  try{await removeMusic(kind);revokeMusic(kind);toast('已移除本机音乐，改用随项目发布的 MP3 或原有提示音。');}
  catch(err){toast('移除音乐失败：'+err.message);}
  if(tab==='practice'&&!session)render();
}


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
  $('#modalActionBar').hidden = true;
  $('#modalActionBar').innerHTML = '';
  document.body.style.overflow = 'hidden';
}
function closeModal() {
  if (ocrBusy) {toast('图片正在识别，完成后再关闭。'); return;}
  $('#overlay').hidden = true;
  $('#overlay').setAttribute('aria-hidden', 'true');
  $('#modalBody').innerHTML = '';
  $('#modalActionBar').innerHTML = '';
  $('#modalActionBar').hidden = true;
  document.body.style.overflow = '';
  importFile = null;
  importDraft = null;
  importTargetBankId = null;
  importReviewExpanded.clear();
  if (importFileUrl) { URL.revokeObjectURL(importFileUrl); importFileUrl = ''; }
  cropPointer=null;
  clearConfirmedCrop();

  editorContext = null;
}
function setTab(next) {
  if (session && next !== 'practice') stopPlayback();
  tab = next;
  window.scrollTo({top:0,behavior:'instant'});
  render();
  if(next==='settings' && !updateState.checked && !updateState.checking) void checkForUpdate();
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
  let html = `<div class="page-header"><div><div class="eyebrow">WORD LIBRARY</div><h1 class="page-title">我的词库</h1><p class="page-description">既能新建词库，也能在已有词库中用拍照或手动输入继续添加。</p></div><button type="button" class="btn btn-primary" data-action="open-import">＋ 导入</button></div>
    <div class="stats"><div class="stat"><strong>${db.banks.length}</strong><span>份词库</span></div><div class="stat"><strong>${totalWords()}</strong><span>个词语</span></div><div class="stat"><strong>${db.groups.length}</strong><span>个组合</span></div></div>`;
  if (!db.banks.length) return html+`<div class="empty"><div class="empty-symbol">▦</div><h3>从第一份词库开始</h3><p>拍课本、练习册或默写清单，也可以直接粘贴词语。</p><div class="action-row" style="justify-content:center"><button class="btn btn-primary" data-action="open-import">创建词库</button><button class="btn" data-action="add-demo">体验示例</button></div></div>`;
  html += `<div class="section-title">词库列表 · ${db.banks.length} 份</div>`;
  for (const bank of db.banks) {
    const isOpen=expanded.has(bank.id);
    const selectedCount=bank.items.filter(item=>selected.has(refKey(bank.id,item.id))).length;
    html += `<article class="card"><div class="card-head"><div style="min-width:0;flex:1"><h2 class="card-title">${esc(bank.title)}</h2><div class="subtext"><span class="badge">${languageName(bank.lang)}</span>${bank.items.length} 个词语${selectedCount?` · 已选 ${selectedCount}`:''}</div></div><button class="btn btn-small btn-subtle" data-action="toggle-bank" data-bank="${esc(bank.id)}">${isOpen?'收起':'展开'}</button></div>
    <div class="bank-add-actions" aria-label="向${esc(bank.title)}添加词语"><button class="btn bank-add-btn" data-action="add-words-manual" data-bank="${esc(bank.id)}">⌨ 手动输入添加</button><button class="btn bank-add-btn" data-action="add-words-photo" data-bank="${esc(bank.id)}">▧ 拍照识别添加</button></div>
    <div class="bank-actions"><button class="btn btn-small" data-action="select-bank" data-bank="${esc(bank.id)}">${selectedCount===bank.items.length&&bank.items.length?'取消全选':'全选词语'}</button><button class="btn btn-small btn-ghost" data-action="rename-bank" data-bank="${esc(bank.id)}">重命名</button><span class="spacer"></span><button class="text-button danger" data-action="delete-bank" data-bank="${esc(bank.id)}">删除</button></div>`;
    if (isOpen) {
      html+=`<div class="bank-body">`;
      if(!bank.items.length) html+=`<div class="hint">没有词语，点击上方“手动输入添加”或“拍照识别添加”。</div>`;
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
function repsChoice() {return `<div class="option-grid settings-count">${[1,2,3,4,5].map(i=>`<label class="choice setting-count-option"><input type="radio" name="repetitions" value="${i}" ${db.settings.repetitions===i?'checked':''}><strong>${i} 遍</strong></label>`).join('')}</div>`;}
function settingsMini() {
  return `<section class="setting-panel"><h3 class="focus-heading">听写播报设置</h3><p class="subtext">开始后会自动播完本次范围内的所有词语，无需逐词点击。</p>
  <div class="setting-focus"><div class="setting-focus-name"><strong>① 每个词语重复几遍</strong><small>例如“苹果”读 2 遍</small></div>${repsChoice()}</div>
  <div class="setting-focus"><div class="setting-focus-name"><strong>② 同一个词语的重复间隔</strong><small>两遍“苹果”之间停顿多久</small></div>
    <div class="range-title"><span>重复间隔</span><strong id="repeatGapValue">${db.settings.repeatGap} 秒</strong></div><input aria-label="同一个词语的重复间隔" type="range" name="repeatGap" min="0" max="5" step=".5" value="${db.settings.repeatGap}"></div>
  <div class="setting-focus"><div class="setting-focus-name"><strong>③ 不同词语之间的书写时间</strong><small>上一个词全部读完（包含拼音提示）后，等多久再读下一个词</small></div>
    <div class="range-title"><span>书写时间</span><strong id="wordGapValue">${db.settings.wordGap} 秒</strong></div>
    <input aria-label="不同词语之间的书写时间" type="range" name="wordGap" min="1" max="30" step="1" value="${db.settings.wordGap}">
    <div class="option-grid writing-presets">${[3,5,8,10].map(n=>`<button type="button" class="btn ${db.settings.wordGap===n?'btn-subtle':'btn-secondary'}" data-action="set-word-gap" data-seconds="${n}" aria-pressed="${db.settings.wordGap===n}">${n} 秒</button>`).join('')}</div></div>
  <div class="setting-focus"><div class="setting-focus-name"><strong>④ 播放顺序</strong></div>${orderRadio()}</div>
  <div class="action-row"><label class="choice" style="flex:1"><input type="checkbox" name="skipDuplicates" ${db.settings.skipDuplicates?'checked':''}>合并重复词语</label><label class="choice" style="flex:1"><input type="checkbox" name="hideAnswers" ${db.settings.hideAnswers?'checked':''}>默认隐藏答案</label></div>
  </section>`;
}
function voiceFineTunePanel() {
  const a=db.settings;
  return `<section class="setting-panel" id="voiceTunePanel">
    <h3 class="focus-heading">⑤ 发音选择与清晰度微调</h3>
    <p class="subtext">先试听再选音色；中文和英文分别调整，修改后自动保存。优先推荐较慢、自然的读音。</p>
    <div class="action-row tune-presets"><button type="button" class="btn btn-subtle" data-action="voice-preset" data-preset="clear">清晰慢速（推荐）</button><button type="button" class="btn" data-action="voice-preset" data-preset="natural">自然速度</button></div>
    <label class="field"><span>中文音色（${availableVoiceCount('zh-CN')} 种可选）</span><select name="zhVoice">${voiceOptions('zh-CN',a.zhVoice)}</select></label>
    <p class="setting-help">以下列出 Safari 实际提供的中文声音（含普通话、台湾国语、粤语），不是云端音色库。建议优先选普通话 zh-CN。选择某声线后可直接试听并保存。</p>
    <details class="voice-gallery-details" open><summary>展开中文音色逐个试听（${availableVoiceCount('zh-CN')} 种）</summary>
      <div class="voice-gallery">${voiceGallery()}</div>
    </details>
    <label class="field"><span>中文试听词语</span><input type="text" id="zhTestText" value="崎岖，震耳欲聋，失魂落魄。" maxlength="80" placeholder="可以输入难读的词进行试听"></label>
    <label class="field"><span>中文语速</span><div class="range-title"><span>0.75—0.85× 建议区间</span><strong id="rateZhValue">${a.rateZh.toFixed(2)} ×</strong></div><input type="range" name="rateZh" min=".55" max="1.2" step=".05" value="${a.rateZh}"></label>
    <label class="field"><span>英语音色</span><select name="enVoice">${voiceOptions('en-US',a.enVoice)}</select></label>
    <label class="field"><span>英语语速</span><div class="range-title"><span>0.70—0.85× 建议区间</span><strong id="rateEnValue">${a.rateEn.toFixed(2)} ×</strong></div><input type="range" name="rateEn" min=".55" max="1.2" step=".05" value="${a.rateEn}"></label>
    <div class="action-row"><button class="btn btn-subtle" data-action="test-voice" data-lang="zh-CN">▶ 试听中文</button><button class="btn btn-subtle" data-action="test-voice" data-lang="en-US">▶ 试听英文</button><button class="btn" data-action="refresh-voices">刷新音色列表</button></div>
    <details class="fine-details"><summary>微调音高、音量</summary>
      <label class="field"><span>中文音高</span><div class="range-title"><span>建议接近 1.00</span><strong id="pitchZhValue">${a.pitchZh.toFixed(2)}</strong></div><input type="range" name="pitchZh" min=".85" max="1.15" step=".05" value="${a.pitchZh}"></label>
      <label class="field"><span>英语音高</span><div class="range-title"><span>建议接近 1.00</span><strong id="pitchEnValue">${a.pitchEn.toFixed(2)}</strong></div><input type="range" name="pitchEn" min=".85" max="1.15" step=".05" value="${a.pitchEn}"></label>
      <label class="field"><span>语音音量</span><div class="range-title"><span>语音音量</span><strong id="voiceVolumeValue">${Math.round(a.voiceVolume*100)}%</strong></div><input type="range" name="voiceVolume" min=".2" max="1" step=".05" value="${a.voiceVolume}"></label>
    </details>
    <p class="setting-help">音色取自当前设备。iPhone 未安装的音色不会出现在列表中；音高和速度能调节，但不能把普通音色变成专业录音。</p>
  </section>`;
}
function ceremonyPanel() {
  const a=db.settings;
  return `<section class="setting-panel" id="ceremonyPanel"><h3 class="focus-heading">⑥ 开始与结束音乐</h3>
    <p class="subtext"><strong>顺序：先完整播放音乐，再朗读提示语。</strong>开场：Dir_OP.mp3 → “现在开始听写” → 第一个词；收尾：Dir_EP.mp3 → “本次听写已完成”。</p>
    <label class="choice cue-choice"><input type="checkbox" name="introCue" ${a.introCue?'checked':''}>播放开始音乐和开始语音</label>
    <div class="music-picker"><div class="music-name"><strong>开始音乐 · Dir_OP.mp3</strong><small>${esc(musicLabel('intro'))}</small></div>
      <label class="btn btn-small" for="introMusicFile">选择 MP3 文件<input class="visually-hidden-file" id="introMusicFile" type="file" accept="audio/mpeg,.mp3"></label>
      <button type="button" class="btn btn-small" data-action="test-music" data-kind="intro">▶ 试听开始音乐</button>
      ${customMusic.intro?'<button type="button" class="btn btn-small btn-subtle" data-action="clear-music" data-kind="intro">移除本机音乐</button>':''}</div>
    <label class="choice cue-choice"><input type="checkbox" name="outroCue" ${a.outroCue?'checked':''}>播放结束音乐和完成语音</label>
    <div class="music-picker"><div class="music-name"><strong>结束音乐 · Dir_EP.mp3</strong><small>${esc(musicLabel('outro'))}</small></div>
      <label class="btn btn-small" for="outroMusicFile">选择 MP3 文件<input class="visually-hidden-file" id="outroMusicFile" type="file" accept="audio/mpeg,.mp3"></label>
      <button type="button" class="btn btn-small" data-action="test-music" data-kind="outro">▶ 试听结束音乐</button>
      ${customMusic.outro?'<button type="button" class="btn btn-small btn-subtle" data-action="clear-music" data-kind="outro">移除本机音乐</button>':''}</div>
    <div class="range-title"><span>提示音乐音量</span><strong id="jingleVolumeValue">${Math.round(a.jingleVolume*100)}%</strong></div>
    <input aria-label="提示音乐音量" type="range" name="jingleVolume" min="0" max=".8" step=".05" value="${a.jingleVolume}">
    <p class="setting-help">手机选入的 MP3 会尝试保存在当前设备中，换手机需重新选择。也可由电脑把真实 Dir_OP.mp3、Dir_EP.mp3 上传到 GitHub 仓库的 assets/audio/ 目录，让所有设备自动使用。当前版本没有内置你尚未上传的那两个文件。</p>
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
  html+=voiceFineTunePanel()+ceremonyPanel();
  html+=`<button class="btn btn-primary btn-wide" style="min-height:56px;font-size:16px" data-action="start-play" ${words.length?'':'disabled'}>▶ 开始播报 ${words.length} 个词语</button><div class="small-note">点击开始后先播放提示音并宣布开始。首次播放需要点击按钮授权声音。请把 iPhone 保持亮屏、网页保持前台，语音效果受系统可用音色影响。</div>`;
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
  const meta=completed?'本轮听写已完成':step?.phase==='intro'?'开场提示 · 即将开始':step?.phase==='outro'?'结束提示 · 即将完成':step?.phase==='pinyin'?'正在提示写拼音':step?.phase==='word'?`本词第 ${step.rep} / ${step.reps} 遍`:'等待下一次播报';
  const title=completed?'全部完成':step?.phase==='intro'?'准备开始':step?.phase==='outro'?'收尾提示':s.revealed?esc(item?.text):Array.from(item?.text??'').map(ch=>/\s/.test(ch)?'&nbsp;':'●').join('');
  const progress=completed?100:step?.phase==='outro'?99:Math.round((idx/s.words.length)*100);
  return `<div class="page-header"><div><div class="eyebrow">NOW PLAYING</div><h1 class="page-title">${completed?'听写结束':'正在听写'}</h1><p class="page-description">${esc(s.sourceName)}</p></div><button class="btn btn-small" data-action="stop-play">结束</button></div>
  <div class="play-card"><div class="play-kicker">${completed?'完成':'第 '+(idx+1)+' / '+s.words.length+' 个词语'} · ${item?languageName(item.lang):''}</div><div class="play-title">${title}</div><div class="play-meta">${meta}</div><div class="tiny-progress"><div style="width:${progress}%"></div></div>
  <div class="play-actions"><button class="btn" data-action="prev-word" ${completed?'disabled':''}>↶ 上一个</button><button class="btn btn-primary" data-action="toggle-pause">${completed?'✓ 已完成':s.paused?'▶ 继续':'Ⅱ 暂停'}</button><button class="btn" data-action="next-word" ${completed?'disabled':''}>下一个 ↷</button></div><div class="play-footer"><span>${completed?'':(item?.marks.length?'本词含拼音提示':'请认真听写')}</span><span>${completed?s.words.length:idx+1} / ${s.words.length}</span></div></div>
  <div class="action-row"><button class="btn" data-action="replay-word" ${completed?'disabled':''}>↻ 重听当前词</button><button class="btn" data-action="toggle-reveal" ${completed?'disabled':''}>${s.revealed?'隐藏词语':'显示词语'}</button>${completed?'<button class="btn btn-primary" data-action="restart-play">再来一轮</button>':''}</div>
  <div class="small-note">“暂停”会取消正在朗读的一小段，“继续”将重新朗读该段，以免漏词；上一词/下一词按词跳转。${completed?'可返回词库重新组合练习。':''}</div>`;
}
function voicesFor(lang){
  if(!('speechSynthesis' in window))return [];
  const prefix=lang==='zh-CN'?'zh':'en';
  return speechSynthesis.getVoices().filter(v=>v.lang.toLowerCase().startsWith(prefix))
    .sort((a,b)=>{
      const target=lang.toLowerCase();
      const aRank=a.lang.toLowerCase()===target?0:1;
      const bRank=b.lang.toLowerCase()===target?0:1;
      return aRank-bRank || a.name.localeCompare(b.name);
    });
}
function availableVoiceCount(lang){return voicesFor(lang).length;}
function voiceGallery(){
  const voices=voicesFor('zh-CN');
  if(!voices.length)return '<p class="setting-help">当前浏览器尚未报告中文音色。点下方“刷新音色列表”或在 Safari 中重开页面。</p>';
  return voices.map((v,i)=>{
    const chosen=v.voiceURI===db.settings.zhVoice;
    const dialect=v.lang.toLowerCase().startsWith('zh-hk')?'粤语':v.lang.toLowerCase().startsWith('zh-tw')?'台湾国语':'普通话';
    return `<div class="voice-gallery-item"><div class="voice-gallery-name"><strong>${i+1}. ${esc(v.name)}</strong><small>${esc(v.lang)} · ${dialect}${chosen?' · 已选':''}</small></div><button type="button" class="btn btn-small" data-action="audition-voice" data-voice="${esc(v.voiceURI)}">试听</button><button type="button" class="btn btn-small ${chosen?'btn-subtle':''}" data-action="pick-voice" data-voice="${esc(v.voiceURI)}">${chosen?'已选择':'选用'}</button></div>`;
  }).join('');
}
function voiceOptions(lang,chosen){
  if(!('speechSynthesis' in window))return '<option value="">当前浏览器不支持语音</option>';
  const voices=voicesFor(lang);
  const unknown=chosen&&!voices.some(v=>v.voiceURI===chosen)?`<option value="${esc(chosen)}" selected disabled>原选音色当前不可用，请重新选择</option>`:'';
  const options=voices.map((v,i)=>`<option value="${esc(v.voiceURI)}" ${v.voiceURI===chosen?'selected':''}>${i+1}. ${esc(v.name)} · ${esc(v.lang)}${v.localService?' · 本机':''}</option>`).join('');
  return `<option value="">系统自动选择</option>${unknown}${options}`;
}

function updatePanelHtml(){
  const ready=updateState.latest && isNewerVersion(updateState.latest,APP_VERSION);
  const label=updateState.message || '尚未检查更新';
  return `<div class="card-head"><div><h3 style="margin:0 0 6px">应用版本与更新</h3><div class="subtext">当前版本：<strong>V${APP_VERSION}</strong></div></div><span class="badge">PWA</span></div>
    <p class="update-status" role="status">${esc(label)}</p>
    ${ready && updateState.notes ? `<p class="subtext">新版说明：${esc(updateState.notes)}</p>` : ''}
    <div class="action-row"><button type="button" class="btn ${ready?'btn-subtle':'btn-primary'}" data-action="check-update" ${updateState.checking||updateState.applying?'disabled':''}>${updateState.checking?'检查中…':'检查更新'}</button>
    ${ready?`<button type="button" class="btn btn-primary" data-action="apply-update" ${updateState.checking||updateState.applying?'disabled':''}>${updateState.applying?'正在更新…':'立即更新到 V'+esc(updateState.latest)}</button>`:''}</div>
    <div class="setting-help">新版需先发布到 GitHub Pages。更新仅替换程序文件，不会主动清空本地词库；更新前仍建议导出 JSON 备份。需要联网。</div>`;
}
function refreshUpdatePanel(){
  const panel=$('#appUpdatePanel');if(panel)panel.innerHTML=updatePanelHtml();
}
async function registrationForUpdate(){
  if(!('serviceWorker' in navigator))return null;
  let reg=await navigator.serviceWorker.getRegistration('./');
  if(!reg) reg=await navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'});
  return reg;
}
async function checkForUpdate(){
  if(updateState.checking||updateState.applying)return;
  updateState.checking=true;updateState.message='正在联网检查 GitHub Pages 上的最新版本…';refreshUpdatePanel();
  try{
    const url=new URL('./version.json',window.location.href);
    url.searchParams.set('t',String(Date.now())); // The old service worker must not serve a cached version manifest.
    const response=await fetch(url.href,{cache:'no-store'});
    if(!response.ok)throw new Error('更新清单未发布（HTTP '+response.status+'）');
    const info=await response.json();
    if(!/^\d+\.\d+\.\d+$/.test(info?.version||'')) throw new Error('远端版本清单格式不正确');
    updateState.latest=info.version;
    updateState.notes=typeof info.notes==='string'?info.notes.slice(0,240):'';
    updateState.checked=true;
    if(isNewerVersion(info.version,APP_VERSION)){
      const reg=await registrationForUpdate();
      await reg?.update();
      updateState.message='发现新版本 V'+info.version+'，可点击「立即更新」。';
    }else{
      updateState.message='当前已是最新版本 V'+APP_VERSION+'。';
    }
  }catch(error){
    updateState.message='检查失败：'+(error.message||'网络不可用')+'。请确认已经部署 version.json 并联网重试。';
  }finally{updateState.checking=false;refreshUpdatePanel();}
}
function waitForWorkerInstalled(reg,timeoutMs=12000){
  return new Promise(resolve=>{
    if(reg.waiting){resolve(reg.waiting);return;}
    const worker=reg.installing;
    if(!worker){resolve(null);return;}
    let done=false;
    const finish=result=>{if(done)return;done=true;clearTimeout(timer);worker.removeEventListener('statechange',onState);resolve(result);};
    const onState=()=>{
      if(reg.waiting)finish(reg.waiting);
      else if(worker.state==='activated')finish(null);
      else if(worker.state==='redundant')finish(null);
      // A fresh SW may install and immediately activate; wait for activation before reloading.
    };
    const timer=setTimeout(()=>finish(null),timeoutMs);
    worker.addEventListener('statechange',onState);
    onState();
  });
}
async function applyAvailableUpdate(){
  if(updateState.applying||!updateState.latest||!isNewerVersion(updateState.latest,APP_VERSION))return;
  updateState.applying=true;updateState.message='正在获取新版程序，请保持网络连接…';refreshUpdatePanel();
  try{
    const reg=await registrationForUpdate();
    if(!reg){updateState.message='浏览器未启用离线更新机制，尝试重新打开最新版网页。';window.location.reload();return;}
    await reg.update();
    const waiting=await waitForWorkerInstalled(reg);
    if(waiting){
      applyingUpdate=true;
      updateState.message='已获取新版，正在切换程序…';refreshUpdatePanel();
      const reload=()=>{if(!applyingUpdate)return;applyingUpdate=false;const next=new URL('./',location.href);next.searchParams.set('updated',String(Date.now()));location.replace(next.href);};
      navigator.serviceWorker.addEventListener('controllerchange',reload,{once:true});
      waiting.postMessage({type:'SKIP_WAITING'});
      // Fallback for iOS versions that do not dispatch controllerchange reliably.
      setTimeout(reload,3500);
      return;
    }
    // A newly activated service worker may have taken control automatically.
    updateState.message='正在重新载入新版程序…';refreshUpdatePanel();
    const next=new URL('./',location.href);next.searchParams.set('updated',String(Date.now()));location.replace(next.href);
  }catch(err){
    updateState.message='更新未完成：'+(err.message||'网络错误')+'。旧版仍可继续使用。';
    updateState.applying=false;refreshUpdatePanel();
  }
}
function renderSettings() {
  return `<div class="page-header"><div><div class="eyebrow">PREFERENCES & DATA</div><h1 class="page-title">设置与备份</h1><p class="page-description">调整声音风格、保护词库，方便长期使用。</p></div></div>
  <section class="setting-panel" id="appUpdatePanel">${updatePanelHtml()}</section>
  <section class="setting-panel"><h3>发音设置</h3><p class="subtext">中文、英文的音色、语速、音高、音量，以及开场和结束音乐，现在直接放在「听写」页面开始按钮上方，方便边试听边调整。</p><button type="button" class="btn btn-subtle" data-action="go-practice">去听写页调整</button></section>
  <section class="setting-panel"><h3>词库数据</h3><p class="subtext">当前 ${db.banks.length} 份词库，${totalWords()} 个词语，${db.groups.length} 个组合。数据只存当前浏览器，不会自动同步到其他设备。</p>
  <div class="action-row"><button class="btn btn-primary" data-action="export-backup">导出 JSON 备份</button><label class="btn" for="backupFile">导入 JSON 备份</label><input type="file" id="backupFile" accept="application/json,.json" class="visually-hidden-file"></div>
  <div class="small-note warning-note">Safari 清理网站数据、删除主屏幕应用，或更换设备时，词库可能丢失。建议每周导出备份。导入备份会替换当前所有词库与组合。</div></section>
  <section class="setting-panel"><h3>离线与播报说明</h3><p class="subtext">手动录入、词库与基础播报无需云端账号；印刷体本机 OCR 首次使用需要联网加载语言模型。手写体请使用 iPhone「照片」实况文本复制或手动输入。</p><p class="subtext">iOS 锁屏、切出应用或语音引擎被系统中断，可能停止播报；建议亮屏使用。</p></section>
  <section class="setting-panel"><h3>快速试用</h3><div class="action-row"><button class="btn" data-action="add-demo">新增示例词库</button><button class="btn btn-danger" data-action="clear-everything">清空全部数据</button></div></section>`;
}

function openImport(restore = false, targetBankId = null, preferredMode = 'manual') {
  if(!restore) {
    importTargetBankId = targetBankId;
    importDraft = null;
    importMode = preferredMode === 'photo' ? 'photo' : 'manual';
  }
  const targetBank = importTargetBankId ? getBank(importTargetBankId) : null;
  if(importTargetBankId && !targetBank) {toast('目标词库不存在，请返回词库列表重新选择。');return;}
  const old = restore ? importDraft : null;
  const title = targetBank ? '向已有词库添加词语' : '创建词库 · 添加词语';
  modal(title, `
  ${targetBank ? `<div class="review-summary"><strong>添加至：${esc(targetBank.title)}</strong><span class="badge">${languageName(targetBank.lang)}</span><div class="hint">已有 ${targetBank.items.length} 个词语，新词会追加到这里，不覆盖已有内容，重复项自动跳过。</div></div><input type="hidden" id="importLang" value="${targetBank.lang}">` : `<label class="field"><span>词库名称</span><input id="importName" placeholder="例如：五年级第12课 / PET Unit 3" value="${esc(old?.name || '听写 · '+new Date().toLocaleDateString('zh-CN'))}" maxlength="80"></label>
  <label class="field"><span>词语语言</span><select id="importLang"><option value="zh-CN" ${(old?.lang||'zh-CN')==='zh-CN'?'selected':''}>中文</option><option value="en-US" ${old?.lang==='en-US'?'selected':''}>英文</option></select></label>`}
  <div class="field"><span>选择添加方式</span><div class="import-methods" role="group" aria-label="添加方式">
    <button type="button" class="import-method ${importMode==='manual'?'active':''}" data-action="import-mode" data-method="manual" aria-pressed="${importMode==='manual'}"><span class="method-symbol">⌨</span><span>手动输入<small>单词、词组或批量粘贴</small></span></button>
    <button type="button" class="import-method ${importMode==='photo'?'active':''}" data-action="import-mode" data-method="photo" aria-pressed="${importMode==='photo'}"><span class="method-symbol">▧</span><span>拍照识别<small>拍课本、相册选图</small></span></button>
  </div></div>
  <section class="import-primary-zone" id="manualImportPanel"><label class="field"><span>⌨ ${importMode==='manual'?'直接输入 / 粘贴词语':'照片识别结果 / 手动补充'}</span><textarea id="importText" rows="5" placeholder="例如：苹果 香蕉 葡萄\n或者每行一个词语">${esc(old?.entries.map(x=>x.text).join('\n') || '')}</textarea></label><div class="manual-import-tip">中文空格、换行、逗号自动切分；英文短语保留空格。输入后点击下面的「核对并保存」。</div></section>
  <section id="photoImportPanel" ${importMode==='photo'?'':'hidden'}>
    <div class="field"><span>拍照或从相册选择图片</span><div class="action-row"><label class="btn btn-subtle" for="cameraFile">📷 拍照</label><input type="file" id="cameraFile" accept="image/*" capture="environment" class="visually-hidden-file"><label class="btn" for="galleryFile">▧ 相册选取</label><input type="file" id="galleryFile" accept="image/*" class="visually-hidden-file"></div></div>
    <div class="ocr-service-alert">本版不需要注册任何云服务。照片框选后可尝试<strong>印刷体识别</strong>；<strong>手写体暂不保证识别</strong>。手写照片请优先通过 iPhone「照片」的实况文本复制，再粘贴到上方输入框。</div>
    <div class="action-row"><button type="button" class="btn" data-action="paste-live-text">粘贴 iPhone 实况文本</button></div>
    <div class="hint">在 iPhone「照片」中长按文字并复制，再返回此处粘贴；也可直接手动录入。实况文本不保证能正确读取所有手写字。</div>
    <div id="photoHolder"></div>
    <div id="ocrStatus" class="ocr-status" role="status">先拍照或选图，拖动蓝框选择印刷文字，再确认选区。无需云端服务。</div>
    <small class="hint">识别结果需要人工核对；不要把姓名等隐私信息放进框选区域。</small>
  </section>
  <label class="field"><span>拆分方式</span><select id="importSplit"><option value="auto" selected>自动识别分隔（推荐：中文空格自动切分，英文保留短语）</option><option value="line">严格按行（一个整行作为词语）</option><option value="punct">按换行、逗号、顿号、分号拆分</option><option value="spaces">按空格、换行及标点拆分</option></select></label>
  <div class="small-note" id="importPreview">输入后会显示词语数量和部分预览。</div>
  <button class="btn btn-primary btn-wide" data-action="review-import">下一步 · 核对词语和拼音标记</button>`);
  if(importFile && importFileUrl) drawPhotoHolder();
  updateCropActionBar();
  refreshImportPreview();
}
function setImportMode(mode) {
  importMode=mode==='photo'?'photo':'manual';
  $$('.import-method').forEach(btn=>{
    const active=btn.dataset.method===importMode;
    btn.classList.toggle('active',active);btn.setAttribute('aria-pressed',String(active));
  });
  const label=$('#manualImportPanel .field>span');
  if(label)label.textContent=importMode==='manual'?'⌨ 直接输入 / 粘贴词语':'照片识别结果 / 手动补充';
  $('#photoImportPanel').hidden=importMode!=='photo';
  updateCropActionBar();
  if(importMode==='manual'){const input=$('#importText');input?.scrollIntoView({block:'center',behavior:'instant'});input?.focus({preventScroll:true});}
}
function refreshImportPreview() {
  const raw=$('#importText')?.value ?? '';
  const entries=parseEntries(raw,$('#importLang')?.value,$('#importSplit')?.value);
  const target=$('#importPreview');
  if(target) target.innerHTML=entries.length?`当前 <strong>${entries.length}</strong> 个不重复词语。预览：${entries.slice(0,7).map(x=>`<span class="label-chip">${esc(x.text)}</span>`).join('')}${entries.length>7?' …':''}`:'请先选择手动输入或拍照识别，添加至少一个词语。';
}
function startImportReview() {
  const targetBank = importTargetBankId ? getBank(importTargetBankId) : null;
  if(importTargetBankId && !targetBank){toast('目标词库已被删除。');return;}
  const name=targetBank?.title ?? $('#importName')?.value.trim();
  const lang=targetBank?.lang ?? $('#importLang')?.value;
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
  importDraft={name,lang,entries,targetBankId:importTargetBankId};
  importReviewExpanded.clear();
  renderImportReview();
}
function renderImportReview() {
  const draft=importDraft;if(!draft)return;
  const targetBank=draft.targetBankId?getBank(draft.targetBankId):null;
  const existingKeys=new Set((targetBank?.items||[]).map(x=>normalizeTermKey(x.text)));
  const previouslyAdded=draft.entries.filter(x=>existingKeys.has(normalizeTermKey(x.text))).length;
  modal('逐条核对 · 保存前可修改',`<div class="review-summary"><strong>${esc(draft.name)}</strong><span class="badge">${languageName(draft.lang)}</span><div class="hint">共 <strong>${draft.entries.length}</strong> 项。可改字、删除或标拼音。${targetBank?`已有相同词语 ${previouslyAdded} 项，保存时自动跳过；已有词语及组合不受影响。`:''}</div></div>
  <div id="importReviewList" class="review-list">${draft.entries.map((item,i)=>renderReviewItem(item,i,draft.lang)).join('')}</div>
  <div class="action-row" style="margin:10px 0 13px"><button class="btn btn-small btn-subtle" data-action="add-review-row">＋ 补充一个</button><button class="btn btn-small" data-action="dedupe-review">一键去重</button></div>
  <div class="action-row"><button class="btn" data-action="back-to-import">返回输入</button><button class="btn btn-primary" style="flex:1" data-action="save-import">${targetBank?'确认添加到当前词库':'确认并保存词库'}</button></div>`);
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
function dedupeImportReview() {
  if(!importDraft)return;
  const seen=new Set();
  const bank=importDraft.targetBankId?getBank(importDraft.targetBankId):null;
  for(const item of bank?.items||[])seen.add(normalizeTermKey(item.text));
  const before=importDraft.entries.length;
  importDraft.entries=importDraft.entries.filter(item=>{
    const key=normalizeTermKey(item.text);
    if(!key||seen.has(key))return false;
    seen.add(key);return true;
  });
  renderImportReview();
  toast(`已清理 ${before-importDraft.entries.length} 项空白或重复词语。`);
}
function saveImport() {
  const draft=importDraft;if(!draft)return;
  const targetBank=draft.targetBankId?getBank(draft.targetBankId):null;
  if(draft.targetBankId&&!targetBank){toast('目标词库已不存在，无法保存。');return;}
  const {items,skipped}=prepareBankEntries(draft.entries,draft.lang,targetBank?.items||[]);
  if(!items.length){toast(skipped?'没有需要新增的词语：全部已在词库中或重复。':'请至少保留一个词语。');return;}
  if(targetBank){
    targetBank.items.push(...items);
    expanded.add(targetBank.id);
    save();closeModal();tab='banks';render();
    toast(`已向「${targetBank.title}」添加 ${items.length} 个词语${skipped?`，跳过 ${skipped} 个重复项`:''}。`);
  }else{
    const bank={id:uid(),title:draft.name,lang:draft.lang,createdAt:Date.now(),items};
    db.banks.unshift(bank);
    expanded.add(bank.id);
    save();closeModal();tab='banks';render();
    toast(`已保存 ${items.length} 个词语${skipped?`，去除 ${skipped} 个重复项`:''}。`);
  }
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
  session={words,steps:buildSessionSteps(words,db.settings),stepIndex:0,paused:false,finished:false,revealed:!db.settings.hideAnswers,playToken:0,timer:0,watchdog:0,sourceName:sourceLabel(sourceToUse),musicPlayer:new Audio()};
  // Start audio context from the actual tap; on iPhone user interaction is required.
  if(db.settings.introCue || db.settings.outroCue) ensureAudioContext();
  render();
  executeStep(); // Called directly from a tap.
}
function cancelCue(s){
  if(!s) return;
  if(s.musicPlayer){
    s.musicPlayer.onended=null;s.musicPlayer.onerror=null;
    try{s.musicPlayer.pause();s.musicPlayer.currentTime=0;}catch{}
  }
  for(const node of s.cueNodes||[])try{node.stop()}catch{}
  s.cueNodes=[];
}
function cancelTimers(s){if(!s)return;clearTimeout(s.timer);clearTimeout(s.watchdog);s.timer=0;s.watchdog=0;cancelCue(s);}
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
// Short, original, instrumental cue: generated locally, no copyrighted audio or network file.
function ensureAudioContext(){
  try {
    if(!audioContext){const Class=window.AudioContext||window.webkitAudioContext;if(!Class)return null;audioContext=new Class();}
    if(audioContext.state==='suspended') void audioContext.resume().catch(()=>{});
    return audioContext;
  } catch(err){console.warn('提示音不可用',err);return null;}
}
function playOriginalCue(s,kind,onDone){
  const ctx=ensureAudioContext();
  const notes=kind==='intro'?[523.25,659.25,783.99,1046.50]:[783.99,659.25,587.33,523.25];
  const volume=Math.max(0,Math.min(.8,db.settings.jingleVolume??.38));
  if(ctx && volume>0){
    const t0=ctx.currentTime+.035;s.cueNodes=[];
    for(let i=0;i<notes.length;i++){
      const start=t0+i*.275;
      const osc=ctx.createOscillator(),amp=ctx.createGain();
      osc.type='sine';osc.frequency.setValueAtTime(notes[i],start);
      amp.gain.setValueAtTime(.0001,start);
      amp.gain.exponentialRampToValueAtTime(Math.max(.001,volume*.22),start+.027);
      amp.gain.exponentialRampToValueAtTime(.0001,start+.245);
      osc.connect(amp);amp.connect(ctx.destination);osc.start(start);osc.stop(start+.252);
      s.cueNodes.push(osc);
    }
  }
  s.timer=setTimeout(()=>{s.cueNodes=[];onDone();},1300);
}
/** Play MP3 fully, then advance to speech; no hardcoded audio length. */
function playCue(s,kind,onDone){
  const clip=currentMusic(kind);
  if(!clip?.url){playOriginalCue(s,kind,onDone);return;}
  const player=s.musicPlayer || (s.musicPlayer=new Audio());
  player.onended=null;player.onerror=null;
  player.src=clip.url;
  player.preload='auto';
  // Some iOS models ignore per-element volume; device volume remains the fallback.
  player.volume=Math.min(1,Math.max(0,db.settings.jingleVolume??.38));
  let finished=false;
  const finish=()=>{
    if(finished)return;finished=true;
    player.onended=null;player.onerror=null;
    onDone();
  };
  const fallback=()=>{
    if(finished)return;finished=true;
    player.onended=null;player.onerror=null;
    try{player.pause();}catch{}
    toast(`${kind==='intro'?'开始':'结束'} MP3 播放失败，已改用短提示音。`);
    playOriginalCue(s,kind,onDone);
  };
  player.onended=finish;
  player.onerror=fallback;
  try{
    const result=player.play();
    if(result?.catch)void result.catch(fallback);
  }catch(err){fallback();}
}

function speakOnce(text,lang,onDone,onFailure,voiceOverride=null) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang=lang;
  utterance.rate=lang==='en-US'?db.settings.rateEn:db.settings.rateZh;
  utterance.pitch=lang==='en-US'?db.settings.pitchEn:db.settings.pitchZh;
  utterance.volume=db.settings.voiceVolume;
  const v=voiceOverride||chooseVoice(lang);if(v)utterance.voice=v;
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
  if(step.type==='jingle'){
    const token=++s.playToken;
    updatePlayer();
    playCue(s,step.kind,()=>{
      if(session!==s||s.paused||s.playToken!==token)return;
      cancelTimers(s);s.stepIndex++;executeStep();
    });
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

function clearConfirmedCrop(){
  confirmedCropBlob = null;
  if(confirmedCropUrl){ URL.revokeObjectURL(confirmedCropUrl); confirmedCropUrl=''; }
}
function updateCropActionBar(){
  const bar = $('#modalActionBar');
  if(!bar) return;
  const active = !$('#overlay').hidden && importMode==='photo' && !!$('#photoImportPanel') && !!importFile;
  bar.hidden = !active;
  if(!active){bar.innerHTML='';return;}
  const isConfirmed = !!confirmedCropBlob;
  bar.innerHTML = `<div class="crop-action-caption" id="cropFooterStatus">${ocrBusy?'正在处理选区，请勿退出…':isConfirmed?'✓ 已确认选区 · 可开始识别':'第 1 步 / 2 步 · 确认蓝框内的文字范围'}</div>
    <div class="crop-action-buttons">${isConfirmed?`<button type="button" class="btn" data-action="edit-crop" ${ocrBusy?'disabled':''}>重新框选</button>`:''}
    <button type="button" class="btn btn-primary crop-confirm-button" data-action="${isConfirmed?'run-ocr':'confirm-crop'}" ${ocrBusy?'disabled':''}>${ocrBusy?'正在处理…':isConfirmed?'第 2 步 · 开始识别文字':'✓ 确认选区'}</button></div>`;
}
function drawPhotoHolder(){
  const holder=$('#photoHolder');
  if(!holder)return;
  if(!importFileUrl){holder.innerHTML='';updateCropActionBar();return;}
  if(confirmedCropBlob && confirmedCropUrl){
    holder.innerHTML = `<div class="crop-confirmed"><div class="crop-confirmed-title">✓ 选区已确认</div>
    <div class="crop-help">下面是将要识别的内容，框外文字不会上传或参与识别。</div>
    <img class="crop-result-preview" src="${esc(confirmedCropUrl)}" alt="已裁剪的识别区域预览">
    </div>`;
    updateCropActionBar();return;
  }
  holder.innerHTML=`<div class="crop-help">① 拖动蓝框、四角或在照片上重新框选，选好后点下方「确认选区」。</div>
  <div class="crop-stage-wrap"><div id="cropStage" class="crop-stage" role="group" aria-label="图片识别区域裁剪"><img id="cropImage" alt="待裁剪的照片" src="${esc(importFileUrl)}" draggable="false"><div id="cropBox" class="crop-box"><i class="crop-handle tl" data-handle="tl"></i><i class="crop-handle tr" data-handle="tr"></i><i class="crop-handle bl" data-handle="bl"></i><i class="crop-handle br" data-handle="br"></i></div></div></div>
  <div class="crop-info"><span>框外内容不会识别</span><button class="btn btn-small" data-action="reset-crop" type="button">重置选区</button></div>
  <div class="hint">已选择：${esc(importFile?.name || '拍摄照片')}</div>`;
  syncCropBox();updateCropActionBar();
}
async function confirmCrop(){
  if(ocrBusy || !importFile || confirmedCropBlob) return;
  ocrBusy=true;updateCropActionBar();
  const status=$('#ocrStatus');if(status)status.textContent='正在生成选区预览…';
  try{
    confirmedCropBlob=await prepareImage(importFile, crop);
    confirmedCropUrl=URL.createObjectURL(confirmedCropBlob);
    drawPhotoHolder();
    $('#photoHolder')?.scrollIntoView({behavior:'smooth',block:'start'});
    if(status)status.textContent='选区已确认。核对上方预览，然后点击底部「开始识别文字」，如不对可重新框选。';
  }catch(err){
    clearConfirmedCrop();
    if(status)status.textContent='裁剪失败：'+(err.message||'无法处理图片')+'。请更换图片。';
  }finally{ocrBusy=false;updateCropActionBar();}
}
function editCrop(){
  if(ocrBusy) return;
  clearConfirmedCrop();drawPhotoHolder();
  $('#photoHolder')?.scrollIntoView({behavior:'smooth',block:'start'});
  const status=$('#ocrStatus');if(status)status.textContent='请重新调整蓝框，完成后点击底部「确认选区」。';
}
function syncCropBox(){
  const box=$('#cropBox');if(!box)return;
  box.style.left=(crop.x*100)+'%';box.style.top=(crop.y*100)+'%';box.style.width=(crop.w*100)+'%';box.style.height=(crop.h*100)+'%';
}
function updatePhotoPreview(file){
  importFile=file;
  clearConfirmedCrop();
  if(importFileUrl){URL.revokeObjectURL(importFileUrl);importFileUrl='';}
  crop={x:.06,y:.06,w:.88,h:.88};
  if(!file){drawPhotoHolder();return;}
  importFileUrl=URL.createObjectURL(file);drawPhotoHolder();
  $('#photoHolder')?.scrollIntoView({behavior:'smooth',block:'start'});
}
function cropPosition(event,stage){
  const r=stage.getBoundingClientRect();
  return {x:Math.min(1,Math.max(0,(event.clientX-r.left)/r.width)), y:Math.min(1,Math.max(0,(event.clientY-r.top)/r.height))};
}
// Pointer events: draw on image, move inside box, resize from corners. Includes iOS touch.
document.addEventListener('pointerdown',event=>{
  const stage=event.target.closest('#cropStage');if(!stage||ocrBusy)return;
  event.preventDefault();
  const at=cropPosition(event,stage);
  const handle=event.target.closest('[data-handle]')?.dataset.handle;
  const mode=handle?'resize':event.target.closest('#cropBox')?'move':'draw';
  cropPointer={id:event.pointerId,mode,handle,start:at,initial:{...crop}};
  if(mode==='draw')crop={x:at.x,y:at.y,w:.01,h:.01};
  stage.setPointerCapture(event.pointerId);syncCropBox();
});
document.addEventListener('pointermove',event=>{
  const stage=$('#cropStage');
  const p=cropPointer;if(!stage||!p||event.pointerId!==p.id)return;
  event.preventDefault();
  const at=cropPosition(event,stage),a=p.initial;
  if(p.mode==='draw'){
    crop={x:Math.min(at.x,p.start.x),y:Math.min(at.y,p.start.y),w:Math.abs(at.x-p.start.x),h:Math.abs(at.y-p.start.y)};
  } else if(p.mode==='move'){
    crop={...a,x:Math.min(1-a.w,Math.max(0,a.x+at.x-p.start.x)),y:Math.min(1-a.h,Math.max(0,a.y+at.y-p.start.y))};
  } else {
    const left=p.handle.includes('l')?at.x:a.x;
    const right=p.handle.includes('r')?at.x:a.x+a.w;
    const top=p.handle.includes('t')?at.y:a.y;
    const bottom=p.handle.includes('b')?at.y:a.y+a.h;
    crop={x:Math.min(left,right),y:Math.min(top,bottom),w:Math.abs(right-left),h:Math.abs(bottom-top)};
  }
  syncCropBox();
});
function finishCrop(event){
  if(!cropPointer||event.pointerId!==cropPointer.id)return;
  crop=clampCrop(crop);
  cropPointer=null;syncCropBox();
}
document.addEventListener('pointerup',finishCrop);
document.addEventListener('pointercancel',finishCrop);
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
async function prepareImage(file,rect){
  // Crop *before* handing the image to any OCR engine or sending it to the network.
  const url=URL.createObjectURL(file);
  try{
    const img=new Image();
    await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('无法读取照片，可尝试转换为 JPG'));img.src=url;});
    const r=clampCrop(rect);
    const sx=Math.min(img.naturalWidth-1,Math.round(r.x*img.naturalWidth));
    const sy=Math.min(img.naturalHeight-1,Math.round(r.y*img.naturalHeight));
    const sw=Math.max(1,Math.min(img.naturalWidth-sx,Math.round(r.w*img.naturalWidth)));
    const sh=Math.max(1,Math.min(img.naturalHeight-sy,Math.round(r.h*img.naturalHeight)));
    const scale=Math.min(1,2048/Math.max(sw,sh));
    const w=Math.max(1,Math.round(sw*scale)),h=Math.max(1,Math.round(sh*scale));
    const c=document.createElement('canvas');c.width=w;c.height=h;
    const ctx=c.getContext('2d',{willReadFrequently:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);
    ctx.imageSmoothingQuality='high';ctx.drawImage(img,sx,sy,sw,sh,0,0,w,h);
    return new Promise((resolve,reject)=>c.toBlob(blob=>blob?resolve(blob):reject(new Error('无法导出裁剪图片')),'image/jpeg',.88));
  }finally{URL.revokeObjectURL(url);}
}
async function recognizePrint(blob,lang,onStatus){
  await ensureOcr();
  const worker=await Tesseract.createWorker(lang==='en-US'?'eng':'chi_sim',1,{
    logger:m=>{if(m.status==='recognizing text')onStatus(`本机印刷体识别 ${Math.round((m.progress||0)*100)}%…`);}
  });
  try {const res=await worker.recognize(blob);return (res?.data?.text||'').trim();}
  finally{await worker.terminate().catch(()=>{});}
}
async function runOcr(){
  if(ocrBusy||!importFile)return;
  if(!confirmedCropBlob){toast('请先点击底部的「确认选区」。');return;}
  ocrBusy=true;updateCropActionBar();
  const status=$('#ocrStatus');
  const updateStatus=t=>{if(status)status.textContent=t;const label=$('#cropFooterStatus');if(label)label.textContent=t;};
  try{
    updateStatus('已确认的选区正在识别…');
    const blob=confirmedCropBlob;
    const lang=$('#importLang').value;
    updateStatus('正在启动本机印刷体识别（首次加载需要联网）…');
    const text=await recognizePrint(blob,lang,updateStatus);
    if(!text){updateStatus('没有识别出印刷词语。手写照片可以使用 iPhone 实况文本或上方手动输入。');return;}
    const textarea=$('#importText');textarea.value=[textarea.value.trim(),text].filter(Boolean).join('\n');
    updateStatus('识别完成，已将选区文字添加到下方。请仔细核对并切分词语。');
    refreshImportPreview();textarea.scrollIntoView({behavior:'smooth',block:'nearest'});
  }catch(err){console.error(err);updateStatus(`本机识别未完成：${err.message||'未知错误'}。可改用手动输入或 iPhone 实况文本。`);}
  finally{ocrBusy=false;updateCropActionBar();}
}
async function pasteLiveText(){
  const target=$('#importText');
  if(!target)return;
  let copy='';
  try{if(navigator.clipboard?.readText)copy=(await navigator.clipboard.readText()).trim();}catch{}
  if(!copy){
    target.focus();
    const status=$('#ocrStatus');
    if(status)status.textContent='无法自动读取剪贴板。请长按下面的输入框，选择「粘贴」。';
    toast('请在下方输入框长按，然后选择粘贴。');
    return;
  }
  target.value=[target.value.trim(),copy].filter(Boolean).join('\n');
  refreshImportPreview();
  const status=$('#ocrStatus');if(status)status.textContent='已粘贴照片文本。请检查识别错误、删除重复项，再核对词语。';
  target.scrollIntoView({behavior:'smooth',block:'nearest'});
  toast('已粘贴剪贴板中的文字，请检查后保存。');
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
    case 'run-ocr':void runOcr();break;
    case 'paste-live-text':void pasteLiveText();break;
    case 'confirm-crop':void confirmCrop();break;
    case 'edit-crop':editCrop();break;
    case 'check-update':void checkForUpdate();break;
    case 'apply-update':void applyAvailableUpdate();break;
    case 'reset-crop':crop={x:.06,y:.06,w:.88,h:.88};syncCropBox();break;
    case 'toggle-bank':expanded.has(bankId)?expanded.delete(bankId):expanded.add(bankId);render();break;
    case 'select-bank':{
      const b=getBank(bankId);if(!b)return;
      const all=b.items.every(x=>selected.has(refKey(bankId,x.id)));
      for(const entry of b.items)all?selected.delete(refKey(bankId,entry.id)):selected.add(refKey(bankId,entry.id));
      render();break;
    }
    case 'clear-selection':selected.clear();render();break;
    case 'add-words-manual':openImport(false,bankId,'manual');break;
    case 'add-words-photo':openImport(false,bankId,'photo');break;
    case 'dedupe-review':dedupeImportReview();break;
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
    case 'set-word-gap': db.settings.wordGap=Number(button.dataset.seconds); save(); render(); break;
    case 'go-practice':setTab('practice');break;
    case 'voice-preset':{
      const clear=button.dataset.preset==='clear';
      db.settings.rateZh=clear?.80:1.00;
      db.settings.rateEn=clear?.75:1.00;
      db.settings.pitchZh=1;db.settings.pitchEn=1;
      save();render();toast(clear?'已使用清晰慢速预设。':'已使用自然速度预设。');break;
    }
    case 'refresh-voices':{
      if('speechSynthesis' in window){speechSynthesis.getVoices();render();toast('已刷新可用音色；只有 Safari 提供的声音会显示。');}break;
    }
    case 'pick-voice':{
      const voice=voicesFor('zh-CN').find(v=>v.voiceURI===button.dataset.voice);
      if(!voice){toast('这个音色已不可用，请刷新列表。');break;}
      db.settings.zhVoice=voice.voiceURI;save();render();toast(`已选用：${voice.name}`);break;
    }
    case 'audition-voice':{
      if(!('speechSynthesis' in window)){toast('此浏览器不支持朗读。');break;}
      const voice=voicesFor('zh-CN').find(v=>v.voiceURI===button.dataset.voice);
      if(!voice){toast('这个音色已不可用，请刷新列表。');break;}
      const sample=$('#zhTestText')?.value.trim()||'崎岖，震耳欲聋，失魂落魄。';
      window.speechSynthesis.cancel();
      speakOnce(sample,voice.lang,()=>{},()=>toast('试听失败，请尝试其他音色。'),voice);
      break;
    }
    case 'test-music':{
      const kind=button.dataset.kind==='outro'?'outro':'intro';
      if(musicPreview){musicPreview.pause();musicPreview=null;}
      const clip=currentMusic(kind);
      if(clip?.url){
        const player=new Audio(clip.url);musicPreview=player;
        player.volume=Math.min(1,Math.max(0,db.settings.jingleVolume??.38));
        player.onended=()=>{if(musicPreview===player)musicPreview=null;};
        player.onerror=()=>toast('MP3 试听失败，请重新选择文件。');
        void player.play().catch(()=>toast('试听被浏览器阻止，请再次点按试听。'));
      }else{
        const temp={timer:0,cueNodes:[],musicPlayer:new Audio()};ensureAudioContext();playOriginalCue(temp,kind,()=>{});
      }
      break;
    }
    case 'clear-music':{
      void clearMusicFile(button.dataset.kind==='outro'?'outro':'intro');break;
    }
    case 'test-cue':{
      const temp={timer:0,cueNodes:[],musicPlayer:new Audio()};ensureAudioContext();playCue(temp,'intro',()=>{});
      break;
    }
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
      speechSynthesis.cancel();speakOnce(lang==='en-US'?'Welcome to the dictation practice.':($('#zhTestText')?.value.trim()||'崎岖，震耳欲聋，失魂落魄。'),lang,()=>{},()=>toast('试听失败，请尝试系统自动音色。'));break;
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
  <li><strong>添加词语：</strong>点击页面右上角「手动录入」即可直接输入，完全不依赖弹窗；已有词库也能通过卡片内按钮追加。中文空格自动拆分，英语按行保留短语。</li>
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
  if(target.id==='introMusicFile'||target.id==='outroMusicFile'){
    const kind=target.id==='introMusicFile'?'intro':'outro';
    void acceptMusicFile(kind,target.files?.[0]);target.value='';return;
  }
  const setting=target.name;
  if(Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS,setting)){
    if(['skipDuplicates','hideAnswers','introCue','outroCue'].includes(setting))db.settings[setting]=target.checked;
    else if(setting==='repetitions')db.settings.repetitions=Number(target.value);
    else if(['rateEn','rateZh','pitchEn','pitchZh','voiceVolume','jingleVolume','wordGap','repeatGap'].includes(setting))db.settings[setting]=Number(target.value);
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
  if(['rateZh','rateEn','pitchZh','pitchEn','voiceVolume','jingleVolume','wordGap','repeatGap'].includes(target.name)){
    const label=$(`#${target.name}Value`);
    if(label)label.textContent=['rateZh','rateEn'].includes(target.name)?Number(target.value).toFixed(2)+' ×':['pitchZh','pitchEn'].includes(target.name)?Number(target.value).toFixed(2):['voiceVolume','jingleVolume'].includes(target.name)?Math.round(Number(target.value)*100)+'%':target.value+' 秒';
  }
});
window.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&!$('#overlay').hidden&&!ocrBusy)closeModal();
});
if('speechSynthesis' in window){
  speechSynthesis.addEventListener?.('voiceschanged',()=>{if((tab==='settings'||(tab==='practice'&&!session))&&$('#overlay').hidden)render();});
}
if('serviceWorker' in navigator && location.protocol.startsWith('http')){
  navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).catch(error=>console.warn('Service Worker 注册失败',error));
}
render();
void loadUserMusic();
void checkBundledMusic();
