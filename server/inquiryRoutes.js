/**
 * AdLands - Sponsor Inquiry API Routes
 * Handles contact form submissions from the sponsor portal.
 * Sends email via Resend HTTP API to matt@mattmatters.com.
 */

const { Router } = require("express");
const https = require("https");

/**
 * Send email via Resend REST API (HTTPS port 443, never blocked by hosting providers)
 */
function sendViaResend(apiKey, emailData) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(emailData);
    const options = {
      hostname: "api.resend.com",
      port: 443,
      path: "/emails",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch (_) { resolve(body); }
        } else {
          let msg = `Resend API error ${res.statusCode}`;
          try { msg = JSON.parse(body).message || msg; } catch (_) {}
          reject(new Error(msg));
        }
      });
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function createInquiryRoutes() {
  const router = Router();

  // Rate limiting: track last inquiry time per IP (in-memory)
  const lastInquiryByIP = new Map();
  const RATE_LIMIT_MS = 60000; // 1 minute

  // Resend API key (same key used for both SMTP and HTTP API)
  const resendApiKey = process.env.SMTP_PASS || null;
  const fromAddress = process.env.SMTP_FROM || "AdLands Sponsor Portal <noreply@adlands.gg>";

  if (resendApiKey) {
    console.log("[Inquiry] Resend API configured, emails will be sent via HTTPS");
  } else {
    console.log("[Inquiry] No SMTP_PASS set, emails will be logged to console only");
  }

  router.post("/", async (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;

    // Rate limit check
    const lastTime = lastInquiryByIP.get(ip);
    if (lastTime && Date.now() - lastTime < RATE_LIMIT_MS) {
      return res.status(429).json({ error: "Please wait before submitting another inquiry." });
    }
    lastInquiryByIP.set(ip, Date.now());

    const {
      name, email, company, message,
      screenshot, importPayload, pricing,
      selectedTiles, selectedMoons, selectedBillboards,
    } = req.body;

    // Validate required fields
    if (!name || !email) {
      return res.status(400).json({ error: "Name and email are required." });
    }

    // Build admin import URL
    const host = req.get("host");
    const protocol = req.protocol;
    const adminImportUrl = importPayload
      ? `${protocol}://${host}/admin.html?import=${importPayload}`
      : null;

    // Build email HTML (screenshot as attachment, not inline CID)
    const html = buildInquiryEmail({
      name, email, company, message,
      pricing, selectedTiles, selectedMoons, selectedBillboards,
      adminImportUrl,
    });

    // Build attachments for Resend API
    const attachments = [];
    if (screenshot) {
      const base64Data = screenshot.replace(/^data:image\/png;base64,/, "");
      attachments.push({
        filename: "selection-preview.png",
        content: base64Data,
      });
    }

    // Determine subject
    const totalItems =
      (selectedTiles ? selectedTiles.length : 0) +
      (selectedMoons ? selectedMoons.length : 0) +
      (selectedBillboards ? selectedBillboards.length : 0);
    const subject = totalItems > 0
      ? `Sponsor Inquiry: ${company || name} (${totalItems} items selected)`
      : `Contact: ${company || name}`;

    try {
      if (resendApiKey) {
        const emailData = {
          from: fromAddress,
          to: ["matt@mattmatters.com"],
          reply_to: email,
          subject,
          html,
        };
        if (attachments.length > 0) {
          emailData.attachments = attachments;
        }
        await sendViaResend(resendApiKey, emailData);
        console.log(`[Inquiry] Email sent: ${subject}`);
      } else {
        console.log("[Inquiry] --- EMAIL WOULD BE SENT ---");
        console.log(`  Subject: ${subject}`);
        console.log(`  From: ${name} <${email}>`);
        console.log(`  Company: ${company || "(none)"}`);
        console.log(`  Message: ${message || "(none)"}`);
        console.log(`  Tiles: ${selectedTiles ? selectedTiles.length : 0}`);
        console.log(`  Moons: ${selectedMoons ? selectedMoons.length : 0}`);
        console.log(`  Billboards: ${selectedBillboards ? selectedBillboards.length : 0}`);
        if (adminImportUrl) console.log(`  Admin Import: ${adminImportUrl}`);
        console.log("[Inquiry] --- END ---");
      }

      res.json({ success: true });
    } catch (err) {
      console.error("[Inquiry] Email send failed:", err.message);
      res.status(500).json({ error: "Failed to send inquiry: " + err.message });
    }
  });

  // Clean up rate limit map periodically (every 10 minutes)
  setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_MS * 2;
    for (const [ip, time] of lastInquiryByIP) {
      if (time < cutoff) lastInquiryByIP.delete(ip);
    }
  }, 600000);

  return router;
}

/**
 * Build HTML email content for sponsor inquiry
 */
function buildInquiryEmail({
  name, email, company, message,
  pricing, selectedTiles, selectedMoons, selectedBillboards,
  adminImportUrl,
}) {
  const hasTiles = selectedTiles && selectedTiles.length > 0;
  const hasMoons = selectedMoons && selectedMoons.length > 0;
  const hasBillboards = selectedBillboards && selectedBillboards.length > 0;
  const hasSelection = hasTiles || hasMoons || hasBillboards;

  // Calculate grand total
  let grandTotal = 0;
  if (pricing) {
    grandTotal = (pricing.total || 0) + (pricing.moonTotal || 0) + (pricing.billboardTotal || 0);
  }

  let html = `
    <div style="font-family: Arial, Helvetica, sans-serif; background: #ffffff; color: #222222; padding: 24px; max-width: 600px; margin: 0 auto;">
      <div style="background: #111111; padding: 16px 20px; margin: -24px -24px 20px -24px;">
        <h1 style="color: #00cccc; font-size: 22px; margin: 0; font-family: monospace;">
          AdLands <span style="color: #999999; font-size: 14px;">Sponsor Inquiry</span>
        </h1>
      </div>

      <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
        <tr>
          <td style="color: #888888; padding: 4px 8px 4px 0; vertical-align: top; font-size: 13px;">Name:</td>
          <td style="color: #222222; padding: 4px 0; font-size: 13px;">${escapeHtml(name)}</td>
        </tr>
        <tr>
          <td style="color: #888888; padding: 4px 8px 4px 0; vertical-align: top; font-size: 13px;">Email:</td>
          <td style="padding: 4px 0; font-size: 13px;"><a href="mailto:${escapeHtml(email)}" style="color: #0077cc;">${escapeHtml(email)}</a></td>
        </tr>
        ${company ? `
        <tr>
          <td style="color: #888888; padding: 4px 8px 4px 0; vertical-align: top; font-size: 13px;">Company:</td>
          <td style="color: #222222; padding: 4px 0; font-size: 13px;">${escapeHtml(company)}</td>
        </tr>
        ` : ""}
      </table>

      ${message ? `
      <div style="background: #f5f5f5; border: 1px solid #dddddd; padding: 12px; margin-bottom: 16px;">
        <div style="color: #888888; font-size: 11px; margin-bottom: 4px; text-transform: uppercase;">Message</div>
        <div style="white-space: pre-wrap; color: #333333;">${escapeHtml(message)}</div>
      </div>
      ` : ""}

      <div style="background: #f0f0f0; padding: 8px 12px; margin-bottom: 16px; color: #666666; font-size: 12px; font-style: italic;">
        Selection screenshot attached as selection-preview.png
      </div>
  `;

  // Pricing breakdown
  if (hasSelection && pricing) {
    html += `
      <div style="background: #f5f5f5; border: 1px solid #dddddd; padding: 12px; margin-bottom: 16px;">
        <div style="color: #888888; font-size: 11px; margin-bottom: 8px; text-transform: uppercase;">Pricing Breakdown</div>
    `;

    // Hex tiers
    if (hasTiles && pricing.byTier) {
      html += `<div style="margin-bottom: 8px; color: #333333; font-weight: bold;">${selectedTiles.length} hex${selectedTiles.length !== 1 ? "es" : ""} selected</div>`;
      for (const [tierId, count] of Object.entries(pricing.byTier)) {
        const tierPrices = { HOTZONE: 15, PRIME: 7, FRONTIER: 3 };
        const price = tierPrices[tierId] || 0;
        html += `<table style="width: 100%; border-collapse: collapse;"><tr>
          <td style="color: #555555; padding: 2px 0;">${tierId} x ${count}</td>
          <td style="color: #555555; padding: 2px 0; text-align: right;">$${(price * count).toFixed(2)}</td>
        </tr></table>`;
      }
      if (pricing.discount > 0) {
        html += `<div style="color: #16a34a; padding: 4px 0;">Cluster Discount: -${pricing.discount}% (-$${pricing.discountAmount.toFixed(2)})</div>`;
      }
    }

    // Moons
    if (hasMoons && pricing.moons) {
      html += `<div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #dddddd; color: #333333; font-weight: bold;">${selectedMoons.length} moon${selectedMoons.length !== 1 ? "s" : ""}</div>`;
      for (const moon of pricing.moons) {
        html += `<table style="width: 100%; border-collapse: collapse;"><tr>
          <td style="color: #555555; padding: 2px 0;">${moon.label}</td>
          <td style="color: #555555; padding: 2px 0; text-align: right;">$${moon.price.toFixed(2)}</td>
        </tr></table>`;
      }
    }

    // Billboards
    if (hasBillboards && pricing.billboards) {
      html += `<div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #dddddd; color: #333333; font-weight: bold;">${selectedBillboards.length} billboard${selectedBillboards.length !== 1 ? "s" : ""}</div>`;
      for (const bb of pricing.billboards) {
        html += `<table style="width: 100%; border-collapse: collapse;"><tr>
          <td style="color: #555555; padding: 2px 0;">${bb.label}</td>
          <td style="color: #555555; padding: 2px 0; text-align: right;">$${bb.price.toFixed(2)}</td>
        </tr></table>`;
      }
    }

    // Total
    html += `
        <table style="width: 100%; border-collapse: collapse; margin-top: 8px; padding-top: 8px; border-top: 2px solid #0099aa;"><tr>
          <td style="color: #222222; padding: 4px 0; font-weight: bold;">Monthly Total</td>
          <td style="color: #0099aa; font-size: 18px; padding: 4px 0; text-align: right; font-weight: bold;">$${grandTotal.toFixed(2)}/mo</td>
        </tr></table>
      </div>
    `;
  }

  // Territory indices
  if (hasSelection) {
    html += `
      <div style="background: #f5f5f5; border: 1px solid #dddddd; padding: 12px; margin-bottom: 16px;">
        <div style="color: #888888; font-size: 11px; margin-bottom: 4px; text-transform: uppercase;">Territory Details</div>
    `;
    if (hasTiles) {
      html += `<div style="margin-bottom: 4px; color: #555555; font-size: 13px;">Hex indices: ${selectedTiles.join(", ")}</div>`;
    }
    if (hasMoons) {
      html += `<div style="margin-bottom: 4px; color: #555555; font-size: 13px;">Moon indices: ${selectedMoons.join(", ")}</div>`;
    }
    if (hasBillboards) {
      html += `<div style="color: #555555; font-size: 13px;">Billboard indices: ${selectedBillboards.join(", ")}</div>`;
    }
    html += `</div>`;
  }

  // Admin import link
  if (adminImportUrl) {
    html += `
      <div style="margin-bottom: 16px;">
        <a href="${adminImportUrl}" style="display: inline-block; background: #0099aa; color: #ffffff; padding: 10px 20px; text-decoration: none; font-family: monospace; font-size: 14px;">
          Import Selection into Admin Portal
        </a>
      </div>
    `;
  }

  html += `
      <div style="color: #aaaaaa; font-size: 11px; border-top: 1px solid #eeeeee; padding-top: 12px; margin-top: 16px;">
        Sent from the AdLands Sponsor Portal
      </div>
    </div>
  `;

  return html;
}

/**
 * Escape HTML entities
 */
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = { createInquiryRoutes };
