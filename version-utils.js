/** Pure version comparison for user-requested updates; no storage changes. */
export function compareVersions(a,b){
  const re=/^\d+\.\d+\.\d+$/;
  if(!re.test(a)||!re.test(b))throw new Error('Invalid version');
  const p=a.split('.').map(Number),q=b.split('.').map(Number);
  for(let i=0;i<3;i++){if(p[i]>q[i])return 1;if(p[i]<q[i])return -1;}
  return 0;
}
export function isNewerVersion(remote,current){return compareVersions(remote,current)>0;}
