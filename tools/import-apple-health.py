#!/usr/bin/env python3
"""Prepare/verify weekly Apple Health exports locally; upload is a separate command."""
import argparse,json,os,sqlite3,sys
from pathlib import Path
from apple_health.native import prepare
from apple_health.transfer import verify_plan,upload,restore

def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='command',required=True)
    p=sub.add_parser('prepare');p.add_argument('source',type=Path);p.add_argument('--destination',type=Path,required=True)
    for name in ('verify','review','upload','restore'):
        p=sub.add_parser(name);p.add_argument('prepared',type=Path)
        if name=='upload':
            p.add_argument('--credentials',type=Path,required=True);p.add_argument('--projection',choices=['all','workouts','none'],default='all');p.add_argument('--database-budget-mb',type=int,default=450);p.add_argument('--limit',type=int)
        if name=='restore':p.add_argument('--destination',type=Path,required=True)
    args=parser.parse_args()
    progress=lambda event:print(json.dumps(event),file=sys.stderr,flush=True)
    if args.command=='prepare':result=prepare(args.source,args.destination,progress)
    elif args.command=='verify':result=verify_plan(args.prepared)
    elif args.command=='upload':result=upload(args.prepared,args.credentials,args.projection,args.database_budget_mb,args.limit,progress)
    elif args.command=='restore':result=restore(args.prepared,args.destination)
    else:
        conn=sqlite3.connect(args.prepared/'staging.sqlite3')
        result=json.loads(conn.execute("select value from meta where key='report'").fetchone()[0]);conn.close()
    print(json.dumps(result))

if __name__=='__main__':
    try:main()
    except KeyboardInterrupt:print('Interrupted. Uploaded batches remain resumable.',file=sys.stderr);sys.exit(130)
    except Exception as exc:
        # Only our static error codes may be printed. Never print XML, record values or HTTP bodies.
        code=str(exc) if type(exc) in (ValueError,) or exc.__class__.__name__=='TransferError' else exc.__class__.__name__
        if not code.replace('_','').isalnum():code=exc.__class__.__name__
        print('Import stopped: '+code,file=sys.stderr);sys.exit(1)
