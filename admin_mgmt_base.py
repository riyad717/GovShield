"""Shared helpers for the administrator management module (stdlib only).

This file is part of the additive admin management feature. It does not change
any existing GovShield code. server.py only forwards /api/admin/mgmt/* requests
to admin_mgmt.handle(), which uses the helpers below.
"""
import base64
import hashlib
import hmac
import re
import secrets
import struct
import time
from urllib.parse import quote

ROLES = {"super_admin": "Super admin", "officer": "Officer", "viewer": "Read-only viewer"}

ROLE_NOTES = {
    "super_admin": "Full control: administrators, citizens, cases and the audit trail.",
    "officer": "Works citizens and cases. Can enable/disable citizens, reset citizen passwords, add notes, assign and change status.",
    "viewer": "Read-only. Can see citizens, cases and the audit trail, but cannot change anything.",
}

PERMISSION_LABELS = {
    "admins.view": "See the administrator list",
    "admins.manage": "Add administrators, change roles, enable/disable, reset passwords and 2FA",
    "citizens.view": "See the citizen list (NID masked)",
    "citizens.manage": "Enable/disable citizens and reset citizen passwords",
    "cases.view": "See applications and case history",
    "cases.work": "Add notes, assign cases and change application status",
    "audit.view": "See the audit trail",
    "roles.view": "See roles and rights",
}

ROLE_PERMS = {
    "super_admin": {"admins.view", "admins.manage", "citizens.view", "citizens.manage",
                    "cases.view", "cases.work", "audit.view", "roles.view"},
    "officer": {"citizens.view", "citizens.manage", "cases.view", "cases.work", "roles.view"},
    "viewer": {"citizens.view", "cases.view", "audit.view", "roles.view"},
}

TOTP_STEP_SECONDS = 30
TOTP_PASS_SECONDS = 30 * 60        # after a correct 2FA code, the management area stays open this long
TOTP_MAX_FAILS = 5                 # wrong codes allowed in 10 minutes

SCHEMA = """
CREATE TABLE IF NOT EXISTS admin_profiles (
    admin_id INTEGER PRIMARY KEY,
    role TEXT NOT NULL DEFAULT 'officer',
    totp_secret TEXT NOT NULL DEFAULT '',
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    last_totp_step INTEGER NOT NULL DEFAULT 0,
    must_change_password INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS admin_2fa_passes (
    token TEXT PRIMARY KEY,
    expires_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS case_assignments (
    app_code TEXT PRIMARY KEY,
    admin_id INTEGER NOT NULL,
    assigned_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS case_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_code TEXT NOT NULL,
    author TEXT NOT NULL,
    note TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
"""


# ---------- database helpers ----------

def db_one(srv, sql, params=()):
    conn = srv.connect()
    try:
        return conn.execute(sql, params).fetchone()
    finally:
        conn.close()


def db_rows(srv, sql, params=()):
    conn = srv.connect()
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


def db_write(srv, sql, params=()):
    conn = srv.connect()
    try:
        with conn:
            return conn.execute(sql, params)
    finally:
        conn.close()


def ensure_schema(srv, bootstrap_username):
    """Creates the new tables if missing and gives every administrator a role row."""
    conn = srv.connect()
    try:
        conn.executescript(SCHEMA)
        with conn:
            conn.execute(
                "INSERT OR IGNORE INTO admin_profiles (admin_id, role) "
                "SELECT id, CASE WHEN username = ? THEN 'super_admin' ELSE 'officer' END FROM admin_users",
                (bootstrap_username,),
            )
    finally:
        conn.close()


def audit(srv, handler, label, action, result, severity, detail=""):
    srv.record_audit(label, handler.client_address[0], action, result, severity,
                     " ".join(str(detail).split())[:120])


def permissions_for(role):
    return sorted(ROLE_PERMS.get(role, set()))


def bearer_token(handler):
    header = handler.headers.get("Authorization", "")
    return header[7:].strip() if header.startswith("Bearer ") else ""


# ---------- passwords ----------

def password_errors(password, current=None):
    if len(password) < 10 or len(password) > 128:
        return "Use 10 to 128 characters."
    if not (re.search(r"[A-Za-z]", password) and re.search(r"[0-9]", password)):
        return "Use both letters and numbers."
    if current is not None and password == current:
        return "Choose a password different from the current one."
    return ""


def temp_password():
    """A readable one-time password with letters and numbers."""
    alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    while True:
        text = "".join(secrets.choice(alphabet) for _ in range(12))
        if re.search(r"[A-Za-z]", text) and re.search(r"[0-9]", text):
            return text


# ---------- two-factor codes (TOTP, RFC 6238, SHA-1, 6 digits, 30 seconds) ----------

def new_totp_secret():
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii")


def totp_at(secret, step):
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    digest = hmac.new(key, struct.pack(">Q", step), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return "%06d" % (value % 1000000)


def check_totp(secret, code, last_step):
    """The time step the code matches (accepted once only), or None."""
    code = str(code or "").strip()
    if not secret or not re.fullmatch(r"[0-9]{6}", code):
        return None
    now_step = int(time.time()) // TOTP_STEP_SECONDS
    for step in range(now_step - 1, now_step + 2):          # allow one step of clock drift
        if step > last_step and hmac.compare_digest(totp_at(secret, step), code):
            return step
    return None


def totp_uri(username, secret):
    return "otpauth://totp/GovShield:%s?secret=%s&issuer=GovShield" % (quote(username), secret)


def totp_locked(srv, label):
    row = db_one(srv, "SELECT COUNT(*) AS n FROM audit_log WHERE action = '2FA' AND result = 'Failed' "
                      "AND user_label = ? AND created_at >= datetime('now', 'localtime', '-10 minutes')", (label,))
    return row["n"] >= TOTP_MAX_FAILS


def passed_2fa(srv, token):
    row = db_one(srv, "SELECT 1 FROM admin_2fa_passes WHERE token = ? AND expires_at > ?", (token, time.time()))
    return row is not None


def grant_2fa_pass(srv, token):
    now = time.time()
    db_write(srv, "DELETE FROM admin_2fa_passes WHERE expires_at < ?", (now,))
    db_write(srv, "INSERT OR REPLACE INTO admin_2fa_passes (token, expires_at) VALUES (?, ?)",
             (token, now + TOTP_PASS_SECONDS))
