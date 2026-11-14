"""Run a LAT script as __main__ from cached bytecode, for tests that call it many times.

`python script.py` compiles the whole script on every start (about 0.1-0.2s for the large
LAT scripts); importing it by path reuses the __pycache__ copy. The script still runs as
__main__ with the same argv, __file__ and sys.path[0] as a direct start.

    subprocess.run(cached_script.command(SCRIPT, 'show', ...))
"""
import importlib.util
from pathlib import Path
import sys

HERE = Path(__file__).resolve()


def command(script, *args):
    """argv that runs `script` with `args`, like [sys.executable, script, *args]."""
    return [sys.executable, str(HERE), str(script), *map(str, args)]


if __name__ == '__main__':
    script = sys.argv[1]
    sys.argv = sys.argv[1:]
    sys.path[0] = str(Path(script).resolve().parent)
    spec = importlib.util.spec_from_file_location('__main__', script)
    module = importlib.util.module_from_spec(spec)
    sys.modules['__main__'] = module
    spec.loader.exec_module(module)
