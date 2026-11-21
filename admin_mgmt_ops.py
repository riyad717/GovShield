"""Citizen accounts, case handling, audit trail and roles for the admin management module.

Part of the additive admin management feature (stdlib only). Routes are reached
through admin_mgmt.handle() after the 2FA and password gates have passed.
"""
import re
import secrets
from urllib.parse import parse_qs, urlparse

from admin_mgmt_base import (
    PERMISSION_LABELS, ROLE_NOTES, ROLE_PERMS, ROLES, audit, db_one, db_rows, db_write,
    permissions_for, temp_password,
)


def handle(srv, handler, admin, profile, method, sub, passed):
    query = parse_qs(urlparse(handler.path).query)

    if sub == "/citizens" and method == "GET":
        need(srv, profile, "citizens.view")
        return list_citizens(srv, query)
    match = re.fullmatch(r"/citizens/(\d+)/(active|reset-password)", sub)
    if match and method == "POST":
        need(srv, profile, "citizens.manage")
        return citizen_action(srv, handler, admin, int(match.group(1)), match.group(2))

    if sub == "/cases" and method == "GET":
        need(srv, profile, "cases.view")
        return list_cases(srv, query, admin)
    match = re.fullmatch(r"/cases/(APP-\d+)", sub)
    if match and method == "GET":
        need(srv, profile, "cases.view")
        return case_detail(srv, match.group(1))
    match = re.fullmatch(r"/cases/(APP-\d+)/(notes|assign|status)", sub)
    if match and method == "POST":
        need(srv, profile, "cases.work")
        return case_action(srv, handler, admin, match.group(1), match.group(2))

    if sub == "/audit" and method == "GET":
        need(srv, profile, "audit.view")
        return list_audit(srv, query)
    if sub == "/roles" and method == "GET":
        need(srv, profile, "roles.view")
        return roles_payload()

    raise srv.ApiError(404, "Not found.")


def need(srv, profile, permission):
    if permission not in permissions_for(profile["role"]):
        raise srv.ApiError(403, "Your role does not allow this action.")


def _text(query, key, limit):
    return (query.get(key) or [""])[0].strip()[:limit]


# ---------- citizens ----------

def list_citizens(srv, query):
    q = _text(query, "q", 60)
    status = _text(query, "status", 10)
    sql = """SELECT c.id, c.full_name, c.nid_number, c.phone_number, c.is_active, c.created_at,
             (SELECT COUNT(*) FROM applications a WHERE a.national_id = c.nid_number) AS applications
             FROM authorized_users c WHERE 1=1"""
    params = []
    if q:
        like = "%" + q + "%"
        sql += " AND (c.full_name LIKE ? OR c.nid_number LIKE ? OR c.phone_number LIKE ?)"
        params += [like, like, like]
    if status == "active":
        sql += " AND c.is_active = 1"
    elif status == "disabled":
        sql += " AND c.is_active = 0"
    sql += " ORDER BY c.id LIMIT 300"
    rows = db_rows(srv, sql, params)
    return 200, {"citizens": [{
        "id": r["id"], "name": r["full_name"], "nid": srv.mask_nid(r["nid_number"]),
        "phone": r["phone_number"], "active": bool(r["is_active"]),
        "registered": r["created_at"], "applications": r["applications"],
    } for r in rows]}


def citizen_action(srv, handler, actor, citizen_id, action):
    row = db_one(srv, "SELECT id, full_name, nid_number FROM authorized_users WHERE id = ?", (citizen_id,))
    if not row:
        raise srv.ApiError(404, "Citizen account not found.")
    who = "%s (NID %s)" % (row["full_name"], srv.mask_nid(row["nid_number"]))
    if action == "active":
        data = handler._read_json()
        active = data.get("active") is True
        db_write(srv, "UPDATE authorized_users SET is_active = ? WHERE id = ?", (1 if active else 0, citizen_id))
        audit(srv, handler, actor["name"], "Citizen enabled" if active else "Citizen disabled",
              "Success", "Low" if active else "High", who)
        if active:
            return 200, {"ok": True, "message": "Citizen account enabled."}
        return 200, {"ok": True, "message": "Citizen account disabled. Their sessions stop working at once."}
    temp = temp_password()
    salt = secrets.token_hex(16)
    db_write(srv, "UPDATE authorized_users SET password_salt = ?, password_hash = ? WHERE id = ?",
             (salt, srv.password_digest(temp, salt), citizen_id))
    audit(srv, handler, actor["name"], "Citizen password reset", "Success", "High", who)
    return 200, {"ok": True, "name": row["full_name"], "temp_password": temp,
                 "message": "Temporary password set. Give it to the citizen privately."}


# ---------- cases (applications) ----------

def list_cases(srv, query, admin):
    q = _text(query, "q", 60)
    status = _text(query, "status", 20)
    owner = _text(query, "owner", 20)
    sql = """SELECT a.app_code, a.service, a.applicant_name, a.national_id, a.status, a.created_at,
             (SELECT u.full_name FROM case_assignments c JOIN admin_users u ON u.id = c.admin_id
                  WHERE c.app_code = a.app_code) AS assigned_to,
             (SELECT c.admin_id FROM case_assignments c WHERE c.app_code = a.app_code) AS assigned_id,
             (SELECT COUNT(*) FROM case_notes n WHERE n.app_code = a.app_code) AS notes
             FROM applications a WHERE 1=1"""
    params = []
    if q:
        like = "%" + q + "%"
        sql += " AND (a.app_code LIKE ? OR a.applicant_name LIKE ? OR a.national_id LIKE ?)"
        params += [like, like, like]
    if status in srv.APP_STATUSES:
        sql += " AND a.status = ?"
        params.append(status)
    if owner == "unassigned":
        sql += " AND NOT EXISTS (SELECT 1 FROM case_assignments c WHERE c.app_code = a.app_code)"
    elif owner == "mine":
        sql += " AND EXISTS (SELECT 1 FROM case_assignments c WHERE c.app_code = a.app_code AND c.admin_id = ?)"
        params.append(admin["id"])
    sql += " ORDER BY a.id DESC LIMIT 300"
    rows = db_rows(srv, sql, params)
    return 200, {"statuses": list(srv.APP_STATUSES), "cases": [{
        "code": r["app_code"], "service": r["service"], "name": r["applicant_name"],
        "nid": srv.mask_nid(r["national_id"] or ""), "status": r["status"], "created": r["created_at"],
        "assigned_to": r["assigned_to"] or "", "assigned_id": r["assigned_id"] or 0, "notes": r["notes"],
    } for r in rows]}


def case_detail(srv, code):
    app = db_one(srv, "SELECT * FROM applications WHERE app_code = ?", (code,))
    if not app:
        raise srv.ApiError(404, "Application not found.")
    assign = db_one(srv, "SELECT c.admin_id, u.full_name FROM case_assignments c "
                         "JOIN admin_users u ON u.id = c.admin_id WHERE c.app_code = ?", (code,))
    notes = db_rows(srv, "SELECT id, author, note, created_at FROM case_notes WHERE app_code = ? ORDER BY id DESC", (code,))
    history = db_rows(srv, "SELECT created_at, user_label, action, detail FROM audit_log "
                           "WHERE detail LIKE ? ORDER BY id DESC LIMIT 50", (code + " %",))
    staff = db_rows(srv, "SELECT id, full_name FROM admin_users WHERE is_active = 1 ORDER BY full_name")
    return 200, {
        "staff": [{"id": s["id"], "name": s["full_name"]} for s in staff],
        "case": {
            "code": app["app_code"], "service": app["service"], "name": app["applicant_name"],
            "nid": srv.mask_nid(app["national_id"] or ""), "address": app["address"] or "",
            "status": app["status"], "created": app["created_at"],
            "assigned_id": assign["admin_id"] if assign else 0,
            "assigned_to": assign["full_name"] if assign else "",
        },
        "notes": [{"id": n["id"], "author": n["author"], "note": n["note"], "created": n["created_at"]} for n in notes],
        "history": [{"when": h["created_at"], "who": h["user_label"], "action": h["action"], "detail": h["detail"]}
                    for h in history],
    }


def case_action(srv, handler, admin, code, action):
    data = handler._read_json()
    if not db_one(srv, "SELECT 1 FROM applications WHERE app_code = ?", (code,)):
        raise srv.ApiError(404, "Application not found.")

    if action == "notes":
        note = str(data.get("note", "")).strip()
        if len(note) < 2 or len(note) > 1000:
            raise srv.ApiError(400, "Please correct the highlighted fields.", {"note": "Write 2 to 1000 characters."})
        db_write(srv, "INSERT INTO case_notes (app_code, author, note) VALUES (?, ?, ?)", (code, admin["name"], note))
        audit(srv, handler, admin["name"], "Case note", "Success", "Low", "%s - note added" % code)
        return 201, {"ok": True, "message": "Note saved."}

    if action == "assign":
        try:
            target = int(data.get("admin_id", 0))
        except (TypeError, ValueError):
            raise srv.ApiError(400, "Choose an administrator.", {"admin_id": "Choose an administrator."})
        if target == 0:
            db_write(srv, "DELETE FROM case_assignments WHERE app_code = ?", (code,))
            audit(srv, handler, admin["name"], "Case assigned", "Success", "Low", "%s - unassigned" % code)
            return 200, {"ok": True, "message": "Case unassigned."}
        who = db_one(srv, "SELECT full_name FROM admin_users WHERE id = ? AND is_active = 1", (target,))
        if not who:
            raise srv.ApiError(400, "Choose an active administrator.", {"admin_id": "Choose an active administrator."})
        db_write(srv, "INSERT OR REPLACE INTO case_assignments (app_code, admin_id) VALUES (?, ?)", (code, target))
        audit(srv, handler, admin["name"], "Case assigned", "Success", "Low", "%s - assigned to %s" % (code, who["full_name"]))
        return 200, {"ok": True, "message": "Case assigned to %s." % who["full_name"]}

    status = str(data.get("status", "")).strip()
    if status not in srv.APP_STATUSES:
        raise srv.ApiError(400, "Please choose a valid status.", {"status": "Choose a valid status."})
    old_status = srv.change_application_status(code, status)
    audit(srv, handler, admin["name"], "Status", "Success", "Low", "%s - %s -> %s" % (code, old_status, status))
    return 200, {"ok": True, "id": code, "status": status, "message": "Status updated."}


# ---------- audit trail ----------

def list_audit(srv, query):
    where, params = [], []
    user = _text(query, "user", 60)
    if user:
        where.append("user_label LIKE ?")
        params.append("%" + user + "%")
    action = _text(query, "action", 40)
    if action:
        where.append("action = ?")
        params.append(action)
    result = _text(query, "result", 10)
    if result in ("Success", "Failed"):
        where.append("result = ?")
        params.append(result)
    day_from = _text(query, "from", 10)
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", day_from):
        where.append("date(created_at) >= ?")
        params.append(day_from)
    day_to = _text(query, "to", 10)
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", day_to):
        where.append("date(created_at) <= ?")
        params.append(day_to)
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    try:
        limit = min(max(int(_text(query, "limit", 3) or 50), 1), 100)
    except ValueError:
        limit = 50
    try:
        offset = max(int(_text(query, "offset", 7) or 0), 0)
    except ValueError:
        offset = 0
    total = db_one(srv, "SELECT COUNT(*) AS n FROM audit_log" + clause, params)["n"]
    rows = db_rows(srv, "SELECT id, created_at, user_label, ip_address, action, result, severity, detail "
                        "FROM audit_log" + clause + " ORDER BY id DESC LIMIT ? OFFSET ?", params + [limit, offset])
    actions = [r["action"] for r in db_rows(srv, "SELECT DISTINCT action FROM audit_log ORDER BY action")]
    return 200, {"total": total, "limit": limit, "offset": offset, "actions": actions, "rows": [{
        "id": r["id"], "when": r["created_at"], "who": r["user_label"], "ip": r["ip_address"],
        "action": r["action"], "result": r["result"], "severity": r["severity"], "detail": r["detail"],
    } for r in rows]}


# ---------- roles and rights ----------

def roles_payload():
    return 200, {
        "roles": [{"id": k, "label": v, "note": ROLE_NOTES.get(k, ""), "permissions": sorted(ROLE_PERMS.get(k, set()))}
                  for k, v in ROLES.items()],
        "permissions": [{"id": k, "label": v} for k, v in PERMISSION_LABELS.items()],
    }
