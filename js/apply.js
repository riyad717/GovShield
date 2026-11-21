/* GovShield – Apply Online */

onPageShow("apply", function () {
    const nameField = document.getElementById("appName");
    const nidField = document.getElementById("appNid");
    // pre-fill with the logged-in citizen (still editable)
    if (currentGovShieldUser) {
        if (nameField && !nameField.dataset.touched) nameField.value = currentGovShieldUser.name || "";
        if (nidField && !nidField.dataset.touched && /^\d{10}$/.test(currentGovShieldUser.nid || "")) {
            nidField.value = currentGovShieldUser.nid;
        }
    }
    showFormMessage("applySubmitBtn", "", true);
});

document.addEventListener("DOMContentLoaded", function () {
    ["appName", "appNid"].forEach(function (id) {
        const field = document.getElementById(id);
        if (field) field.addEventListener("input", function () { field.dataset.touched = "1"; });
    });
    const button = document.querySelector('#apply button[onclick="submitApplication()"]');
    if (button) button.id = "applySubmitBtn";
});

async function submitApplication() {
    const button = document.getElementById("applySubmitBtn");
    const data = {
        service: document.getElementById("appService").value.trim(),
        name: document.getElementById("appName").value.trim(),
        nid: document.getElementById("appNid").value.trim(),
        address: document.getElementById("appAddr").value.trim()
    };

    if (data.service === "Select Service" || !data.service) return showFormMessage("applySubmitBtn", "Please select a service.", false);
    if (data.name.length < 3) return showFormMessage("applySubmitBtn", "Enter the applicant name.", false);
    if (!/^(\d{10}|\d{13}|\d{17})$/.test(data.nid)) return showFormMessage("applySubmitBtn", "NID must be 10, 13 or 17 digits.", false);
    if (data.address.length < 5) return showFormMessage("applySubmitBtn", "Enter your address (at least 5 characters).", false);

    button.disabled = true;
    button.textContent = "Submitting...";
    try {
        const app = await api.createApplication(data);
        showFormMessage("applySubmitBtn", "Application submitted. Your Application ID is " + app.id + ".", true);
        document.getElementById("appService").selectedIndex = 0;
        document.getElementById("appAddr").value = "";
        setTimeout(function () { showPage("track"); }, 1200);
    } catch (error) {
        const details = Object.values(error.fieldErrors || {}).join(" ");
        showFormMessage("applySubmitBtn", details || error.message, false);
    } finally {
        button.disabled = false;
        button.textContent = "Submit Application";
    }
}
