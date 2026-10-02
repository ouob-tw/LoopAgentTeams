"""CJK-aware soft-wrap chunks for the panel's Textual TextArea (display only).

Textual 8.2.8 has no public hook for TextArea wrapping. ``WrappedDocument``
calls ``textual._wrap.compute_wrap_offsets``, which splits lines with the
module-level ``chunks`` function at whitespace only, so a space-free CJK run
moves to the next line as one word. ``install()`` replaces that private
``chunks`` (used only by ``WrappedDocument``) with one that also allows breaks
between CJK characters; Textual's own placement, folding, tab and cell-width
logic stays unchanged. ``tests/test_lat_panel_ui.py`` pins this hook to
textual==8.2.8.
"""
import re
import unicodedata

from textual import _wrap

TEXTUAL_CHUNKS = _wrap.chunks
# Same chunks as Textual's ``re_chunk`` (``\S+\s*|\s+``), with the word captured.
RE_CHUNK = re.compile(r"(\S+)\s*|\s+")

# Basic kinsoku: these never start a line ...
CJK_NO_START = frozenset("，。、；：！？）］｝〉》」』】〕〗〙〟”’…‥｡､．・")
# ... and these never end one.
CJK_NO_END = frozenset("（［｛〈《「『【〔〖〘〝“‘")
# ASCII closing/opening marks only matter next to CJK, where a new break would
# otherwise appear (``GitHub）`` / ``中文)``); breaks at spaces keep Textual's rules.
NO_START = CJK_NO_START | frozenset(")]},.;:!?%")
NO_END = CJK_NO_END | frozenset("([{")


def is_cjk(character):
    """Wide/fullwidth/halfwidth-form characters: Han, Kana, Hangul, CJK punctuation."""
    return unicodedata.east_asian_width(character) in ("W", "F", "H")


def _break_between(before, after):
    if after in NO_START or before in NO_END:
        return False
    return is_cjk(before) or is_cjk(after)


def chunks(text):
    """Yield ``(start, end, chunk)`` like ``textual._wrap.chunks``, split further
    between CJK characters; trailing whitespace stays on the last piece."""
    if not text:
        return
    cuts = []
    previous = ""  # last non-space character before the current chunk
    for match in RE_CHUNK.finditer(text):
        start = match.start()
        if start and text[start] not in CJK_NO_START and previous not in CJK_NO_END:
            cuts.append(start)
        if match.group(1):
            cuts.extend(
                position for position in range(start + 1, match.end(1))
                if _break_between(text[position - 1], text[position])
            )
            previous = text[match.end(1) - 1]
    bounds = [0, *cuts, len(text)]
    for start, end in zip(bounds, bounds[1:]):
        yield start, end, text[start:end]


def install():
    _wrap.chunks = chunks
