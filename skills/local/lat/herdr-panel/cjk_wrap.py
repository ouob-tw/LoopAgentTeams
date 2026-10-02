"""CJK-aware soft wrap for the panel's Textual TextArea (display only).

Textual 8.2.8 has no public hook for TextArea wrapping. ``WrappedDocument``
calls ``textual._wrap.compute_wrap_offsets``, which splits lines with the
module-level ``chunks`` function at whitespace only, so a space-free CJK run
moves to the next line as one word. ``install()`` points the document's private
``compute_wrap_offsets`` name at Textual's own function run with this module's
``chunks``, which also breaks between CJK characters and pre-folds over-wide
pieces at kinsoku-safe positions. Textual's placement, tab and cell-width logic
stays in use; the ``textual._wrap`` module itself is not modified.
``tests/test_lat_panel_wrap.py`` pins these internals to textual==8.2.8.
"""
from types import FunctionType
import re
import unicodedata

from rich.cells import get_character_cell_size
from textual import _wrap
from textual.document import _wrapped_document
from textual.expand_tabs import get_tab_widths

# Same chunks as Textual's ``re_chunk`` (``\S+\s*|\s+``), with the word captured.
RE_CHUNK = re.compile(r"(\S+)\s*|\s+")

# Basic kinsoku: these never start a line ...
CJK_NO_START = frozenset("，。、；：！？）］｝〉》」』】〕〗〙〟”’…‥｡､．・")
# ... and these never end one.
CJK_NO_END = frozenset("（［｛〈《「『【〔〖〘〝“‘")
KINSOKU_MARKS = CJK_NO_START | CJK_NO_END
# ASCII closing/opening marks only matter next to CJK, where a new break would
# otherwise appear (``GitHub）`` / ``中文)``); breaks at spaces and folds of
# over-wide words keep Textual's behaviour for them.
NO_START = CJK_NO_START | frozenset(")]},.;:!?%")
NO_END = CJK_NO_END | frozenset("([{")


def is_cjk(character):
    """Wide/fullwidth/halfwidth-form characters: Han, Kana, Hangul, CJK punctuation."""
    return unicodedata.east_asian_width(character) in ("W", "F", "H")


def _break_between(before, after):
    if after in NO_START or before in NO_END:
        return False
    return is_cjk(before) or is_cjk(after)


def _kinsoku_blocks(before, after):
    """Whether a space break or fold between these non-space characters
    violates CJK kinsoku."""
    return after in CJK_NO_START or before in CJK_NO_END


def _cell_widths(tab_sections):
    """Per-character cell widths of a line, tabs expanded as Textual does."""
    widths = []
    for section, tab_width in tab_sections:
        widths.extend(get_character_cell_size(character) for character in section)
        if tab_width:
            widths.append(tab_width)
    return widths


def _fold(text, start, end, width, widths):
    """Cut positions folding the piece ``text[start:end]`` to ``width`` like
    Textual, moving a cut back off a kinsoku position when the line allows it."""
    cuts = []
    line_start, used = start, 0
    for position in range(start, end):
        size = widths[position]
        if position > line_start and used + size > width:
            cut = position
            while cut > line_start and _kinsoku_blocks(text[cut - 1], text[cut]):
                cut -= 1
            line_start = cut if cut > line_start else position
            cuts.append(line_start)
            used = sum(widths[line_start:position])
        used += size
    return cuts


def chunks(text, width=None, widths=None):
    """Yield ``(start, end, chunk)`` like ``textual._wrap.chunks``, split further
    between CJK characters; trailing whitespace stays on the last piece. With
    ``width`` and the line's cell ``widths``, pieces wider than it that hold CJK
    marks are cut where Textual would fold them, kept off kinsoku positions."""
    if not text:
        return
    cuts = []
    previous = ""  # last non-space character before the current chunk
    for match in RE_CHUNK.finditer(text):
        start = match.start()
        if start and not _kinsoku_blocks(previous, text[start]):
            cuts.append(start)
        if match.group(1):
            cuts.extend(
                position for position in range(start + 1, match.end(1))
                if _break_between(text[position - 1], text[position])
            )
            previous = text[match.end(1) - 1]
    bounds = [0, *cuts, len(text)]
    for start, end in zip(bounds, bounds[1:]):
        # Only pieces with CJK marks are pre-folded; others keep Textual's fold.
        folds = (
            _fold(text, start, end, width, widths)
            if width and sum(widths[start:end]) > width
            and not KINSOKU_MARKS.isdisjoint(text[start:end]) else []
        )
        for piece_start, piece_end in zip([start, *folds], [*folds, end]):
            yield piece_start, piece_end, text[piece_start:piece_end]


def compute_wrap_offsets(
    text, width, tab_size, fold=True, precomputed_tab_sections=None,
):
    """``textual._wrap.compute_wrap_offsets`` run with this module's ``chunks``."""
    # Same tab sections Textual measures with.
    widths = _cell_widths(
        precomputed_tab_sections or get_tab_widths(text, min(tab_size, width))
    )
    textual_compute = FunctionType(
        _wrap.compute_wrap_offsets.__code__,
        {**vars(_wrap), "chunks": lambda line: chunks(line, width, widths)},
    )
    return textual_compute(text, width, tab_size, fold, precomputed_tab_sections)


def install():
    _wrapped_document.compute_wrap_offsets = compute_wrap_offsets
