"""Adds up this machine's Claude Code and Codex token use for the usage-meter popup.

Prints one JSON object: for each range (24h, 7d, 30d, 90d) the sessions, tokens by kind, cost at
API list prices, per-provider and per-model splits and a series for the chart, plus one cell per
day for the activity calendar. A per-file cache under ~/.cache/usage-meter keeps reruns to the
logs that changed.
"""
import datetime
import json
import os
import re
import time

# Haiku 5.5 bills a prompt over 100K tokens (cache reads and writes included) at a higher rate; such a
# reply's model carries this mark, which only prices it and is cut before a model is shown.
LONG = '+long'
LONG_PROMPT = 100_000
# Per million tokens: input, output, cache read, from Anthropic's and OpenAI's pricing pages (checked
# 2026-10-20). A Claude 5-minute cache write is 1.25x input, a 1-hour one 2x; Codex logs no cache
# writes. OpenAI's are its short-context (<=272K) standard rates, which Codex's 258K window keeps
# every request under.
PRICES = {
    'claude-fable-5-1': (10, 50, 0.25),
    'claude-fable-5': (10, 50, 1.00),
    'claude-opus-5-5': (4, 20, 0.20),
    'claude-opus-5': (5, 25, 0.50),
    'claude-opus-4-8': (5, 25, 0.50),
    'claude-opus-4-7': (5, 25, 0.50),
    'claude-opus-4-6': (5, 25, 0.50),
    'claude-sonnet-5-5': (2, 10, 0.10),
    'claude-sonnet-5': (2, 10, 0.20),
    'claude-sonnet-4-6': (3, 15, 0.30),
    'claude-haiku-5-5': (0.10, 0.50, 0.01),
    'claude-haiku-5-5' + LONG: (0.50, 2.50, 0.05),
    'claude-haiku-4-5': (1, 5, 0.10),
    'gpt-6-astra': (10, 50, 1.00),
    'gpt-6.1-sol': (2, 10, 0.10),
    'gpt-6-sol': (2, 10, 0.20),
    'gpt-6-luna': (0.10, 0.50, 0.01),
    'gpt-5.6-sol': (4, 20, 0.40),
    'gpt-5.6-terra': (2, 12, 0.20),
    'gpt-5.6-luna': (0.20, 1.20, 0.02),
    'gpt-5.4': (2.50, 15, 0.25),
}
PROVIDERS = ('claude', 'codex')
# Range id: bucket unit, span in units (hours or days), units per bucket. 90 days reads better as
# 13 weekly bars than as 90 one-column ones.
RANGES = {'24h': ('hour', 24, 1), '7d': ('day', 7, 1), '30d': ('day', 30, 1), '90d': ('week', 90, 7)}
CALENDAR_WEEKS = 13
OLDEST_DAYS = 91
CACHE_VERSION = 3
# Bumped when the printed shape or its sums change, so the mod re-reads instead of drawing stale ones.
OUTPUT_VERSION = 4


def price(model):
    return PRICES.get(re.sub(r'-\d{8}$', '', model))


def hour_of(timestamp):
    return int(datetime.datetime.fromisoformat(timestamp.replace('Z', '+00:00')).timestamp() // 3600)


def add(rows, key, amounts):
    row = rows.setdefault(key, [0, 0, 0, 0, 0])
    for i, n in enumerate(amounts):
        row[i] += n or 0


def read_claude(path):
    """Sums one Claude Code transcript into {"hour|claude|session|model": [input, output, cacheRead, write5m, write1h]}."""
    final = {}
    with open(path, errors='ignore') as f:
        for n, line in enumerate(f):
            if '"usage"' not in line or '"assistant"' not in line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            m = d.get('message') or {}
            if d.get('type') != 'assistant' or not m.get('usage') or not d.get('timestamp'):
                continue
            # A reply is written once per content block; the last copy carries its final usage.
            final[m.get('id') or n] = (d, m)

    rows = {}
    for d, m in final.values():
        u = m['usage']
        write = u.get('cache_creation_input_tokens') or 0
        write_1h = min(write, (u.get('cache_creation') or {}).get('ephemeral_1h_input_tokens') or 0)
        model = m.get('model', '?')
        prompt = (u.get('input_tokens') or 0) + (u.get('cache_read_input_tokens') or 0) + write
        if re.sub(r'-\d{8}$', '', model) == 'claude-haiku-5-5' and prompt > LONG_PROMPT:
            model += LONG
        key = f"{hour_of(d['timestamp'])}|claude|{d.get('sessionId', '')}|{model}"
        add(rows, key, (u.get('input_tokens'), u.get('output_tokens'), u.get('cache_read_input_tokens'), write - write_1h, write_1h))
    return rows


def read_codex(path):
    """
    Sums one Codex session log the same way, from the running totals its token_count events carry.

    A forked or subagent log opens by replaying its parent's history, totals included, before its own
    first turn_context; those set where its totals start, as they were counted in the parent's log.
    """
    rows, model, session, last, is_own = {}, '?', os.path.basename(path), None, False
    with open(path, errors='ignore') as f:
        for line in f:
            if '"token_count"' not in line and '"turn_context"' not in line and '"session_meta"' not in line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            p = d.get('payload') or {}
            total = (p.get('info') or {}).get('total_token_usage')
            if d.get('type') == 'session_meta':
                session = p.get('id') or session
            elif d.get('type') == 'turn_context':
                model = p.get('model') or model
                is_own = True
            elif p.get('type') == 'token_count' and total and d.get('timestamp'):
                seen = [total.get(k) or 0 for k in ('input_tokens', 'cached_input_tokens', 'output_tokens')]
                if not is_own:
                    last = seen
                    continue
                # Totals only grow, and repeat when nothing new was used; a drop starts over from zero.
                if last is None or any(a < b for a, b in zip(seen, last)):
                    inp, cached, outp = seen
                else:
                    inp, cached, outp = (a - b for a, b in zip(seen, last))
                last = seen
                if inp or outp:
                    # OpenAI counts cached tokens inside input_tokens.
                    add(rows, f"{hour_of(d['timestamp'])}|codex|{session}|{model}", (max(0, inp - cached), outp, cached, 0, 0))
    return rows


def scan(sources, cache_path, now):
    try:
        with open(cache_path) as f:
            cache = json.load(f)
        if cache.get('version') != CACHE_VERSION:
            raise ValueError
    except (OSError, ValueError):
        cache = {'version': CACHE_VERSION, 'files': {}}

    files = {}
    for root, read in sources:
        for folder, _, names in os.walk(root):
            for name in names:
                path = os.path.join(folder, name)
                try:
                    st = os.stat(path)
                except OSError:
                    continue
                if not name.endswith('.jsonl') or st.st_mtime < now - OLDEST_DAYS * 86400:
                    continue
                seen = cache['files'].get(path)
                if seen and seen['size'] == st.st_size and seen['mtime'] == st.st_mtime:
                    files[path] = seen
                else:
                    files[path] = {'size': st.st_size, 'mtime': st.st_mtime, 'rows': read(path)}

    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    with open(cache_path + '.tmp', 'w') as f:
        json.dump({'version': CACHE_VERSION, 'files': files}, f)
    os.replace(cache_path + '.tmp', cache_path)

    return [(key, row) for entry in files.values() for key, row in entry['rows'].items()]


def label(unit, start):
    if unit == 'hour':
        return f"{start.hour % 12 or 12} {'AM' if start.hour < 12 else 'PM'}"
    return f'{start:%b} {start.day}'


def priced(model, row):
    """A row's cost split by kind and what caching saved, at API list prices; None for an unknown model."""
    p = price(model)
    if not p:
        return None
    inp, outp, read, write_5m, write_1h = row
    by_kind = (inp * p[0] / 1e6, outp * p[1] / 1e6, read * p[2] / 1e6, (write_5m * 1.25 + write_1h * 2) * p[0] / 1e6)
    # What reads saved over paying full input price, less what writing the cache cost over plain input.
    saved = (read * (p[0] - p[2]) - (write_5m * 0.25 + write_1h) * p[0]) / 1e6
    return by_kind, saved


def summarize(rows, now):
    this_hour = int(now // 3600)
    today = datetime.date.fromtimestamp(now)
    out = {}

    for range_id, (unit, span, step) in RANGES.items():
        count = -(-span // step)
        if unit == 'hour':
            starts = [datetime.datetime.fromtimestamp((this_hour - span + 1 + i) * 3600) for i in range(count)]
        else:
            # The oldest bucket is the short one, so the newest ends today.
            starts = [today - datetime.timedelta(days=min(span - 1, (count - i) * step - 1)) for i in range(count)]
        series = [{'label': label(unit, s), 'tokens': 0, 'usd': 0.0, 'byProvider': {p: {'tokens': 0, 'usd': 0.0} for p in PROVIDERS}}
                  for s in starts]
        providers = {p: {'id': p, 'sessions': set(), 'tokens': 0, 'usd': 0.0} for p in PROVIDERS}
        kinds = [0, 0, 0, 0]
        costs = [0.0, 0.0, 0.0, 0.0]
        models = {}
        usd = unpriced = saved = 0

        for key, row in rows:
            hour, provider, session, model = key.split('|', 3)
            hour = int(hour)
            age = this_hour - hour if unit == 'hour' else (today - datetime.date.fromtimestamp(hour * 3600)).days
            if not 0 <= age < span:
                continue
            i = count - 1 - age // step

            inp, outp, read, write_5m, write_1h = row
            tokens = sum(row)
            pricing = priced(model, row)
            by_kind = (0.0, 0.0, 0.0, 0.0)
            if pricing:
                by_kind, row_saved = pricing
                saved += row_saved
            else:
                unpriced += tokens
            cost = sum(by_kind)
            usd += cost
            for k, c in enumerate(by_kind):
                costs[k] += c
            for k, n in enumerate((inp, outp, read, write_5m + write_1h)):
                kinds[k] += n
            name = model.removesuffix(LONG)
            for total in (models.setdefault(name, {'model': name, 'provider': provider, 'tokens': 0, 'usd': 0.0}),
                          providers[provider], series[i], series[i]['byProvider'][provider]):
                total['tokens'] += tokens
                total['usd'] += cost
            if tokens:
                providers[provider]['sessions'].add(session)

        out[range_id] = {
            'unit': unit,
            'when': 'last 24 hours' if unit == 'hour' else f"{label(unit, starts[0])} – {label(unit, today)}",
            'sessions': sum(len(p['sessions']) for p in providers.values()),
            'providers': [{**p, 'sessions': len(p['sessions'])} for p in providers.values()],
            'tokens': dict(zip(('input', 'output', 'cacheRead', 'cacheWrite'), kinds)),
            'usd': usd,
            'costs': dict(zip(('input', 'output', 'cacheRead', 'cacheWrite'), costs)),
            'saved': saved,
            'unpriced': unpriced,
            'models': sorted((m for m in models.values() if m['tokens']), key=lambda m: -m['tokens']),
            'series': series,
        }
    return out


def calendar(rows, now):
    """One cell per day, Sunday-first like GitHub's, from CALENDAR_WEEKS weeks back through today."""
    today = datetime.date.fromtimestamp(now)
    first = today - datetime.timedelta(days=(today.weekday() + 1) % 7 + 7 * (CALENDAR_WEEKS - 1))
    days = [{'label': label('day', first + datetime.timedelta(days=i)), 'tokens': 0, 'usd': 0.0}
            for i in range((today - first).days + 1)]
    for key, row in rows:
        i = (datetime.date.fromtimestamp(int(key.split('|', 1)[0]) * 3600) - first).days
        if 0 <= i < len(days):
            pricing = priced(key.rsplit('|', 1)[1], row)
            days[i]['tokens'] += sum(row)
            days[i]['usd'] += sum(pricing[0]) if pricing else 0.0
    return days


if __name__ == '__main__':
    now = time.time()
    sources = [
        (os.path.join(os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude'), 'projects'), read_claude),
        (os.path.join(os.environ.get('CODEX_HOME') or os.path.expanduser('~/.codex'), 'sessions'), read_codex),
    ]
    rows = scan(sources, os.path.expanduser('~/.cache/usage-meter/scan.json'), now)
    print(json.dumps({'version': OUTPUT_VERSION, 'scannedAt': int(now * 1000), 'ranges': summarize(rows, now),
                      'calendar': calendar(rows, now)}))
