"""CJK-aware soft wrap for the panel's Textual TextArea (display only).

Textual 8.2.8 has no public hook for TextArea wrapping. ``WrappedDocument``
calls ``textual._wrap.compute_wrap_offsets``, which splits lines with the
module-level ``chunks`` function at whitespace only, so a space-free CJK run
moves to the next line as one word. ``install()`` replaces two private names
used only by ``WrappedDocument``: ``textual._wrap.chunks`` with one that also
allows breaks between CJK characters, and the document's
``compute_wrap_offsets`` with a wrapper that moves a character fold of an
over-wide word off a kinsoku position. Textual's own placement, folding, tab
and cell-width logic stays in use. ``tests/test_lat_panel_wrap.py`` pins these
hooks to textual==8.2.8.
"""
import re
import unicodedata

from textual import _wrap
from textual.document import _wrapped_document

TEXTUAL_CHUNKS = _wrap.chunks
TEXTUAL_COMPUTE_WRAP_OFFSETS = _wrap.compute_wrap_offsets
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


def _kinsoku_blocks(text, position):
    """Whether a break before ``text[position]`` violates CJK kinsoku; used at
    spaces and folds, where ASCII marks keep Textual's behaviour."""
    return (
        text[position] in CJK_NO_START
        or text[:position].rstrip()[-1:] in CJK_NO_END
    )


def chunks(text):
    """Yield ``(start, end, chunk)`` like ``textual._wrap.chunks``, split further
    between CJK characters; trailing whitespace stays on the last piece."""
    if not text:
        return
    cuts = []
    for match in RE_CHUNK.finditer(text):
        start = match.start()
        if start and not _kinsoku_blocks(text, start):
            cuts.append(start)
        if match.group(1):
            cuts.extend(
                position for position in range(start + 1, match.end(1))
                if _break_between(text[position - 1], text[position])
            )
    bounds = [0, *cuts, len(text)]
    for start, end in zip(bounds, bounds[1:]):
        yield start, end, text[start:end]


def compute_wrap_offsets(
    text, width, tab_size, fold=True, precomputed_tab_sections=None,
):
    """Textual's offsets, with folds inside an over-wide chunk moved back so a
    closing mark does not start a line nor an opening mark end one."""
    offsets = TEXTUAL_COMPUTE_WRAP_OFFSETS(
        text, width, tab_size, fold, precomputed_tab_sections
    )
    if "\t" in text:  # tab stops are relative to the document line; keep as is
        return offsets
    for index, offset in enumerate(offsets):
        if not _kinsoku_blocks(text, offset):
            continue
        line_start = offsets[index - 1] if index else 0
        moved = offset - 1
        while moved > line_start and _kinsoku_blocks(text, moved):
            moved -= 1
        if moved > line_start:
            rest = compute_wrap_offsets(text[moved:], width, tab_size, fold)
            return [*offsets[:index], moved, *(moved + rest_offset for rest_offset in rest)]
    return offsets


def install():
    _wrap.chunks = chunks
    _wrapped_document.compute_wrap_offsets = compute_wrap_offsets
