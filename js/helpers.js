/* GovShield – shared helpers */

function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function statusBadge(status) {
    const good = ["Approved", "Paid", "Available"];
    const bad = ["Rejected", "Failed"];
    const cls = good.includes(status) ? "badge-success" : bad.includes(status) ? "badge-danger" : "badge-warning";
    return '<span class="badge ' + cls + '">' + escapeHtml(status) + "</span>";
}

function formatMoney(value) {
    const number = Number(value);
    return "BDT " + number.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* show a coloured message under a button; the element is created once */
function showFormMessage(anchorId, text, ok) {
    const anchor = document.getElementById(anchorId);
    if (!anchor) return;
    let box = document.getElementById(anchorId + "Msg");
    if (!box) {
        box = document.createElement("p");
        box.id = anchorId + "Msg";
        box.setAttribute("role", "alert");
        box.style.cssText = "margin-top:12px;font-size:14px;line-height:1.5;";
        anchor.insertAdjacentElement("afterend", box);
    }
    box.style.color = ok ? "#15803d" : "#b91c1c";
    box.textContent = text || "";
}

/* run code whenever a page is opened (showPage fires this custom event) */
function onPageShow(pageId, callback) {
    document.addEventListener("pageshow", function (event) {
        if (event.detail === pageId) callback();
    });
}

function emptyRow(columns, text) {
    return '<tr><td colspan="' + columns + '" style="text-align:center;color:#64748b;padding:20px;">' + escapeHtml(text) + "</td></tr>";
}
