#!/usr/bin/env python3
"""Locate the openNova implementation without duplicating its code."""
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[3]
if not (root / 'tools/video/tool.py').is_file():
    sys.exit('Incomplete OpenNova source: tools/video/tool.py is missing.')
sys.path.insert(0, str(root))
from tools.video.tool import main

if __name__ == '__main__':
    sys.exit(main())
