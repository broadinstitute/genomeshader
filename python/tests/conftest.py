import pytest


@pytest.fixture(autouse=True)
def _no_background_cred_refresh(monkeypatch):
    """GenomeShader auto-starts a background credential refresher for gs://
    sessions. Tests construct plenty of gs:// sessions, so opt out globally —
    otherwise every construction spawns a daemon thread and prints an auth-hint
    (there's no ADC in CI)."""
    monkeypatch.setenv("GENOMESHADER_NO_CRED_REFRESH", "1")
