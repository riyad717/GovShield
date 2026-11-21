/* GovShield – Pay Bills & Taxes */

async function loadPayments() {
    const body = document.getElementById("payHistory");
    try {
        const payments = await api.listPayments();
        body.innerHTML = payments.length ? payments.map(function (p) {
            return "<tr><td>" + escapeHtml(p.id) + "</td><td>" + escapeHtml(p.type) + "</td><td>" +
                escapeHtml(formatMoney(p.amount)) + "</td><td>" + escapeHtml(p.method) + "</td><td>" +
                statusBadge(p.status) + "</td></tr>";
        }).join("") : emptyRow(5, "No payments yet.");
    } catch (error) {
        body.innerHTML = emptyRow(5, error.message);
    }
}

onPageShow("pay", function () {
    const result = document.getElementById("payResult");
    if (result) result.style.display = "none";
    showFormMessage("payNowBtn", "", true);
    loadPayments();
});

document.addEventListener("DOMContentLoaded", function () {
    const button = document.querySelector('#pay button[onclick="makePayment()"]');
    if (button) button.id = "payNowBtn";
});

async function makePayment() {
    const button = document.getElementById("payNowBtn");
    const methodInput = document.querySelector('input[name="payMethod"]:checked');
    const data = {
        type: document.getElementById("payType").value.trim(),
        reference: document.getElementById("payRef").value.trim(),
        amount: document.getElementById("payAmount").value.trim(),
        method: methodInput ? methodInput.value : ""
    };
    const result = document.getElementById("payResult");
    result.style.display = "none";

    if (!data.type) return showFormMessage("payNowBtn", "Please select a payment type.", false);
    if (!/^[A-Za-z0-9-]{6,20}$/.test(data.reference)) return showFormMessage("payNowBtn", "Reference number must be 6-20 letters, numbers or hyphens.", false);
    if (!/^\d+(\.\d{1,2})?$/.test(data.amount) || Number(data.amount) < 1 || Number(data.amount) > 1000000) {
        return showFormMessage("payNowBtn", "Enter an amount between 1 and 1,000,000 (max 2 decimals).", false);
    }
    if (!data.method) return showFormMessage("payNowBtn", "Please select a payment method.", false);

    button.disabled = true;
    button.textContent = "Processing...";
    try {
        const pay = await api.createPayment(data);
        showFormMessage("payNowBtn", "", true);
        result.innerHTML = "<strong>Payment successful</strong><br>Transaction ID: " + escapeHtml(pay.id) +
            "<br>Type: " + escapeHtml(pay.type) + "<br>Amount: " + escapeHtml(formatMoney(pay.amount)) +
            "<br>Method: " + escapeHtml(pay.method);
        result.style.display = "block";
        document.getElementById("payRef").value = "";
        document.getElementById("payAmount").value = "";
        loadPayments();
    } catch (error) {
        const details = Object.values(error.fieldErrors || {}).join(" ");
        showFormMessage("payNowBtn", details || error.message, false);
    } finally {
        button.disabled = false;
        button.textContent = "Pay Now";
    }
}
