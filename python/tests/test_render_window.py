"""Displayed window for a locus-string request (view.py).

`show("chr:START-END")` must display the EXACT window, not the data's min/max +
padding. A too-small request widens to a minimum span centered on the requested
midpoint. Pure staticmethod — no session needed.
"""
from genomeshader.view import GenomeShader

_win = GenomeShader._displayed_window_for_request


def test_exact_window_preserved():
    assert _win(("Pf3D7_01_v3", 100000, 101000)) == ("Pf3D7_01_v3", 100000, 101000)


def test_window_at_or_above_min_unchanged():
    assert _win(("chr1", 100, 200)) == ("chr1", 100, 200)  # span 100 >= 40


def test_tiny_request_widened_and_centered():
    c, s, e = _win(("chr1", 1000, 1000))  # single position
    assert (c, s, e) == ("chr1", 980, 1020)  # 40bp centered on 1000
    assert e - s == 40


def test_start_clamped_to_one():
    c, s, e = _win(("chr1", 5, 5))  # near contig start
    assert s >= 1
    assert c == "chr1"


def test_custom_min_window():
    c, s, e = _win(("chr1", 500, 510), min_window_bp=100)  # span 10 < 100
    assert e - s == 100 and (s + e) // 2 == 505
