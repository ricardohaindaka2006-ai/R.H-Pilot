"""Offline Node/Python protocol fixture. No MetaTrader5 dependency or broker."""
import json
import os
from pathlib import Path
import sys
import tempfile
import urllib.request
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'mt5-agent'))
from test_agent import A, FakeMT5

origin = os.environ['RHP_FIXTURE_URL']
http = A.BridgeHTTP(origin, os.environ['RHP_FIXTURE_TOKEN'], True)


def workspace(route, body=None):
    request = urllib.request.Request(origin + route,
        None if body is None else json.dumps(body).encode(),
        {'Content-Type': 'application/json', 'Cookie': os.environ['RHP_FIXTURE_COOKIE']},
        method='GET' if body is None else 'POST')
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


with tempfile.TemporaryDirectory(prefix='rhp-protocol-fixture-') as directory:
    journal = A.Journal(Path(directory) / 'journal.sqlite3',
        {'origin': origin, 'login': '1234567', 'server': 'Deriv-Demo', 'symbol': 'XAUUSD'})
    try:
        mt5 = FakeMT5()
        agent = A.Agent(mt5, journal, '1234567', 'Deriv-Demo', 'XAUUSD', True)
        first, versions = agent.snapshot()
        reply = http.exchange(first)
        assert reply['command'] is None
        workspace('/api/mt5/start', {'confirmation': 'MT5_DEMO_ONLY'})
        mt5.tick.time_msc = A.now_ms() + 1
        body, versions = agent.snapshot()
        reply = http.exchange(body)
        command = reply['command']
        assert command is not None
        journal.acknowledge(reply['ack'], versions)
        agent.execute(command)
        agent.execute(command)  # a repeated delivery must not open twice
        body, versions = agent.snapshot()
        reply = http.exchange(body)
        journal.acknowledge(reply['ack'], versions)
        assert reply['command'] is None
        assert len(mt5.live_positions) == 1
        mt5.close_position(mt5.live_positions[0], 100.5)
        body, versions = agent.snapshot()
        reply = http.exchange(body)
        journal.acknowledge(reply['ack'], versions)
        status = workspace('/api/mt5/status')['mt5']
        print(json.dumps({'fakeBroker': True, 'realOrders': 0,
            'openSubmissions': len([r for kind, r in mt5.calls if kind == 'send' and r['action'] == 1 and 'position' not in r]),
            'closedTrades': status['ledger']['closedTrades'], 'pnl': status['ledger']['profit'],
            'unresolved': len([o for o in status['orders'] if o['status'] in ('filled', 'delivered', 'uncertain')])}))
    finally:
        journal.close()
