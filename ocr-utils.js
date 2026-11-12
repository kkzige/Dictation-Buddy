/** Shared OCR and crop validation, no DOM. */
export function validateOcrEndpoint(value) {
  if(typeof value!=='string'||!value.trim()||value.length>512)return false;
  try {
    const u=new URL(value.trim());
    return u.protocol==='https:'&&!u.username&&!u.password&&u.hostname.includes('.')&&u.pathname.endsWith('/ocr')&&!u.hash;
  } catch {return false;}
}
export function extractOcrLines(result) {
  if(!result||!Array.isArray(result.lines))return [];
  return result.lines.map(v=>String(v??'').trim()).filter(Boolean).slice(0,600);
}
export function clampCrop(rect) {
  let x=Number(rect?.x),y=Number(rect?.y),w=Number(rect?.w),h=Number(rect?.h);
  if(![x,y,w,h].every(Number.isFinite))return {x:.06,y:.06,w:.88,h:.88};
  x=Math.max(0,Math.min(.97,x));y=Math.max(0,Math.min(.97,y));
  w=Math.max(.03,Math.min(1-x,w));h=Math.max(.03,Math.min(1-y,h));
  return {x,y,w,h};
}
