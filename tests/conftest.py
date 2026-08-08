import pathlib
import sys

# make `model.python` importable regardless of pytest rootdir handling
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
