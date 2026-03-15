#!/usr/bin/env python3
import json, os, time, subprocess
from datetime import datetime

PLAYERS = '/home/savolent/Signal/players'
SIGNAL_DIR = '/home/savolent/Signal'
AGENTS = ['neonecho', 'zealot', 'savolent', 'cipher', 'pilgrim', 'seeker', 'drifter']
CHECK_INTERVAL = 300

def read_status(agent):
    try:
        return json.load(open(f'{PLAYERS}/{agent}/status.json'))
    except:
        return None

def check_fleet_running():
    try:
        result = subprocess.run(['ps', 'aux'], capture_output=True, text=True)
        return 'roci.js' in result.stdout
    except:
        return False

def restart_fleet():
    print('[monitor] Fleet not running -- restarting...')
    subprocess.Popen(
        ['bash', '-c', f'cd {SIGNAL_DIR} && SKIP_FIREWALL=1 node apps/signal/bin/roci.js start --domain spacemolt neonecho zealot savolent cipher pilgrim seeker drifter >> /tmp/fleet.log 2>&1'],
        start_new_session=True
    )

def check_and_report():
    now = datetime.utcnow().isoformat()[:19]
    print(f'\n[{now}] Fleet check')
    if not check_fleet_running():
        restart_fleet()
        return
    stuck = []
    for agent in AGENTS:
        s = read_status(agent)
        if not s:
            print(f'  {agent}: NO STATUS')
            continue
        updated = s.get('lastUpdated', '')
        cargo = s.get('metrics', {})
        try:
            age_min = (time.time() - time.mktime(time.strptime(updated[:19], '%Y-%m-%dT%H:%M:%S'))) / 60
        except:
            age_min = 999
        turn = s.get('turnCount', 0)
        phase = s.get('phase', '?')
        sit = s.get('situation', '?')
        cu = cargo.get('cargoUsed', '?')
        cc = cargo.get('cargoCapacity', '?')
        upd = updated[11:19] if updated else '?'
        line = f'  {agent:12} t{turn:>3} | {phase:8} | {sit:12} | cargo {cu:>3}/{cc:>3} | {upd} ({age_min:.0f}m ago)'
        if age_min > 20:
            line += ' [STUCK]'
            stuck.append(agent)
        print(line)
    if stuck:
        print(f'  Stuck agents: {stuck}')

print('[monitor] CULT fleet monitor started.')
while True:
    try:
        check_and_report()
    except Exception as e:
        print(f'[monitor] Error: {e}')
    time.sleep(CHECK_INTERVAL)
