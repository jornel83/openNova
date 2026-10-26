"""Conservative interruption evidence; this is not speaker/distance recognition."""
from array import array
import math
import sys

PAUSE_MS = 256
FAST_MS = 96
STABLE_SECONDS = .16
PAUSE_TIMEOUT = 1.2
STOP_WORDS = {'停', '停止', '停一下', '暂停', '等等', '等一下', '先停一下', '别说了', 'stop'}
FILLERS = set('嗯啊哦噢呃额唉哎')


class AcousticEvidence:
    """Estimate background only on non-speech; measure consecutive strong frames."""
    def __init__(self):
        self.noise_dbfs = -60.0
        self.run_ms = 0

    def measure(self, frame, probability):
        samples = array('h', frame)
        if sys.byteorder != 'little': samples.byteswap()
        rms = math.sqrt(sum(value*value for value in samples)/len(samples))/32768
        level = max(-90.0, 20*math.log10(max(rms, 1e-9)))
        if probability < .2:
            # Track rises faster than falls, without learning speech as the noise floor.
            rate = .1 if level > self.noise_dbfs else .02
            self.noise_dbfs += rate*(max(-80.0, level)-self.noise_dbfs)
        strong = probability >= .65 and level >= max(-55.0, self.noise_dbfs+8)
        self.run_ms = self.run_ms+32 if strong else 0
        return {'strong_ms':self.run_ms, 'probability':round(probability,3),
                'rms_dbfs':round(level,1), 'noise_dbfs':round(self.noise_dbfs,1)}


class BargeInCandidate:
    def __init__(self):
        self.acoustic = {'strong_ms':0}
        self.anchor = ''
        self.anchor_at = 0
        self.pause_expired = False

    def update(self, event):
        if 'acoustic' in event:
            self.acoustic = event['acoustic']
        if event['type'] not in ('partial','final'): return False
        text = ''.join(c for c in event.get('text','').lower() if c.isalnum())
        strong_ms = self.acoustic.get('strong_ms',0)
        if text in STOP_WORDS and strong_ms >= FAST_MS: return True
        meaningful = ''.join(c for c in text if c not in FILLERS)
        if len(meaningful) < 2:
            self.anchor = ''
            return False
        stable = bool(self.anchor and meaningful.startswith(self.anchor)
                      and event['time']-self.anchor_at >= STABLE_SECONDS)
        if not self.anchor or not meaningful.startswith(self.anchor):
            self.anchor, self.anchor_at = meaningful[:2], event['time']
        return strong_ms >= PAUSE_MS and (event['type']=='final' or stable)

    @property
    def can_pause(self):
        return not self.pause_expired and self.acoustic.get('strong_ms',0) >= PAUSE_MS
