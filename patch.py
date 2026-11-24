from pathlib import Path
p=Path('/mnt/data/dictation-pwa-v0.3.6')
app=p/'app.js'
s=app.read_text()
s=s.replace("import {isNewerVersion} from './version-utils.js';", "import {isNewerVersion} from './version-utils.js';\nimport {saveMusic, loadMusic, removeMusic} from './audio-store.js';")
s=s.replace("const APP_VERSION = '0.3.5'", "const APP_VERSION = '0.3.6'")
s=s.replace("let audioContext = null;", """let audioContext = null;
// Optional music is a local IndexedDB file or a deployed assets/audio/Op.mp3, Ep.mp3.
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
  for(const [kind,filename] of [['intro','Op.mp3'],['outro','Ep.mp3']]){
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
    if(!/\\.mp3$/i.test(file.name)||!file.size||file.size>15*1024*1024)throw new Error('请选用不超过 15MB 的 MP3 文件。');
    const record=await saveMusic(kind,file);
    revokeMusic(kind);
    customMusic[kind]={name:record.name,source:'local',url:URL.createObjectURL(record.blob)};
    toast(`已保存${kind==='intro'?'开始':'结束'}音乐：${record.name}`);
  }catch(err){toast(`无法保存音乐：${err.message}。本机文件存储失败时，请尝试用电脑把 Op/Ep.mp3 放入 assets/audio。`);}
  if(tab==='practice'&&!session)render();
}
async function clearMusicFile(kind){
  if(musicPreview){musicPreview.pause();musicPreview=null;}
  try{await removeMusic(kind);revokeMusic(kind);toast('已移除本机音乐，改用随项目发布的 MP3 或原有提示音。');}
  catch(err){toast('移除音乐失败：'+err.message);}
  if(tab==='practice'&&!session)render();
}
""")
# new voice listing labels and count
s=s.replace('<label class="field"><span>中文音色</span><select name="zhVoice">${voiceOptions(\'zh-CN\',a.zhVoice)}</select></label>', '''<label class="field"><span>中文音色（${availableVoiceCount('zh-CN')} 种可选）</span><select name="zhVoice">${voiceOptions('zh-CN',a.zhVoice)}</select></label>
    <p class="setting-help">当前列表来自 iPhone 系统，不是云端音色库；可逐个切换后点击「试听中文」。如果显示较少，点击刷新，并检查手机的系统语音设置。</p>
    <label class="field"><span>中文试听词语</span><input type="text" id="zhTestText" value="崎岖，震耳欲聋，失魂落魄。" maxlength="80" placeholder="可以输入难读的词进行试听"></label>''')
# Replace ceremony panel function exactly
start=s.index('function ceremonyPanel() {')
end=s.index('\nfunction renderPractice()',start)
s=s[:start]+'''function ceremonyPanel() {
  const a=db.settings;
  return `<section class="setting-panel" id="ceremonyPanel"><h3 class="focus-heading">⑥ 开始与结束音乐</h3>
    <p class="subtext"><strong>顺序：先完整播放音乐，再朗读提示语。</strong>开场：Op.mp3 → “现在开始听写” → 第一个词；收尾：Ep.mp3 → “本次听写已完成”。</p>
    <label class="choice cue-choice"><input type="checkbox" name="introCue" ${a.introCue?'checked':''}>播放开始音乐和开始语音</label>
    <div class="music-picker"><div class="music-name"><strong>开始音乐 · Op.mp3</strong><small>${esc(musicLabel('intro'))}</small></div>
      <label class="btn btn-small" for="introMusicFile">选择 MP3 文件<input class="visually-hidden-file" id="introMusicFile" type="file" accept="audio/mpeg,.mp3"></label>
      <button type="button" class="btn btn-small" data-action="test-music" data-kind="intro">▶ 试听开始音乐</button>
      ${customMusic.intro?'<button type="button" class="btn btn-small btn-subtle" data-action="clear-music" data-kind="intro">移除本机音乐</button>':''}</div>
    <label class="choice cue-choice"><input type="checkbox" name="outroCue" ${a.outroCue?'checked':''}>播放结束音乐和完成语音</label>
    <div class="music-picker"><div class="music-name"><strong>结束音乐 · Ep.mp3</strong><small>${esc(musicLabel('outro'))}</small></div>
      <label class="btn btn-small" for="outroMusicFile">选择 MP3 文件<input class="visually-hidden-file" id="outroMusicFile" type="file" accept="audio/mpeg,.mp3"></label>
      <button type="button" class="btn btn-small" data-action="test-music" data-kind="outro">▶ 试听结束音乐</button>
      ${customMusic.outro?'<button type="button" class="btn btn-small btn-subtle" data-action="clear-music" data-kind="outro">移除本机音乐</button>':''}</div>
    <div class="range-title"><span>提示音乐音量</span><strong id="jingleVolumeValue">${Math.round(a.jingleVolume*100)}%</strong></div>
    <input aria-label="提示音乐音量" type="range" name="jingleVolume" min="0" max=".8" step=".05" value="${a.jingleVolume}">
    <p class="setting-help">手机选入的 MP3 会尝试保存在当前设备中，换手机需重新选择。也可由电脑把真实 Op.mp3、Ep.mp3 上传到 GitHub 仓库的 assets/audio/ 目录，让所有设备自动使用。当前版本没有内置你尚未上传的那两个文件。</p>
  </section>`;
}
''' +s[end:]
# voice count/list options
start=s.index('function voiceOptions(lang, chosen) {')
end=s.index('\nfunction updatePanelHtml()',start)
s=s[:start]+'''function voicesFor(lang){
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
function voiceOptions(lang,chosen){
  if(!('speechSynthesis' in window))return '<option value="">当前浏览器不支持语音</option>';
  const voices=voicesFor(lang);
  const unknown=chosen&&!voices.some(v=>v.voiceURI===chosen)?`<option value="${esc(chosen)}" selected disabled>原选音色当前不可用，请重新选择</option>`:'';
  const options=voices.map((v,i)=>`<option value="${esc(v.voiceURI)}" ${v.voiceURI===chosen?'selected':''}>${i+1}. ${esc(v.name)} · ${esc(v.lang)}${v.localService?' · 本机':''}</option>`).join('');
  return `<option value="">系统自动选择</option>${unknown}${options}`;
}
''' +s[end:]
# session.audioPlayer per session
s=s.replace("sourceName:sourceLabel(sourceToUse)};", "sourceName:sourceLabel(sourceToUse),musicPlayer:new Audio()};")
s=s.replace('function cancelCue(s){\n  if(!s) return;', '''function cancelCue(s){
  if(!s) return;
  if(s.musicPlayer){
    s.musicPlayer.onended=null;s.musicPlayer.onerror=null;
    try{s.musicPlayer.pause();s.musicPlayer.currentTime=0;}catch{}
  }''')
# swap playCue block but retain old synth implementation
start=s.index('function playCue(s,kind,onDone){')
end=s.index('\nfunction speakOnce(',start)
s=s[:start]+'''function playOriginalCue(s,kind,onDone){
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
    s.musicPlayer=null; // release audio after full playback
    onDone();
  };
  const fallback=()=>{
    if(finished)return;finished=true;
    player.onended=null;player.onerror=null;
    try{player.pause();}catch{}
    s.musicPlayer=null;
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
''' +s[end:]
# We must not set musicPlayer null on finish, because iOS reuse same unlocked audio element helps outro playing. remove those lines.
s=s.replace('    s.musicPlayer=null; // release audio after full playback\n','')
s=s.replace('    s.musicPlayer=null;\n    toast(', '    toast(')
# insert handler cases
case="""    case 'test-cue':{
      const temp={timer:0,cueNodes:[]};ensureAudioContext();playCue(temp,'intro',()=>{});
      toast('正在试听开场提示音乐。');break;
    }"""
replacement="""    case 'test-music':{
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
    }"""
assert case in s
s=s.replace(case,replacement)
s=s.replace("speechSynthesis.cancel();speakOnce(lang==='en-US'?'Welcome to the dictation practice.':'你好，现在开始中文听写。'", "speechSynthesis.cancel();speakOnce(lang==='en-US'?'Welcome to the dictation practice.':($('#zhTestText')?.value.trim()||'崎岖，震耳欲聋，失魂落魄。')")
# audio file input event before settings
needle="  if(target.id==='backupFile'){importBackup(target.files?.[0]);target.value='';return;}"
s=s.replace(needle,needle+"\n  if(target.id==='introMusicFile'||target.id==='outroMusicFile'){\n    const kind=target.id==='introMusicFile'?'intro':'outro';\n    void acceptMusicFile(kind,target.files?.[0]);target.value='';return;\n  }")
# preload after render
s=s.replace("render();\n// Versioned", "render();\n// Versioned")
s=s.replace("}\nrender();\n", "}\nrender();\nvoid loadUserMusic();\nvoid checkBundledMusic();\n") if False else s
# append to final render at end
assert s.endswith('render();\n')
s=s[:-len('render();\n')]+'render();\nvoid loadUserMusic();\nvoid checkBundledMusic();\n'
app.write_text(s)
# version update other assets
for file in ['index.html','manual.html','sw.js','version.json']:
 path=p/file
 text=path.read_text().replace('0.3.5','0.3.6')
 if file=='sw.js':
  text=text.replace("'./version-utils.js',", "'./version-utils.js', './audio-store.js',")
 if file=='version.json':
  import json
  obj=json.loads(text)
  obj['notes']='新增 MP3 自选与本机保存，支持 Op.mp3 开场、Ep.mp3 收尾：必须等音乐完整播完再说提示语；强化中文音色数量展示与逐个试听；保留手动录入、词库及原有听写设置。'
  text=json.dumps(obj,ensure_ascii=False,indent=2)+'\n'
 path.write_text(text)
# css
with (p/'styles.css').open('a') as f:f.write('''
/* v0.3.6: user-selected MP3 intro/outro and voice choices */
.music-picker{display:flex;gap:7px;align-items:center;flex-wrap:wrap;padding:10px 11px;background:#f8fafc;border:1px solid #e4eaf2;border-radius:12px;margin:7px 0 14px}
.music-name{flex:1 0 100%;display:flex;flex-direction:column;gap:3px;color:#294a6d;font-size:13px}
.music-name small{font-size:12px;color:#71859a;overflow-wrap:anywhere}
.music-picker .btn{min-height:41px;flex:1;white-space:normal;font-size:12px;padding:9px 7px;text-align:center}
#zhTestText{min-height:46px;font-size:16px}
''')
# create folder for optional assets; explain to users
(p/'assets/audio').mkdir(parents=True,exist_ok=True)
(p/'assets/audio/说明.txt').write_text('可选：将你自己合法拥有使用权的 Op.mp3（开始音乐）和 Ep.mp3（结束音乐）放在此目录。不要随意使用未授权音乐公开发布。\n若没有这两个文件，可以在 iPhone 听写页面直接选入 MP3，音乐保存在当前设备浏览器。\n')
