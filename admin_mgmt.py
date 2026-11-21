"""Administrator management routes, mounted under /api/admin/mgmt/ (additive module).

server.py forwards requests here with one dispatch block. The caller has already
checked the administrator's Bearer token before handle() runs.
"""
import hmac
import re
import secrets

from admin_mgmt_base import (
    ROLES, ROLE_NOTES, audit, bearer_token, check_totp, db_one, db_rows, db_write,
    ensure_schema, grant_2fa_pass, new_totp_secret, passed_2fa, password_errors,
    permissions_for, temp_password, totp_locked, totp_uri,
)
import admin_mgmt_ops as ops

# these work before 2FA or a forced password change, so the admin can always get out of the lock
OPEN_PATHS = ("/me", "/password")
OPEN_PREFIXES = ("/2fa/",)


def handle(srv, handler, method, path):
    admin = srv.admin_session_user(handler)
    if not admin:
        raise srv.ApiError(401, "Please log in as an administrator.")
    bootstrap = getattr(srv, "ADMIN_USERNAME", "")
    ensure_schema(srv, bootstrap)
    sub = path[len("/api/admin/mgmt"):]
    profile = db_one(srv, "SELECT * FROM admin_profiles WHERE admin_id = ?", (admin["id"],))
    passed = (not profile["totp_enabled"]) or passed_2fa(srv, bearer_token(handler))

    is_open = sub in OPEN_PATHS or sub.startswith(OPEN_PREFIXES)
    if not is_open:
        if not passed:
            raise srv.ApiError(403, "Enter your two-step login code to continue.", {"gate": "2fa"})
        if profile["must_change_password"]:
            raise srv.ApiError(403, "Change your password before using this area.", {"gate": "password"})

    if sub == "/me" and method == "GET":
        return me_payload(admin, profile, passed)
    if sub == "/password" and method == "POST":
        return change_password(srv, handler, admin)
    if sub == "/2fa/setup" and method == "POST":
        return setup_2fa(srv, admin, profile)
    if sub == "/2fa/enable" and method == "POST":
        return enable_2fa(srv, handler, admin, profile)
    if sub == "/2fa/disable" and method == "POST":
        return disable_2fa(srv, handler, admin, profile)
    if sub == "/2fa/verify" and method == "POST":
        return verify_2fa(srv, handler, admin, profile)

    if sub == "/admins":
        require(srv, profile, "admins.view")
        if method == "GET":
            return list_admins(srv)
        if method == "POST":
            require(srv, profile, "admins.manage")
            return create_admin(srv, handler, admin)

    match = re.fullmatch(r"/admins/(\d+)/(role|active|reset-password|reset-2fa)", sub)
    if match and method == "POST":
        require(srv, profile, "admins.manage")
        return admin_action(srv, handler, admin, int(match.group(1)), match.group(2))

    return ops.handle(srv, handler, admin, profile, method, sub, passed)


def require(srv, profile, permission):
    if permission not in permissions_for(profile["role"]):
        raise srv.ApiError(403, "Your role does not allow this action.")


# ---------- own account ----------

def me_payload(admin, profile, passed):
    return 200, {"admin": {
        "id": admin["id"], "username": admin["username"], "name": admin["name"],
        "role": profile["role"], "role_label": ROLES.get(profile["role"], ""),
        "role_note": ROLE_NOTES.get(profile["role"], ""),
        "permissions": permissions_for(profile["role"]),
        "totp_enabled": bool(profile["totp_enabled"]),
        "passed_2fa": bool(passed),
        "must_change_password": bool(profile["must_change_password"]),
    }}


def change_password(srv, handler, admin):
    data = handler._read_json()
    current = str(data.get("current", ""))
    new = str(data.get("new", ""))
    row = db_one(srv, "SELECT password_salt, password_hash FROM admin_users WHERE id = ?", (admin["id"],))
    if not hmac.compare_digest(srv.password_digest(current, row["password_salt"]), row["password_hash"]):
        audit(srv, handler, admin["name"], "Password change", "Failed", "High", "wrong current password")
        raise srv.ApiError(401, "Your current password is wrong.", {"current": "Wrong password."})
    error = password_errors(new, current)
    if error:
        raise srv.ApiError(400, "Please correct the highlighted fields.", {"new": error})
    salt = secrets.token_hex(16)
    db_write(srv, "UPDATE admin_users SET password_salt = ?, password_hash = ? WHERE id = ?",
             (salt, srv.password_digest(new, salt), admin["id"]))
    db_write(srv, "UPDATE admin_profiles SET must_change_password = 0 WHERE admin_id = ?", (admin["id"],))
    audit(srv, handler, admin["name"], "Password changed", "Success", "Low")
    return 200, {"ok": True, "message": "Your password has been changed."}


# ---------- two-step login (authenticator app codes) ----------

def verify_code(srv, handler, admin, profile, code):
    """Checks a 6-digit code and returns its time step. Wrong codes are logged and rate limited."""
    if totp_locked(srv, admin["name"]):
        raise srv.ApiError(429, "Too many wrong codes. Wait 10 minutes and try again.")
    step = check_totp(profile["totp_secret"], code, profile["last_totp_step"])
    if step is None:
        audit(srv, handler, admin["name"], "2FA", "Failed", "High", "wrong code")
        raise srv.ApiError(400, "The code is wrong or was already used. Check your authenticator app.", {"code": "Wrong code."})
    return step


def setup_2fa(srv, admin, profile):
    if profile["totp_enabled"]:
        raise srv.ApiError(400, "Two-step login is already on. Turn it off first to set it up again.")
    secret = new_totp_secret()
    db_write(srv, "UPDATE admin_profiles SET totp_secret = ? WHERE admin_id = ?", (secret, admin["id"]))
    return 200, {"secret": secret, "uri": totp_uri(admin["username"], secret)}


def enable_2fa(srv, handler, admin, profile):
    data = handler._read_json()
    if profile["totp_enabled"]:
        raise srv.ApiError(400, "Two-step login is already on.")
    if not profile["totp_secret"]:
        raise srv.ApiError(400, "Start the setup first.")
    step = verify_code(srv, handler, admin, profile, data.get("code"))
    db_write(srv, "UPDATE admin_profiles SET totp_enabled = 1, last_totp_step = ? WHERE admin_id = ?", (step, admin["id"]))
    grant_2fa_pass(srv, bearer_token(handler))
    audit(srv, handler, admin["name"], "2FA turned on", "Success", "High")
    return 200, {"ok": True, "message": "Two-step login is on."}


def disable_2fa(srv, handler, admin, profile):
    data = handler._read_json()
    if not profile["totp_enabled"]:
        raise srv.ApiError(400, "Two-step login is not on.")
    row = db_one(srv, "SELECT password_salt, password_hash FROM admin_users WHERE id = ?", (admin["id"],))
    if not hmac.compare_digest(srv.password_digest(str(data.get("password", "")), row["password_salt"]), row["password_hash"]):
        audit(srv, handler, admin["name"], "2FA", "Failed", "High", "wrong password on turn-off")
        raise srv.ApiError(401, "Wrong password.", {"password": "Wrong password."})
    verify_code(srv, handler, admin, profile, data.get("code"))
    db_write(srv, "UPDATE admin_profiles SET totp_enabled = 0, totp_secret = '', last_totp_step = 0 WHERE admin_id = ?",
             (admin["id"],))
    audit(srv, handler, admin["name"], "2FA turned off", "Success", "High")
    return 200, {"ok": True, "message": "Two-step login is off."}


def verify_2fa(srv, handler, admin, profile):
    data = handler._read_json()
    if not profile["totp_enabled"]:
        raise srv.ApiError(400, "Two-step login is not on.")
    step = verify_code(srv, handler, admin, profile, data.get("code"))
    db_write(srv, "UPDATE admin_profiles SET last_totp_step = ? WHERE admin_id = ?", (step, admin["id"]))
    grant_2fa_pass(srv, bearer_token(handler))
    return 200, {"ok": True, "message": "Code accepted."}


# ---------- administrator accounts ----------

def list_admins(srv):
    rows = db_rows(srv, """
        SELECT u.id, u.username, u.full_name, u.is_active, p.role, p.totp_enabled, p.must_change_password,
               (SELECT MAX(a.created_at) FROM audit_log a WHERE a.user_label = u.full_name
                    AND a.action = 'Admin login' AND a.result = 'Success') AS last_login,
               (SELECT COUNT(*) FROM case_assignments c WHERE c.admin_id = u.id) AS open_cases
        FROM admin_users u JOIN admin_profiles p ON p.admin_id = u.id ORDER BY u.id""")
    return 200, {"admins": [{
        "id": r["id"], "username": r["username"], "name": r["full_name"], "active": bool(r["is_active"]),
        "role": r["role"], "role_label": ROLES.get(r["role"], r["role"]),
        "totp_enabled": bool(r["totp_enabled"]), "must_change_password": bool(r["must_change_password"]),
        "last_login": r["last_login"] or "", "open_cases": r["open_cases"],
    } for r in rows]}


def create_admin(srv, handler, actor):
    data = handler._read_json()
    username = str(data.get("username", "")).strip()
    full_name = " ".join(str(data.get("full_name", "")).split())[:80]
    role = str(data.get("role", "officer")).strip()
    errors = {}
    if not re.fullmatch(r"[A-Za-z0-9_.\-]{3,32}", username):
        errors["username"] = "Use 3 to 32 letters, numbers, dot, dash or underscore."
    if len(full_name) < 2:
        errors["full_name"] = "Enter the full name."
    if role not in ROLES:
        errors["role"] = "Choose a valid role."
    if errors:
        raise srv.ApiError(400, "Please correct the highlighted fields.", errors)
    if db_one(srv, "SELECT 1 FROM admin_users WHERE username = ?", (username,)):
        raise srv.ApiError(409, "This username already exists.", {"username": "Already used."})
    temp = temp_password()
    salt = secrets.token_hex(16)
    conn = srv.connect()
    try:
        with conn:
            cur = conn.execute(
                "INSERT INTO admin_users (username, full_name, password_salt, password_hash, is_active) VALUES (?, ?, ?, ?, 1)",
                (username, full_name, salt, srv.password_digest(temp, salt)))
            new_id = cur.lastrowid
            conn.execute("INSERT INTO admin_profiles (admin_id, role, must_change_password) VALUES (?, ?, 1)",
                         (new_id, role))
    finally:
        conn.close()
    audit(srv, handler, actor["name"], "Admin added", "Success", "High", "%s as %s" % (username, ROLES[role]))
    return 201, {"ok": True, "id": new_id, "username": username, "temp_password": temp,
                 "message": "Administrator added. Give the temporary password privately; they must change it at first login."}


def other_active_supers(srv, admin_id):
    row = db_one(srv, "SELECT COUNT(*) AS n FROM admin_users u JOIN admin_profiles p ON p.admin_id = u.id "
                      "WHERE p.role = 'super_admin' AND u.is_active = 1 AND u.id != ?", (admin_id,))
    return row["n"]


def admin_action(srv, handler, actor, admin_id, action):
    data = handler._read_json()
    target = db_one(srv, "SELECT id, username, full_name, is_active FROM admin_users WHERE id = ?", (admin_id,))
    if not target:
        raise srv.ApiError(404, "Administrator not found.")
    if target["id"] == actor["id"]:
        raise srv.ApiError(400, "You cannot change your own account here. Use My account instead.")
    old_role = db_one(srv, "SELECT role FROM admin_profiles WHERE admin_id = ?", (admin_id,))["role"]
    name = target["full_name"]

    if action == "role":
        role = str(data.get("role", "")).strip()
        if role not in ROLES:
            raise srv.ApiError(400, "Choose a valid role.", {"role": "Choose a valid role."})
        if old_role == "super_admin" and role != "super_admin" and other_active_supers(srv, admin_id) == 0:
            raise srv.ApiError(400, "At least one active super admin must remain.")
        db_write(srv, "UPDATE admin_profiles SET role = ? WHERE admin_id = ?", (role, admin_id))
        audit(srv, handler, actor["name"], "Role changed", "Success", "High",
              "%s: %s -> %s" % (target["username"], ROLES.get(old_role, old_role), ROLES[role]))
        return 200, {"ok": True, "message": "Role updated."}

    if action == "active":
        active = data.get("active") is True
        if not active and old_role == "super_admin" and other_active_supers(srv, admin_id) == 0:
            raise srv.ApiError(400, "At least one active super admin must remain.")
        db_write(srv, "UPDATE admin_users SET is_active = ? WHERE id = ?", (1 if active else 0, admin_id))
        audit(srv, handler, actor["name"], "Admin enabled" if active else "Admin disabled", "Success", "High",
              target["username"])
        return 200, {"ok": True, "message": "Account enabled." if active else "Account disabled. Its sessions stop working at once."}

    if action == "reset-password":
        temp = temp_password()
        salt = secrets.token_hex(16)
        db_write(srv, "UPDATE admin_users SET password_salt = ?, password_hash = ? WHERE id = ?",
                 (salt, srv.password_digest(temp, salt), admin_id))
        db_write(srv, "UPDATE admin_profiles SET must_change_password = 1 WHERE admin_id = ?", (admin_id,))
        audit(srv, handler, actor["name"], "Password reset", "Success", "High", target["username"])
        return 200, {"ok": True, "username": target["username"], "temp_password": temp,
                     "message": "Temporary password set. They must change it at next login."}

    # reset-2fa
    db_write(srv, "UPDATE admin_profiles SET totp_enabled = 0, totp_secret = '', last_totp_step = 0 WHERE admin_id = ?",
             (admin_id,))
    audit(srv, handler, actor["name"], "2FA reset", "Success", "High", target["username"])
    return 200, {"ok": True, "message": "Two-step login turned off for this administrator."}
