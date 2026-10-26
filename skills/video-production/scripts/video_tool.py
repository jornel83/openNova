#!/usr/bin/env python3
"""Locate the openNova implementation without duplicating its code."""
import os
from pathlib import Path
import sys

root = Path(os.environ.get('OPENNOVA_ROOT', Path(__file__).resolve().parents[3])).resolve()
if not (root / 'tools/video/tool.py').is_file():
    sys.exit('Set OPENNOVA_ROOT to the repository containing tools/video/tool.py.')
sys.path.insert(0, str(root))
from tools.video.tool import main

if __name__ == '__main__':
    sys.exit(main())
