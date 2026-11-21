/* GovShield – Track Application */

let trackApplications = [];

async function loadTrack() {
    const body = document.getElementById("trkBody");
    try {
        trackApplications = await api.listApplications();
        apiRequest("/api/activity", { method: "POST", body: { action: "Track", detail: "Viewed application status" } }).catch(function () {});
        renderTrack();
    } catch (error) {
        body.innerHTML = emptyRow(5, error.message);
    }
}

function renderTrack() {
    const search = document.getElementById("trkSearch").value.trim().toLowerCase();
    const filter = document.getElementById("trkFilter").value;
    const count = function (status) { return trackApplications.filter(function (a) { return a.status === status; }).length; };

    document.getElementById("trkTotal").textContent = trackApplications.length;
    document.getElementById("trkPending").textContent = count("Pending");
    document.getElementById("trkProcessing").textContent = count("Processing");
    document.getElementById("trkApproved").textContent = count("Approved");

    const rows = trackApplications.filter(function (a) {
        const text = (a.id + " " + a.service).toLowerCase();
        return (!search || text.includes(search)) && (!filter || a.status === filter);
    });

    document.getElementById("trkBody").innerHTML = rows.length ? rows.map(function (a) {
        return "<tr><td>" + escapeHtml(a.id) + "</td><td>" + escapeHtml(a.service) + "</td><td>" +
            escapeHtml(a.date) + "</td><td>" + statusBadge(a.status) + "</td>" +
            '<td><button class="btn btn-primary btn-sm" data-track="' + escapeHtml(a.id) + '">View</button></td></tr>';
    }).join("") : emptyRow(5, trackApplications.length ? "No applications match your search." : "No applications yet.");
}

function showTrackDetail(id) {
    const a = trackApplications.find(function (x) { return x.id === id; });
    const box = document.getElementById("trkDetail");
    if (!a) { box.style.display = "none"; return; }

    const steps = ["Pending", "Processing", "Approved"];
    let timeline;
    if (a.status === "Rejected") {
        timeline = '<div class="track-steps"><span class="step done">Submitted</span><span class="step rejected">Rejected</span></div>';
    } else {
        const reached = steps.indexOf(a.status);
        timeline = '<div class="track-steps">' + steps.map(function (s, i) {
            return '<span class="step' + (i <= reached ? " done" : "") + '">' + s + "</span>";
        }).join("") + "</div>";
    }
    box.innerHTML = "<h3>Application " + escapeHtml(a.id) + "</h3>" + timeline +
        "<p><strong>Service:</strong> " + escapeHtml(a.service) + "</p>" +
        "<p><strong>Applicant:</strong> " + escapeHtml(a.name) + "</p>" +
        "<p><strong>NID:</strong> " + escapeHtml(a.nid) + "</p>" +
        "<p><strong>Address:</strong> " + escapeHtml(a.address || "-") + "</p>" +
        "<p><strong>Submitted:</strong> " + escapeHtml(a.date) + "</p>" +
        "<p><strong>Status:</strong> " + statusBadge(a.status) + "</p>";
    box.style.display = "block";
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

onPageShow("track", function () {
    document.getElementById("trkDetail").style.display = "none";
    loadTrack();
});

document.addEventListener("DOMContentLoaded", function () {
    document.getElementById("trkSearch").addEventListener("input", renderTrack);
    document.getElementById("trkFilter").addEventListener("change", renderTrack);
    document.getElementById("trkBody").addEventListener("click", function (event) {
        const button = event.target.closest("[data-track]");
        if (button) showTrackDetail(button.dataset.track);
    });
});
