from pathlib import Path


MAP_JS = Path(__file__).resolve().parents[1] / 'frontend' / 'map.js'


def _source() -> str:
    return MAP_JS.read_text(encoding='utf-8')


def test_tourbook_visibility_not_tied_to_last_profile():
    source = _source()
    assert "const inTourMode = _tourIsActive();" in source
    assert "_roadbookSyncPanelVisibility(inTourMode);" in source
    assert "if (!LAST_PROFILE) {" in source
    assert "roadbookMeta.textContent = 'No route profile loaded yet';" in source
