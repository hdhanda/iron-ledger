#!/usr/bin/env python3
"""Read-only XLSX -> reviewable v2 backup. Never contacts or writes a database.
Requires openpyxl. Run --help. Private outputs must stay outside the Git repository.
"""
import argparse, collections, copy, datetime as dt, hashlib, json, pathlib, re
import openpyxl

TABLES = ('exercises', 'routines', 'sessions', 'cardio', 'body')

def serial(value):
    if isinstance(value, (dt.date, dt.datetime, dt.time)):
        return value.isoformat()
    return value

def date(value):
    if isinstance(value, (dt.date, dt.datetime)):
        return value.strftime('%Y-%m-%d')
    if isinstance(value, (float, int)):
        return openpyxl.utils.datetime.from_excel(value).strftime('%Y-%m-%d')
    text = str(value or '')
    for fmt in ('%Y-%m-%d', '%Y-%m-%dT%H:%M:%S', '%m/%d/%Y', '%m/%d/%y'):
        try:
            return dt.datetime.strptime(text, fmt).strftime('%Y-%m-%d')
        except ValueError:
            pass
    raise ValueError(f'Unrecognized date {text!r}; do not guess a workout date')

def flag(value):
    if value in (True, 1, 'Y', 'TRUE', 'true'): return True
    if value in (False, 0, 'N', 'FALSE', 'false', None, ''): return False
    raise ValueError(f'Unrecognized boolean {value!r}')

def number(value, default=None):
    if value in (None, ''): return default
    n = float(value)
    if not __import__('math').isfinite(n): raise ValueError('Non-finite number')
    return int(n) if n.is_integer() else n

def stamp(value):
    if not value: return None
    parsed = dt.datetime.fromisoformat(str(serial(value)).replace('Z', '+00:00'))
    if not parsed.tzinfo: raise ValueError(f'logged_at has no timezone: {value}')
    return int(parsed.timestamp() * 1000)

def key(table, row):
    return (row['id'], row['split']) if table == 'routines' else row['id']

def canonical(value): return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)

def read_workbook(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    tabs = {}
    for sheet in wb:
        values = list(sheet.values)
        headers = values[0]
        rows = []
        for rownum, values_row in enumerate(values[1:], 2):
            if not any(v is not None for v in values_row): continue
            row = {str(k): v for k, v in zip(headers, values_row) if k is not None}
            row['_row'] = rownum
            rows.append(row)
        tabs[sheet.title] = rows
    for name in ('sets', 'sessions', 'exercises', 'routines', 'cardio', 'body'):
        if name not in tabs: raise ValueError(f'Missing tab {name}')
    return tabs

def reconcile(base, incoming, conflicts, path=''):
    """Fill missing fields, recursively reconcile objects, never overwrite facts."""
    for k, value in incoming.items():
        if k in ('synced', 'cloud', 'settings', 'migrationReview'): continue
        if k not in base or base[k] in (None, ''):
            base[k] = copy.deepcopy(value)
        elif value in (None, ''): continue
        elif isinstance(base[k], dict) and isinstance(value, dict):
            reconcile(base[k], value, conflicts, path+'.'+k)
        elif base[k] != value:
            conflicts.append({'path': path+'.'+k, 'sheet': base[k], 'backup': value})

def merge_backup(db, backup, conflicts):
    for table in TABLES:
        for incoming in backup.get(table, []):
            old = next((r for r in db[table] if key(table, r) == key(table, incoming)), None)
            if old is None:
                db[table].append(copy.deepcopy(incoming)); continue
            if table != 'sessions':
                reconcile(old, incoming, conflicts, f'{table}/{key(table, old)}'); continue
            reconcile(old, {k:v for k,v in incoming.items() if k != 'entries'}, conflicts, f'sessions/{old["id"]}')
            for entry in incoming.get('entries', []):
                dest = next((e for e in old['entries'] if e['exId'] == entry['exId']), None)
                if dest is None: old['entries'].append(copy.deepcopy(entry)); continue
                reconcile(dest, {k:v for k,v in entry.items() if k != 'sets'}, conflicts, f'{old["id"]}/{entry["exId"]}')
                for st in entry['sets']:
                    existing = next((s for s in dest['sets'] if s['id'] == st['id']), None)
                    if existing is None: dest['sets'].append(copy.deepcopy(st))
                    else: reconcile(existing, st, conflicts, f'{old["id"]}/{st["id"]}')
    db['active'] = copy.deepcopy(backup.get('active'))
    # Preserve phone settings for recovery; credentials are never written to the database.
    db['settings'] = copy.deepcopy(backup.get('settings', {}))

def build(source, backup=None, decisions=None, template=None, catalog=None):
    source = copy.deepcopy(source)
    backup = backup or {}; decisions = decisions or {}
    db = {'schemaVersion':2, **{t:[] for t in TABLES}, 'active':None,
          'settings':{'endpoint':'','token':'','unit':'lb'}}
    report = {'sourceCounts':{t:len(source[t]) for t in source}, 'errors':[], 'review':[],
              'conflicts':[], 'exerciseMapping':[], 'excluded':[], 'backupProvided':bool(backup)}
    errors, review = report['errors'], report['review']
    raw = lambda row: {k:serial(v) for k,v in row.items() if k != '_exId'}
    def issue(code, message): review.append({'code':code, 'message':message})
    def excluded(table, id):
        if id in decisions.get('exclude', {}).get(table, []):
            report['excluded'].append({'table':table,'id':id}); return True
        return False
    def add(table, row):
        if any(key(table,r) == key(table,row) for r in db[table]):
            errors.append(f'Duplicate {table} ID {key(table,row)}'); return
        db[table].append(row)
    for r in source['exercises']:
        add('exercises', {'id':str(r['exercise_id']), 'name':r['name'], 'pattern':r['pattern'],
                         'group':r['group'], 'anchor':flag(r['anchor'])})
    # Match original app catalog by exact name only, never fuzzy names or spelling fixes.
    for ex in (catalog or {}).get('exercises', []):
        if not any(e['id']==ex['id'] for e in db['exercises']): db['exercises'].append(copy.deepcopy(ex))
    for ex in backup.get('exercises', []):
        existing = next((e for e in db['exercises'] if e['id']==ex['id']), None)
        if existing: reconcile(existing, ex, report['conflicts'], 'exercises/'+ex['id'])
        else: db['exercises'].append(copy.deepcopy(ex))
    backup_sets = {}
    for s in backup.get('sessions', []):
        for e in s['entries']:
            for st in e['sets']:
                if st['id'] in backup_sets: errors.append('Duplicate backup set '+st['id'])
                backup_sets[st['id']] = (s['id'],e['exId'])
    ex_map = {}
    for r in source['sets']:
        name = r['exercise']; metadata = (r['pattern'],r['group'],flag(r['anchor']))
        explicit = r.get('exercise_id') or decisions.get('exerciseIds', {}).get(name)
        linked = backup_sets.get(str(r['set_uid']))
        if linked:
            if linked[0] != str(r['session_id']): errors.append('Set changes session between sources: '+str(r['set_uid']))
            explicit = linked[1]
        candidates = [e for e in db['exercises'] if e['name']==name]
        if explicit:
            chosen = next((e for e in db['exercises'] if e['id']==explicit),None)
            if chosen is None:
                chosen = {'id':explicit,'name':name,'pattern':metadata[0],'group':metadata[1],'anchor':metadata[2],'custom':True}
                db['exercises'].append(chosen)
        elif len(candidates)==1: chosen=candidates[0]
        else:
            if len(candidates)>1: errors.append('Ambiguous exact name requires exerciseIds decision: '+name)
            eid='hist_'+hashlib.sha256(name.encode()).hexdigest()[:20]
            chosen=next((e for e in db['exercises'] if e['id']==eid),None)
            if chosen is None:
                chosen={'id':eid,'name':name,'pattern':metadata[0],'group':metadata[1],'anchor':metadata[2],'custom':True}
                db['exercises'].append(chosen)
        if (chosen.get('pattern'),chosen.get('group'),chosen.get('anchor',False)) != metadata:
            issue('exercise-metadata:'+name, f'{name}: historical metadata differs; preserved on each original set')
        if name in ex_map and ex_map[name] != chosen['id']:
            issue('exercise-identity:'+name, f'{name}: different IDs retained based on stable backup set IDs')
        ex_map[name]=chosen['id'];r['_exId']=chosen['id']
    report['exerciseMapping']=[{'name':n,'id':i} for n,i in sorted(ex_map.items())]
    reference_names={e['name'] for e in source['exercises']}
    report['historicalNamesMissingReference']=sorted(set(ex_map)-reference_names)
    if not backup:
        issue('phone-backup-missing','Phone backup absent: custom IDs, local-only records, custom routines and active workout have not been reconciled.')
    routines={}
    for r in source['routines']:
        k=(str(r['routine_id']),r['split'])
        routine=routines.setdefault(k,{'id':k[0],'name':r['routine_name'],'split':k[1],'blocks':[]})
        routine['blocks'].append({'order':number(r['order']), 'exId':str(r['exercise_id']),
            'sets':number(r['sets']), 'repLow':number(r['rep_low']), 'repHigh':number(r['rep_high']),
            'progression':r['progression'], 'increment':number(r['increment_lb'])})
    db['routines']=list(routines.values())
    def routine_id(value, split):
        if not value: return None
        matches=[r for r in db['routines'] if r['split']==split and value in (r['id'],r['name'])]
        if len(matches)==1: return matches[0]['id']
        issue('routine:'+str(value)+':'+split,'Unresolved historical routine reference retained: '+str(value))
        return str(value)
    for r in source['sessions']:
        sid=str(r['session_id'])
        if excluded('sessions',sid): continue
        add('sessions', {'id':sid,'date':date(r['date']),'type':r['split'],'status':r['status'] or 'completed',
            'routineId':routine_id(r['routine'],r['split']),
            'readiness':{'sleep':number(r['sleep_1_5'],0),'soreness':number(r['soreness_1_5'],0),'stress':number(r['stress_1_5'],0)},
            'bodyweight':number(r['bodyweight_lb']),'notes':r['notes'] or '', 'startedAt':None,'endedAt':None,
            'durationMinutes':number(r['duration_min']),'entries':[], '_source':raw(r)})
    ids=set()
    for r in source['sets']:
        sid,stid=str(r['session_id']),str(r['set_uid'])
        if stid in ids: errors.append('Duplicate source set ID '+stid)
        ids.add(stid)
        if sid in decisions.get('exclude',{}).get('sessions',[]): continue
        s=next((s for s in db['sessions'] if s['id']==sid),None)
        if s is None:
            errors.append('Orphan set '+stid+' in session '+sid); continue
        if s['date'] != date(r['date']) or s['type'] != r['split'] or s['status'] != r['status']:
            errors.append('Set/session date, type or status mismatch: '+stid)
        e=next((e for e in s['entries'] if e['exId']==r['_exId']),None)
        plan={'targetWeight':number(r['plan_weight']), 'repLow':number(r['plan_rep_low']), 'repHigh':number(r['plan_rep_high'])}
        if e is None:
            e={'exId':r['_exId'],'plan':plan if any(v is not None for v in plan.values()) else None,'sets':[]};s['entries'].append(e)
        w,reps=number(r['weight_lb']),number(r['reps'])
        if w is None or w<0 or reps is None or not isinstance(reps,int) or reps<=0: errors.append('Invalid weight/reps '+stid)
        e['sets'].append({'id':stid,'w':w,'r':reps,'rpe':number(r['rpe']),'warmup':flag(r['warmup']),
                          't':stamp(r['logged_at']), '_source':raw(r)})
    for s in db['sessions']:
        work=[st for e in s['entries'] for st in e['sets'] if not st['warmup']]
        volume=sum((st['w'] or 0)*(st['r'] or 0) for st in work)
        if number(s['_source']['total_sets']) != len(work) or abs(number(s['_source']['total_volume_lb'],0)-volume)>0.11:
            issue('session-totals:'+s['id'], f'{s["id"]}: session claims {s["_source"]["total_sets"]} sets / {s["_source"]["total_volume_lb"]} volume; rows contain {len(work)} / {volume}.')
    maps={'cardio':('cardio_id',{'miles':'miles','minutes':'minutes','effort':'effort_1_10','avgHr':'avg_hr'}),
          'body':('body_id',{'weight':'weight_lb','bf':'body_fat_pct','waist':'waist_in'})}
    for table,(id_col,fields) in maps.items():
        for r in source[table]:
            rid=str(r[id_col])
            if excluded(table,rid): continue
            obj={'id':rid,'date':date(r['date']),**{k:number(r[v]) for k,v in fields.items()},'_source':raw(r)}
            if table=='cardio': obj['notes']=r.get('notes') or ''
            add(table,obj)
    if template:
        for table,idcol in [('sessions','session_id'),('cardio','cardio_id'),('body','body_id')]:
            template_ids={str(r[idcol]) for r in template[table]}
            for r in db[table]:
                if r['id'] in template_ids: issue('template:'+table+':'+r['id'],f'{table}/{r["id"]} also exists in supplied template; review before importing.')
    merge_backup(db,backup,report['conflicts'])
    ex_ids={e['id'] for e in db['exercises']}; all_sets={}
    for s in db['sessions']+([db['active']] if db['active'] else []):
        for e in s['entries']:
            if e['exId'] not in ex_ids: errors.append('Missing exercise '+e['exId'])
            for st in e['sets']:
                if st['id'] in all_sets: errors.append('Duplicate destination set '+st['id'])
                all_sets[st['id']]=(s['id'],e['exId'],st)
    for r in db['routines']:
        for b in r['blocks']:
            if b['exId'] not in ex_ids: errors.append('Missing routine exercise '+b['exId'])
    for r in source['sets']:
        if str(r['session_id']) in decisions.get('exclude',{}).get('sessions',[]): continue
        found=all_sets.get(str(r['set_uid']))
        if not found or found[0]!=str(r['session_id']) or found[1]!=r['_exId']:
            errors.append('Source-to-destination association failed: '+str(r['set_uid']))
        elif (found[2]['w'],found[2]['r'],found[2]['warmup'],found[2]['rpe']) != (number(r['weight_lb']),number(r['reps']),flag(r['warmup']),number(r['rpe'])):
            errors.append('Source set facts changed: '+str(r['set_uid']))
    report['review']=list({r['code']:r for r in review}.values())
    report['unresolved']=[r for r in report['review'] if r['code'] not in decisions.get('acknowledge',[])]
    report['destinationCounts']={t:len(db[t]) for t in TABLES}
    sets=[st for s in db['sessions'] for e in s['entries'] for st in e['sets']]
    report['destinationCounts'].update(sets=len(sets),workingSets=sum(not s['warmup'] for s in sets),warmups=sum(s['warmup'] for s in sets))
    report['blocked']=bool(errors or report['conflicts'] or report['unresolved'])
    db['migrationReview']={'blocked':report['blocked'],'sourceSha256':decisions.get('_sourceSha256'), 'reviewCodes':[r['code'] for r in report['review']]}
    return db,report

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--xlsx',required=True);p.add_argument('--backup');p.add_argument('--template');p.add_argument('--catalog');p.add_argument('--decisions');p.add_argument('--out',required=True)
    args=p.parse_args();out=pathlib.Path(args.out);out.mkdir(parents=True,exist_ok=True)
    load=lambda path: json.loads(pathlib.Path(path).read_text()) if path else None
    decisions=load(args.decisions) or {};decisions['_sourceSha256']=hashlib.sha256(pathlib.Path(args.xlsx).read_bytes()).hexdigest()
    source=read_workbook(args.xlsx)
    db,report=build(source,load(args.backup),decisions,read_workbook(args.template) if args.template else None,load(args.catalog))
    report['sourceSha256']=decisions['_sourceSha256']
    for name,obj in [('candidate.json',db),('report.json',report),('source-archive.json',source)]:
        (out/name).write_text(json.dumps(obj,indent=2,ensure_ascii=False,default=serial)+'\n')
    print(json.dumps({k:report[k] for k in ['sourceCounts','destinationCounts','blocked','errors','unresolved']},indent=2))
    raise SystemExit(2 if report['blocked'] else 0)

if __name__=='__main__': main()
