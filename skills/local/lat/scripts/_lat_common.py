"""Shared LAT storage, CLI, watcher identity and directory rules (stdlib only)."""
from datetime import datetime, timedelta
import json
import logging
import os
from pathlib import Path
import subprocess
import tempfile

_UNSET = object()


def _current_bytes(path):
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


def write_text_atomic(path, text, *, expected=_UNSET, mode=None):
    """Compare bytes and replace durably; callers own any surrounding lock."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    original = _current_bytes(path) if expected is _UNSET else expected
    if mode is None:
        mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                         delete=False) as stream:
            temporary = Path(stream.name)
            os.fchmod(stream.fileno(), mode)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
            if _current_bytes(path) != original:
                raise ValueError(f'Concurrent change detected: {path}; retry after inspection')
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        return text.encode('utf-8')
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def write_json_atomic(path, value, *, expected=_UNSET, mode=None):
    return write_text_atomic(path, json.dumps(value, indent=2, ensure_ascii=False) + '\n',
                             expected=expected, mode=mode)


def run_cli(command, *, timeout, failure=None, env=None):
    """Return stdout or raise ValueError using the watcher's error format."""
    try:
        result = subprocess.run(command, text=True, capture_output=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired as error:
        raise ValueError(f'{" ".join(command[:2])} timed out after {timeout} seconds') from error
    except OSError as error:
        raise ValueError(f'{failure or command[0] + " failed"}: {error}') from error
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip() or f'exit {result.returncode}'
        raise ValueError(f'{failure or command[0] + " failed"}: {detail}')
    return result.stdout


def shared_lat_dir(workspace):
    """One .lat per repository, in the main checkout; linked worktrees share it."""
    workspace = Path(workspace)
    if (workspace / '.git').is_file():
        common = run_cli(['git', '-C', str(workspace), 'rev-parse', '--path-format=absolute',
                          '--git-common-dir'], timeout=10).strip()
        return Path(common).parent / '.lat'
    return workspace / '.lat'


def process_starttime(pid):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rpartition(') ')[2].split()
        return None if fields[0] == 'Z' else int(fields[19])
    except (OSError, ValueError, IndexError):
        return None


def watcher_process_matches(pid, expected_args):
    """Reject missing/zombie/reused PIDs, then match the watcher argument slice."""
    try:
        if pid is None or int(pid) <= 1 or process_starttime(pid) is None:
            return False
        command = tuple(part.decode() for part in Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
                        if part)
        expected = tuple(expected_args)
        return any(Path(command[i]).name == 'lat-watch.py'
                   and command[i + 1:i + 1 + len(expected)] == expected
                   for i in range(len(command) - len(expected)))
    except (OSError, ValueError, UnicodeDecodeError):
        return False


def reports_directory(env=None):
    env = os.environ if env is None else env
    override = env.get('LAT_REPORTS_DIR')
    state = env.get('XDG_STATE_HOME')
    directory = (Path(override) if override else
                 (Path(state) if state and Path(state).is_absolute() else
                  Path.home() / '.local/state') / 'lat/reports')
    if not directory.is_absolute():
        raise ValueError('LAT_REPORTS_DIR must be absolute')
    return directory


def plugin_directory(kind, env=None):
    """Resolve lat.panel directories; config discovery has a ten second timeout."""
    env = os.environ if env is None else env
    variable = f'HERDR_PLUGIN_{kind.upper()}_DIR'
    if env.get(variable):
        return Path(env[variable]).expanduser()
    if kind == 'config':
        try:
            output = run_cli(['herdr', 'plugin', 'config-dir', 'lat.panel'], timeout=10, env=env)
            if output.strip():
                return Path(output.strip()).expanduser()
        except ValueError:
            pass
        base = Path(env.get('XDG_CONFIG_HOME', Path.home() / '.config'))
        return base / 'herdr/plugins/config/lat.panel'
    base = Path(env.get('XDG_STATE_HOME', Path.home() / '.local/state'))
    return base / 'herdr/plugins/lat.panel'


_PAUSE_WARNED = set()


def hcom_paused_dir():
    """Shared board/watcher pause records; only absolute overrides are accepted."""
    override = os.environ.get('LAT_HCOM_PAUSED_DIR', '')
    if override and Path(override).is_absolute():
        return Path(override)
    state = os.environ.get('XDG_STATE_HOME', '')
    root = Path(state) if state and Path(state).is_absolute() else Path.home() / '.local/state'
    return root / 'lat/hcom-paused'


def read_hcom_pauses(warn=None):
    """Read complete pause records by full HCOM name; warn once per invalid path.

    Missing records are normal. A repaired or removed file resets its warning.
    """
    warn = warn or (lambda path, error: logging.warning('Invalid HCOM pause record %s: %s', path, error))
    directory = hcom_paused_dir()
    invalid = set()

    def reject(path, error):
        key = str(path)
        invalid.add(key)
        if key not in _PAUSE_WARNED:
            warn(path, str(error))
            _PAUSE_WARNED.add(key)

    try:
        paths = sorted(directory.iterdir())
    except FileNotFoundError:
        paths = []
    except OSError as error:
        reject(directory, error)
        paths = []
    records = {}
    for path in paths:
        if path.suffix != '.json':
            continue
        try:
            record = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(record, dict):
                raise ValueError('expected an object')
            if any(not isinstance(record.get(field), str) or not record[field].strip()
                   for field in ('session_id', 'hcom_name', 'client', 'paused_at')):
                raise ValueError('missing or invalid pause field')
            if 'pane' not in record or (record['pane'] is not None
                                       and not isinstance(record['pane'], str)):
                raise ValueError('pane must be a string or null')
            if path.stem != record['session_id']:
                raise ValueError('session_id must match filename')
            paused_at = datetime.fromisoformat(record['paused_at'].replace('Z', '+00:00'))
            if paused_at.utcoffset() != timedelta(0):
                raise ValueError('paused_at must be UTC ISO 8601')
            records[record['hcom_name']] = record
        except (OSError, ValueError, TypeError) as error:
            reject(path, error)
    _PAUSE_WARNED.difference_update(
        key for key in tuple(_PAUSE_WARNED)
        if (key == str(directory) or str(Path(key).parent) == str(directory)) and key not in invalid)
    return records
