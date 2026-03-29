import { initDb } from "./_firebase.js";

const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
const TN_STOREID = process.env.TN_STORE_ID;
const APP_URL    = process.env.APP_URL || process.env.VERCEL_URL;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const webhookUrl = `https://${APP_URL}/api/webhook`;
  const results = [];

  for (const event of ["order/created", "order/updated"]) {
    const resp = await fetch(`https://api.tiendanube.com/v1/${TN_STOREID}/webhooks`, {
      method: "POST",
      headers: {
        "Authentication": `bearer ${TN_TOKEN}`,
        "User-Agent": "EnviosHub (maxidottori@gmail.com)",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ event, url: webhookUrl })
    });
    const data = await resp.json();
    results.push({ event, ok: resp.ok, data });
  }

  return res.status(200).json({ ok: true, webhookUrl, results });
}
