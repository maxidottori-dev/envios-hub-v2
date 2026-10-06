import { initDb } from "./_firebase.js";

const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
const TN_STOREID = process.env.TN_STORE_ID;
const APP_URL    = process.env.APP_URL || process.env.VERCEL_URL;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const webhookUrl = `https://${APP_URL}/api/webhook`;
  const eventos = ["order/created", "order/updated", "order/cancelled"];
  const headers = {
    "Authentication": `bearer ${TN_TOKEN}`,
    "User-Agent": "EnviosHub (maxidottori@gmail.com)",
    "Content-Type": "application/json"
  };

  // 1. Listar webhooks existentes para no crear duplicados
  const listResp = await fetch(`https://api.tiendanube.com/v1/${TN_STOREID}/webhooks`, { headers });
  const existentes = listResp.ok ? await listResp.json() : [];
  const yaRegistrados = new Set(
    existentes.filter(w => w.url === webhookUrl).map(w => w.event)
  );

  const results = [];

  for (const event of eventos) {
    if (yaRegistrados.has(event)) {
      results.push({ event, ok: true, skipped: true, msg: "ya existe" });
      continue;
    }
    const resp = await fetch(`https://api.tiendanube.com/v1/${TN_STOREID}/webhooks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ event, url: webhookUrl })
    });
    const data = await resp.json();
    results.push({ event, ok: resp.ok, skipped: false, data });
  }

  return res.status(200).json({ ok: true, webhookUrl, yaRegistrados: [...yaRegistrados], results });
}
