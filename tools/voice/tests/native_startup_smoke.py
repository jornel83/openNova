#!/usr/bin/env python3
"""Explicit hardware smoke test: opens mic briefly; no ASR, recording or audible output.

Not part of unittest discovery. Run only when testing the local audio route.
"""
import asyncio
import argparse
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from audio_bridge import NativeAudio

async def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device')
    parser.add_argument('--output-device')
    args=parser.parse_args()
    audio=NativeAudio(device=args.device,output_device=args.output_device)
    try:
        info=await audio.start()
        assert info.get('voice_processing') is True, 'Voice Processing did not start'
        samples=0
        deadline=asyncio.get_running_loop().time()+1
        while asyncio.get_running_loop().time()<deadline:
            item=await asyncio.wait_for(audio.input.get(),2)
            if isinstance(item,Exception): raise item
            epoch,pcm=item
            assert epoch==0 and len(pcm)%2==0, 'Invalid capture PCM'
            samples+=len(pcm)//2
        assert samples>0, 'No captured PCM received'
        await audio.clear(1)
        assert await audio.write(bytes(4800),1,1), 'Silent playback buffer rejected'
        await asyncio.wait_for(audio.drained(1),3)
        await audio.capture(False,1)
        await asyncio.sleep(.1)
        assert audio.input.empty(), 'Muted capture still delivered PCM'
        print(json.dumps({'ready':True,'input':info['input'],'output':info['output'],
                          'voice_processing':True,'capture_samples':samples,
                          'silent_playback_drained':True,'mute_verified':True,
                          'recording_saved':False,'asr_used':False},ensure_ascii=False))
    finally:
        await audio.close()

if __name__=='__main__': asyncio.run(main())
