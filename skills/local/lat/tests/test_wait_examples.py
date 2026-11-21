"""Check documented wait commands against the watcher's actual CLI parser."""
import argparse
import importlib.util
from pathlib import Path
import re
import shlex
import sys
import unittest
from unittest.mock import patch


LAT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('lat_watch_examples', LAT / 'scripts/lat-watch.py')
WATCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WATCH)


class Parsed(Exception):
    pass


def examples(text):
    text = re.sub(r'\\\s*\n\s*', ' ', text)
    return re.findall(r'lat-watch\.py"?\s+wait\b([^`\n]*)', text)


def parse_example(arguments):
    if '…' in arguments:
        raise ValueError('example contains an ellipsis')
    arguments = re.sub(r'<[^>]+>', 'dummy', arguments)
    arguments = re.sub(r'\$\{?\w+\}?', 'dummy', arguments)
    argv = ['lat-watch.py', 'wait', *shlex.split(arguments)]
    original = argparse.ArgumentParser.parse_args

    def capture(parser, *args, **kwargs):
        original(parser, *args, **kwargs)
        raise Parsed

    with patch.object(sys, 'argv', argv), patch.object(argparse.ArgumentParser, 'parse_args', capture):
        try:
            WATCH.main()
        except Parsed:
            return
    raise AssertionError('parser did not run')


class WaitExamplesTest(unittest.TestCase):
    def test_documented_examples_parse(self):
        paths = [LAT / 'SKILL.md', *(LAT / 'references').rglob('*.md')]
        found = 0
        for path in paths:
            for arguments in examples(path.read_text()):
                found += 1
                with self.subTest(file=path, arguments=arguments):
                    parse_example(arguments)
        self.assertGreater(found, 0, 'no wait examples found')

    def test_extraction_and_rejection(self):
        sample = '`lat-watch.py wait --workspace "$workspace" --agent <name> --reason \'<reason>\'`\n'
        sample += 'lat-watch.py" wait --workspace "$workspace" \\\n --agent <name> --reason \'ok\'\n'
        self.assertEqual(len(examples(sample)), 2)
        for args in examples(sample):
            parse_example(args)
        with self.assertRaises(ValueError):
            parse_example(' … --for-pending')
        with self.assertRaises(SystemExit):
            parse_example(' --agent dummy --reason dummy')


if __name__ == '__main__':
    unittest.main()
