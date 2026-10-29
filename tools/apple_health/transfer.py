"""Resumable transfer of prepared exports using a revocable, low-scope import token."""
import base64,gzip,hashlib,json,sqlite3,time,urllib.request,urllib.error
from pathlib import Path
from .native import canonical,digest,VERSION,normalize_device

class TransferError(Exception):pass

def verify_plan(folder):
    conn=sqlite3.connect(folder/'staging.sqlite3')
    try:
        row=conn.execute("select value from meta where key='complete'").fetchone()
        if not row or row[0]!='true':raise TransferError('preparation_incomplete')
        if conn.execute("select value from meta where key='preparer_revision'").fetchone()!=('2',):raise TransferError('preparation_needs_refresh')
        sha=conn.execute("select value from meta where key='manifest_sha256'").fetchone()[0]
        manifest=json.loads(gzip.decompress(conn.execute('select body from archive where payload_sha256=?',(sha,)).fetchone()[0]))['data']['nativeAppleArchive']
        for file in manifest['files']:
            packed=folder/'raw'/(file['sha256']+'.gz')
            compressed=hashlib.sha256();plain=hashlib.sha256()
            with packed.open('rb') as f:
                for part in file['parts']:
                    chunk=f.read(part['bytes']);compressed.update(chunk)
                    if digest(chunk)!=part['chunk_sha256']:raise TransferError('archive_chunk_corrupt')
                    row=conn.execute('select body from archive where payload_sha256=?',(part['payload_sha256'],)).fetchone()
                    body=gzip.decompress(row[0])
                    if digest(body)!=part['payload_sha256'] or base64.b64decode(json.loads(body)['data']['nativeAppleArchive']['content_base64'])!=chunk:raise TransferError('archive_envelope_corrupt')
                if f.read(1):raise TransferError('archive_extra_bytes')
            with gzip.open(packed,'rb') as f:
                for block in iter(lambda:f.read(1024*1024),b''):plain.update(block)
            if plain.hexdigest()!=file['sha256'] or compressed.hexdigest()!=file['compressed_sha256']:raise TransferError('archive_checksum_mismatch')
        return {'verified_files':len(manifest['files']),'source_bytes':sum(f['bytes'] for f in manifest['files'])}
    finally:conn.close()

def upload(folder,credentials,projection='all',database_budget_mb=450,limit=None,progress=None):
    values=json.loads(credentials.read_text());endpoint=values['endpoint'];token=values.get('import_token') or values.get('phone_token')
    if not token:raise TransferError('import_token_missing')
    if endpoint!='https://armhlqarrdzioobepcng.supabase.co/functions/v1/import-health':raise TransferError('unexpected_endpoint')
    if projection not in ('all','workouts','none'):raise TransferError('invalid_scope')
    conn=sqlite3.connect(folder/'staging.sqlite3')
    report=json.loads(conn.execute("select value from meta where key='report'").fetchone()[0])
    if conn.execute("select value from meta where key='complete'").fetchone()[0]!='true':raise TransferError('preparation_incomplete')
    # Full JSON payload size is a conservative lower-order capacity signal, not a guaranteed PG size.
    if projection=='all' and report['projected_payload_bytes']>database_budget_mb*1024*1024:
        conn.close();raise TransferError('full_projection_exceeds_configured_database_budget')
    verify_plan(folder)
    cache_key=digest([endpoint,hashlib.sha256(token.encode()).hexdigest(),projection])
    previous=conn.execute("select value from meta where key='upload_identity'").fetchone()
    if previous and previous[0]!=cache_key:
        conn.execute('update archive set acked=0');conn.execute('update projections set acked=0')
    conn.execute('insert or replace into meta values(?,?)',('upload_identity',cache_key));conn.commit()
    cache=sqlite3.connect(folder.parent/'upload-cache.sqlite3');(folder.parent/'upload-cache.sqlite3').chmod(0o600)
    cache.execute('create table if not exists delivered(scope text,kind text,id text,signature text,primary key(scope,kind,id))')
    count=0;skipped=0
    def acknowledged(kind,row):
        nonlocal skipped
        def without_index(value):
            if isinstance(value,dict):return {k:normalize_device(v) if k=='device' and isinstance(v,str) else without_index(v) for k,v in value.items() if k!='native_index'}
            if isinstance(value,list):return [without_index(v) for v in value]
            return value
        signature=digest(without_index(row));found=cache.execute('select signature from delivered where scope=? and kind=? and id=?',(cache_key,kind,row['id'])).fetchone()
        if found and found[0]==signature:skipped+=1;return True,(kind,row['id'],signature)
        return False,(kind,row['id'],signature)
    def send(body):
        nonlocal count
        for attempt in range(5):
            try:
                req=urllib.request.Request(endpoint,data=body,headers={'Content-Type':'application/json','x-health-import-token':token,'automation-id':'apple-native-manual-export','export-version':VERSION,'automation-aggregation':'none'},method='POST')
                with urllib.request.urlopen(req,timeout=60) as response:result=json.loads(response.read())
                if result.get('status')!='completed':raise TransferError('batch_requires_review')
                count+=1
                if progress and count%10==0:progress({'phase':'upload','acknowledged_requests':count})
                # Existing server limiter allows 60 requests/minute including retries.
                time.sleep(1.05)
                return result
            except urllib.error.HTTPError as exc:
                if exc.code not in (429,502,503,504):raise TransferError('upload_http_'+str(exc.code)) from None
                time.sleep(60 if exc.code==429 else min(2**attempt,16))
            except (TimeoutError,urllib.error.URLError):time.sleep(min(2**attempt,16))
        raise TransferError('upload_retry_limit')
    try:
        manifest_sha=report['manifest_sha256']
        for sha,packed in conn.execute('select payload_sha256,body from archive where acked=0 order by payload_sha256=? asc,payload_sha256',(manifest_sha,)):
            if limit is not None and count>=limit:return {'uploaded_requests':count,'complete':False}
            send(gzip.decompress(packed));conn.execute('update archive set acked=1 where payload_sha256=?',(sha,));conn.commit()
        if projection!='none':
            for ordinal,packed in conn.execute('select ordinal,body from projections where acked=0 order by ordinal'):
                value=json.loads(gzip.decompress(packed));data={};pending=[]
                for family,items in value['data'].items():
                    if projection=='workouts' and family!='workouts':continue
                    if family=='metrics':
                        for metric in items:
                            keep=[]
                            for point in metric['data']:
                                known,identity=acknowledged('metric:'+metric['name'],point)
                                if not known:keep.append(point);pending.append(identity)
                            if keep:data.setdefault(family,[]).append({**metric,'data':keep})
                    else:
                        for row in items:
                            known,identity=acknowledged(family,row)
                            if not known:data.setdefault(family,[]).append(row);pending.append(identity)
                if not data:
                    conn.execute('update projections set acked=1 where ordinal=?',(ordinal,));continue
                value['data']=data;body=canonical(value).encode()
                if limit is not None and count>=limit:return {'uploaded_requests':count,'complete':False,'unchanged_rows_skipped':skipped}
                send(body)
                cache.executemany('insert or replace into delivered values(?,?,?,?)',[(cache_key,*identity) for identity in pending]);cache.commit()
                conn.execute('update projections set acked=1 where ordinal=?',(ordinal,));conn.commit()
        conn.commit();return {'uploaded_requests':count,'complete':True,'projection_scope':projection,'unchanged_rows_skipped':skipped}
    finally:cache.close();conn.close()

def restore(folder,destination):
    verify_plan(folder);destination=destination.resolve();destination.mkdir(parents=True,exist_ok=True,mode=0o700)
    conn=sqlite3.connect(folder/'staging.sqlite3')
    try:
        sha=conn.execute("select value from meta where key='manifest_sha256'").fetchone()[0]
        manifest=json.loads(gzip.decompress(conn.execute('select body from archive where payload_sha256=?',(sha,)).fetchone()[0]))['data']['nativeAppleArchive']
        for file in manifest['files']:
            target=destination/file['path']
            if not target.resolve().is_relative_to(destination) or target.exists():raise TransferError('restore_target_unsafe_or_exists')
            target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            with gzip.open(folder/'raw'/(file['sha256']+'.gz'),'rb') as src,target.open('xb') as dst:
                target.chmod(0o600)
                for block in iter(lambda:src.read(1024*1024),b''):dst.write(block)
        return {'restored_files':len(manifest['files'])}
    finally:conn.close()
