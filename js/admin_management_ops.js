/* Administrator management: Citizens, Cases and Audit trail views (additive).
   Loaded after admin_management.js, which provides MGMT, mgmtRequest, mgmtView and the dialog helpers. */

const MGMT_OPS = { seq: {}, timer: null, offset: 0, limit: 50, rows: [] };
const MGMT_CASE_STATUSES = ["Pending", "Processing", "Approved", "Rejected"];

const MGMT_CITIZEN_TOOLBAR = '<input class="adm-input" type="search" placeholder="Search name, NID or phone" data-field="q" data-mgmt-filter="citizens">'
    + '<select class="adm-select" data-field="status" data-mgmt-filter="citizens">'
    + '<option value="all">All accounts</option><option value="active">Active only</option><option value="disabled">Disabled only</option></select>';

const MGMT_CASE_TOOLBAR = '<input class="adm-input" type="search" placeholder="Search code, name or NID" data-field="q" data-mgmt-filter="cases">'
    + '<select class="adm-select" data-field="status" data-mgmt-filter="cases"><option value="">All statuses</option>'
    + MGMT_CASE_STATUSES.map(function (s) { return '<option value="' + s + '">' + s + '</option>'; }).join("")
    + '</select>'
    + '<select class="adm-select" data-field="owner" data-mgmt-filter="cases">'
    + '<option value="all">Any assignee</option><option value="unassigned">Unassigned</option><option value="mine">Assigned to me</option></select>';

const MGMT_AUDIT_TOOLBAR = '<input class="adm-input" type="search" placeholder="Who (name or username)" data-field="user" data-mgmt-filter="audit">'
    + '<select class="adm-select" data-field="action" data-mgmt-filter="audit"><option value="">All actions</option></select>'
    + '<select class="adm-select" data-field="result" data-mgmt-filter="audit"><option value="">Any result</option>'
    + '<option value="Success">Success</option><option value="Failed">Failed</option></select>'
    + '<input class="adm-input" type="date" title="From date" data-field="from" data-mgmt-filter="audit">'
    + '<input class="adm-input" type="date" title="To date" data-field="to" data-mgmt-filter="audit">'
    + '<button class="adm-btn" data-mgmt="audit-csv">Export this page (CSV)</button>';

/* ---------- shared helpers ---------- */

function mgmtOpsRender(sub) {
    if (sub === "citizens") return mgmtOpsCitizens();
    if (sub === "cases") return mgmtOpsCases();
    if (sub === "audit") return mgmtOpsAudit();
    if (sub === "sms") return mgmtOpsSms();
}

function mgmtOpsField(view, name) {
    const el = view.querySelector('[data-field="' + name + '"]');
    return el ? el.value.trim() : "";
}

// builds the toolbar once, so typing in a search box is never interrupted by a redraw
function mgmtOpsShell(name, title, note, toolbar) {
    const view = mgmtView(name);
    if (!view.querySelector('[data-table="' + name + '"]')) {
        view.innerHTML = '<div class="adm-mgmt-card"><h3>' + title + '</h3><p>' + note + '</p>'
            + '<div class="adm-mgmt-toolbar">' + toolbar + '</div>'
            + '<div data-table="' + name + '"></div>'
            + '<div class="adm-mgmt-pager" data-pager="' + name + '"></div></div>';
    }
    return view;
}

function mgmtOpsNext(name) {
    MGMT_OPS.seq[name] = (MGMT_OPS.seq[name] || 0) + 1;
    return MGMT_OPS.seq[name];
}

function mgmtStatusPill(status) {
    const cls = status === "Approved" ? "ok" : status === "Rejected" ? "bad" : status === "Processing" ? "warn" : "muted";
    return admPill(status, cls);
}

function mgmtOpsFilterChanged(name) {
    clearTimeout(MGMT_OPS.timer);
    MGMT_OPS.timer = setTimeout(function () {
        if (name === "audit") MGMT_OPS.offset = 0;
        if (MGMT.sub === name) mgmtOpsRender(name);
    }, 250);
}

document.addEventListener("input", function (event) {
    const el = event.target;
    if (el && el.dataset && el.dataset.mgmtFilter) mgmtOpsFilterChanged(el.dataset.mgmtFilter);
});

document.addEventListener("change", function (event) {
    const el = event.target;
    if (el && el.dataset && el.dataset.mgmtFilter) mgmtOpsFilterChanged(el.dataset.mgmtFilter);
});

/* ---------- Citizens ---------- */

async function mgmtOpsCitizens() {
    const view = mgmtOpsShell("citizens", "Citizens",
        "Registered citizen accounts. NIDs are masked. Disabling an account signs the citizen out at once.", MGMT_CITIZEN_TOOLBAR);
    const table = view.querySelector('[data-table="citizens"]');
    const seq = mgmtOpsNext("citizens");
    const query = new URLSearchParams({ q: mgmtOpsField(view, "q"), status: mgmtOpsField(view, "status") || "all" });
    try {
        const data = await mgmtRequest("/citizens?" + query.toString());
        if (seq !== MGMT_OPS.seq.citizens) return;
        const canManage = mgmtHas("citizens.manage");
        const rows = data.citizens.map(function (c) {
            const actions = canManage
                ? '<td><div class="adm-mgmt-actions"><button class="adm-btn small" data-mgmt="citizen-active" data-id="' + c.id
                    + '" data-value="' + (c.active ? "0" : "1") + '">' + (c.active ? "Disable" : "Enable") + '</button>'
                    + '<button class="adm-btn small" data-mgmt="citizen-reset" data-id="' + c.id + '" data-name="' + escapeHtml(c.name)
                    + '">Reset password</button></div></td>'
                : "";
            return '<tr><td><strong>' + escapeHtml(c.name) + '</strong></td><td>' + escapeHtml(c.nid) + '</td><td>'
                + escapeHtml(c.phone) + '</td><td>' + c.applications + '</td><td>' + escapeHtml(c.registered) + '</td><td>'
                + mgmtPill(c.active, "Active", "Disabled") + '</td>' + actions + '</tr>';
        }).join("");
        const cols = canManage ? 7 : 6;
        table.innerHTML = '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Name</th><th>NID</th><th>Phone</th>'
            + '<th>Applications</th><th>Registered</th><th>Status</th>' + (canManage ? '<th>Actions</th>' : '') + '</tr></thead><tbody>'
            + (rows || '<tr><td colspan="' + cols + '">No citizens match these filters.</td></tr>') + '</tbody></table></div>';
    } catch (error) {
        if (!error.sessionEnded) table.innerHTML = mgmtNotice(error.message, true);
    }
}

/* ---------- Cases ---------- */

async function mgmtOpsCases() {
    const view = mgmtOpsShell("cases", "Cases",
        "Applications, who is handling each one, and internal notes. Status changes are recorded in the audit trail.", MGMT_CASE_TOOLBAR);
    const table = view.querySelector('[data-table="cases"]');
    const seq = mgmtOpsNext("cases");
    const query = new URLSearchParams({ q: mgmtOpsField(view, "q"), status: mgmtOpsField(view, "status"), owner: mgmtOpsField(view, "owner") || "all" });
    try {
        const data = await mgmtRequest("/cases?" + query.toString());
        if (seq !== MGMT_OPS.seq.cases) return;
        const rows = data.cases.map(function (c) {
            return '<tr><td><strong>' + escapeHtml(c.code) + '</strong></td><td>' + escapeHtml(c.name) + '</td><td>'
                + escapeHtml(c.nid) + '</td><td>' + escapeHtml(c.service) + '</td><td>' + mgmtStatusPill(c.status) + '</td><td>'
                + (c.assigned_to ? escapeHtml(c.assigned_to) : admPill("Unassigned", "muted")) + '</td><td>' + c.notes + '</td><td>'
                + escapeHtml(c.created) + '</td><td><button class="adm-btn small" data-mgmt="case-open" data-code="'
                + escapeHtml(c.code) + '">Open</button></td></tr>';
        }).join("");
        table.innerHTML = '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Code</th><th>Applicant</th>'
            + '<th>NID</th><th>Service</th><th>Status</th><th>Assigned to</th><th>Notes</th><th>Created</th><th></th></tr></thead><tbody>'
            + (rows || '<tr><td colspan="9">No applications match these filters.</td></tr>') + '</tbody></table></div>';
    } catch (error) {
        if (!error.sessionEnded) table.innerHTML = mgmtNotice(error.message, true);
    }
}

async function mgmtOpsOpenCase(code) {
    const data = await mgmtRequest("/cases/" + encodeURIComponent(code));
    const c = data.case;
    const canWork = mgmtHas("cases.work");
    const statusOptions = MGMT_CASE_STATUSES.map(function (s) {
        return '<option value="' + s + '"' + (s === c.status ? " selected" : "") + '>' + s + '</option>';
    }).join("");
    const staffOptions = '<option value="0">Unassigned</option>' + data.staff.map(function (s) {
        return '<option value="' + s.id + '"' + (s.id === c.assigned_id ? " selected" : "") + '>' + escapeHtml(s.name) + '</option>';
    }).join("");
    const work = canWork
        ? '<div class="adm-mgmt-form">'
            + '<div class="adm-mgmt-field"><label>Status</label><select class="adm-select" id="mgmtCaseStatus">' + statusOptions + '</select></div>'
            + '<div class="adm-mgmt-field"><label>Assigned to</label><select class="adm-select" id="mgmtCaseAssign">' + staffOptions + '</select></div></div>'
            + '<div class="adm-mgmt-actions"><button class="adm-btn primary" data-mgmt="case-status" data-code="' + escapeHtml(c.code) + '">Save status</button>'
            + '<button class="adm-btn" data-mgmt="case-assign" data-code="' + escapeHtml(c.code) + '">Save assignment</button></div>'
        : '<p class="adm-mgmt-hint">Your role can view this case but cannot change it.</p>';
    const notes = data.notes.length
        ? '<ul class="adm-mgmt-note-list">' + data.notes.map(function (n) {
            return '<li><div class="meta">' + escapeHtml(n.author) + ' &middot; ' + escapeHtml(n.created) + '</div>'
                + '<div class="text">' + escapeHtml(n.note) + '</div></li>';
        }).join("") + '</ul>'
        : '<p class="adm-mgmt-hint">No notes yet.</p>';
    const addNote = canWork
        ? '<form class="adm-mgmt-form adm-mgmt-stack" data-mgmt-form="case-note" data-code="' + escapeHtml(c.code) + '" novalidate>'
            + '<div class="adm-mgmt-field"><label>Internal note (staff only)</label>'
            + '<textarea class="adm-input" name="note" rows="3" maxlength="1000"></textarea>'
            + '<div class="adm-mgmt-err" data-err="note"></div></div>'
            + '<div><button class="adm-btn" type="submit">Add note</button></div>'
            + '<div class="adm-mgmt-msg" data-msg></div></form>'
        : '';
    const history = data.history.length
        ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead><tbody>'
            + data.history.map(function (h) {
                return '<tr><td>' + escapeHtml(h.when) + '</td><td>' + escapeHtml(h.who || "") + '</td><td>'
                    + escapeHtml(h.action) + '</td><td>' + escapeHtml(h.detail) + '</td></tr>';
            }).join("") + '</tbody></table></div>'
        : '<p class="adm-mgmt-hint">No history yet.</p>';
    mgmtDialog(c.code + " · " + c.service,
        '<p>' + escapeHtml(c.name) + ' &middot; NID ' + escapeHtml(c.nid) + '</p>'
        + '<p class="adm-mgmt-hint">' + escapeHtml(c.address || "No address on file") + '</p>'
        + '<p>Status: ' + mgmtStatusPill(c.status) + ' &middot; Assigned: ' + escapeHtml(c.assigned_to || "nobody") + '</p>'
        + work + mgmtOpsDetailsHtml(data)
        + '<h4 class="adm-mgmt-sub">Notes</h4>' + addNote + notes
        + '<h4 class="adm-mgmt-sub">History</h4>' + history);
}

/* ---------- Audit trail ---------- */

async function mgmtOpsAudit() {
    const view = mgmtOpsShell("audit", "Audit trail",
        "Every sign-in, change and citizen action, with the time, the user and the IP address.", MGMT_AUDIT_TOOLBAR);
    const table = view.querySelector('[data-table="audit"]');
    const pager = view.querySelector('[data-pager="audit"]');
    const seq = mgmtOpsNext("audit");
    const query = new URLSearchParams({
        user: mgmtOpsField(view, "user"), action: mgmtOpsField(view, "action"), result: mgmtOpsField(view, "result"),
        from: mgmtOpsField(view, "from"), to: mgmtOpsField(view, "to"),
        limit: String(MGMT_OPS.limit), offset: String(MGMT_OPS.offset)
    });
    try {
        const data = await mgmtRequest("/audit?" + query.toString());
        if (seq !== MGMT_OPS.seq.audit) return;
        const select = view.querySelector('[data-field="action"]');
        if (select.options.length <= 1) data.actions.forEach(function (a) { select.add(new Option(a, a)); });
        MGMT_OPS.rows = data.rows;
        const rows = data.rows.map(function (r) {
            return '<tr><td>' + escapeHtml(r.when) + '</td><td>' + escapeHtml(r.who || "") + '</td><td>' + escapeHtml(r.ip || "")
                + '</td><td>' + escapeHtml(r.action) + '</td><td>' + admPill(r.result, r.result === "Success" ? "ok" : "bad")
                + '</td><td>' + admPill(r.severity, r.severity === "High" ? "warn" : "muted") + '</td><td>'
                + escapeHtml(r.detail || "") + '</td></tr>';
        }).join("");
        table.innerHTML = '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>When</th><th>Who</th><th>IP</th>'
            + '<th>Action</th><th>Result</th><th>Severity</th><th>Detail</th></tr></thead><tbody>'
            + (rows || '<tr><td colspan="7">No entries match these filters.</td></tr>') + '</tbody></table></div>';
        const from = data.total ? data.offset + 1 : 0;
        const to = Math.min(data.offset + data.limit, data.total);
        pager.innerHTML = '<span>Showing ' + from + '–' + to + ' of ' + data.total + '</span>'
            + '<button class="adm-btn small" data-mgmt="audit-page" data-dir="-1"' + (data.offset === 0 ? " disabled" : "") + '>Newer</button>'
            + '<button class="adm-btn small" data-mgmt="audit-page" data-dir="1"' + (to >= data.total ? " disabled" : "") + '>Older</button>';
    } catch (error) {
        if (!error.sessionEnded) table.innerHTML = mgmtNotice(error.message, true);
    }
}

function mgmtOpsCsv() {
    const head = ["When", "Who", "IP", "Action", "Result", "Severity", "Detail"];
    const safe = function (value) {
        let text = value === null || value === undefined ? "" : String(value);
        if (/^[=+\-@]/.test(text)) text = "'" + text;           // stops spreadsheet formulas
        return '"' + text.replace(/"/g, '""') + '"';
    };
    const lines = [head].concat(MGMT_OPS.rows.map(function (r) {
        return [r.when, r.who, r.ip, r.action, r.result, r.severity, r.detail];
    }));
    const csv = lines.map(function (cols) { return cols.map(safe).join(","); }).join("\r\n");
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "audit-trail.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

/* ---------- actions and forms ---------- */

async function mgmtOpsAct(action, el) {
    if (action === "citizen-active") {
        const enable = el.dataset.value === "1";
        if (!window.confirm(enable ? "Enable this citizen account?" : "Disable this citizen account? They will be signed out at once.")) return;
        const result = await mgmtRequest("/citizens/" + el.dataset.id + "/active", { active: enable });
        admToast(result.message, true);
        return mgmtOpsCitizens();
    }
    if (action === "citizen-reset") {
        if (!window.confirm("Set a new temporary password for this citizen? Their current password stops working.")) return;
        const result = await mgmtRequest("/citizens/" + el.dataset.id + "/reset-password", {});
        mgmtShowSecret("Temporary password", "For " + (el.dataset.name || result.name) + ". Give it to the citizen privately.",
            result.temp_password, "Ask the citizen to log in with it and keep it safe.");
        return mgmtOpsCitizens();
    }
    if (action === "case-open") return mgmtOpsOpenCase(el.dataset.code);
    if (action === "case-status") {
        const result = await mgmtRequest("/cases/" + el.dataset.code + "/status",
            { status: document.getElementById("mgmtCaseStatus").value });
        admToast(result.message, true);
        await mgmtOpsOpenCase(el.dataset.code);
        return mgmtOpsCases();
    }
    if (action === "case-assign") {
        const result = await mgmtRequest("/cases/" + el.dataset.code + "/assign",
            { admin_id: Number(document.getElementById("mgmtCaseAssign").value) });
        admToast(result.message, true);
        await mgmtOpsOpenCase(el.dataset.code);
        return mgmtOpsCases();
    }
    if (action === "audit-page") {
        MGMT_OPS.offset = Math.max(0, MGMT_OPS.offset + Number(el.dataset.dir) * MGMT_OPS.limit);
        return mgmtOpsAudit();
    }
    if (action === "audit-csv") return mgmtOpsCsv();
}

/* ---------- Applicant form details (case dialog) ---------- */

function mgmtOpsDetailsHtml(data) {
    const photo = data.photo
        ? '<div class="adm-mgmt-photo"><img src="' + escapeHtml(data.photo) + '" alt="Applicant photo"></div>'
        : '<p class="adm-mgmt-hint">No photo was attached to this application.</p>';
    const rows = (data.details || []).map(function (d) {
        return '<tr><th>' + escapeHtml(d.label) + '</th><td>' + escapeHtml(d.value) + '</td></tr>';
    }).join("");
    const details = rows
        ? '<div class="adm-table-wrap"><table class="adm-table"><tbody>' + rows + '</tbody></table></div>'
        : '<p class="adm-mgmt-hint">No extra form details on this application.</p>';
    return '<h4 class="adm-mgmt-sub">Applicant form</h4>' + photo + details;
}

/* ---------- SMS and API (sign-up phone codes) ---------- */

const MGMT_SMS_MODES = [
    ["off", "Off: no phone check at sign-up"],
    ["demo", "Demo: show the code on screen, send nothing"],
    ["live", "Live: send the code by SMS through the provider"]
];

async function mgmtOpsSms() {
    const view = mgmtView("sms");
    let s;
    try {
        s = await mgmtRequest("/sms");
    } catch (error) {
        if (!error.sessionEnded) view.innerHTML = mgmtNotice(error.message, true);
        return;
    }
    const modes = MGMT_SMS_MODES.map(function (m) {
        return '<option value="' + m[0] + '"' + (m[0] === s.mode ? " selected" : "") + '>' + escapeHtml(m[1]) + '</option>';
    }).join("");
    const methods = ["GET", "POST"].map(function (m) {
        return '<option' + (m === s.http_method ? " selected" : "") + '>' + m + '</option>';
    }).join("");
    const keyNote = s.has_key
        ? "Saved as " + escapeHtml(s.key_hint) + ". Leave this blank to keep the current key."
        : "No key saved yet. Live mode needs one.";
    view.innerHTML = '<div class="adm-mgmt-card"><h3>Sign-up phone codes</h3>'
        + '<p>When the phone code is on, a new citizen must enter a 6-digit code sent to their mobile before the account opens. Use Demo while testing. Live sends real SMS through your provider.</p>'
        + '<form class="adm-mgmt-form adm-mgmt-stack" data-mgmt-form="sms-settings" novalidate>'
        + '<div class="adm-mgmt-field"><label>Mode</label><select class="adm-select" name="mode">' + modes + '</select><div class="adm-mgmt-err" data-err="mode"></div></div>'
        + '<div class="adm-mgmt-field"><label>Provider URL</label><input class="adm-input" name="api_url" value="' + escapeHtml(s.api_url) + '" maxlength="500" placeholder="https://provider.example/send?key={apikey}&amp;sender={sender}&amp;to={to}&amp;msg={message}"><div class="adm-mgmt-err" data-err="api_url"></div></div>'
        + '<div class="adm-mgmt-field"><label>Request method</label><select class="adm-select" name="http_method">' + methods + '</select><div class="adm-mgmt-err" data-err="http_method"></div></div>'
        + '<div class="adm-mgmt-field"><label>API key</label><input class="adm-input" type="password" name="api_key" autocomplete="new-password" placeholder="' + (s.has_key ? "Saved" : "Paste the key") + '"><div class="adm-mgmt-hint">' + keyNote + '</div><div class="adm-mgmt-err" data-err="api_key"></div></div>'
        + '<div class="adm-mgmt-field"><label>Sender ID</label><input class="adm-input" name="sender_id" value="' + escapeHtml(s.sender_id) + '" maxlength="20"><div class="adm-mgmt-err" data-err="sender_id"></div></div>'
        + '<div class="adm-mgmt-field"><label>Success word in the reply</label><input class="adm-input" name="success_text" value="' + escapeHtml(s.success_text) + '" maxlength="60"><div class="adm-mgmt-hint">If the provider reply contains this word, the SMS counts as sent.</div><div class="adm-mgmt-err" data-err="success_text"></div></div>'
        + '<p class="adm-mgmt-hint">Placeholders: {apikey}, {sender}, {to}, {message}. Values are encoded for the URL automatically.</p>'
        + '<div><button class="adm-btn primary" type="submit">Save settings</button></div>'
        + '<div class="adm-mgmt-msg" data-msg></div></form></div>'
        + '<div class="adm-mgmt-card"><h3>Send a test SMS</h3><p>Checks the provider with a real message. In Demo mode nothing is sent.</p>'
        + '<form class="adm-mgmt-form adm-mgmt-stack" data-mgmt-form="sms-test" novalidate>'
        + '<div class="adm-mgmt-field"><label>Mobile number</label><input class="adm-input" name="to" maxlength="16" placeholder="01XXXXXXXXX"><div class="adm-mgmt-err" data-err="to"></div></div>'
        + '<div class="adm-mgmt-field"><label>Message (optional)</label><input class="adm-input" name="message" maxlength="160"><div class="adm-mgmt-err" data-err="message"></div></div>'
        + '<div><button class="adm-btn" type="submit">Send test</button></div>'
        + '<div class="adm-mgmt-msg" data-msg></div></form></div>';
}

async function mgmtOpsSmsSave(data) {
    const result = await mgmtRequest("/sms", {
        mode: data.mode, api_url: data.api_url, http_method: data.http_method,
        api_key: data.api_key, sender_id: data.sender_id, success_text: data.success_text
    });
    admToast(result.message || "SMS settings saved.", true);
    return mgmtOpsSms();
}

async function mgmtOpsSmsTest(form, data) {
    const result = await mgmtRequest("/sms/test", { to: data.to, message: data.message });
    mgmtFlash(form, result.message, false);
}

async function mgmtOpsForm(name, form, data) {
    if (name === "sms-settings") return mgmtOpsSmsSave(data);
    if (name === "sms-test") return mgmtOpsSmsTest(form, data);
    if (name === "case-note") {
        const code = form.dataset.code;
        await mgmtRequest("/cases/" + code + "/notes", { note: data.note });
        admToast("Note saved.", true);
        await mgmtOpsOpenCase(code);
        return mgmtOpsCases();
    }
    throw new Error("Unknown form.");
}
