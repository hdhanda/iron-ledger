import base64,gzip,json,sqlite3,sys,tempfile,unittest
from unittest.mock import patch
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
from apple_health.native import prepare,xml_items,digest,attributes_id
from apple_health.transfer import verify_plan,restore,upload,TransferError

XML='''<?xml version="1.0"?><!DOCTYPE HealthData [<!ELEMENT HealthData ANY>]><HealthData locale="en_US">
<ExportDate value="2024-01-01 00:00:00 +0000"/><Me HKCharacteristicTypeIdentifierBiologicalSex="Synthetic"/>
<Record type="HKQuantityTypeIdentifierFutureMetric" unit="custom" value="7.25" sourceName="Synthetic Watch" startDate="2024-01-01 01:00:00 +0000" endDate="2024-01-01 01:00:01 +0000"><MetadataEntry key="future" value="retained"/><HeartRateVariabilityMetadataList><InstantaneousBeatsPerMinute bpm="60" time="01:00:00.123"/></HeartRateVariabilityMetadataList></Record>
<Record type="HKCategoryTypeIdentifierSleepAnalysis" value="HKCategoryValueSleepAnalysisAsleepCore" sourceName="Synthetic Watch" startDate="2024-01-01 01:00:00 +0000" endDate="2024-01-01 02:00:00 +0000"/>
<Workout workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="Synthetic Watch" duration="30" durationUnit="min" startDate="2024-01-01 01:00:00 +0000" endDate="2024-01-01 01:30:00 +0000"><WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="5" unit="km" startDate="2024-01-01 01:00:00 +0000" endDate="2024-01-01 01:30:00 +0000"/><WorkoutRoute><FileReference path="/workout-routes/synthetic.gpx"/></WorkoutRoute><WorkoutEvent type="pause" date="2024-01-01 01:05:00 +0000"/></Workout>
<FutureEvent arbitrary="retained"/>
</HealthData>'''
class NativeTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)/'source';self.root.mkdir();(self.root/'export.xml').write_text(XML)
  (self.root/'workout-routes').mkdir();(self.root/'workout-routes/synthetic.gpx').write_text('<gpx><trk/></gpx>');(self.root/'future.bin').write_bytes(bytes(range(256))*30)
  self.folder=Path(self.tmp.name)/'prepared'
 def tearDown(self):self.tmp.cleanup()
 def test_stream_nested_fidelity_roundtrip_and_repeat(self):
  report=prepare(self.root,self.folder);self.assertEqual(report['unique_observations'],2);self.assertEqual(report['unique_workouts'],1)
  self.assertEqual(verify_plan(self.folder)['verified_files'],3)
  restored=Path(self.tmp.name)/'restored';restore(self.folder,restored)
  for file in self.root.rglob('*'):
   if file.is_file():self.assertEqual(file.read_bytes(),(restored/file.relative_to(self.root)).read_bytes())
  self.assertEqual(prepare(self.root,self.folder),report)
  db=sqlite3.connect(self.folder/'staging.sqlite3');row=db.execute('select point_json from observations where value_numeric is not null').fetchone();p=json.loads(gzip.decompress(row[0]));db.close()
  self.assertFalse(p['is_aggregated']);self.assertEqual(p['native']['children'][0]['attributes']['value'],'retained');self.assertEqual(p['native']['children'][1]['children'][0]['attributes']['time'],'01:00:00.123')
 def test_new_metric_queries_without_schema_change(self):
  prepare(self.root,self.folder);db=sqlite3.connect(self.folder/'staging.sqlite3')
  self.assertEqual(db.execute('select value_numeric,unit from observations where metric_name=?',('HKQuantityTypeIdentifierFutureMetric',)).fetchone(),(7.25,'custom'))
  self.assertEqual(db.execute('select count(*) from observations where value_numeric is null').fetchone()[0],1);db.close()
 def test_reject_entity_and_symlink_and_corrupt_archive(self):
  (self.root/'export.xml').write_text('<!DOCTYPE HealthData [<!ENTITY e "bad">]><HealthData>&e;</HealthData>')
  with self.assertRaises(ValueError):list(xml_items(self.root/'export.xml'))
  (self.root/'export.xml').write_text(XML);(self.root/'link').symlink_to('/etc/hosts')
  with self.assertRaises(ValueError):prepare(self.root,self.folder)
  (self.root/'link').unlink();prepare(self.root,self.folder)
  next((self.folder/'raw').glob('*.gz')).write_bytes(b'corrupted')
  with self.assertRaises(Exception):verify_plan(self.folder)
 def test_source_changes_do_not_reuse_stale_preparation(self):
  prepare(self.root,self.folder);(self.root/'future.bin').write_bytes(b'new')
  with self.assertRaises(ValueError):prepare(self.root,self.folder)
 def test_budget_refusal_happens_before_network(self):
  prepare(self.root,self.folder);credentials=Path(self.tmp.name)/'credentials.json';credentials.write_text(json.dumps({'endpoint':'https://armhlqarrdzioobepcng.supabase.co/functions/v1/import-health','phone_token':'synthetic'}))
  with self.assertRaisesRegex(TransferError,'budget'):upload(self.folder,credentials,database_budget_mb=0)
 def test_identity_ignores_device_memory_addresses_and_workout_stat_changes(self):
  import xml.etree.ElementTree as ET
  first=ET.fromstring('<Record type="new" device="&lt;HKDevice: 0xabc&gt;" value="1"/>')
  second=ET.fromstring('<Record type="new" device="&lt;HKDevice: 0xdef&gt;" value="1"/>')
  self.assertEqual(attributes_id(first),attributes_id(second))
  first=ET.fromstring('<Workout workoutActivityType="Running" startDate="start" endDate="end"><WorkoutStatistics sum="1"/></Workout>')
  second=ET.fromstring('<Workout workoutActivityType="Running" startDate="start" endDate="corrected"><WorkoutStatistics sum="2"/></Workout>')
  self.assertEqual(attributes_id(first),attributes_id(second))
 def test_weekly_reexport_skips_unchanged_readings_and_workouts(self):
  prepare(self.root,self.folder)
  credentials=Path(self.tmp.name)/'credentials.json';credentials.write_text(json.dumps({'endpoint':'https://armhlqarrdzioobepcng.supabase.co/functions/v1/import-health','phone_token':'synthetic'}))
  sent=[]
  class Response:
   def __enter__(self):return self
   def __exit__(self,*args):pass
   def read(self):return b'{"status":"completed"}'
  def fake(req,**kwargs):sent.append(json.loads(req.data));return Response()
  with patch('apple_health.transfer.urllib.request.urlopen',fake),patch('apple_health.transfer.time.sleep'):
   result=upload(self.folder,credentials);self.assertTrue(result['complete'])
   (self.root/'export.xml').write_text(XML.replace('2024-01-01 00:00:00 +0000','2024-01-08 00:00:00 +0000'))
   second=Path(self.tmp.name)/'week-two';prepare(self.root,second);sent.clear()
   result=upload(second,credentials);self.assertTrue(result['complete']);self.assertGreaterEqual(result['unchanged_rows_skipped'],3)
   self.assertFalse(any('metrics' in p['data'] or 'workouts' in p['data'] for p in sent))
 def test_finder_metadata_does_not_change_export_identity(self):
  first=prepare(self.root,self.folder);(self.root/'.DS_Store').write_bytes(b'finder metadata')
  self.assertEqual(prepare(self.root,self.folder),first)
if __name__=='__main__':unittest.main()
