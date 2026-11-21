/* GovShield – small helper for calling the Python backend with the login token. */

async function apiRequest(path, options) {
    options = options || {};
    const headers = Object.assign({}, authHeaders(), options.headers || {});
    let body = options.body;
    if (body && typeof body !== "string") {
        body = JSON.stringify(body);
        headers["Content-Type"] = "application/json";
    }
    let response;
    try {
        response = await fetch(path, { method: options.method || "GET", headers: headers, body: body });
    } catch (e) {
        throw new Error("Cannot reach the server. Make sure `python server.py` is running.");
    }
    let data = {};
    try { data = await response.json(); } catch (e) { /* empty body */ }

    if (response.status === 401) {
        // session expired or server restarted: go back to login
        sessionStorage.removeItem(AUTH_TOKEN_KEY);
        currentGovShieldUser = null;
        showSessionEnded();
        throw new Error(data.error || "Please log in again.");
    }
    if (!response.ok) {
        const error = new Error(data.error || "Request failed.");
        error.fieldErrors = data.errors || {};
        throw error;
    }
    return data;
}

const api = {
    listApplications: function () { return apiRequest("/api/applications"); },
    createApplication: function (data) { return apiRequest("/api/applications", { method: "POST", body: data }); },
    listPayments: function () { return apiRequest("/api/payments"); },
    createPayment: function (data) { return apiRequest("/api/payments", { method: "POST", body: data }); }
};

/* Shown on the login page when a saved login is no longer valid (for example after a server wipe). */
function showSessionEnded() {
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
    currentGovShieldUser = null;
    showPage("login");
    const message = document.getElementById("loginMessage");
    if (message) {
        message.style.color = "#b91c1c";
        message.textContent = "Your session has ended. Please log in again.";
    }
}
