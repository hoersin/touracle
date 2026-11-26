"""UI internationalization: resource files, keys and the English reference.

English (frontend/i18n/en.js) is the reference: every key used in index.html or map.js
exists there, the static texts in index.html are identical to it (they are the
pre-script fallback), and every other locale covers the same keys with the same
placeholders and markup.
"""
from __future__ import annotations

import json
import re
from html.parser import HTMLParser
from pathlib import Path

import pytest

FRONTEND = Path(__file__).resolve().parents[1] / 'frontend'
LOCALES = ('en', 'de', 'fr', 'es', 'zh-CN')
PLACEHOLDER = re.compile(r'\{(\w+)\}')
TAG = re.compile(r'</?([a-z]+)[^>]*>')


def load(lang):
    text = (FRONTEND / 'i18n' / f'{lang}.js').read_text(encoding='utf-8')
    body = text[text.index('= {', text.index('WM_I18N_RESOURCES', text.index('\n'))) + 2:text.rindex('}') + 1]
    return json.loads(body)


EN = load('en')


def test_english_reference_is_complete_and_non_empty():
    assert len(EN) > 400
    assert all(isinstance(v, str) and v.strip() for v in EN.values())


@pytest.mark.parametrize('lang', LOCALES[1:])
def test_locale_covers_every_key_with_same_placeholders_and_markup(lang):
    res = load(lang)
    assert set(res) == set(EN), {'missing': sorted(set(EN) - set(res))[:10], 'extra': sorted(set(res) - set(EN))[:10]}
    for k, en in EN.items():
        v = res[k]
        assert v.strip(), (lang, k)
        assert sorted(PLACEHOLDER.findall(v)) == sorted(PLACEHOLDER.findall(en)), (lang, k, v)
        assert sorted(TAG.findall(v)) == sorted(TAG.findall(en)), (lang, k, v)


def test_index_loads_all_locales_before_the_i18n_core_and_map():
    html = (FRONTEND / 'index.html').read_text(encoding='utf-8')
    pos = [html.index(f'i18n/{n}.js') for n in (*LOCALES, 'i18n')]
    assert pos == sorted(pos)
    assert pos[-1] < html.index('/map.js?v=')                 # map.js is appended at the end of body


class _Collect(HTMLParser):
    """Static texts of elements marked with data-i18n / data-i18n-* attributes."""
    VOID = {'input', 'img', 'br', 'hr', 'meta', 'link', 'source', 'wbr', 'area', 'col', 'embed', 'track', 'param', 'base'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []          # [tag, key or None, text parts]
        self.texts = []          # (key, text)
        self.attrs = []          # (key, attribute value)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        for attr, name in (('data-i18n-title', 'title'), ('data-i18n-aria-label', 'aria-label'),
                           ('data-i18n-placeholder', 'placeholder')):
            if attr in a:
                self.attrs.append((a[attr], a.get(name)))
        if tag in self.VOID:
            return
        self.stack.append([tag, a.get('data-i18n'), []])

    def handle_endtag(self, tag):
        while self.stack:
            t, key, parts = self.stack.pop()
            if key:
                self.texts.append((key, ' '.join(''.join(parts).split())))
            if self.stack:
                self.stack[-1][2].extend(parts)
            if t == tag:
                break

    def handle_data(self, data):
        if self.stack:
            self.stack[-1][2].append(data)


def _collected():
    c = _Collect()
    c.feed((FRONTEND / 'index.html').read_text(encoding='utf-8'))
    return c


def test_every_html_key_exists_and_static_text_equals_english():
    c = _collected()
    assert len(c.texts) > 200
    wrong = [(k, txt, EN.get(k)) for k, txt in c.texts if EN.get(k) is None or ' '.join(EN[k].split()) != txt]
    assert not wrong, wrong[:10]
    wrong_attr = [(k, v, EN.get(k)) for k, v in c.attrs if EN.get(k) is None or EN[k] != v]
    assert not wrong_attr, wrong_attr[:10]
    html = (FRONTEND / 'index.html').read_text(encoding='utf-8')
    html_keys = re.findall(r'data-i18n-html="([^"]+)"', html)
    assert html_keys and all(k in EN for k in html_keys)


def test_every_literal_key_used_by_the_map_script_exists():
    src = (FRONTEND / 'map.js').read_text(encoding='utf-8')
    used = set(re.findall(r"\b(?:i18nT|i18nMsg)\(\s*'([A-Za-z0-9_.\-]+)'", src))
    assert len(used) > 100
    assert sorted(used - set(EN)) == []


def test_technical_identifiers_are_not_translated():
    # field names in the calculation guide stay identifiers in every language
    for lang in LOCALES[1:]:
        res = load(lang)
        for k, en in EN.items():
            for ident in re.findall(r'<strong>([a-z0-9]+_[a-z0-9_*]+)</strong>', en):
                assert f'<strong>{ident}</strong>' in res[k], (lang, k, ident)
