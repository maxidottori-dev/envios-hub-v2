const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
const TN_STOREID = process.env.TN_STORE_ID;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { fulfillmentId } = req.body || {};
  if (!fulfillmentId) return res.status(400).json({ error: "fulfillmentId requerido" });

  try {
    const url = `https://api.tiendanube.com/v1/${TN_STOREID}/fulfillment_orders/${fulfillmentId}`;
    const resp = await fetch(url, {
      method: "PATCH",
      headers: {
        "Authentication": `bearer ${TN_TOKEN}`,
        "User-Agent":     "EnviosHub (maxidottori@gmail.com)",
        "Content-Type":   "application/json",
      },
      body: JSON.stringify({ status: "dispatched", notify_customer: true }),
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      console.error("TN_DISPATCH_FAIL", fulfillmentId, resp.status, JSON.stringify(data));
      return res.status(resp.status).json({ error: "TN error", status: resp.status, detail: data });
    }

    console.log("TN_DISPATCH_OK", fulfillmentId);
    return res.status(200).json({ ok: true, fulfillmentId });

  } catch (e) {
    console.error("TN_DISPATCH_ERROR", fulfillmentId, e.message);
    return res.status(500).json({ error: e.message });
  }
}
