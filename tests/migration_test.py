import sys, pathlib, unittest, copy, datetime as dt
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'tools'))
from migrate import build, date

class MigrationTests(unittest.TestCase):
    def source(self):
        return {'exercises':[{'exercise_id':'bench','name':'Bench','pattern':'Horizontal Push','group':'Push','anchor':'Y'}],
          'routines':[], 'sessions':[{'session_id':'sess','date':dt.datetime(2026,10,7),'split':'Push','status':'completed','routine':None,
             'sleep_1_5':3,'soreness_1_5':2,'stress_1_5':1,'bodyweight_lb':170,'duration_min':30,'notes':'note','total_sets':1,'total_volume_lb':800}],
          'sets':[{'set_uid':'set1','session_id':'sess','date':'2026-10-07','split':'Push','status':'completed','routine':None,'exercise':'Bench',
             'pattern':'Horizontal Push','group':'Push','anchor':'Y','set_no':1,'warmup':'N','weight_lb':100,'reps':8,'rpe':8,'e1rm':126.7,'volume_lb':800,
             'plan_weight':None,'plan_rep_low':None,'plan_rep_high':None,'logged_at':'2026-10-08T02:12:00Z'}], 'cardio':[], 'body':[]}
    def test_dates_and_complete_reconstruction(self):
        db,r=build(self.source())
        self.assertEqual(r['errors'],[]);self.assertEqual(db['sessions'][0]['date'],'2026-10-07')
        self.assertEqual(db['sessions'][0]['entries'][0]['sets'][0]['id'],'set1')
        self.assertEqual(date(46302),'2026-10-07')
        self.assertEqual(r['destinationCounts']['workingSets'],1)
    def test_preserve_similar_names_and_warmups(self):
        src=self.source();second=copy.deepcopy(src['sets'][0]);second.update(set_uid='set2',exercise='Benchh',warmup='Y');src['sets'].append(second)
        db,r=build(src);self.assertEqual(len(db['exercises']),2);self.assertEqual(r['destinationCounts']['warmups'],1)
        self.assertEqual(r['errors'],[])
    def test_stable_backup_id_and_unsynced_union(self):
        src=self.source();src['sets'][0]['exercise']='Custom bench';src['exercises']=[]
        db,r=build(copy.deepcopy(src));db['exercises'][0]['id']='phone-custom';db['sessions'][0]['entries'][0]['exId']='phone-custom'
        set2=copy.deepcopy(db['sessions'][0]['entries'][0]['sets'][0]);set2['id']='phone-only';db['sessions'][0]['entries'][0]['sets'].append(set2)
        merged,r=build(src,db);self.assertEqual(r['errors'],[]);self.assertEqual(r['conflicts'],[])
        self.assertEqual(merged['sessions'][0]['entries'][0]['exId'],'phone-custom')
        self.assertEqual(r['destinationCounts']['sets'],2)
    def test_orphans_duplicates_and_samples_require_review(self):
        src=self.source();src['sets'].append(copy.deepcopy(src['sets'][0]));_,r=build(src)
        self.assertTrue(r['blocked']);self.assertTrue(any('Duplicate' in e for e in r['errors']))
        src=self.source();src['sets'][0]['session_id']='orphan';_,r=build(src);self.assertTrue(any('Orphan' in e for e in r['errors']))
        src=self.source();_,r=build(src,template=src);self.assertTrue(any(x['code']=='template:sessions:sess' for x in r['review']))

if __name__=='__main__':unittest.main()
