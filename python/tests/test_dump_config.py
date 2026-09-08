"""dump_config writes the last render config to JSON for verbatim harness replay.

Bound to a stub (no compiled extension / GCS session needed).
"""
import json
import types

import pytest

from genomeshader.view import GenomeShader


def _stub(cfg):
    o = types.SimpleNamespace()
    o._last_config = cfg
    o.dump_config = types.MethodType(GenomeShader.dump_config, o)
    return o


def test_writes_config_json(tmp_path):
    cfg = {"region": "chr1:100-200", "reference_data": "ACGT",
           "variant_tracks": [{"id": "flow-0", "variants_data": [{"pos": 150}]}]}
    o = _stub(cfg)
    p = o.dump_config(str(tmp_path / "c.json"))
    loaded = json.load(open(p))
    assert loaded == cfg


def test_raises_without_config():
    with pytest.raises(ValueError):
        _stub(None).dump_config("x.json")
