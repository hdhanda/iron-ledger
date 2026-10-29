import {hash} from './parser.mjs';
const sha=s=>typeof s==='string'&&/^[0-9a-f]{64}$/.test(s);
const integer=(n,max)=>Number.isSafeInteger(n)&&n>=0&&n<=max;
const fail=()=>{throw Error('invalid_native_export')};
const path=s=>typeof s==='string'&&s.length>0&&s.length<=2048&&!s.startsWith('/')&&!s.includes('\\')&&!s.split('/').some(p=>!p||p==='.'||p==='..');
export async function validateNative(payload){
 const source=payload.native_source,archive=payload.data.nativeAppleArchive;
 if(source){
  if(source.format!=='apple-health-xml-v1'||!sha(source.export_id)||!sha(source.manifest_sha256)||!integer(source.batch_index,1000000)||archive)fail();
 }
 if(payload.data.nativeAppleEvents&&!source)fail();
 if(!archive)return {source:source??null,archive:null};
 if(source||Object.keys(payload.data).length!==1||!archive||typeof archive!=='object'||Array.isArray(archive))fail();
 if(archive.kind==='chunk'){
  if(!sha(archive.file_sha256)||!sha(archive.compressed_sha256)||!sha(archive.chunk_sha256)||archive.encoding!=='gzip'||!integer(archive.index,1000000)||!integer(archive.count,1000000)||archive.count<1||archive.index>=archive.count||typeof archive.content_base64!=='string'||archive.content_base64.length>174764||!/^[A-Za-z0-9+/]*={0,2}$/.test(archive.content_base64))fail();
  let raw;try{raw=Uint8Array.from(atob(archive.content_base64),c=>c.charCodeAt(0));}catch{fail();}
  if(raw.length>131072||await hash(raw)!==archive.chunk_sha256)fail();
  return {source:null,archive,info:{native_kind:'chunk',file_sha256:archive.file_sha256,compressed_sha256:archive.compressed_sha256,index:archive.index,count:archive.count,chunk_sha256:archive.chunk_sha256,chunk_bytes:raw.length}};
 }
 if(archive.kind!=='manifest'||archive.format!=='apple-health-xml-v1'||!sha(archive.export_id)||!Array.isArray(archive.files)||archive.files.length>10000||!archive.files.length)fail();
 const paths=new Set();let n=0;
 for(const file of archive.files){
  if(!path(file.path)||paths.has(file.path)||!sha(file.sha256)||!sha(file.compressed_sha256)||!integer(file.bytes,100*1024**3)||!integer(file.compressed_bytes,100*1024**3)||!Array.isArray(file.parts)||!file.parts.length)fail();paths.add(file.path);
  let size=0;
  for(let i=0;i<file.parts.length;i++){const p=file.parts[i];if(!sha(p.payload_sha256)||!sha(p.chunk_sha256)||p.index!==i||!integer(p.bytes,131072))fail();size+=p.bytes;if(++n>20000)fail();}
  if(size!==file.compressed_bytes)fail();
 }
 return {source:null,archive,info:{native_kind:'manifest',export_id:archive.export_id,file_count:archive.files.length,chunk_count:n}};
}
