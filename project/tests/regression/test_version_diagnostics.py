"""Client / server version indicator in the real UI.

- Shows the actual identifiers: the client bundle this page loaded and the running
  backend (the code it was started from), "-dirty" preserved.
- Identifiers are selectable; a click copies a fixed-format diagnostic block.
- "Copied" feedback; without clipboard access the identifiers are selected instead.
- A server running older code than the client is flagged (restart needed).
- All five UI languages.
"""
from __future__ import annotations

import pytest

from conftest import HERE, TourPage

LANGS = ('en', 'de', 'fr', 'es', 'zh-CN')


@pytest.fixture
def versions(server, monkeypatch):
    """Running backend started from 1a2b3c4d-dirty; code on disk now 1a2b3c4d-dirty too."""
    mod = server.module
    state = {'server': '1a2b3c4d-dirty', 'disk': '1a2b3c4d-dirty', 'changed': False}
    monkeypatch.setattr(mod, 'APP_VERSION', state['server'])
    monkeypatch.setattr(mod, '_live_code_version', lambda: state['disk'])
    monkeypatch.setattr(mod, '_backend_code_changed_since_start', lambda: state['changed'])

    def set_(**kw):
        state.update(kw)
        monkeypatch.setattr(mod, 'APP_VERSION', state['server'])
    server.set_versions = set_
    return server


@pytest.fixture
def open_page(versions, chromium):
    contexts = []
    leaflet = (HERE / 'vendor' / 'leaflet-1.9.4.js').read_text(encoding='utf-8')

    def open_(clipboard=True, init_script=None):
        ctx = chromium.new_context(viewport={'width': 1440, 'height': 900})
        contexts.append(ctx)
        if clipboard:
            ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=versions.url)

        def route(r):
            url = r.request.url
            if url.startswith(versions.url):
                r.continue_()
            elif 'leaflet' in url and url.endswith('.js'):
                r.fulfill(body=leaflet, content_type='text/javascript')
            else:
                r.abort()
        ctx.route('**/*', route)
        if init_script:
            ctx.add_init_script(init_script)
        tp = TourPage(ctx.new_page(), versions.url)
        tp.open()
        tp.page.wait_for_function("() => { const t = (document.querySelector('#wmVersionBadge [data-role=version-server]') || {}).textContent;"
                                  " return !!t && t !== 'unknown'; }", timeout=10000)
        return tp
    yield open_
    for c in contexts:
        c.close()


def badge(page):
    return page.evaluate("""() => { const b = document.getElementById('wmVersionBadge'); const q = r => b.querySelector(`[data-role=${r}]`);
        return { client: q('version-client').textContent, server: q('version-server').textContent,
                 clientLabel: q('version-client-label').textContent, serverLabel: q('version-server-label').textContent,
                 warn: !q('version-warn').hidden, status: q('version-status').hidden ? '' : q('version-status').textContent,
                 title: b.title, copyLabel: q('version-copy').getAttribute('aria-label'),
                 selectable: getComputedStyle(q('version-ids')).userSelect,
                 pointer: getComputedStyle(b).pointerEvents }; }""")


def test_badge_shows_the_actual_client_and_server_identifiers(open_page, versions):
    tp = open_page()
    b = badge(tp.page)
    loaded = tp.page.evaluate("[...document.scripts].map(s => s.src).find(s => s.includes('/map.js?v=')) || ''")
    client = loaded.split('v=', 1)[1].replace('%3A', ':')
    assert b['client'] == client and client.startswith('1a2b3c4d-dirty:'), (b, loaded)     # the bundle this page runs
    assert b['server'] == '1a2b3c4d-dirty'                                                 # the running backend
    assert b['selectable'] in ('text', 'auto') and b['pointer'] != 'none'
    assert not b['warn']
    assert not tp.errors, tp.errors


def test_click_copies_the_diagnostic_block(open_page):
    tp = open_page()
    page = tp.page
    page.click('#wmVersionBadge [data-role=version-copy]')
    page.wait_for_function("() => !document.querySelector('#wmVersionBadge [data-role=version-status]').hidden")
    b = badge(page)
    assert b['status'] == 'Copied'
    copied = page.evaluate("navigator.clipboard.readText()")
    assert copied == f"Touracle – Diagnostic Information\nClient:  {b['client']}\nServer:  {b['server']}", copied
    page.wait_for_timeout(2200)
    assert badge(page)['status'] == ''                                                      # brief feedback
    # a click anywhere on the indicator copies as well
    page.evaluate("navigator.clipboard.writeText('x')")
    page.click('#wmVersionBadge .wm-version-sep')
    page.wait_for_timeout(200)
    assert page.evaluate("navigator.clipboard.readText()") == copied


def test_selecting_an_identifier_does_not_copy(open_page):
    tp = open_page()
    page = tp.page
    page.evaluate("navigator.clipboard.writeText('untouched')")
    box = page.locator('#wmVersionBadge [data-role=version-server]').bounding_box()
    page.mouse.move(box['x'] + 1, box['y'] + box['height'] / 2)
    page.mouse.down()
    page.mouse.move(box['x'] + box['width'] - 1, box['y'] + box['height'] / 2, steps=5)
    page.mouse.up()
    page.wait_for_timeout(200)
    assert page.evaluate("String(window.getSelection())").strip() != ''
    assert page.evaluate("navigator.clipboard.readText()") == 'untouched'


def test_without_clipboard_access_the_identifiers_are_selected(open_page):
    tp = open_page(clipboard=False, init_script="""
        Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
        document.execCommand = () => false;""")
    page = tp.page
    page.click('#wmVersionBadge [data-role=version-copy]')
    page.wait_for_timeout(200)
    b = badge(page)
    assert 'Ctrl+C' in b['status'], b
    sel = page.evaluate("String(window.getSelection())")
    assert b['client'] in sel and b['server'] in sel, sel
    assert not tp.errors, tp.errors


def test_server_running_older_code_is_flagged(open_page, versions):
    versions.set_versions(server='0badc0de', disk='1a2b3c4d-dirty')
    tp = open_page()
    page = tp.page
    page.wait_for_function("() => document.querySelector('#wmVersionBadge [data-role=version-server]').textContent === '0badc0de'")
    b = badge(page)
    assert b['warn'] and 'Restart the server' in b['title'], b
    # same commit, but the backend sources changed on disk after the start
    versions.set_versions(server='1a2b3c4d-dirty', disk='1a2b3c4d-dirty', changed=True)
    tp2 = open_page()
    tp2.page.wait_for_timeout(500)
    assert badge(tp2.page)['warn']
    versions.set_versions(changed=False)
    tp3 = open_page()
    tp3.page.wait_for_timeout(500)
    assert not badge(tp3.page)['warn']


def test_version_indicator_in_all_five_languages(open_page):
    tp = open_page()
    page = tp.page
    seen = {}
    for lang in LANGS:
        page.evaluate("l => window.WM_I18N.setLanguage(l)", lang)
        page.wait_for_timeout(200)
        b = badge(page)
        seen[lang] = (b['title'], b['copyLabel'], b['serverLabel'])
        assert b['client'] and b['server'] == '1a2b3c4d-dirty'
        page.click('#wmVersionBadge [data-role=version-copy]')
        page.wait_for_function("() => !document.querySelector('#wmVersionBadge [data-role=version-status]').hidden")
        assert badge(page)['status'] == page.evaluate("l => window.WM_I18N.tIn(l, 'version.copied')", lang)
        assert page.evaluate("navigator.clipboard.readText()").startswith('Touracle – Diagnostic Information\nClient:  ')
    page.evaluate("window.WM_I18N.setLanguage('en')")
    assert len({v[0] for v in seen.values()}) == 5 and len({v[1] for v in seen.values()}) == 5, seen
    assert page.evaluate("[...window.WM_I18N.missing]") == []
