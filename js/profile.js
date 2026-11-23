/* GovShield – My Profile (citizen photo) */

const PROFILE_MAX_BYTES = 2 * 1024 * 1024;
let profileChosenImage = null;   // data URL of a photo picked but not saved yet

function profileSetMessage(text, ok) {
    const el = document.getElementById("profileMessage");
    el.style.color = ok ? "#15803d" : "#b91c1c";
    el.textContent = text || "";
}

function profileInitials(name) {
    const parts = String(name || "G").trim().split(/\s+/).slice(0, 2);
    return parts.map(function (word) { return word.charAt(0); }).join("").toUpperCase();
}

function profileRenderUser() {
    const user = currentGovShieldUser || {};
    document.getElementById("profileName").textContent = user.name || "Citizen";
    document.getElementById("profileInitial").textContent = profileInitials(user.name);
    const nid = user.nid || "";
    document.getElementById("profileNid").textContent = /^[0-9]{10}$/.test(nid) ? "NID: ******" + nid.slice(-4) : "";
}

function profileShowPhoto(dataUrl) {
    const avatar = document.getElementById("profileAvatar");
    const initial = document.getElementById("profileInitial");
    let img = avatar.querySelector("img");
    if (dataUrl) {
        if (!img) {
            img = document.createElement("img");
            img.alt = "Your profile photo";
            avatar.appendChild(img);
        }
        img.src = dataUrl;
        initial.hidden = true;
    } else {
        if (img) img.remove();
        initial.hidden = false;
    }
    const status = document.getElementById("profilePhotoStatus");
    status.textContent = dataUrl ? "Photo saved" : "No photo yet";
    status.className = "pf-pill " + (dataUrl ? "ok" : "warn");
    document.getElementById("profileRemoveBtn").hidden = !dataUrl;
}

async function profileLoad() {
    try {
        const result = await apiRequest("/api/me/photo");
        profileShowPhoto(result.photo);
    } catch (error) {
        profileSetMessage(error.message, false);
    }
}

onPageShow("profile", function () {
    profileRenderUser();
    profileSetMessage("", true);
    profileLoad();
});

document.addEventListener("DOMContentLoaded", function () {
    const input = document.getElementById("profilePhotoInput");
    if (input) input.addEventListener("change", profileChosen);
});

function profileChosen(event) {
    const input = event.target;
    const file = input.files && input.files[0];
    profileChosenImage = null;
    document.getElementById("profileSaveBtn").disabled = true;
    document.getElementById("profilePreview").hidden = true;
    if (!file) return;
    if (file.type !== "image/jpeg" && file.type !== "image/png") {
        profileSetMessage("Please choose a JPG or PNG photo.", false);
        input.value = "";
        return;
    }
    if (file.size > PROFILE_MAX_BYTES) {
        profileSetMessage("The photo must be 2 MB or smaller.", false);
        input.value = "";
        return;
    }
    const reader = new FileReader();
    reader.onload = function () {
        profileChosenImage = reader.result;
        const preview = document.getElementById("profilePreview");
        preview.src = profileChosenImage;
        preview.hidden = false;
        document.getElementById("profileSaveBtn").disabled = false;
        profileSetMessage("Ready. Press Save photo to keep it.", true);
    };
    reader.readAsDataURL(file);
}

async function saveProfilePhoto() {
    if (!profileChosenImage) return;
    const button = document.getElementById("profileSaveBtn");
    button.disabled = true;
    button.textContent = "Saving...";
    try {
        const result = await apiRequest("/api/me/photo", { method: "POST", body: { image: profileChosenImage } });
        profileShowPhoto(result.photo);
        profileChosenImage = null;
        document.getElementById("profilePhotoInput").value = "";
        document.getElementById("profilePreview").hidden = true;
        profileSetMessage("Photo saved. You can now submit applications.", true);
    } catch (error) {
        const errors = error.fieldErrors || {};
        profileSetMessage(Object.values(errors).join(" ") || error.message, false);
    } finally {
        button.textContent = "Save photo";
        button.disabled = !profileChosenImage;
    }
}

async function removeProfilePhoto() {
    if (!confirm("Remove your profile photo? You will need a photo again before you can apply.")) return;
    try {
        await apiRequest("/api/me/photo", { method: "POST", body: { remove: true } });
        profileShowPhoto(null);
        profileSetMessage("Photo removed.", true);
    } catch (error) {
        profileSetMessage(error.message, false);
    }
}
