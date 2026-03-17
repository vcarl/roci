#!/usr/bin/env python3
"""
Direct OAuth token refresh for Claude AI credentials.
No browser required. Uses refresh_token grant against platform.claude.com.
Called by run-token-watchdog.sh and run-agent.sh.
"""
import json, os, sys, time, urllib.request, urllib.parse, urllib.error

CREDS_PATH = os.path.expanduser("~/.claude/.credentials.json")
TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token"
CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
SIGNAL_DIR = "/home/savolent/Signal"
REFRESH_THRESHOLD_MIN = 45


def load_creds():
    with open(CREDS_PATH) as f:
        return json.load(f)


def save_creds(creds):
    """Atomic write to avoid partial reads by claude subprocesses."""
    tmp = CREDS_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(creds, f)
    os.replace(tmp, CREDS_PATH)


def get_expiry_min(creds):
    exp = creds.get("claudeAiOauth", {}).get("expiresAt", 0)
    return max(0, (exp - int(time.time() * 1000)) // 60000)


def update_oauth_token_files(access_token):
    """Update .oauth-token files used by signal.js mcp-remote auth."""
    for p in [f"{SIGNAL_DIR}/.oauth-token", f"{SIGNAL_DIR}/apps/.oauth-token"]:
        try:
            with open(p, "w") as f:
                f.write(access_token)
        except Exception as e:
            print(f"[refresh-token] Warning: could not write {p}: {e}", file=sys.stderr)


def do_api_refresh(refresh_token):
    """POST to OAuth token endpoint. Try JSON first, fall back to form-encoded."""
    def make_request(data, content_type):
        req = urllib.request.Request(
            TOKEN_ENDPOINT,
            data=data,
            headers={"Content-Type": content_type, "User-Agent": "claude-code/1.0"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())

    # Try JSON body first
    try:
        payload = json.dumps({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": CLIENT_ID,
        }).encode()
        return make_request(payload, "application/json")
    except urllib.error.HTTPError as e:
        if e.code not in (400, 415):
            raise
        # Fall back to form-encoded (standard OAuth2 spec)
        payload = urllib.parse.urlencode({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": CLIENT_ID,
        }).encode()
        return make_request(payload, "application/x-www-form-urlencoded")


def refresh_if_needed(force=False):
    try:
        creds = load_creds()
    except Exception as e:
        print(f"[refresh-token] ERROR: cannot read credentials: {e}", file=sys.stderr)
        sys.exit(1)

    exp_min = get_expiry_min(creds)

    if not force and exp_min > REFRESH_THRESHOLD_MIN:
        print(f"[refresh-token] Token OK: {exp_min}min remaining.")
        return

    oauth = creds.get("claudeAiOauth", {})
    refresh_token = oauth.get("refreshToken")
    if not refresh_token:
        print("[refresh-token] ERROR: No refresh token in credentials.", file=sys.stderr)
        sys.exit(1)

    print(f"[refresh-token] Token expires in {exp_min}min. Refreshing via API...")

    try:
        data = do_api_refresh(refresh_token)
    except Exception as e:
        print(f"[refresh-token] ERROR: Refresh API call failed: {e}", file=sys.stderr)
        sys.exit(2)

    # Update credentials
    oauth["accessToken"] = data["access_token"]
    if "expires_in" in data:
        oauth["expiresAt"] = int(time.time() * 1000) + int(data["expires_in"]) * 1000
    elif "expires_at" in data:
        oauth["expiresAt"] = int(data["expires_at"]) * 1000
    if "refresh_token" in data:
        oauth["refreshToken"] = data["refresh_token"]

    creds["claudeAiOauth"] = oauth
    save_creds(creds)
    update_oauth_token_files(oauth["accessToken"])

    new_exp_min = get_expiry_min(creds)
    print(f"[refresh-token] Done. New expiry: {new_exp_min}min from now.")


if __name__ == "__main__":
    force = "--force" in sys.argv
    refresh_if_needed(force=force)
