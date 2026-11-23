/* GovShield – Apply Online (full application form) */

// server error key -> id of the message element under that field
const APPLY_ERROR_IDS = {
    service: "appServiceErr", name: "appNameErr", nid: "appNidErr", address: "appAddrErr",
    father_name: "appFatherErr", mother_name: "appMotherErr", date_of_birth: "appDobErr",
    gender: "appGenderErr", phone: "appPhoneErr", email: "appEmailErr",
    permanent_address: "appPermAddrErr", birth_place: "appBirthPlaceErr", ward_no: "appWardErr",
    business_name: "appBizNameErr", business_address: "appBizAddrErr", trade_type: "appTradeTypeErr",
    purpose: "appPurposeErr", declaration: "appDeclareErr"
};

// service -> the block of extra fields it needs
const APPLY_SERVICE_BLOCKS = {
    "Birth Certificate": "svcBirth",
    "Citizenship Certificate": "svcCitizen",
    "Trade Licence": "svcTrade",
    "Other Certificate": "svcOther"
};

function applyClearErrors() {
    Object.values(APPLY_ERROR_IDS).forEach(function (id) {
        const el = document.getElementById(id);
        if (el) el.textContent = "";
    });
    const serviceErr = document.getElementById("appServiceErr");
    if (serviceErr) serviceErr.textContent = "";
}

function applyShowErrors(errors) {
    Object.keys(errors || {}).forEach(function (key) {
        const el = document.getElementById(APPLY_ERROR_IDS[key] || "");
        if (el) el.textContent = errors[key];
    });
}

function applySelectService(service) {
    document.getElementById("appService").value = service;
    document.querySelectorAll(".pf-service").forEach(function (button) {
        button.setAttribute("aria-pressed", String(button.dataset.service === service));
    });
    Object.values(APPLY_SERVICE_BLOCKS).forEach(function (id) {
        document.getElementById(id).hidden = true;
    });
    const block = APPLY_SERVICE_BLOCKS[service];
    document.getElementById("svcSection").hidden = !block;
    if (block) document.getElementById(block).hidden = false;
}

async function applyCheckPhoto() {
    const chip = document.getElementById("appPhotoChip");
    const text = document.getElementById("appPhotoText");
    try {
        const result = await apiRequest("/api/me/photo");
        const hasPhoto = Boolean(result.photo);
        chip.classList.toggle("ok", hasPhoto);
        text.textContent = hasPhoto ? "✓ Profile photo ready" : "Add a profile photo before you apply";
    } catch (error) {
        text.textContent = "Could not check your profile photo";
    }
}

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
    applyCheckPhoto();
});

document.addEventListener("DOMContentLoaded", function () {
    ["appName", "appNid"].forEach(function (id) {
        const field = document.getElementById(id);
        if (field) field.addEventListener("input", function () { field.dataset.touched = "1"; });
    });
    document.querySelectorAll(".pf-service").forEach(function (button) {
        button.addEventListener("click", function () { applySelectService(button.dataset.service); });
    });
});

function collectApplication() {
    const value = function (id) {
        const el = document.getElementById(id);
        return el ? el.value.trim() : "";
    };
    return {
        service: value("appService"),
        name: value("appName"),
        nid: value("appNid"),
        address: value("appAddr"),
        father_name: value("appFather"),
        mother_name: value("appMother"),
        date_of_birth: value("appDob"),
        gender: value("appGender"),
        phone: value("appPhone"),
        email: value("appEmail"),
        permanent_address: value("appPermAddr"),
        birth_place: value("appBirthPlace"),
        ward_no: value("appWard"),
        business_name: value("appBizName"),
        business_address: value("appBizAddr"),
        trade_type: value("appTradeType"),
        purpose: value("appPurpose"),
        declaration: document.getElementById("appDeclare").checked
    };
}

function resetApplyForm() {
    // keep the applicant's own name and NID, clear the rest
    ["appAddr", "appFather", "appMother", "appDob", "appGender", "appPhone", "appEmail",
     "appPermAddr", "appBirthPlace", "appWard", "appBizName", "appBizAddr", "appTradeType", "appPurpose"]
        .forEach(function (id) {
            const el = document.getElementById(id);
            if (el) el.value = "";
        });
    document.getElementById("appDeclare").checked = false;
    applySelectService("Select Service");
}

async function submitApplication() {
    const button = document.getElementById("applySubmitBtn");
    applyClearErrors();
    const data = collectApplication();

    if (data.service === "Select Service" || !data.service) {
        document.getElementById("appServiceErr").textContent = "Please choose a service first.";
        return;
    }

    button.disabled = true;
    button.textContent = "Submitting...";
    try {
        const app = await api.createApplication(data);
        showFormMessage("applySubmitBtn", "Application submitted. Your Application ID is " + app.id + ".", true);
        resetApplyForm();
        setTimeout(function () { showPage("track"); }, 1200);
    } catch (error) {
        const errors = error.fieldErrors || {};
        applyShowErrors(errors);
        const details = Object.values(errors).join(" ");
        showFormMessage("applySubmitBtn", details || error.message, false);
    } finally {
        button.disabled = false;
        button.textContent = "Submit Application";
    }
}
