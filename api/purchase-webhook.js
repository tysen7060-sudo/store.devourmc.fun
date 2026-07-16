"use strict";

const {
  RequestError,
  embed,
  field,
  methodGuard,
  multiline,
  readJsonBody,
  required,
  safeError,
  sendDiscordWebhook,
  text
} = require("./_discord");

const deliveredPurchases = new Set();

module.exports = async function handler(req, res) {
  if (!methodGuard(req, res)) return;
  try {
    const body = await readJsonBody(req);
    const paymentStatus = text(body.paymentStatus).toLowerCase();
    if (!["paid", "captured", "succeeded", "success", "completed"].includes(paymentStatus)) {
      throw new RequestError("Purchase is not confirmed.", 400, "PAYMENT_NOT_CONFIRMED");
    }

    const orderId = required(body.orderId || body.paymentId || body.orderReference, "Order ID");
    if (deliveredPurchases.has(orderId)) {
      res.status(200).json({ success: true, duplicate: true });
      return;
    }

    const products = Array.isArray(body.products) ? body.products : [];
    await sendDiscordWebhook(process.env.DISCORD_PURCHASE_WEBHOOK_URL, {
      embeds: [
        embed("New DevourMC Purchase", [
          field("Player", required(body.minecraftUsername, "Minecraft username"), true),
          field("Customer Email", text(body.email) || "Not collected", true),
          field("Customer Discord", text(body.discordUsername) || "Not collected", true),
          field("Products", products.length ? products.map(item => `${text(item.name)} x ${Number(item.quantity) || 1} (${text(item.category) || "item"})`).join("\n") : "Not provided"),
          field("Subtotal", `${text(body.currency || "INR")} ${text(body.subtotal)}`, true),
          field("Coupon", text(body.couponCode) || "None", true),
          field("Discount", text(body.discountAmount || body.discountValue) || "None", true),
          field("Final Paid", `${text(body.currency || "INR")} ${text(body.finalPaid)}`, true),
          field("Order ID", orderId, true),
          field("Payment Status", text(body.paymentStatus), true),
          field("Website Order Reference", text(body.orderReference) || orderId),
          field("Date", new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })),
          field("Notes", multiline(body.notes, 500))
        ])
      ]
    });

    deliveredPurchases.add(orderId);
    res.status(200).json({ success: true });
  } catch (error) {
    console.warn("Purchase Discord webhook skipped/failed:", error?.code || error?.message || "unknown");
    safeError(res, error, "Purchase notification could not be delivered.");
  }
};
