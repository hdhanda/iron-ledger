"""Streaming, dependency-free Apple export preparation. Never logs record content."""
from __future__ import annotations
import base64, gzip, hashlib, json, math, os, re, sqlite3, xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime
from pathlib import Path, PurePosixPath

VERSION = 'apple-health-xml-v1'
BATCH_BYTES = 192 * 1024
CHUNK_BYTES = 128 * 1024
NAMES = {'HKWorkoutActivityTypeRunning':'Running','HKWorkoutActivityTypeTraditionalStrengthTraining':'Traditional Strength Training','HKWorkoutActivityTypeFunctionalStrengthTraining':'Functional Strength Training'}

def canonical(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False)

def digest(value):
    return hashlib.sha256(value if isinstance(value,bytes) else canonical(value).encode()).hexdigest()

def file_hash(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
    return h.hexdigest()

def private_dir(path):
    path.mkdir(parents=True,exist_ok=True,mode=0o700);path.chmod(0o700)

def safe_files(root):
    root=root.resolve(strict=True)
    for path in sorted(root.rglob('*')):
        if path.name in ('.DS_Store','.localized') or path.name.startswith('._') or '__MACOSX' in path.relative_to(root).parts:continue
        if path.is_symlink():raise ValueError('symlinks_not_allowed')
        if path.is_file():
            if not path.resolve().is_relative_to(root):raise ValueError('outside_source')
            yield path

def xml_items(path):
    """Yield complete root children while releasing prior elements, including nested metadata."""
    with path.open('rb') as f:
        head=f.read(65536)
        if re.search(br'<!ENTITY\b|<!DOCTYPE\s+[^>]*\b(?:SYSTEM|PUBLIC)\b',head,re.I):raise ValueError('external_or_entity_xml_not_supported')
    depth=0;root=None
    for event,el in ET.iterparse(path,events=('start','end')):
        if event=='start':
            depth+=1
            if depth==1:root=el
        else:
            if depth==2:
                yield el
                root.remove(el)
            depth-=1

def tree(el):
    value={'tag':el.tag,'attributes':dict(el.attrib)}
    if el.text and el.text.strip():value['text']=el.text
    if list(el):value['children']=[tree(child) for child in el]
    if el.tail and el.tail.strip():value['tail']=el.tail
    return value

def number(value):
    try:
        n=float(value)
        return n if math.isfinite(n) else None
    except (ValueError,TypeError):return None

def source_time(value):
    if not value:return None
    try:return datetime.strptime(value,'%Y-%m-%d %H:%M:%S %z').isoformat()
    except ValueError:
        try:
            dt=datetime.fromisoformat(value.replace('Z','+00:00'))
            return dt.isoformat() if dt.tzinfo else None
        except ValueError:return None

def normalize_device(value):
    return re.sub(r'(HKDevice:\s*)0x[0-9a-f]+',r'\1<address>',value,flags=re.I)

def identity_tree(el):
    value=tree(el)
    def clean(node):
        if 'device' in node.get('attributes',{}):node['attributes']['device']=normalize_device(node['attributes']['device'])
        for child in node.get('children',[]):clean(child)
    clean(value);return value

def attributes_id(el):
    attrs=el.attrib;metadata={m.get('key'):m.get('value') for m in el.findall('MetadataEntry')}
    stable=metadata.get('HKMetadataKeySyncIdentifier') or metadata.get('HKExternalUUID') or metadata.get('HKMetadataKeyExternalUUID')
    if stable:return 'native:'+digest([el.tag,attrs.get('type'),attrs.get('sourceName'),stable])
    if el.tag=='Workout':
        return 'native:'+digest(['workout-start',attrs.get('workoutActivityType'),attrs.get('startDate'),attrs.get('sourceName'),normalize_device(attrs.get('device',''))])
    # No invented sample ID: content-addressed variants remain distinct if Apple supplies no stable identity.
    return 'native:'+digest(identity_tree(el))

def point(el,index):
    a=el.attrib;n=number(a.get('value'))
    result={'id':attributes_id(el),'date':a.get('startDate'),'end':a.get('endDate'),'source':a.get('sourceName'),
            'units':a.get('unit'),'is_aggregated':False,'native':tree(el),'native_index':index,'identity_method':'vendor_sync_id' if any(m.get('key')=='HKMetadataKeySyncIdentifier' for m in el.findall('MetadataEntry')) else 'content_fingerprint'}
    if n is not None:result['qty']=n
    return result

def workout(el,index,manifest_files):
    a=el.attrib;stats={s.get('type'):s.attrib for s in el.findall('WorkoutStatistics')}
    seconds={'s':1,'sec':1,'min':60,'hr':3600,'h':3600}.get(a.get('durationUnit'))
    raw_duration=number(a.get('duration'));duration=raw_duration*seconds if seconds and raw_duration is not None else None
    if duration is None:
        start,end=source_time(a.get('startDate')),source_time(a.get('endDate'))
        if start and end:duration=(datetime.fromisoformat(end)-datetime.fromisoformat(start)).total_seconds()
    distance=next((stats[k] for k in ['HKQuantityTypeIdentifierDistanceWalkingRunning','HKQuantityTypeIdentifierDistanceCycling','HKQuantityTypeIdentifierDistanceSwimming'] if k in stats),None)
    hr=stats.get('HKQuantityTypeIdentifierHeartRate',{});energy=stats.get('HKQuantityTypeIdentifierActiveEnergyBurned',{})
    value={'id':attributes_id(el),'name':NAMES.get(a.get('workoutActivityType'),a.get('workoutActivityType','Unknown')),'start':a.get('startDate'),'end':a.get('endDate'),'source':a.get('sourceName'),
           'duration':duration,'metadata':{'native':tree(el),'native_index':index},'native_series':{}}
    if distance and number(distance.get('sum')) is not None:value['distance']={'qty':number(distance['sum']),'units':distance.get('unit')}
    elif number(a.get('totalDistance')) is not None:value['distance']={'qty':number(a['totalDistance']),'units':a.get('totalDistanceUnit')}
    if number(energy.get('sum')) is not None:value['activeEnergyBurned']={'qty':number(energy['sum']),'units':energy.get('unit')}
    for key,stat in [('avgHeartRate','average'),('maxHeartRate','maximum')]:
        if number(hr.get(stat)) is not None and hr.get('unit') in ('count/min','bpm'):value[key]={'qty':number(hr[stat]),'units':'bpm'}
    route_files=[]
    for reference in el.findall('.//FileReference'):
        relative=(reference.get('path') or '').lstrip('/')
        if '..' in PurePosixPath(relative).parts:raise ValueError('unsafe_file_reference')
        entry=manifest_files.get(relative)
        if not entry:raise ValueError('referenced_file_missing')
        route_files.append({'path':relative,'sha256':entry['sha256']})
    value['native_route_files']=route_files
    for name,stat in stats.items():
        p={'date':stat.get('startDate'),'end':stat.get('endDate'),'units':stat.get('unit'),'source':a.get('sourceName'),
           'is_aggregated':True,'aggregation_level':'workout-summary','native_statistic':dict(stat)}
        for k,target in [('sum','qty'),('average','Avg'),('minimum','Min'),('maximum','Max')]:
            if number(stat.get(k)) is not None:p[target]=number(stat[k])
        value['native_series'][name]=[p]
    return value

def event(el,index):
    a=el.attrib
    return {'id':attributes_id(el),'type':el.tag,'start':a.get('startDate') or a.get('date') or a.get('receivedDate'),
            'end':a.get('endDate'),'source':a.get('sourceName'),'native':tree(el),'native_index':index}

def envelopes(root,manifest_files):
    counts=Counter();types=Counter();invalid_times=0
    for index,el in enumerate(xml_items(root/'export.xml')):
        counts[el.tag]+=1
        if el.tag=='Record':
            p=point(el,index);types[el.get('type','unknown')]+=1
            yield {'metrics':[{'name':el.get('type','unknown'),'units':el.get('unit'),'data':[p]}]},('observations',p['id'])
        elif el.tag=='Workout':
            w=workout(el,index,manifest_files)
            yield {'workouts':[w]},('workouts',w['id'])
        else:
            e=event(el,index)
            yield {'nativeAppleEvents':[e]},('events',e['id'])

def init_db(path):
    conn=sqlite3.connect(path);path.chmod(0o600)
    conn.executescript('''pragma journal_mode=WAL;pragma synchronous=FULL;
    create table if not exists meta(key text primary key,value text not null);
    create table if not exists archive(payload_sha256 text primary key,body blob not null,bytes int not null,acked int not null default 0);
    create table if not exists projections(ordinal integer primary key,body blob not null,bytes int not null,counts text not null,acked int not null default 0);
    create table if not exists identities(kind text,id text,primary key(kind,id));
    create table if not exists observations(id text primary key,metric_name text,observed_at text,end_at text,source text,unit text,value_numeric real,point_json blob);
    create index if not exists observations_metric_time on observations(metric_name,observed_at);
    create table if not exists workout_index(id text primary key,start_at text,activity_type text,workout_json blob);

    ''');return conn

def prepare(source,destination,progress=None):
    root=source.resolve(strict=True);private_dir(destination)
    if destination.resolve().is_relative_to(root):raise ValueError('destination_must_be_outside_export')
    if not (root/'export.xml').is_file():raise ValueError('export_xml_missing')
    files=[];raw_dir=destination/'raw';private_dir(raw_dir)
    for file in safe_files(root):
        original_hash=file_hash(file);compressed=raw_dir/(original_hash+'.gz')
        if not compressed.exists():
            with file.open('rb') as src,compressed.open('wb') as dst:
                compressed.chmod(0o600)
                with gzip.GzipFile(filename='',mode='wb',fileobj=dst,mtime=0,compresslevel=6) as gz:
                    for block in iter(lambda:src.read(1024*1024),b''):gz.write(block)
        files.append({'path':file.relative_to(root).as_posix(),'sha256':original_hash,'bytes':file.stat().st_size,
                      'compressed_sha256':file_hash(compressed),'compressed_bytes':compressed.stat().st_size})
    export_id=digest([{'path':f['path'],'sha256':f['sha256'],'bytes':f['bytes']} for f in files])
    conn=init_db(destination/'staging.sqlite3')
    previous=conn.execute("select value from meta where key='export_id'").fetchone()
    if previous and previous[0]!=export_id:raise ValueError('destination_contains_different_export')
    completed=conn.execute("select value from meta where key='complete'").fetchone()
    if previous and completed and completed[0]=='true' and conn.execute("select value from meta where key='preparer_revision'").fetchone()==('2',):
        result=json.loads(conn.execute("select value from meta where key='report'").fetchone()[0]);conn.close();return result
    conn.execute("insert or replace into meta values('complete','false')");conn.commit()
    conn.execute('delete from projections');conn.execute('delete from identities');conn.execute('delete from observations');conn.execute('delete from workout_index')
    manifest_files={f['path']:f for f in files};archive_parts=[]
    for file in files:
        compressed=raw_dir/(file['sha256']+'.gz');parts=[];count=max(1,(file['compressed_bytes']+CHUNK_BYTES-1)//CHUNK_BYTES)
        with compressed.open('rb') as src:
            for index in range(count):
                chunk=src.read(CHUNK_BYTES)
                value={'kind':'chunk','file_sha256':file['sha256'],'compressed_sha256':file['compressed_sha256'],'index':index,'count':count,
                       'chunk_sha256':digest(chunk),'encoding':'gzip','content_base64':base64.b64encode(chunk).decode()}
                body=canonical({'data':{'nativeAppleArchive':value}}).encode();checksum=digest(body)
                conn.execute('insert or ignore into archive(payload_sha256,body,bytes) values(?,?,?)',(checksum,gzip.compress(body,mtime=0),len(body)))
                parts.append({'payload_sha256':checksum,'chunk_sha256':value['chunk_sha256'],'index':index,'bytes':len(chunk)})
        file['parts']=parts;archive_parts.extend(parts)
    manifest={'kind':'manifest','format':VERSION,'export_id':export_id,'files':files}
    body=canonical({'data':{'nativeAppleArchive':manifest}}).encode();manifest_sha=digest(body)
    if len(body)>1024*1024:raise ValueError('manifest_too_large')
    conn.execute('insert or ignore into archive(payload_sha256,body,bytes) values(?,?,?)',(manifest_sha,gzip.compress(body,mtime=0),len(body)))
    counts=Counter();duplicates=0;data={};identities=[];ordinal=0;current_size=0
    def flush():
        nonlocal data,identities,ordinal,current_size
        if not data:return
        body=canonical({'native_source':{'format':VERSION,'export_id':export_id,'manifest_sha256':manifest_sha,'batch_index':ordinal},'data':data}).encode()
        batch_counts={k:sum(len(m['data']) for m in v) if k=='metrics' else len(v) for k,v in data.items()}
        conn.execute('insert or ignore into projections(ordinal,body,bytes,counts) values(?,?,?,?)',(ordinal,gzip.compress(body,mtime=0),len(body),canonical(batch_counts)))
        ordinal+=1;data={};identities=[];current_size=0
        if ordinal%50==0:
            conn.commit()
            if progress:progress({'phase':'prepare','batches':ordinal,'readings_seen':counts['observations'],'workouts_seen':counts['workouts']})
    for fragment,identity in envelopes(root,manifest_files):
        counts[identity[0]]+=1
        inserted=conn.execute('insert or ignore into identities(kind,id) values(?,?)',identity).rowcount
        if not inserted:duplicates+=1;continue
        if identity[0]=='observations':
            m=fragment['metrics'][0];p=m['data'][0]
            conn.execute('insert into observations values(?,?,?,?,?,?,?,?)',(p['id'],m['name'],source_time(p.get('date')),source_time(p.get('end')),p.get('source'),p.get('units'),p.get('qty'),gzip.compress(canonical(p).encode(),mtime=0)))
        elif identity[0]=='workouts':
            w=fragment['workouts'][0]
            conn.execute('insert into workout_index values(?,?,?,?)',(w['id'],source_time(w.get('start')),w['name'],gzip.compress(canonical(w).encode(),mtime=0)))
        size=len(canonical(fragment).encode())
        if data and current_size+size>BATCH_BYTES:flush()
        for family,items in fragment.items():
            if family=='metrics':
                for metric in items:
                    existing=next((m for m in data.get(family,[]) if (m['name'],m.get('units'))==(metric['name'],metric.get('units'))),None)
                    if existing:existing['data'].extend(metric['data'])
                    else:data.setdefault(family,[]).append(metric)
            else:data.setdefault(family,[]).extend(items)
        current_size+=size;identities.append(identity)
    flush()
    report={'format':VERSION,'export_id':export_id,'manifest_sha256':manifest_sha,'files':len(files),'source_bytes':sum(f['bytes'] for f in files),
            'compressed_bytes':sum(f['compressed_bytes'] for f in files),'raw_chunks':len(archive_parts),'xml_items':dict(counts),'within_export_duplicates':duplicates,
            'projection_batches':ordinal,'projected_payload_bytes':conn.execute('select coalesce(sum(bytes),0) from projections').fetchone()[0],
            'unique_observations':conn.execute('select count(*) from observations').fetchone()[0],
            'unique_workouts':conn.execute('select count(*) from workout_index').fetchone()[0]}
    for key,value in [('preparer_revision','2'),('export_id',export_id),('manifest_sha256',manifest_sha),('report',canonical(report)),('complete','true')]:conn.execute('insert or replace into meta values(?,?)',(key,value))
    conn.commit();conn.close()
    with (destination/'report.json').open('w') as f:json.dump(report,f,indent=2)
    (destination/'report.json').chmod(0o600)
    return report
