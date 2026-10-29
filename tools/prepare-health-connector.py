#!/usr/bin/env python3
"""Prepare bounded SQL-connector chunks privately. No network or production writes."""
import argparse,hashlib,json,os,secrets
from pathlib import Path

def prepare(source,manifest_path,destination):
    os.umask(0o077)
    if destination.exists():raise ValueError('destination_exists')
    raw=source.read_bytes();text=raw.decode('utf-8');payload=json.loads(text);manifest=json.loads(manifest_path.read_text())
    if manifest.get('complete') is not True or manifest.get('omitted')!=0:raise ValueError('incomplete_extraction')
    if len(raw)>1572864:raise ValueError('split_extraction_window_first')
    if any(not isinstance(v,list) for v in payload.values()):raise ValueError('native_metric_arrays_required')
    actual={k:len(v) for k,v in payload.items()}
    if actual!=manifest.get('record_counts'):raise ValueError('count_mismatch')
    for metric,rows in payload.items():
        if metric!='workout' and rows and not manifest.get('units',{}).get(metric):raise ValueError('missing_metric_unit')
    chunks=[];chunk=[];size=0
    for char in text:
        length=len(char.encode('utf-8'))
        if size+length>24000:chunks.append(''.join(chunk));chunk=[];size=0
        chunk.append(char);size+=length
    if chunk:chunks.append(''.join(chunk))
    manifest.update(schema_version=1,payload_sha256=hashlib.sha256(raw).hexdigest(),payload_bytes=len(raw),part_count=len(chunks))
    destination.mkdir(parents=True,mode=0o700)
    (destination/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
    # Dollar-quote delimiters are random and checked against content. Never use shell interpolation.
    for i,chunk in enumerate(chunks):
        tag='health_'+secrets.token_hex(12)
        while '$'+tag+'$' in chunk:tag='health_'+secrets.token_hex(12)
        sql=f"select health_private.connector_append('JOB_UUID'::uuid,{i},${tag}${chunk}${tag}$);\n"
        (destination/f'part-{i:03d}.sql').write_text(sql)
    for path in destination.iterdir():path.chmod(0o600)
    return {'parts':len(chunks),'payload_bytes':len(raw),'sha256':manifest['payload_sha256']}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('source',type=Path);parser.add_argument('--manifest',type=Path,required=True);parser.add_argument('--destination',type=Path,required=True);args=parser.parse_args()
    try:print(json.dumps(prepare(args.source,args.manifest,args.destination)))
    except (OSError,ValueError,KeyError,TypeError):raise SystemExit('Preparation failed; source records were not logged.')
