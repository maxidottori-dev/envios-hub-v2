// Vercel Function — registra el webhook en Tienda Nube (llamar una sola vez)
const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
const TN_STOREID = process.env.TN_STORE_ID;
const APP_URL    = process.env.VERCEL_URL || process.env.APP_URL;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const webhookUrl = `https://${APP_URL}/api/webhook`;

  // Registrar webhook para order/created
  const resp = await fetch(`https://api.tiendanube.com/v1/${TN_STOREID}/webhooks`, {
    method: "POST",
    headers: {
      "Authentication": `bearer ${TN_TOKEN}`,
      "User-Agent": "EnviosHub (maxidottori@gmail.com)",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ event: "order/created", url: webhookUrl })
  });

  const data = await resp.json();
  return res.status(200).json({ ok: resp.ok, webhook: data, webhookUrl });
}
