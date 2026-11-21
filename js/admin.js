/* GovShield – Premium Admin Console.
   Shows every citizen action (applications, payments, documents, track views, logins and
   security events) and lets an administrator change an application's status.
   All data comes from /api/admin/* and is only available to administrator accounts. */

const ADM_REFRESH_MS = 15000;      // reload while the admin page is open
const ADM_PAGE_SIZE = 20;
const ADM_STATUSES = ["Pending", "Processing", "Approved", "Rejected"];
const ADM_STATUS_COLORS = { Pending: "#f59e0b", Processing: "#0284c7", Approved: "#16a34a", Rejected: "#dc2626" };
const ADM_METHOD_COLORS = { bKash: "#e2136e", Nagad: "#f97316", Card: "#0f3d5e" };
const ADM_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

let admData = { overview: null, applications: [], payments: [], citizens: [], audit: [] };
let admTab = "overview";
let admPage = { applications: 1, payments: 1, activity: 1 };
let admCharts = {};
let admTimer = null;
let admOpenId = null;
let admServiceKey = "";
let admSignature = "";

/* ---------- small helpers ---------- */

function admEl(id) { return document.getElementById(id); }
function admSet(id, text) { const el = admEl(id); if (el) el.textContent = text; }
function admNum(n) { return Number(n || 0).toLocaleString("en-US"); }
function admMoney(n) {
    return "BDT " + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* "2026-11-21" or "2026-11-21 17:02:00"  ->  "21 Nov 2026" or "21 Nov 2026, 5:02 PM" */
function admDate(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(value || ""));
    if (!m) return "-";
    const day = Number(m[3]) + " " + (ADM_MONTHS[Number(m[2]) - 1] || "") + " " + m[1];
    if (!m[4]) return day;
    let hour = Number(m[4]);
    const suffix = hour >= 12 ? "PM" : "AM";
    hour = hour % 12 || 12;
    return day + ", " + hour + ":" + m[5] + " " + suffix;
}

function admShortDay(iso) {
    const m = /^\d{4}-(\d{2})-(\d{2})/.exec(String(iso));
    return m ? Number(m[2]) + " " + (ADM_MONTHS[Number(m[1]) - 1] || "") : "";
}

function admPill(text, cls) { return '<span class="adm-pill ' + cls + '">' + escapeHtml(text) + "</span>"; }
function admResultPill(r) { return admPill(r, r === "Success" ? "ok" : r === "Blocked" ? "bad" : "warn"); }
function admSeverityPill(s) { return admPill(s, s === "High" ? "bad" : s === "Medium" ? "warn" : "muted"); }
function admRiskPill(n) { return n >= 5 ? admPill("High", "bad") : n >= 3 ? admPill("Medium", "warn") : admPill("Low", "muted"); }

function admInfo(label, value) {
    return "<div><span>" + escapeHtml(label) + "</span><strong>" + escapeHtml(value) + "</strong></div>";
}

function admToast(text, ok) {
    const box = admEl("adm-toast");
    if (!box) return;
    box.className = "adm-toast " + (ok ? "ok" : "err");
    box.textContent = text;
    box.hidden = false;
    clearTimeout(admToast.timer);
    admToast.timer = setTimeout(function () { box.hidden = true; }, 3200);
}

/* pagination: returns the rows for the current page plus the info needed to draw the pager */
function admSlice(rows, tab) {
    const pages = Math.max(1, Math.ceil(rows.length / ADM_PAGE_SIZE));
    admPage[tab] = Math.min(Math.max(1, admPage[tab]), pages);
    const start = (admPage[tab] - 1) * ADM_PAGE_SIZE;
    return { items: rows.slice(start, start + ADM_PAGE_SIZE), page: admPage[tab], pages: pages, total: rows.length };
}

function admPagerHtml(info, tab) {
    if (!info.total) return "<span>No records</span>";
    return "<span>" + admNum(info.total) + " records · page " + info.page + " of " + info.pages + "</span>" +
        '<span><button class="adm-btn small" data-page="' + tab + ':-1"' + (info.page <= 1 ? " disabled" : "") + ">Previous</button> " +
        '<button class="adm-btn small" data-page="' + tab + ':1"' + (info.page >= info.pages ? " disabled" : "") + ">Next</button></span>";
}

/* ---------- request helper with its own administrator session ---------- */

const ADM_TOKEN_KEY = "govshield_admin_session";   // separate from the citizen login key

async function adminRequest(path, options) {
    options = options || {};
    const headers = {};
    const token = sessionStorage.getItem(ADM_TOKEN_KEY);
    if (token) headers["Authorization"] = "Bearer " + token;
    let body = options.body;
    if (body && typeof body !== "string") {
        body = JSON.stringify(body);
        headers["Content-Type"] = "application/json";
    }
    let response;
    try {
        response = await fetch(path, { method: options.method || "GET", headers: headers, body: body });
    } catch (e) {
        throw new Error("Cannot reach the server. Make sure the server is running.");
    }
    let data = {};
    try { data = await response.json(); } catch (e) { /* empty body */ }
    if (response.status === 401 && !options.keepSession) {
        // the administrator session has ended: go back to the login form
        sessionStorage.removeItem(ADM_TOKEN_KEY);
        const error = new Error(data.error || "Please log in as an administrator.");
        error.sessionEnded = true;
        admShowLogin(error.message);
        throw error;
    }
    if (!response.ok) throw new Error(data.error || "Request failed.");
    return data;
}

/* ---------- loading ---------- */

async function admLoad() {
    try {
        const results = await Promise.all([
            adminRequest("/api/admin/overview"),
            adminRequest("/api/admin/applications"),
            adminRequest("/api/admin/payments"),
            adminRequest("/api/admin/citizens"),
            adminRequest("/api/admin/audit")
        ]);
        admEl("admDenied").hidden = true;
        admSet("admLive", "Live · updated " + new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }));
        // redraw only when the data changed, so a background refresh never swaps out a row you are clicking
        const signature = JSON.stringify(results);
        if (signature !== admSignature) {
            admSignature = signature;
            admData = { overview: results[0], applications: results[1], payments: results[2], citizens: results[3], audit: results[4] };
            admRender();
        }
    } catch (error) {
        if (error.sessionEnded) return;     // the login form is already showing
        const denied = /administrator/i.test(error.message);
        admEl("admDenied").hidden = !denied;
        admSet("admLive", denied ? "Restricted" : "Connection problem");
        if (!denied) admToast(error.message, false);
    }
}

/* ---------- rendering ---------- */

function admRender() {
    admUpdateCounts();
    admFillServiceOptions();
    if (admTab === "overview") admRenderOverview();
    if (admTab === "applications") admRenderApplications();
    if (admTab === "payments") admRenderPayments();
    if (admTab === "citizens") admRenderCitizens();
    if (admTab === "activity") admRenderActivity();
    if (admTab === "security") admRenderSecurity();
}

function admUpdateCounts() {
    admSet("cnt-applications", admData.applications.length);
    admSet("cnt-payments", admData.payments.length);
    admSet("cnt-citizens", admData.citizens.length);
    admSet("cnt-activity", admData.audit.length);
    admSet("cnt-security", admData.audit.filter(function (e) { return e.severity === "High"; }).length);
}

function admFillServiceOptions() {
    const services = Array.from(new Set(admData.applications.map(function (a) { return a.service; }))).sort();
    const key = services.join("|");
    if (key === admServiceKey) return;          // rebuild only when the list changes
    admServiceKey = key;
    const select = admEl("app-service");
    const current = select.value;
    select.innerHTML = '<option value="">All services</option>' + services.map(function (s) {
        return '<option value="' + escapeHtml(s) + '">' + escapeHtml(s) + "</option>";
    }).join("");
    select.value = current;
}

/* ----- overview ----- */

function admOptions(extra) {
    return Object.assign({ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } }, extra);
}

function admChart(key, canvasId, config) {
    const canvas = admEl(canvasId);
    if (!canvas) return;
    if (typeof Chart === "undefined") {
        canvas.parentElement.innerHTML = '<p class="adm-note">Charts need an internet connection (Chart.js did not load).</p>';
        return;
    }
    if (admCharts[key]) admCharts[key].destroy();
    admCharts[key] = new Chart(canvas, config);
}

function admRenderOverview() {
    const o = admData.overview;
    if (!o) return;

    admSet("kpi-citizens", admNum(o.citizens));
    admSet("kpi-citizens-sub", "active accounts");
    admSet("kpi-applications", admNum(o.applications));
    admSet("kpi-applications-sub", admNum(o.pending) + " waiting · " + admNum(o.applicationsToday) + " today");
    admSet("kpi-payments", admNum(o.payments));
    admSet("kpi-payments-sub", admMoney(o.paymentsTotal) + " collected");
    admSet("kpi-logins", admNum(o.loginsToday));
    admSet("kpi-logins-sub", "successful logins today");
    admSet("kpi-failed", admNum(o.failedToday));
    admSet("kpi-failed-sub", "failed attempts today");
    admSet("kpi-alerts", admNum(o.alerts));
    admSet("kpi-alerts-sub", "high-severity events");

    const s = o.series;
    admChart("trend", "ch-trend", {
        type: "line",
        data: {
            labels: s.days.map(admShortDay),
            datasets: [
                { label: "Applications", data: s.applications, borderColor: "#0284c7", backgroundColor: "rgba(2,132,199,.12)", fill: true, tension: .35 },
                { label: "Payments", data: s.payments, borderColor: "#16a34a", backgroundColor: "rgba(22,163,74,.10)", fill: true, tension: .35 },
                { label: "Logins", data: s.logins, borderColor: "#7c3aed", borderDash: [6, 4], fill: false, tension: .35 }
            ]
        },
        options: admOptions({ scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } })
    });

    admChart("status", "ch-status", {
        type: "doughnut",
        data: {
            labels: ADM_STATUSES,
            datasets: [{
                data: ADM_STATUSES.map(function (k) { return o.applicationsByStatus[k] || 0; }),
                backgroundColor: ADM_STATUSES.map(function (k) { return ADM_STATUS_COLORS[k]; }),
                borderWidth: 0
            }]
        },
        options: admOptions({ cutout: "65%" })
    });

    const services = Object.keys(o.applicationsByService).sort();
    admChart("service", "ch-service", {
        type: "bar",
        data: {
            labels: services,
            datasets: [{ label: "Applications", data: services.map(function (k) { return o.applicationsByService[k]; }), backgroundColor: "#0284c7", borderRadius: 8 }]
        },
        options: admOptions({
            indexAxis: "y",
            plugins: { legend: { display: false } },
            scales: { x: { beginAtZero: true, ticks: { precision: 0 } } }
        })
    });

    const methods = Object.keys(o.paymentsByMethod).sort();
    admChart("method", "ch-method", {
        type: "bar",
        data: {
            labels: methods,
            datasets: [{
                label: "Amount",
                data: methods.map(function (k) { return o.paymentsByMethod[k]; }),
                backgroundColor: methods.map(function (k) { return ADM_METHOD_COLORS[k] || "#0284c7"; }),
                borderRadius: 8
            }]
        },
        options: admOptions({
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { return admMoney(c.raw); } } } },
            scales: { y: { beginAtZero: true } }
        })
    });

    admEl("ov-recent").innerHTML = admData.audit.slice(0, 8).map(function (e) {
        return "<tr><td>" + escapeHtml(admDate(e.time)) + "</td><td>" + escapeHtml(e.user) + "</td><td>" +
            admPill(e.action, "act") + "</td><td>" + escapeHtml(e.detail || "-") + "</td><td>" + admResultPill(e.result) + "</td></tr>";
    }).join("") || emptyRow(5, "No activity yet. Log in or apply for a service to create the first entry.");
}

/* ----- applications ----- */

function admRenderApplications() {
    const q = admEl("app-search").value.trim().toLowerCase();
    const status = admEl("app-status").value;
    const service = admEl("app-service").value;
    const rows = admData.applications.filter(function (a) {
        const text = (a.id + " " + a.name + " " + a.service + " " + a.address).toLowerCase();
        return (!q || text.includes(q)) && (!status || a.status === status) && (!service || a.service === service);
    });
    const info = admSlice(rows, "applications");
    admEl("app-body").innerHTML = info.items.length ? info.items.map(function (a) {
        return '<tr data-open="' + escapeHtml(a.id) + '"><td><strong>' + escapeHtml(a.id) + "</strong></td><td>" +
            escapeHtml(a.name) + "</td><td>" + escapeHtml(a.nid) + "</td><td>" + escapeHtml(a.service) + "</td><td>" +
            escapeHtml(admDate(a.date)) + "</td><td>" + statusBadge(a.status) + '</td><td><button class="adm-btn small" data-open="' +
            escapeHtml(a.id) + '">Open</button></td></tr>';
    }).join("") : emptyRow(7, "No applications match the filters.");
    admEl("app-pager").innerHTML = admPagerHtml(info, "applications");
}

/* ----- payments ----- */

function admRenderPayments() {
    const q = admEl("pay-search").value.trim().toLowerCase();
    const method = admEl("pay-method").value;
    const rows = admData.payments.filter(function (p) {
        return (!q || (p.id + " " + p.reference + " " + p.type).toLowerCase().includes(q)) && (!method || p.method === method);
    });
    const info = admSlice(rows, "payments");
    const sum = rows.reduce(function (total, p) { return total + Number(p.amount); }, 0);
    admEl("pay-body").innerHTML = info.items.length ? info.items.map(function (p) {
        return "<tr><td><strong>" + escapeHtml(p.id) + "</strong></td><td>" + escapeHtml(p.type) + "</td><td>" +
            escapeHtml(p.reference) + "</td><td>" + admPill(p.method, "act") + '</td><td class="num">' +
            escapeHtml(admMoney(p.amount)) + "</td><td>" + statusBadge(p.status) + "</td><td>" + escapeHtml(admDate(p.date)) + "</td></tr>";
    }).join("") : emptyRow(7, "No payments match the filters.");
    admSet("pay-totals", admNum(rows.length) + " payments · " + admMoney(sum));
    admEl("pay-pager").innerHTML = admPagerHtml(info, "payments");
}

/* ----- citizens ----- */

function admRenderCitizens() {
    const q = admEl("cit-search").value.trim().toLowerCase();
    const rows = admData.citizens.filter(function (c) { return !q || c.name.toLowerCase().includes(q); });
    admEl("cit-body").innerHTML = rows.length ? rows.map(function (c) {
        return "<tr><td><strong>" + escapeHtml(c.name) + "</strong></td><td>" + escapeHtml(c.nid) + "</td><td>" +
            escapeHtml(c.phone) + "</td><td>" + admPill(c.active ? "Active" : "Disabled", c.active ? "ok" : "bad") +
            "</td><td>" + escapeHtml(admDate(c.registered)) + '</td><td class="num">' + admNum(c.applications) +
            '</td><td class="num">' + admNum(c.payments) + '</td><td class="num">' + escapeHtml(admMoney(c.paid)) +
            "</td><td>" + escapeHtml(c.lastLogin ? admDate(c.lastLogin) : "Never") + '</td><td><button class="adm-btn small" data-activity="' +
            escapeHtml(c.name) + '">Activity</button></td></tr>';
    }).join("") : emptyRow(10, "No citizens match the search.");
    admSet("cit-count", admNum(rows.length) + " citizens");
}

/* ----- activity log ----- */

function admRenderActivity() {
    const user = admEl("act-user").value.trim().toLowerCase();
    const action = admEl("act-action").value;
    const result = admEl("act-result").value;
    const rows = admData.audit.filter(function (e) {
        return (!user || e.user.toLowerCase().includes(user)) && (!action || e.action === action) && (!result || e.result === result);
    });
    const info = admSlice(rows, "activity");
    admEl("act-body").innerHTML = info.items.length ? info.items.map(function (e) {
        return "<tr><td>" + escapeHtml(admDate(e.time)) + "</td><td>" + escapeHtml(e.user) + "</td><td>" + escapeHtml(e.ip) +
            "</td><td>" + admPill(e.action, "act") + "</td><td>" + escapeHtml(e.detail || "-") + "</td><td>" +
            admResultPill(e.result) + "</td><td>" + admSeverityPill(e.severity) + "</td></tr>";
    }).join("") : emptyRow(7, "No activity matches the filters.");
    admEl("act-pager").innerHTML = admPagerHtml(info, "activity");
}

/* ----- security ----- */

function admRenderSecurity() {
    const byIp = {};
    admData.audit.forEach(function (e) {
        if (e.action !== "Login" || e.result !== "Failed") return;
        const row = byIp[e.ip] || { ip: e.ip, count: 0, last: "" };
        row.count += 1;
        if (e.time > row.last) row.last = e.time;
        byIp[e.ip] = row;
    });
    const ips = Object.keys(byIp).map(function (k) { return byIp[k]; }).sort(function (a, b) { return b.count - a.count; });
    admEl("sec-ips").innerHTML = ips.length ? ips.map(function (f) {
        return "<tr><td>" + escapeHtml(f.ip) + '</td><td class="num">' + admNum(f.count) + "</td><td>" +
            escapeHtml(admDate(f.last)) + "</td><td>" + admRiskPill(f.count) + "</td></tr>";
    }).join("") : emptyRow(4, "No failed logins recorded.");

    const alerts = admData.audit.filter(function (e) { return e.severity === "High"; }).slice(0, 30);
    admEl("sec-alerts").innerHTML = alerts.length ? alerts.map(function (e) {
        const failedLogin = e.action === "Login" && e.result === "Failed";
        const message = failedLogin ? "Repeated failed logins from " + e.ip
            : e.result === "Blocked" ? e.action + " blocked by rate limit from " + e.ip
            : e.action + " errors repeated from " + e.ip;
        const status = e.result === "Blocked" ? admPill("Blocked", "ok") : admPill("Investigating", "warn");
        return "<tr><td>" + escapeHtml(message) + '<br><small style="color:#64748b">' + escapeHtml(admDate(e.time)) +
            "</small></td><td>" + admSeverityPill(e.severity) + "</td><td>" + status + "</td></tr>";
    }).join("") : emptyRow(3, "No security alerts. Everything looks normal.");
}

/* ---------- tabs ---------- */

function admShowTab(name) {
    admTab = name;
    document.querySelectorAll("#admin .adm-tab").forEach(function (b) { b.classList.toggle("active", b.dataset.tab === name); });
    document.querySelectorAll("#admin .adm-pane").forEach(function (p) { p.classList.toggle("active", p.dataset.pane === name); });
    admRender();
}

function admShowActivityFor(name) {
    admEl("act-user").value = name;
    admPage.activity = 1;
    admShowTab("activity");
}

/* ---------- application details and status change ---------- */

function admOpenApp(id) {
    const a = admData.applications.find(function (x) { return x.id === id; });
    if (!a) return;
    admOpenId = id;

    const steps = ["Pending", "Processing", "Approved"];
    const reached = steps.indexOf(a.status);
    const timeline = a.status === "Rejected"
        ? '<div class="adm-steps"><span class="adm-step done">Submitted</span><span class="adm-step rej">Rejected</span></div>'
        : '<div class="adm-steps">' + steps.map(function (s, i) {
            return '<span class="adm-step' + (i <= reached ? " done" : "") + '">' + s + "</span>";
        }).join("") + "</div>";

    const related = admData.audit.filter(function (e) { return (e.detail || "").split(" ")[0] === id; }).slice(0, 15);

    admEl("app-modal-body").innerHTML =
        '<h2 id="app-modal-title" style="color:#0f3d5e;margin:0">' + escapeHtml(a.id) + "</h2>" +
        '<div style="margin-top:8px">' + statusBadge(a.status) + ' <span style="color:#64748b;margin-left:8px">' + escapeHtml(a.service) + "</span></div>" +
        timeline +
        '<div class="adm-info">' + admInfo("Applicant", a.name) + admInfo("NID (masked)", a.nid) +
        admInfo("Submitted", admDate(a.date)) + admInfo("Address", a.address || "-") + "</div>" +
        '<div class="adm-status-row"><strong>Change status</strong>' +
        '<select class="adm-select" id="app-new-status">' + ADM_STATUSES.map(function (s) {
            return "<option" + (s === a.status ? " selected" : "") + ">" + s + "</option>";
        }).join("") + "</select>" +
        '<button class="adm-btn primary" id="app-save-status">Save status</button></div>' +
        '<div class="adm-section-title">Activity for this application</div>' +
        (related.length
            ? '<ul class="adm-related">' + related.map(function (e) {
                return "<li><span>" + escapeHtml(e.user + " · " + e.action + " · " + (e.detail || "")) + "</span><span>" +
                    escapeHtml(admDate(e.time)) + "</span></li>";
              }).join("") + "</ul>"
            : '<p class="adm-note" style="padding:12px 0">No activity recorded yet.</p>');

    admEl("app-modal").hidden = false;
}

function admCloseApp() {
    admEl("app-modal").hidden = true;
    admOpenId = null;
}

async function admSaveStatus() {
    const id = admOpenId;
    if (!id) return;
    const status = admEl("app-new-status").value;
    const button = admEl("app-save-status");
    if (button) button.disabled = true;
    try {
        await adminRequest("/api/admin/applications/" + encodeURIComponent(id) + "/status", {
            method: "POST",
            body: { status: status }
        });
        admToast(id + " status changed to " + status, true);
        admCloseApp();
        await admLoad();
    } catch (error) {
        admToast(error.message, false);
        if (button) button.disabled = false;
    }
}

/* ---------- CSV export (the full list for the current tab) ---------- */

function admCsvCell(value) {
    let text = value === null || value === undefined ? "" : String(value);
    if (/^[=+\-@]/.test(text)) text = "'" + text;      // stops spreadsheet formula injection
    return '"' + text.replace(/"/g, '""') + '"';
}

function admExport() {
    const sets = {
        applications: {
            headers: ["Application", "Applicant", "NID (masked)", "Service", "Submitted", "Status"],
            rows: admData.applications.map(function (a) { return [a.id, a.name, a.nid, a.service, a.date, a.status]; })
        },
        payments: {
            headers: ["Transaction", "Type", "Reference", "Method", "Amount (BDT)", "Status", "Date"],
            rows: admData.payments.map(function (p) { return [p.id, p.type, p.reference, p.method, p.amount, p.status, p.date]; })
        },
        citizens: {
            headers: ["Name", "NID (masked)", "Phone (masked)", "Active", "Registered", "Applications", "Payments", "Total paid (BDT)", "Last login"],
            rows: admData.citizens.map(function (c) {
                return [c.name, c.nid, c.phone, c.active ? "Yes" : "No", c.registered, c.applications, c.payments, c.paid, c.lastLogin];
            })
        },
        activity: {
            headers: ["Time", "User", "IP address", "Action", "Detail", "Result", "Severity"],
            rows: admData.audit.map(function (e) { return [e.time, e.user, e.ip, e.action, e.detail, e.result, e.severity]; })
        }
    };
    const key = sets[admTab] ? admTab : "activity";
    const data = sets[key];
    const lines = [data.headers.map(admCsvCell).join(",")].concat(data.rows.map(function (r) {
        return r.map(admCsvCell).join(",");
    }));
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "govshield-" + key + "-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    admToast("CSV exported: " + admNum(data.rows.length) + " rows", true);
}

/* ---------- page lifecycle ---------- */

/* ---------- login, logout and page start (administrator page only) ---------- */

function admShowLogin(message) {
    clearInterval(admTimer);
    admTimer = null;
    admSignature = "";
    admEl("admin").hidden = true;
    admEl("adminLogin").hidden = false;
    admEl("admLogout").hidden = true;
    admSet("admWho", "");
    admSet("adminLoginMsg", message || "");
    admEl("adminPassword").value = "";
}

function admShowConsole(name) {
    admEl("adminLogin").hidden = true;
    admEl("admin").hidden = false;
    admEl("admLogout").hidden = false;
    admSet("admWho", "Signed in as " + (name || "Administrator"));
    admSet("adminLoginMsg", "");
    admLoad();
    clearInterval(admTimer);
    admTimer = setInterval(admLoad, ADM_REFRESH_MS);
}

async function adminBoot() {
    if (!sessionStorage.getItem(ADM_TOKEN_KEY)) {
        admShowLogin("");
        return;
    }
    try {
        const me = await adminRequest("/api/admin/me");
        admShowConsole(me.admin.name);
    } catch (error) {
        if (!error.sessionEnded) admShowLogin(error.message);
    }
}

async function adminLogin(event) {
    event.preventDefault();
    const button = admEl("adminLoginBtn");
    button.disabled = true;
    admSet("adminLoginMsg", "");
    try {
        const result = await adminRequest("/api/admin/login", {
            method: "POST",
            body: { username: admEl("adminUser").value.trim(), password: admEl("adminPassword").value },
            keepSession: true
        });
        sessionStorage.setItem(ADM_TOKEN_KEY, result.token);
        admShowConsole(result.admin.name);
    } catch (error) {
        admSet("adminLoginMsg", error.message);
    } finally {
        button.disabled = false;
    }
}

async function adminLogout() {
    try {
        await adminRequest("/api/admin/logout", { method: "POST", keepSession: true });
    } catch (e) { /* the local session is cleared below anyway */ }
    sessionStorage.removeItem(ADM_TOKEN_KEY);
    admShowLogin("You have logged out.");
}

document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("#admin .adm-tab").forEach(function (button) {
        button.addEventListener("click", function () { admShowTab(button.dataset.tab); });
    });

    // every filter box resets its table to page 1 and redraws
    const filters = {
        "app-search": "applications", "app-status": "applications", "app-service": "applications",
        "pay-search": "payments", "pay-method": "payments",
        "cit-search": "citizens",
        "act-user": "activity", "act-action": "activity", "act-result": "activity"
    };
    Object.keys(filters).forEach(function (id) {
        const tab = filters[id];
        const el = admEl(id);
        const redraw = function () { admPage[tab] = 1; admRender(); };
        // text boxes redraw while typing; dropdowns redraw when a choice is made.
        // Not on blur: that rebuilds the table under the mouse and swallows the next click.
        el.addEventListener(el.tagName === "SELECT" ? "change" : "input", redraw);
    });

    admEl("admin").addEventListener("click", function (event) {
        const pageButton = event.target.closest("[data-page]");
        if (pageButton) {
            const parts = pageButton.dataset.page.split(":");
            admPage[parts[0]] += Number(parts[1]);
            admRender();
            return;
        }
        const openButton = event.target.closest("[data-open]");
        if (openButton) { admOpenApp(openButton.dataset.open); return; }
        const activityButton = event.target.closest("[data-activity]");
        if (activityButton) { admShowActivityFor(activityButton.dataset.activity); }
    });

    admEl("adminLoginForm").addEventListener("submit", adminLogin);
    admEl("admLogout").addEventListener("click", adminLogout);
    adminBoot();
    admEl("admRefresh").addEventListener("click", admLoad);
    admEl("admExport").addEventListener("click", admExport);
    admEl("app-modal-close").addEventListener("click", admCloseApp);
    admEl("app-modal").addEventListener("click", function (event) {
        if (event.target === admEl("app-modal")) admCloseApp();
    });
    admEl("app-modal-body").addEventListener("click", function (event) {
        if (event.target.closest("#app-save-status")) admSaveStatus();
    });
    document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && !admEl("app-modal").hidden) admCloseApp();
    });
});
