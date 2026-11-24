/** Dedicated IndexedDB audio storage. Kept separate from the existing word-bank localStorage. */
const DB_NAME='dictation-buddy-audio-v1';
const STORE='music';
function openAudioDatabase(){
  return new Promise((resolve,reject)=>{
    if(!('indexedDB' in globalThis)){reject(new Error('浏览器不支持文件持久化'));return;}
    const request=indexedDB.open(DB_NAME,1);
    request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE);};
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error||new Error('无法打开音频存储'));
    request.onblocked=()=>reject(new Error('音频数据库被占用'));
  });
}
async function transact(kind,mode,operation){
  const db=await openAudioDatabase();
  try{
    return await new Promise((resolve,reject)=>{
      let requestResult;
      const tx=db.transaction(STORE,mode);
      const store=tx.objectStore(STORE);
      const request=operation(store);
      request.onsuccess=()=>{requestResult=request.result;};
      request.onerror=()=>reject(request.error||new Error('音频操作失败'));
      tx.oncomplete=()=>resolve(requestResult); // Wait for durable transaction commit, not request only
      tx.onabort=()=>reject(tx.error||new Error('音频存储中断'));
      tx.onerror=()=>reject(tx.error||new Error('音频数据库错误'));
    });
  } finally {db.close();}
}

export async function saveMusic(kind,file){
  if(!['intro','outro'].includes(kind))throw new Error('不支持的音乐类型');
  if(!file||!/\.mp3$/i.test(file.name))throw new Error('请选择 .mp3 文件');
  if(!file.size||file.size>15*1024*1024)throw new Error('MP3 大小须在 0—15MB 之间');
  // Use a Blob (structured-cloneable) rather than a large base64 localStorage string.
  const record={name:file.name,size:file.size,blob:new Blob([await file.arrayBuffer()],{type:'audio/mpeg'}),updated:Date.now()};
  await transact(kind,'readwrite',store=>store.put(record,kind));
  return record;
}
export async function loadMusic(kind){return await transact(kind,'readonly',store=>store.get(kind));}
export async function removeMusic(kind){await transact(kind,'readwrite',store=>store.delete(kind));}
