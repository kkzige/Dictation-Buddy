/** WebAudio MP3 cue engine. Decode before playback, unlock AudioContext from a user gesture. */
export function createMusicEngine(getContext){
  function prepare(clip){
    if(!clip) return Promise.reject(new Error('音乐文件不存在'));
    if(clip.buffer) return Promise.resolve(clip.buffer);
    if(clip.pending) return clip.pending;
    const ctx=getContext();
    if(!ctx) return Promise.reject(new Error('当前浏览器没有 Web Audio 支持'));
    clip.status='loading';
    clip.pending=(async()=>{
      let arrayBuffer;
      if(clip.blob){arrayBuffer=await clip.blob.arrayBuffer();}
      else {
        const response=await fetch(clip.url,{cache:'force-cache'});
        if(!response.ok)throw new Error('无法读取 MP3（HTTP '+response.status+'）');
        const type=(response.headers.get('content-type')||'').toLowerCase();
        if(type.includes('text/html'))throw new Error('MP3 地址返回网页，未找到音乐文件');
        arrayBuffer=await response.arrayBuffer();
      }
      if(!arrayBuffer.byteLength)throw new Error('音乐文件为空');
      // Safari requires a detached/copyable ArrayBuffer for some decode implementations.
      const buffer=await ctx.decodeAudioData(arrayBuffer.slice(0));
      if(!buffer||!(buffer.duration>0))throw new Error('无法解码 MP3');
      clip.buffer=buffer;
      clip.status='ready';
      clip.duration=buffer.duration;
      return buffer;
    })().catch(error=>{
      clip.status='error';clip.error=error.message||'未知错误';clip.pending=null;throw error;
    });
    return clip.pending;
  }
  function play(clip,volume,onEnd,onError){
    let cancelled=false,done=false,node=null,gain=null,guard=0;
    const cleanup=()=>{clearTimeout(guard);if(node)node.onended=null;try{node?.disconnect()}catch{};try{gain?.disconnect()}catch{}};
    const stop=()=>{cancelled=true;cleanup();try{node?.stop()}catch{}};
    Promise.resolve().then(()=>prepare(clip)).then(async buffer=>{
      if(cancelled)return;
      const ctx=getContext();
      if(!ctx)throw new Error('缺少音频设备');
      if(ctx.state==='suspended')await ctx.resume();
      if(cancelled)return;
      if(ctx.state!=='running')throw new Error('音频引擎未获得播放授权');
      node=ctx.createBufferSource();
      gain=ctx.createGain();
      node.buffer=buffer;
      gain.gain.value=Math.min(1,Math.max(0,Number(volume)||0));
      node.connect(gain);gain.connect(ctx.destination);
      node.onended=()=>{if(cancelled||done)return;done=true;cleanup();onEnd();};
      node.start(0);
      // iPhone can interrupt audio on incoming calls or when the page backgrounds.
      guard=setTimeout(()=>{
        if(cancelled||done)return;
        done=true;cleanup();try{node?.stop()}catch{};
        onError(new Error('音乐播放被系统中断或超时'));
      },Math.ceil((buffer.duration+4)*1000));
    }).catch(error=>{
      if(cancelled||done)return;
      done=true;cleanup();onError(error);
    });
    return {stop};
  }
  return {prepare,play};
}
