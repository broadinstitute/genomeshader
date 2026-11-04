"""Sample-selection strategies: seeded reproducibility and balanced groups.

A dossier page must show the same samples every time it is regenerated, so with
`selection_seed` set every strategy is a pure function of (seed, inputs). The
`balanced_groups` strategy splits the budget across the levels of a metadata
column (e.g. case/control) instead of carrier/non-carrier.
"""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402
import harness  # noqa: E402

CASES = [f"C{i:02d}" for i in range(10)]
CONTROLS = [f"K{i:02d}" for i in range(10)]
UNLABELED = ["U00", "U01"]
POOL = CASES + CONTROLS + UNLABELED

METADATA = {
    "columns": [
        {"name": "status", "values": [
            {"value": "control", "count": len(CONTROLS), "color": "#1f77b4"},
            {"value": "case", "count": len(CASES), "color": "#d62728"},
        ]},
        {"name": "ancestry", "values": [
            {"value": "EUR", "count": 11, "color": "#2ca02c"},
            {"value": "AFR", "count": 11, "color": "#9467bd"},
        ]},
    ],
    "by_id": {
        **{s: {"status": "case", "ancestry": "EUR" if i % 2 else "AFR"} for i, s in enumerate(CASES)},
        **{s: {"status": "control", "ancestry": "AFR" if i % 2 else "EUR"} for i, s in enumerate(CONTROLS)},
    },
}


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch(args=harness.CHROMIUM_ARGS)
        except Exception as e:  # pragma: no cover
            pytest.skip(f"headless chromium unavailable: {e}")
        yield b
        b.close()


@pytest.fixture(scope="module")
def page(browser, tmp_path_factory):
    p = browser.new_page()
    p.goto(harness.write_page(tmp_path_factory.mktemp("sel"), harness.build_page()))
    p.wait_for_function("() => window.__GS_READY === true || !!window.__GS_ERR", timeout=30000)
    assert p.evaluate("() => window.__GS_ERR") is None
    yield p
    p.close()


def _select(page, strategy, n, seed=None, balance=None, pool=POOL, color=None):
    return page.evaluate(
        """([strategy, n, seed, balance, pool, meta, color]) => {
          const cfg = window.GENOMESHADER_CONFIG;
          cfg.sample_metadata = meta;
          if (seed == null) delete cfg.selection_seed; else cfg.selection_seed = seed;
          if (balance == null) delete cfg.selection_balance_column; else cfg.selection_balance_column = balance;
          window.__GS_STATE.colorFacetKey = color;
          // No read universe in the demo page: every sample is eligible.
          delete cfg.read_samples; delete cfg.read_bam_index; delete cfg.sample_mapping;
          return window.selectSamplesForStrategy(strategy, pool, n);
        }""",
        [strategy, n, seed, balance, pool, METADATA, color],
    )


@pytest.mark.parametrize("strategy", ["random", "most_diverse", "balanced_groups"])
def test_seeded_selection_is_reproducible(page, strategy):
    a = _select(page, strategy, 8, seed="BI_164_2__chr6_92585596", balance="status")
    b = _select(page, strategy, 8, seed="BI_164_2__chr6_92585596", balance="status")
    assert a == b and len(a) == 8 and len(set(a)) == 8


def test_different_seeds_pick_differently(page):
    picks = {tuple(_select(page, "random", 8, seed=f"locus_{i}")) for i in range(6)}
    assert len(picks) > 1


def test_unseeded_random_still_works(page):
    out = _select(page, "random", 5)
    assert len(out) == 5 and set(out) <= set(POOL)


def test_balanced_groups_splits_budget_across_levels(page):
    out = _select(page, "balanced_groups", 8, seed="s", balance="status")
    assert sum(s in CASES for s in out) == 4
    assert sum(s in CONTROLS for s in out) == 4
    # Grouped by level for a readable page; unlabeled samples are never picked.
    levels = ["case" if s in CASES else "control" for s in out]
    assert levels == sorted(levels, key=levels.index)
    assert not set(out) & set(UNLABELED)


def test_balanced_groups_backfills_a_short_level(page):
    pool = CASES[:2] + CONTROLS
    out = _select(page, "balanced_groups", 8, seed="s", balance="status", pool=pool)
    assert sum(s in CASES for s in out) == 2
    assert sum(s in CONTROLS for s in out) == 6


def test_balanced_groups_uses_explicit_column_over_color(page):
    # Ancestry is the colour; status must still drive the split.
    out = _select(page, "balanced_groups", 6, seed="s", balance="status", color="ancestry")
    assert sum(s in CASES for s in out) == 3


def test_balanced_groups_falls_back_to_color_column(page):
    out = _select(page, "balanced_groups", 6, seed="s", color="ancestry")
    eur = [s for s in out if METADATA["by_id"][s]["ancestry"] == "EUR"]
    assert len(eur) == 3
