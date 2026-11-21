/* GovShield – Security Admin Dashboard.
   Fills the existing admin page (cards, audit table, alerts table, filters) with live data
   from /api/admin/summary and /api/admin/audit. Uses the same helpers as the other pages. */

const ADMIN_REFRESH_MS = 10000;     // reload the data every 10 seconds while the page is open
let adminEvents = [];
let adminTimer = null;

const ADMIN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* "2026-11-21 17:02:00"  ->  "21 Nov, 5:02 PM" */
function adminTimeText(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(String(value || ""));
    if (!match) return "-";
    let hour = Number(match[4]);
    const suffix = hour >= 12 ? "PM" : "AM";
    hour = hour % 12 || 12;
    return Number(match[3]) + " " + (ADMIN_MONTHS[Number(match[2]) - 1] || "") + ", " + hour + ":" + match[5] + " " + suffix;
}

function adminResultBadge(result) {
    const cls = result === "Success" ? "badge-success" : result === "Blocked" ? "badge-danger" : "badge-warning";
    return '<span class="badge ' + cls + '">' + escapeHtml(result) + "</span>";
}

function adminSeverityHtml(severity) {
    if (severity === "High") return '<span class="badge badge-danger">High</span>';
    if (severity === "Medium") return '<span class="badge badge-warning">Medium</span>';
    return escapeHtml(severity);        // Low is plain text, as in the original design
}

/* the three cards: Total Logins, Failed Logins, Security Alerts */
function renderAdminSummary(summary) {
    const values = document.querySelectorAll("#admin .admin-grid .value");
    if (values.length < 3) return;
    values[0].textContent = Number(summary.totalLogins).toLocaleString("en-US");
    values[1].textContent = Number(summary.failedLogins).toLocaleString("en-US");
    values[2].textContent = Number(summary.securityAlerts).toLocaleString("en-US");
}

/* replace the data rows of a table, keeping the header row */
function replaceTableRows(table, html) {
    const body = table.tBodies[0] || table;
    while (body.rows.length > 1) body.deleteRow(1);
    body.insertAdjacentHTML("beforeend", html);
}

/* Live Audit Logs table, filtered by the boxes above it */
function renderAdminTable() {
    // order of the boxes in the page: user, IP, action, result
    const filters = document.querySelectorAll("#admin .filter-box input, #admin .filter-box select");
    const userText = filters[0].value.trim().toLowerCase();
    const ipText = filters[1].value.trim().toLowerCase();
    const action = filters[2].selectedIndex > 0 ? filters[2].value : "";
    const result = filters[3].selectedIndex > 0 ? filters[3].value : "";

    const rows = adminEvents.filter(function (e) {
        return (!userText || e.user.toLowerCase().includes(userText))
            && (!ipText || e.ip.toLowerCase().includes(ipText))
            && (!action || e.action === action)
            && (!result || e.result === result);
    });

    const html = rows.length ? rows.map(function (e) {
        return "<tr><td>" + escapeHtml(e.user) + "</td><td>" + escapeHtml(e.ip) + "</td><td>" + escapeHtml(e.action) +
            "</td><td>" + adminResultBadge(e.result) + "</td><td>" + adminSeverityHtml(e.severity) +
            "</td><td>" + escapeHtml(adminTimeText(e.time)) + "</td></tr>";
    }).join("") : emptyRow(6, adminEvents.length
        ? "No events match the filters."
        : "No activity yet. Log in to the portal to create the first entry.");

    replaceTableRows(document.getElementById("auditTable"), html);
}

/* Security Alerts table: every High-severity event (blocked requests and repeated failures) */
function renderAdminAlerts() {
    const table = document.querySelectorAll("#admin .table-container table")[1];
    if (!table) return;

    const alerts = adminEvents.filter(function (e) { return e.severity === "High"; }).slice(0, 10);
    const html = alerts.length ? alerts.map(function (e) {
        const blocked = e.result === "Blocked";
        const failedLogin = e.action === "Login" && e.result === "Failed";
        const message = failedLogin ? "Repeated failed logins from " + e.ip
            : blocked ? e.action + " blocked by rate limit from " + e.ip
            : e.action + " errors repeated from " + e.ip;
        const type = failedLogin ? "Brute Force" : blocked ? "Rate Limit" : "Other";
        const status = blocked
            ? '<span class="badge badge-success">Blocked</span>'
            : '<span class="badge badge-warning">Investigating</span>';
        return "<tr><td>" + escapeHtml(message + " (" + adminTimeText(e.time) + ")") + "</td><td>" + escapeHtml(type) +
            "</td><td>" + adminSeverityHtml(e.severity) + "</td><td>" + status + "</td></tr>";
    }).join("") : emptyRow(4, "No security alerts. Everything looks normal.");

    replaceTableRows(table, html);
}

async function loadAdminDashboard() {
    try {
        const [summary, events] = await Promise.all([
            apiRequest("/api/admin/summary"),
            apiRequest("/api/admin/audit")
        ]);
        adminEvents = events;
        renderAdminSummary(summary);
        renderAdminTable();
        renderAdminAlerts();
        const subtitle = document.querySelector("#admin .dashboard-header p");
        if (subtitle) {
            subtitle.textContent = "Real-time security monitoring · updated " +
                new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        }
    } catch (error) {
        replaceTableRows(document.getElementById("auditTable"), emptyRow(6, error.message));
    }
}

/* start live refresh when the admin page opens, stop it when any other page opens */
onPageShow("admin", function () {
    loadAdminDashboard();
    clearInterval(adminTimer);
    adminTimer = setInterval(loadAdminDashboard, ADMIN_REFRESH_MS);
});

document.addEventListener("pageshow", function (event) {
    if (event.detail !== "admin") {
        clearInterval(adminTimer);
        adminTimer = null;
    }
});

document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("#admin .filter-box input").forEach(function (el) {
        el.addEventListener("input", renderAdminTable);
    });
    document.querySelectorAll("#admin .filter-box select").forEach(function (el) {
        el.addEventListener("change", renderAdminTable);
    });
});
