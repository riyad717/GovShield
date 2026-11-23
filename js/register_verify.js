/* GovShield – sign-up with a phone code (2 steps) */

let regPendingNid = null;   // NID waiting for the 6-digit code
let regResendTimer = null;

function regSetError(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text || "";
}

function regShowStep(step) {
    document.getElementById("regStepDetails").hidden = step !== 1;
    document.getElementById("regStepCode").hidden = step !== 2;
    document.getElementById("regStepTab1").classList.toggle("active", step === 1);
    document.getElementById("regStepTab1").classList.toggle("done", step === 2);
    document.getElementById("regStepTab2").classList.toggle("active", step === 2);
    document.getElementById("registerMessage").textContent = "";
}

function regReadForm() {
    return {
        nid: document.getElementById("regNid").value.trim(),
        name: document.getElementById("regName").value.trim(),
        phone: document.getElementById("regPhone").value.trim(),
        password: document.getElementById("regPassword").value
    };
}

function regValidate(values) {
    const errors = {
        regNidErr: /^[0-9]{10}$/.test(values.nid) ? "" : "NID must contain exactly 10 digits.",
        regNameErr: values.name.length >= 3 ? "" : "Enter your full name.",
        regPhoneErr: /^(\+?88)?[0-9]{11}$/.test(values.phone.replace(/[\s-]/g, "")) ? "" : "Enter an 11-digit phone number.",
        regPasswordErr: (values.password.length >= 8 && /[A-Za-z]/.test(values.password) && /[0-9]/.test(values.password))
            ? "" : "At least 8 characters with a letter and a number."
    };
    Object.keys(errors).forEach(function (id) { regSetError(id, errors[id]); });
    return Object.values(errors).every(function (text) { return text === ""; });
}

function regStartCooldown(seconds) {
    clearInterval(regResendTimer);
    const button = document.getElementById("resendBtn");
    let left = seconds;
    const tick = function () {
        if (left <= 0) {
            clearInterval(regResendTimer);
            button.disabled = false;
            button.textContent = "Resend code";
            return;
        }
        button.disabled = true;
        button.textContent = "Resend in " + left + "s";
        left -= 1;
    };
    tick();
    regResendTimer = setInterval(tick, 1000);
}

function regFinishToLogin(nid, text) {
    clearInterval(regResendTimer);
    document.getElementById("regPassword").value = "";
    document.getElementById("regCode").value = "";
    regPendingNid = null;
    regShowStep(1);
    document.getElementById("loginId").value = nid;
    const message = document.getElementById("loginMessage");
    message.style.color = "#15803d";
    message.textContent = text;
    showPage("login");
}

// asks the server for a code (or creates the account at once when phone checks are off)
async function regRequestCode(values, button) {
    const message = document.getElementById("registerMessage");
    message.textContent = "";
    if (button) { button.disabled = true; button.textContent = "Sending code..."; }
    try {
        const result = await apiRequest("/api/register/code", { method: "POST", body: values });
        if (result.verified) {
            regFinishToLogin(values.nid, "Registration successful. Please log in.");
            return;
        }
        regPendingNid = values.nid;
        document.getElementById("regMaskedPhone").textContent = result.masked_phone || "your phone";
        const demoNote = document.getElementById("regDemoNote");
        if (result.demo_code) {
            document.getElementById("regDemoCode").textContent = result.demo_code;
            demoNote.hidden = false;
        } else {
            demoNote.hidden = true;
        }
        document.getElementById("regCode").value = "";
        regSetError("regCodeErr", "");
        regShowStep(2);
        regStartCooldown(result.resend_in || 60);
        document.getElementById("regCode").focus();
    } catch (error) {
        message.style.color = "#b91c1c";
        message.textContent = error.message;
    } finally {
        if (button) { button.disabled = false; button.textContent = "Send verification code"; }
    }
}

async function registerUser() {
    const values = regReadForm();
    if (!regValidate(values)) return;
    await regRequestCode(values, document.getElementById("registerBtn"));
}

async function resendRegistrationCode() {
    const values = regReadForm();
    if (!regValidate(values)) {
        regShowStep(1);
        return;
    }
    await regRequestCode(values, null);
}

function backToRegisterDetails() {
    regShowStep(1);
}

async function verifyRegistration() {
    const code = document.getElementById("regCode").value.trim();
    regSetError("regCodeErr", "");
    if (!/^[0-9]{6}$/.test(code)) {
        regSetError("regCodeErr", "Enter the 6-digit code.");
        return;
    }
    if (!regPendingNid) {
        regShowStep(1);
        return;
    }
    const button = document.getElementById("verifyBtn");
    button.disabled = true;
    button.textContent = "Checking...";
    try {
        await apiRequest("/api/register/verify", { method: "POST", body: { nid: regPendingNid, code: code } });
        regFinishToLogin(regPendingNid, "Account created. Please log in.");
    } catch (error) {
        regSetError("regCodeErr", error.message);
    } finally {
        button.disabled = false;
        button.textContent = "Verify and create account";
    }
}
