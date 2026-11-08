# macOS process-tree footprint and CPU sampler. 100% CPU is one logical core.
# Usage: python3 measure-macos.py --calibrate
#        python3 measure-macos.py stage.json samples.jsonl
# stage.json: {"roots": [123], "phase": "idle"}; finish with {"done": true}.
# CPU counters use the local mach timebase; always run calibration first.
# Only descendants of roots are counted; detached crash reporters are excluded.
import ctypes, subprocess, time, json, sys, os
from pathlib import Path
class Usage(ctypes.Structure):
 _fields_=[('uuid',ctypes.c_byte*16)]+[(n,ctypes.c_uint64) for n in ['user','system','pkg','interrupt','pageins','wired','resident','footprint','start','exit']]
class Timebase(ctypes.Structure):
 _fields_=[('numer',ctypes.c_uint32),('denom',ctypes.c_uint32)]
lib=ctypes.CDLL('/usr/lib/libproc.dylib'); kernel=ctypes.CDLL('/usr/lib/libSystem.B.dylib')
tb=Timebase(); kernel.mach_timebase_info(ctypes.byref(tb)); factor=tb.numer/tb.denom/1e9
if sys.argv[1]=='--calibrate':
 def read():
  u=Usage(); assert lib.proc_pid_rusage(os.getpid(),0,ctypes.byref(u))==0
  return u.user+u.system
 start=read(); cpu=time.process_time(); until=time.monotonic()+1
 while time.monotonic()<until: pass
 print(json.dumps({'factor':factor,'deltaRaw':read()-start,'convertedSeconds':(read()-start)*factor,'processTimeSeconds':time.process_time()-cpu})); sys.exit()
stage=Path(sys.argv[1]); output=Path(sys.argv[2]); previous={}; last=time.monotonic()
with output.open('w') as out:
 while True:
  try: s=json.loads(stage.read_text())
  except Exception: time.sleep(.2); continue
  if s.get('done'): break
  rows=subprocess.check_output(['ps','-axo','pid=,ppid=,command='],text=True)
  ps={}
  for row in rows.splitlines():
   v=row.strip().split(None,2)
   if len(v)==3: ps[int(v[0])]=(int(v[1]),v[2])
  selected=set(s.get('roots',[]))
  for _ in range(8):
   selected.update(pid for pid,(ppid,cmd) in ps.items() if ppid in selected)
  now=time.monotonic(); processes=[]
  for pid in selected:
   if pid not in ps: continue
   u=Usage()
   if lib.proc_pid_rusage(pid,0,ctypes.byref(u))!=0: continue
   ppid,cmd=ps[pid]; total=(u.user+u.system)*factor
   old=previous.get(pid); delta=max(0,total-old[0]) if old and old[1]==u.start else 0
   previous[pid]=(total,u.start)
   role='controller'
   if 'worker.js' in cmd: role='node-worker'
   elif '/moli' in cmd and 'serve' in cmd: role='moli'
   elif '--type=renderer' in cmd: role='renderer'
   elif '--type=gpu-process' in cmd: role='gpu'
   elif '--type=utility' in cmd: role='utility'
   elif 'crashpad' in cmd: role='crashpad'
   elif 'Chrome for Testing' in cmd: role='browser-main'
   processes.append(dict(pid=pid,ppid=ppid,role=role,footprint=u.footprint,resident=u.resident,cpuDelta=delta,cpuSeconds=total))
  out.write(json.dumps(dict(at=time.time()*1000,phase=s.get('phase'),cpuPercent=sum(p['cpuDelta'] for p in processes)/(now-last)*100,footprint=sum(p['footprint'] for p in processes),resident=sum(p['resident'] for p in processes),processCount=len(processes),processes=processes))+'\n');out.flush()
  last=now;time.sleep(.5)
