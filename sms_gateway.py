"""SMS gateway settings and one-time codes for citizen sign-up (stdlib only).

Modes (chosen by the administrator in the Management tab):
  off  - no phone check; sign-up works as before
  demo - a 6-digit code is created and shown on the sign-up screen; no SMS is sent
  live - the code is sent through the administrator's SMS provider API and never shown on screen
"""
import hashlib
import hmac
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request

MODES = ("off", "demo", "live")
OTP_TTL_SECONDS = 5 * 60        # a code is valid for 5 minutes
OTP_RESEND_SECONDS = 60         # wait this long before a new code is sent to the same NID
OTP_MAX_TRIES = 5               # wrong codes allowed for one request
SMS_TIMEOUT_SECONDS = 15

SCHEMA = """
CREATE TABLE IF NOT EXISTS sms_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    mode TEXT NOT NULL DEFAULT 'demo',
    api_url TEXT NOT NULL DEFAULT '',
    http_method TEXT NOT NULL DEFAULT 'GET',
    api_key TEXT NOT NULL DEFAULT '',
    sender_id TEXT NOT NULL DEFAULT '',
    success_text TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS pending_registrations (
    nid TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    address TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    code_salt TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at REAL NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_sent REAL NOT NULL
);
"""


def ensure_schema(conn):
    conn.executescript(SCHEMA)
    conn.execute("INSERT OR IGNORE INTO sms_settings (id) VALUES (1)")


def get_settings(srv):
    conn = srv.connect()
    try:
        row = conn.execute("SELECT * FROM sms_settings WHERE id = 1").fetchone()
    finally:
        conn.close()
    return dict(row) if row else {"mode": "demo", "api_url": "", "http_method": "GET", "api_key": "",
                                  "sender_id": "", "success_text": "", "updated_at": ""}


def otp_required(srv):
    return get_settings(srv)["mode"] != "off"


def public_settings(srv):
    """Settings the browser may see. The API key itself is never sent back, only a hint."""
    s = get_settings(srv)
    key = s["api_key"]
    return {
        "mode": s["mode"], "api_url": s["api_url"], "http_method": s["http_method"],
        "sender_id": s["sender_id"], "success_text": s["success_text"],
        "has_key": bool(key), "key_hint": ("••••" + key[-4:]) if len(key) >= 4 else ("••••" if key else ""),
        "updated_at": s["updated_at"],
        "placeholders": ["{apikey}", "{sender}", "{to}", "{message}"],
    }


def mask_phone(phone):
    return "%s****%s" % (phone[:3], phone[-4:])


def _fill(template, values):
    """Puts the values into the URL template. Each value is percent-encoded, so Bangla text works."""
    out = template
    for key, value in values.items():
        out = out.replace("{%s}" % key, urllib.parse.quote(str(value), safe=""))
    return out


def send(srv, settings, phone, text):
    """Calls the provider once. Returns (True, '') or (False, short reason). Never returns the API key."""
    if not settings["api_url"]:
        return False, "API URL is not set."
    values = {"apikey": settings["api_key"], "sender": settings["sender_id"], "to": phone, "message": text}
    url = _fill(settings["api_url"], values)
    body = None
    method = "POST" if settings["http_method"] == "POST" else "GET"
    if method == "POST":
        body = urllib.parse.urlencode(values).encode("utf-8")
    request = urllib.request.Request(url, data=body, method=method,
                                     headers={"User-Agent": "GovShield/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=SMS_TIMEOUT_SECONDS) as response:
            status = response.status
            reply = response.read(1000).decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return False, "provider answered HTTP %d" % error.code
    except (urllib.error.URLError, OSError, ValueError):
        return False, "could not reach the provider"
    if settings["api_key"] and settings["api_key"] in reply:
        reply = reply.replace(settings["api_key"], "***")
    if not 200 <= status < 300:
        return False, "provider answered HTTP %d" % status
    wanted = settings["success_text"].strip().lower()
    if wanted and wanted not in reply.lower():
        return False, "provider reply did not contain the success word: " + reply[:120]
    return True, ""


def _code_hash(secret, salt, code):
    return hmac.new(secret, ("%s:%s" % (salt, code)).encode("utf-8"), hashlib.sha256).hexdigest()


def issue_code(srv, secret, record, settings):
    """Creates a new code for a registry match and stores it with the pending sign-up.

    record: dict with nid, full_name, phone_number, address, password_salt, password_hash.
    Returns the code (the caller shows it only in demo mode).
    """
    now = time.time()
    conn = srv.connect()
    try:
        last = conn.execute("SELECT last_sent FROM pending_registrations WHERE nid = ?", (record["nid"],)).fetchone()
    finally:
        conn.close()
    if last and now - last["last_sent"] < OTP_RESEND_SECONDS:
        wait = int(OTP_RESEND_SECONDS - (now - last["last_sent"])) + 1
        raise srv.ApiError(429, "Please wait %d seconds before asking for a new code." % wait)

    code = "%06d" % secrets.randbelow(1000000)
    if settings["mode"] == "live":
        text = "GovShield verification code: %s. It is valid for 5 minutes. Do not share it." % code
        ok, reason = send(srv, settings, record["phone_number"], text)
        srv.log("SMS to %s: %s" % (mask_phone(record["phone_number"]), "sent" if ok else "FAILED (" + reason + ")"))
        if not ok:
            raise srv.ApiError(502, "The code could not be sent right now. Please try again in a few minutes.")

    code_salt = secrets.token_hex(16)
    conn = srv.connect()
    try:
        with conn:
            conn.execute(
                "INSERT OR REPLACE INTO pending_registrations (nid, full_name, phone_number, address, password_salt, "
                "password_hash, code_salt, code_hash, expires_at, attempts, last_sent) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
                (record["nid"], record["full_name"], record["phone_number"], record["address"],
                 record["password_salt"], record["password_hash"], code_salt,
                 _code_hash(secret, code_salt, code), now + OTP_TTL_SECONDS, now),
            )
    finally:
        conn.close()
    return code


def check_code(srv, secret, nid, code):
    """Returns the pending sign-up if the code is right. Wrong codes are counted."""
    conn = srv.connect()
    try:
        row = conn.execute("SELECT * FROM pending_registrations WHERE nid = ?", (nid,)).fetchone()
        if row is None:
            raise srv.ApiError(400, "Ask for a verification code first.")
        if time.time() > row["expires_at"]:
            with conn:
                conn.execute("DELETE FROM pending_registrations WHERE nid = ?", (nid,))
            raise srv.ApiError(400, "This code has expired. Ask for a new code.")
        if row["attempts"] >= OTP_MAX_TRIES:
            raise srv.ApiError(429, "Too many wrong codes. Ask for a new code.")
        if not hmac.compare_digest(_code_hash(secret, row["code_salt"], code), row["code_hash"]):
            with conn:
                conn.execute("UPDATE pending_registrations SET attempts = attempts + 1 WHERE nid = ?", (nid,))
            left = max(OTP_MAX_TRIES - row["attempts"] - 1, 0)
            raise srv.ApiError(400, "The code is wrong. %d tries left." % left, {"code": "Wrong code."})
        return dict(row)
    finally:
        conn.close()


def delete_pending(srv, nid):
    conn = srv.connect()
    try:
        with conn:
            conn.execute("DELETE FROM pending_registrations WHERE nid = ?", (nid,))
    finally:
        conn.close()


# ---------- administrator routes (called from admin_mgmt.py) ----------

def save(srv, handler, admin):
    from admin_mgmt_base import audit
    data = handler._read_json()
    mode = str(data.get("mode", "")).strip()
    url = str(data.get("api_url", "")).strip()[:500]
    method = str(data.get("http_method", "GET")).strip().upper()
    sender = " ".join(str(data.get("sender_id", "")).split())[:20]
    success = " ".join(str(data.get("success_text", "")).split())[:60]
    new_key = str(data.get("api_key", "")).strip()[:200]
    current = get_settings(srv)

    errors = {}
    if mode not in MODES:
        errors["mode"] = "Choose Off, Demo or Live."
    if url and not re.match(r"^https?://", url):
        errors["api_url"] = "Start with https:// (http:// only for a local test)."
    if mode == "live" and not url:
        errors["api_url"] = "Enter the API URL before turning on Live mode."
    if mode == "live" and not (new_key or current["api_key"]):
        errors["api_key"] = "Enter the API key before turning on Live mode."
    if method not in ("GET", "POST"):
        errors["http_method"] = "Choose GET or POST."
    if errors:
        raise srv.ApiError(400, "Please correct the highlighted fields.", errors)

    conn = srv.connect()
    try:
        with conn:
            conn.execute(
                "UPDATE sms_settings SET mode = ?, api_url = ?, http_method = ?, sender_id = ?, success_text = ?, "
                "updated_at = datetime('now', 'localtime') WHERE id = 1",
                (mode, url, method, sender, success))
            if new_key:
                conn.execute("UPDATE sms_settings SET api_key = ? WHERE id = 1", (new_key,))
    finally:
        conn.close()
    audit(srv, handler, admin["name"], "SMS settings", "Success", "High",
          "mode %s%s" % (mode, ", key changed" if new_key else ""))
    return 200, dict(ok=True, message="SMS settings saved.", **public_settings(srv))


def test(srv, handler, admin):
    from admin_mgmt_base import audit
    data = handler._read_json()
    phone = srv.normalize_phone(data.get("to", ""))
    if not phone:
        raise srv.ApiError(400, "Please correct the highlighted fields.", {"to": "Enter an 11-digit mobile number."})
    text = " ".join(str(data.get("message", "")).split())[:160] or "GovShield test message"
    settings = get_settings(srv)
    if settings["mode"] == "off":
        raise srv.ApiError(400, "SMS is off. Choose Demo or Live first.")
    if settings["mode"] == "demo":
        return 200, {"ok": True, "sent": False, "message": "Demo mode: nothing was sent. Choose Live to use the provider."}
    ok, reason = send(srv, settings, phone, text)
    audit(srv, handler, admin["name"], "SMS test", "Success" if ok else "Failed", "Low", mask_phone(phone))
    if not ok:
        raise srv.ApiError(502, "The SMS provider did not accept the message: " + reason)
    return 200, {"ok": True, "sent": True, "message": "Test SMS sent to %s." % mask_phone(phone)}
