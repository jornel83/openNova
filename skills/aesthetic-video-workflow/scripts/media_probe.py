"""Inspect a local video and sample frames without uploading anything."""
from pathlib import Path
import argparse,json,os,shutil,subprocess

def executable(var,name):
    value=os.environ.get(var) or shutil.which(name)
    if not value:raise SystemExit(f'Install {name} on PATH or set {var}.')
    return value

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('video',type=Path)
    p.add_argument('--out',type=Path,required=True)
    p.add_argument('--sample-fps',type=float,default=2)
    a=p.parse_args()
    if not a.video.is_file():p.error('Input video not found.')
    if not 0<a.sample_fps<=30:p.error('sample-fps must be between 0 and 30.')
    if a.out.exists() and any(a.out.iterdir()):p.error('Use a new or empty output directory.')
    a.out.mkdir(parents=True,exist_ok=True)
    ff=executable('FFMPEG_BIN','ffmpeg');probe=executable('FFPROBE_BIN','ffprobe')
    data=json.loads(subprocess.check_output([probe,'-v','error','-show_format','-show_streams','-of','json',str(a.video)],text=True,encoding='utf-8'))
    (a.out/'metadata.json').write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    subprocess.run([ff,'-hide_banner','-loglevel','error','-n','-i',str(a.video),'-vf',f'fps={a.sample_fps},scale=360:-2','-q:v','3',str(a.out/'sample_%05d.jpg')],check=True)
    records=[{'file':x.name,'nominal_seconds':round(i/a.sample_fps,4)} for i,x in enumerate(sorted(a.out.glob('sample_*.jpg')))]
    (a.out/'samples.json').write_text(json.dumps({'method':'uniform interval samples; exact boundaries need frame-level review','sample_fps':a.sample_fps,'frames':records},indent=2),encoding='utf-8')
    print(json.dumps({'output':str(a.out.resolve()),'sampled_images':len(records),'audio_transcribed':False},ensure_ascii=True))

if __name__=='__main__':main()
