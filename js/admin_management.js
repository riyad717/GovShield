/* Administrator management: the Management tab inside the admin console (additive).
   Loaded after admin.js and admin_management_ops.js. Uses only /api/admin/mgmt/* and the existing admin session. */

const MGMT = { me: null, roles: null, sub: "my", setup: null, busy: false, pane: null, cases: [], staff: [] };

const MGMT_SUB_PERMS = { admins: "admins.view", citizens: "citizens.view", cases: "cases.view", audit: "audit.view" };

const MGMT_SHELL_HTML = ''
    + '<div class="adm-mgmt" id="mgmtRoot">'
    + '<div id="mgmtGate" hidden></div>'
    + '<div id="mgmtBody" hidden>'
    + '<div class="adm-mgmt-subtabs">'
    + '<button class="adm-mgmt-subtab active" data-mgmt="sub" data-sub="my">My account</button>'
    + '<button class="adm-mgmt-subtab" data-mgmt="sub" data-sub="admins">Administrators</button>'
    + '<button class="adm-mgmt-subtab" data-mgmt="sub" data-sub="citizens">Citizens</button>'
    + '<button class="adm-mgmt-subtab" data-mgmt="sub" data-sub="cases">Cases</button>'
    + '<button class="adm-mgmt-subtab" data-mgmt="sub" data-sub="audit">Audit trail</button>'
    + '<button class="adm-mgmt-subtab" data-mgmt="sub" data-sub="roles">Roles and rights</button>'
    + '</div>'
    + '<div class="adm-mgmt-view active" data-view="my"></div>'
    + '<div class="adm-mgmt-view" data-view="admins"></div>'
    + '<div class="adm-mgmt-view" data-view="citizens"></div>'
    + '<div class="adm-mgmt-view" data-view="cases"></div>'
    + '<div class="adm-mgmt-view" data-view="audit"></div>'
    + '<div class="adm-mgmt-view" data-view="roles"></div>'
    + '</div></div>';

/* ---------- request helper ---------- */

function mgmtHas(permission) {
    return !!(MGMT.me && MGMT.me.permissions.indexOf(permission) !== -1);
}

function mgmtFieldError(key, message) {
    const error = new Error(message);
    error.errors = {};
    error.errors[key] = message;
    return error;
}

async function mgmtRequest(path, body) {
    const headers = {};
    const token = sessionStorage.getItem(ADM_TOKEN_KEY);
    if (token) headers["Authorization"] = "Bearer " + token;
    let payload;
    if (body !== undefined) {
        payload = JSON.stringify(body);
        headers["Content-Type"] = "application/json";
    }
    let response;
    try {
        response = await fetch("/api/admin/mgmt" + path, {
            method: payload === undefined ? "GET" : "POST", headers: headers, body: payload
        });
    } catch (e) {
        throw new Error("Cannot reach the server. Make sure the server is running.");
    }
    let data = {};
    try { data = await response.json(); } catch (e) { data = {}; }
    if (!response.ok) {
        const error = new Error(data.error || "Something went wrong.");
        error.errors = data.errors || {};
        if (response.status === 401 && Object.keys(error.errors).length === 0) {
            sessionStorage.removeItem(ADM_TOKEN_KEY);
            admShowLogin("Your session has ended. Please log in again.");
            error.sessionEnded = true;
        }
        throw error;
    }
    return data;
}

async function mgmtLoadRoles() {
    if (!MGMT.roles) MGMT.roles = await mgmtRequest("/roles");
    return MGMT.roles;
}

/* ---------- small DOM helpers ---------- */

function mgmtView(name) {
    return document.querySelector('#mgmtRoot [data-view="' + name + '"]');
}

function mgmtNotice(message, bad) {
    return '<div class="adm-mgmt-card"><div class="adm-mgmt-msg' + (bad ? " bad" : "") + '">' + escapeHtml(message) + '</div></div>';
}

function mgmtFlash(form, text, bad) {
    const msg = form && form.querySelector("[data-msg]");
    if (!msg) return;
    msg.textContent = text;
    msg.classList.toggle("bad", !!bad);
}

function mgmtClearErrors(form) {
    form.querySelectorAll("[data-err]").forEach(function (el) { el.textContent = ""; });
    mgmtFlash(form, "", false);
}

function mgmtShowErrors(form, error) {
    mgmtClearErrors(form);
    const errors = error.errors || {};
    let shown = false;
    Object.keys(errors).forEach(function (key) {
        const el = form.querySelector('[data-err="' + key + '"]');
        if (el) { el.textContent = errors[key]; shown = true; }
    });
    if (!shown || Object.keys(errors).length === 0) mgmtFlash(form, error.message, true);
}

function mgmtField(label, name, type, extra) {
    return '<div class="adm-mgmt-field"><label>' + escapeHtml(label) + '</label>'
        + '<input class="adm-input" name="' + name + '" type="' + (type || "text") + '" ' + (extra || "") + '>'
        + '<div class="adm-mgmt-err" data-err="' + name + '"></div></div>';
}

function mgmtPill(on, onText, offText) {
    return on ? admPill(onText, "ok") : admPill(offText, "muted");
}

/* ---------- dialogs ---------- */

function mgmtDialog(title, html) {
    document.getElementById("mgmtDialogBody").innerHTML = '<h3 class="adm-mgmt-dialog-title">' + escapeHtml(title) + '</h3>' + html;
    document.getElementById("mgmtDialog").hidden = false;
}

function mgmtCloseDialog() {
    document.getElementById("mgmtDialog").hidden = true;
    document.getElementById("mgmtDialogBody").innerHTML = "";
    MGMT.setup = null;
}

function mgmtShowSecret(title, label, value, note) {
    mgmtDialog(title,
        '<p class="adm-mgmt-hint">' + escapeHtml(label) + '</p>'
        + '<div class="adm-mgmt-secret" id="mgmtSecretText">' + escapeHtml(value) + '</div>'
        + '<p class="adm-mgmt-hint">' + escapeHtml(note) + '</p>'
        + '<div class="adm-mgmt-actions"><button class="adm-btn primary" data-mgmt="copy">Copy</button>'
        + '<button class="adm-btn" data-mgmt="close">Done</button></div>');
}

function mgmtCopy() {
    const text = (document.getElementById("mgmtSecretText") || {}).textContent || "";
    if (!navigator.clipboard) { admToast("Select the text and copy it.", false); return; }
    navigator.clipboard.writeText(text).then(
        function () { admToast("Copied.", true); },
        function () { admToast("Could not copy. Select the text and copy it.", false); });
}

function mgmtDisableForm() {
    return '<form class="adm-mgmt-form" data-mgmt-form="2fa-disable" novalidate>'
        + mgmtField("Your password", "password", "password", 'autocomplete="current-password"')
        + mgmtField("Current 6-digit code", "code", "text", 'inputmode="numeric" maxlength="6" autocomplete="one-time-code"')
        + '<div class="adm-mgmt-actions"><button class="adm-btn" type="submit">Turn off two-step login</button></div>'
        + '<div class="adm-mgmt-msg" data-msg></div></form>';
}

/* ---------- gates: two-step code and forced password change ---------- */

function mgmtGate2faHtml() {
    return '<div class="adm-mgmt-card adm-mgmt-gate">'
        + '<h3>Two-step login</h3>'
        + '<p>Enter the 6-digit code from your authenticator app to open Management.</p>'
        + '<form class="adm-mgmt-form" data-mgmt-form="gate-2fa" novalidate>'
        + mgmtField("Code", "code", "text", 'inputmode="numeric" maxlength="6" autocomplete="one-time-code"')
        + '<div><button class="adm-btn primary" type="submit">Continue</button></div>'
        + '<div class="adm-mgmt-msg" data-msg></div></form>'
        + '<p class="adm-mgmt-hint">Lost your phone? <button class="adm-btn small" data-mgmt="2fa-off-open">Turn off two-step login</button></p>'
        + '</div>';
}

function mgmtGatePasswordHtml() {
    return '<div class="adm-mgmt-card adm-mgmt-gate">'
        + '<h3>Choose a new password</h3>'
        + '<p>An administrator set a temporary password for you. Choose your own before using Management.</p>'
        + mgmtPasswordForm("password-change")
        + '</div>';
}

function mgmtPasswordForm(name) {
    return '<form class="adm-mgmt-form" data-mgmt-form="' + name + '" novalidate>'
        + mgmtField("Current password", "current", "password", 'autocomplete="current-password"')
        + mgmtField("New password", "new", "password", 'autocomplete="new-password"')
        + mgmtField("Repeat new password", "confirm", "password", 'autocomplete="new-password"')
        + '<div><button class="adm-btn primary" type="submit">Change password</button></div>'
        + '<div class="adm-mgmt-msg" data-msg></div></form>';
}

/* ---------- main render: gates first, then the open sub-tab ---------- */

async function mgmtRender() {
    if (!MGMT.pane) return;
    const gate = document.getElementById("mgmtGate");
    const body = document.getElementById("mgmtBody");
    let data;
    try {
        data = await mgmtRequest("/me");
    } catch (error) {
        if (!error.sessionEnded) { gate.hidden = false; body.hidden = true; gate.innerHTML = mgmtNotice(error.message, true); }
        return;
    }
    MGMT.me = data.admin;
    if (!MGMT.me.passed_2fa) {
        body.hidden = true; gate.hidden = false; gate.innerHTML = mgmtGate2faHtml();
        return;
    }
    if (MGMT.me.must_change_password) {
        body.hidden = true; gate.hidden = false; gate.innerHTML = mgmtGatePasswordHtml();
        return;
    }
    gate.hidden = true; gate.innerHTML = "";
    body.hidden = false;
    document.querySelectorAll("#mgmtRoot .adm-mgmt-subtab").forEach(function (button) {
        const perm = MGMT_SUB_PERMS[button.dataset.sub];
        button.hidden = !!perm && !mgmtHas(perm);
    });
    if (MGMT_SUB_PERMS[MGMT.sub] && !mgmtHas(MGMT_SUB_PERMS[MGMT.sub])) MGMT.sub = "my";
    mgmtRenderSub(MGMT.sub);
}

function mgmtRenderSub(sub) {
    MGMT.sub = sub;
    document.querySelectorAll("#mgmtRoot .adm-mgmt-subtab").forEach(function (b) { b.classList.toggle("active", b.dataset.sub === sub); });
    document.querySelectorAll("#mgmtRoot .adm-mgmt-view").forEach(function (v) { v.classList.toggle("active", v.dataset.view === sub); });
    if (sub === "my") mgmtRenderMy();
    else if (sub === "admins") mgmtRenderAdmins();
    else if (sub === "roles") mgmtRenderRoles();
    else mgmtOpsRender(sub);
}

/* ---------- My account ---------- */

function mgmtRenderMy() {
    const a = MGMT.me;
    const twoFa = a.totp_enabled
        ? '<p>Status: ' + admPill("On", "ok") + '</p><div class="adm-mgmt-actions"><button class="adm-btn" data-mgmt="2fa-off-open">Turn off</button></div>'
        : '<p>Status: ' + admPill("Off", "muted") + '</p><p class="adm-mgmt-hint">Adds a 6-digit code from an authenticator app before Management opens.</p>'
        + '<div class="adm-mgmt-actions"><button class="adm-btn primary" data-mgmt="2fa-setup">Set up two-step login</button></div>';
    mgmtView("my").innerHTML =
        '<div class="adm-mgmt-card"><h3>' + escapeHtml(a.name) + '</h3>'
        + '<p>@' + escapeHtml(a.username) + ' &middot; Role: <strong>' + escapeHtml(a.role_label) + '</strong></p>'
        + '<p class="adm-mgmt-hint">' + escapeHtml(a.role_note) + '</p></div>'
        + '<div class="adm-mgmt-card"><h3>Change password</h3><p>Use at least 10 characters with letters and numbers.</p>'
        + mgmtPasswordForm("password") + '</div>'
        + '<div class="adm-mgmt-card"><h3>Two-step login</h3><p>Uses an authenticator app (Google Authenticator, Microsoft Authenticator or similar).</p>'
        + twoFa + '</div>';
}

async function mgmt2faSetup() {
    MGMT.setup = await mgmtRequest("/2fa/setup", {});
    mgmtDialog("Set up two-step login",
        '<ol class="adm-mgmt-hint"><li>Open your authenticator app and choose "Enter a setup key".</li>'
        + '<li>Type this key, with time-based codes and the name GovShield:</li></ol>'
        + '<div class="adm-mgmt-secret" id="mgmtSecretText">' + escapeHtml(MGMT.setup.secret) + '</div>'
        + '<form class="adm-mgmt-form" data-mgmt-form="2fa-enable" novalidate>'
        + mgmtField("Enter the 6-digit code to confirm", "code", "text", 'inputmode="numeric" maxlength="6" autocomplete="one-time-code"')
        + '<div class="adm-mgmt-actions"><button class="adm-btn primary" type="submit">Turn on</button>'
        + '<button class="adm-btn" data-mgmt="copy">Copy key</button></div>'
        + '<div class="adm-mgmt-msg" data-msg></div></form>');
}

/* ---------- Administrators ---------- */

async function mgmtRenderAdmins() {
    const view = mgmtView("admins");
    let data;
    let roles;
    try {
        data = await mgmtRequest("/admins");
        roles = await mgmtLoadRoles();
    } catch (error) {
        if (!error.sessionEnded) view.innerHTML = mgmtNotice(error.message, true);
        return;
    }
    const canManage = mgmtHas("admins.manage");
    const roleOptions = roles.roles.map(function (r) { return '<option value="' + r.id + '">' + escapeHtml(r.label) + '</option>'; }).join("");
    let html = "";
    if (canManage) {
        html += '<div class="adm-mgmt-card"><h3>Add an administrator</h3>'
            + '<p>They receive a temporary password and must change it at their first login.</p>'
            + '<form class="adm-mgmt-form" data-mgmt-form="admin-add" novalidate>'
            + mgmtField("Username", "username", "text", 'autocomplete="off" maxlength="32"')
            + mgmtField("Full name", "full_name", "text", 'maxlength="80"')
            + '<div class="adm-mgmt-field"><label>Role</label><select class="adm-select" name="role">' + roleOptions + '</select>'
            + '<div class="adm-mgmt-err" data-err="role"></div></div>'
            + '<div><button class="adm-btn primary" type="submit">Add administrator</button></div>'
            + '<div class="adm-mgmt-msg" data-msg></div></form></div>';
    }
    const rows = data.admins.map(function (a) {
        const isMe = a.id === MGMT.me.id;
        const roleCell = canManage && !isMe
            ? '<select class="adm-select" data-role-for="' + a.id + '">'
                + roles.roles.map(function (r) { return '<option value="' + r.id + '"' + (r.id === a.role ? " selected" : "") + '>' + escapeHtml(r.label) + '</option>'; }).join("")
                + '</select> <button class="adm-btn small" data-mgmt="admin-role" data-id="' + a.id + '">Save</button>'
            : escapeHtml(a.role_label);
        let actions = "";
        if (canManage && !isMe) {
            actions = '<button class="adm-btn small" data-mgmt="admin-active" data-id="' + a.id + '" data-value="' + (a.active ? "0" : "1") + '">'
                + (a.active ? "Disable" : "Enable") + '</button>'
                + '<button class="adm-btn small" data-mgmt="admin-reset-pw" data-id="' + a.id + '">Reset password</button>'
                + (a.totp_enabled ? '<button class="adm-btn small" data-mgmt="admin-reset-2fa" data-id="' + a.id + '">Reset 2FA</button>' : "");
        }
        return '<tr><td><strong>' + escapeHtml(a.name) + '</strong><br><span class="adm-mgmt-hint">@' + escapeHtml(a.username)
            + (isMe ? " &middot; you" : "") + (a.must_change_password ? " &middot; must change password" : "") + '</span></td>'
            + '<td>' + roleCell + '</td>'
            + '<td>' + mgmtPill(a.active, "Active", "Disabled") + '</td>'
            + '<td>' + mgmtPill(a.totp_enabled, "On", "Off") + '</td>'
            + '<td>' + escapeHtml(a.last_login || "Never") + '</td>'
            + '<td>' + a.open_cases + '</td>'
            + '<td><div class="adm-mgmt-actions">' + actions + '</div></td></tr>';
    }).join("");
    html += '<div class="adm-mgmt-card"><h3>Administrators</h3>'
        + '<p>' + (canManage ? "Change roles, enable or disable accounts, and reset passwords or two-step login." : "The list of administrators and their roles.") + '</p>'
        + '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Name</th><th>Role</th><th>Status</th>'
        + '<th>Two-step</th><th>Last login</th><th>Open cases</th><th>Actions</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
    view.innerHTML = html;
}

async function mgmtAdminRole(id) {
    const select = document.querySelector('[data-role-for="' + id + '"]');
    if (!select) return;
    const result = await mgmtRequest("/admins/" + id + "/role", { role: select.value });
    admToast(result.message, true);
    mgmtRenderAdmins();
}

async function mgmtAdminActive(id, value) {
    const active = value === "1";
    if (!window.confirm(active ? "Enable this administrator account?" : "Disable this administrator account? Their sessions stop working at once.")) return;
    const result = await mgmtRequest("/admins/" + id + "/active", { active: active });
    admToast(result.message, true);
    mgmtRenderAdmins();
}

async function mgmtAdminResetPassword(id) {
    if (!window.confirm("Set a new temporary password for this administrator? Their current password stops working.")) return;
    const result = await mgmtRequest("/admins/" + id + "/reset-password", {});
    mgmtShowSecret("Temporary password", "For @" + result.username + ". Share it privately.", result.temp_password,
        "They must choose a new password at their next login.");
    mgmtRenderAdmins();
}

async function mgmtAdminReset2fa(id) {
    if (!window.confirm("Turn off two-step login for this administrator? They can set it up again.")) return;
    const result = await mgmtRequest("/admins/" + id + "/reset-2fa", {});
    admToast(result.message, true);
    mgmtRenderAdmins();
}

/* ---------- Roles and rights ---------- */

async function mgmtRenderRoles() {
    const view = mgmtView("roles");
    let data;
    try {
        data = await mgmtLoadRoles();
    } catch (error) {
        if (!error.sessionEnded) view.innerHTML = mgmtNotice(error.message, true);
        return;
    }
    const head = '<tr><th>Right</th>' + data.roles.map(function (r) { return '<th>' + escapeHtml(r.label) + '</th>'; }).join("") + '</tr>';
    const body = data.permissions.map(function (p) {
        return '<tr><td>' + escapeHtml(p.label) + '</td>' + data.roles.map(function (r) {
            return r.permissions.indexOf(p.id) !== -1 ? '<td class="adm-mgmt-yes">&#10003;</td>' : '<td class="adm-mgmt-no">&ndash;</td>';
        }).join("") + '</tr>';
    }).join("");
    const notes = data.roles.map(function (r) {
        return '<li><strong>' + escapeHtml(r.label) + ':</strong> ' + escapeHtml(r.note) + '</li>';
    }).join("");
    view.innerHTML = '<div class="adm-mgmt-card"><h3>Roles and rights</h3>'
        + '<p>Your role: <strong>' + escapeHtml(MGMT.me.role_label) + '</strong></p>'
        + '<ul class="adm-mgmt-hint">' + notes + '</ul></div>'
        + '<div class="adm-mgmt-card"><div class="adm-table-wrap"><table class="adm-table adm-mgmt-matrix">'
        + '<thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>'
        + '<p class="adm-mgmt-hint">The server checks every right on each request, so a hidden button is never the only protection.</p></div>';
}

/* ---------- forms and actions ---------- */

async function mgmtSubmit(name, form) {
    if (MGMT.busy) return;
    const data = {};
    form.querySelectorAll("[name]").forEach(function (input) { data[input.name] = input.value; });
    const button = form.querySelector('button[type="submit"]');
    MGMT.busy = true;
    if (button) button.disabled = true;
    mgmtClearErrors(form);
    try {
        await mgmtFormAction(name, form, data);
    } catch (error) {
        if (!error.sessionEnded) mgmtShowErrors(form, error);
    } finally {
        MGMT.busy = false;
        if (button) button.disabled = false;
    }
}

async function mgmtFormAction(name, form, data) {
    if (name === "gate-2fa") {
        await mgmtRequest("/2fa/verify", { code: data.code });
        return mgmtRender();
    }
    if (name === "password" || name === "password-change") {
        if (data.new !== data.confirm) throw mgmtFieldError("new", "The new passwords do not match.");
        await mgmtRequest("/password", { current: data.current, new: data.new });
        if (name === "password-change") return mgmtRender();
        form.reset();
        mgmtFlash(form, "Your password has been changed.", false);
        return;
    }
    if (name === "2fa-enable") {
        const result = await mgmtRequest("/2fa/enable", { code: data.code });
        mgmtCloseDialog();
        admToast(result.message, true);
        return mgmtRender();
    }
    if (name === "2fa-disable") {
        const result = await mgmtRequest("/2fa/disable", { password: data.password, code: data.code });
        mgmtCloseDialog();
        admToast(result.message, true);
        return mgmtRender();
    }
    if (name === "admin-add") {
        const result = await mgmtRequest("/admins", { username: data.username, full_name: data.full_name, role: data.role });
        form.reset();
        mgmtShowSecret("Administrator added", "Temporary password for @" + result.username + ". Share it privately.",
            result.temp_password, "They must change it at their first login.");
        mgmtRenderAdmins();
        return;
    }
    if (typeof mgmtOpsForm === "function") return mgmtOpsForm(name, form, data);
    throw new Error("Unknown form.");
}

async function mgmtAct(action, el) {
    try {
        if (action === "sub") return mgmtRenderSub(el.dataset.sub);
        if (action === "close") return mgmtCloseDialog();
        if (action === "copy") return mgmtCopy();
        if (action === "2fa-setup") return await mgmt2faSetup();
        if (action === "2fa-off-open") return mgmtDialog("Turn off two-step login", mgmtDisableForm());
        if (action === "admin-role") return await mgmtAdminRole(el.dataset.id);
        if (action === "admin-active") return await mgmtAdminActive(el.dataset.id, el.dataset.value);
        if (action === "admin-reset-pw") return await mgmtAdminResetPassword(el.dataset.id);
        if (action === "admin-reset-2fa") return await mgmtAdminReset2fa(el.dataset.id);
        if (typeof mgmtOpsAct === "function") return await mgmtOpsAct(action, el);
    } catch (error) {
        if (!error.sessionEnded) admToast(error.message, false);
    }
}

/* ---------- setup: insert the tab and pane, wire delegated events ---------- */

function mgmtInject() {
    const aside = document.querySelector("#admin .adm-side");
    const main = document.querySelector("#admin .adm-main");
    const section = document.getElementById("admin");
    if (!aside || !main || !section || document.querySelector('#admin [data-tab="management"]')) return;

    const tab = document.createElement("button");
    tab.className = "adm-tab";
    tab.dataset.tab = "management";
    tab.textContent = "Management";
    tab.addEventListener("click", function () { admShowTab("management"); mgmtRender(); });
    aside.insertBefore(tab, aside.querySelector(".adm-side-foot"));

    const pane = document.createElement("div");
    pane.className = "adm-pane";
    pane.dataset.pane = "management";
    pane.innerHTML = MGMT_SHELL_HTML;
    main.appendChild(pane);
    MGMT.pane = pane;

    const dialog = document.createElement("div");
    dialog.className = "adm-modal";
    dialog.id = "mgmtDialog";
    dialog.hidden = true;
    dialog.innerHTML = '<div class="adm-modal-box" role="dialog" aria-modal="true">'
        + '<button class="adm-x" data-mgmt="close" aria-label="Close">&times;</button>'
        + '<div id="mgmtDialogBody"></div></div>';
    section.appendChild(dialog);
}

document.addEventListener("DOMContentLoaded", function () {
    mgmtInject();
});

document.addEventListener("click", function (event) {
    const dialog = document.getElementById("mgmtDialog");
    if (dialog && !dialog.hidden && event.target === dialog) { mgmtCloseDialog(); return; }
    const el = event.target.closest ? event.target.closest("[data-mgmt]") : null;
    if (!el || !MGMT.pane || !MGMT.pane.contains(el) && !(dialog && dialog.contains(el))) return;
    event.preventDefault();
    mgmtAct(el.dataset.mgmt, el);
});

document.addEventListener("submit", function (event) {
    const form = event.target;
    if (!form.dataset || !form.dataset.mgmtForm) return;
    event.preventDefault();
    mgmtSubmit(form.dataset.mgmtForm, form);
});

document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
        const dialog = document.getElementById("mgmtDialog");
        if (dialog && !dialog.hidden) mgmtCloseDialog();
    }
});
