import json, time, sys, datetime
CACHE_MAX_AGE_MS = 1800000
try:
    data = json.load(open(sys.argv[1]))
    age_ms = time.time() * 1000 - data.get('ts', 0)
    if age_ms > CACHE_MAX_AGE_MS:
        print('STALE'); sys.exit(0)
    pct = data.get('session', '0%').replace('%','').strip()
    end_ts = data.get('session_end_time', 0)
    end_iso = datetime.datetime.fromtimestamp(end_ts/1000, tz=datetime.timezone.utc).isoformat() if end_ts else ''
    print(f'{pct}|{end_iso}')
except Exception:
    print('STALE')
