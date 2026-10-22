"""Runs scan.py over a made-up Claude Code transcript and Codex log and checks its sums: python3 -I scripts/scan_check.py"""
import datetime
import json
import os
import subprocess
import sys
import tempfile

now = datetime.datetime.now(datetime.timezone.utc)


def reply(msg_id, model, ago, session, **usage):
    at = (now - ago).isoformat().replace('+00:00', 'Z')
    return json.dumps({'type': 'assistant', 'timestamp': at, 'sessionId': session,
                       'message': {'id': msg_id, 'model': model, 'usage': usage}})


lines = [
    # The same reply twice: only the last copy's usage counts.
    reply('m1', 'claude-opus-5-5', datetime.timedelta(minutes=5), 's1', input_tokens=1000, output_tokens=10),
    reply('m1', 'claude-opus-5-5', datetime.timedelta(minutes=5), 's1', input_tokens=1000, output_tokens=100,
          cache_read_input_tokens=1_000_000, cache_creation_input_tokens=2000,
          cache_creation={'ephemeral_5m_input_tokens': 1000, 'ephemeral_1h_input_tokens': 1000}),
    reply('m2', 'claude-haiku-4-5-20251001', datetime.timedelta(minutes=4), 's1', input_tokens=1_000_000),
    reply('m3', 'gpt-x', datetime.timedelta(minutes=3), 's1', input_tokens=500),
    reply('m4', 'claude-opus-5-5', datetime.timedelta(days=40), 's2', output_tokens=7),
    # A Haiku 5.5 prompt over 100K tokens takes its higher rate; Sonnet 5.5 reads cost 5% of input.
    reply('m5', 'claude-haiku-5-5', datetime.timedelta(minutes=2), 's1', cache_read_input_tokens=150_000, output_tokens=1000),
    reply('m6', 'claude-sonnet-5-5', datetime.timedelta(minutes=1), 's1', cache_read_input_tokens=1_000_000),
]


def codex_line(kind, payload):
    return json.dumps({'timestamp': (now - datetime.timedelta(minutes=2)).isoformat().replace('+00:00', 'Z'), 'type': kind, 'payload': payload})


def totals(inp, cached, outp):
    usage = {'input_tokens': inp, 'cached_input_tokens': cached, 'output_tokens': outp}
    return codex_line('event_msg', {'type': 'token_count', 'info': {'total_token_usage': usage}})


codex_lines = [
    codex_line('session_meta', {'id': 'c1'}),
    totals(10_000, 8000, 100),  # a subagent's replay of its parent's totals, counted in the parent's log
    codex_line('turn_context', {'model': 'gpt-6.1-sol'}),
    totals(11_000, 8800, 150),
    totals(13_000, 10_500, 250),
    totals(13_000, 10_500, 250),  # a repeat: nothing new used
]

with tempfile.TemporaryDirectory() as home:
    folder = os.path.join(home, '.claude', 'projects', 'p')
    os.makedirs(folder)
    with open(os.path.join(folder, 's1.jsonl'), 'w') as f:
        f.write('\n'.join(lines) + '\n')
    codex_folder = os.path.join(home, '.codex', 'sessions', '2026', '10', '20')
    os.makedirs(codex_folder)
    with open(os.path.join(codex_folder, 'rollout-c1.jsonl'), 'w') as f:
        f.write('\n'.join(codex_lines) + '\n')
    env = {**os.environ, 'HOME': home, 'CLAUDE_CONFIG_DIR': os.path.join(home, '.claude'), 'CODEX_HOME': os.path.join(home, '.codex')}
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'scan.py')
    runs = [json.loads(subprocess.run([sys.executable, '-I', script], env=env, capture_output=True, check=True, text=True).stdout)
            for _ in range(2)]

for result in runs:  # the second run reads the cache
    month, quarter = result['ranges']['30d'], result['ranges']['90d']
    claude, codex = month['providers']
    # Claude: Opus 5.5 1000 in x $4, 100 out x $20, 1M reads x $0.20, 1000 5m writes x $5, 1000 1h writes x $8
    # ($1.219 with Haiku 4.5's 1M in x $1); Haiku 5.5's long prompt 150K reads x $0.05 + 1000 out x $2.50
    # ($0.01); Sonnet 5.5 1M reads x $0.10; gpt-x unpriced.
    assert claude['id'] == 'claude' and claude['sessions'] == 1 and abs(claude['usd'] - 1.329) < 1e-9, claude
    # Codex's own totals add 3000 in (2500 of them cached) and 150 out past the replayed start; the repeat
    # adds nothing. GPT-6.1 Sol: 500 in x $2, 150 out x $10, 2500 cached x $0.10.
    assert codex == {'id': 'codex', 'sessions': 1, 'tokens': 3150, 'usd': codex['usd']} and abs(codex['usd'] - 0.00275) < 1e-9, codex
    assert month['tokens'] == {'input': 1_002_000, 'output': 1250, 'cacheRead': 2_152_500, 'cacheWrite': 2000}, month['tokens']
    assert abs(month['usd'] - 1.33175) < 1e-9 and abs(sum(month['costs'].values()) - month['usd']) < 1e-9, month['usd']
    assert abs(month['costs']['cacheWrite'] - 0.013) < 1e-9
    # Reads save input less read price: Opus 5.5 1M x $3.80, Codex 2500 x $1.90, Haiku 5.5 150K x $0.45,
    # Sonnet 5.5 1M x $1.90; the Opus writes cost $0.001 + $0.004 over plain input.
    assert abs(month['saved'] - (3.8 + 0.00475 + 0.0675 + 1.9 - 0.001 - 0.004)) < 1e-9, month['saved']
    models = {m['model']: m for m in month['models']}
    assert 'claude-haiku-5-5' in models and not any('+' in name for name in models), models.keys()
    assert abs(models['claude-sonnet-5-5']['usd'] - 0.10) < 1e-9
    assert month['unpriced'] == 500 and month['sessions'] == 2 and quarter['sessions'] == 3
    assert sum(b['tokens'] for b in month['series']) == sum(month['tokens'].values())
    assert sum(b['byProvider']['codex']['tokens'] for b in month['series']) == 3150
    assert {m['model']: m['provider'] for m in month['models']}['gpt-6.1-sol'] == 'codex'
    # The calendar reaches back past the 40-day-old reply.
    assert sum(d['tokens'] for d in result['calendar']) == sum(month['tokens'].values()) + 7
print('scan ok')
