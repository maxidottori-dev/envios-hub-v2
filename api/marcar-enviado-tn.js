const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
const TN_STOREID = process.env.TN_STORE_ID;

const TN_HEADERS = {
  "Authentication": `bearer ${TN_TOKEN}`,
  "User-Agent":     "EnviosHub (maxidottori@gmail.com)",
  "Content-Type":   "application/json",
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { orderTNId } = req.body || {};
  if (!orderTNId) return res.status(400).json({ error: "orderTNId requerido" });

  try {
    // 1. Obtener fulfillment orders del pedido
    const listUrl = `https://api.tiendanube.com/v1/${TN_STOREID}/orders/${orderTNId}/fulfillment-orders`;
    const listResp = await fetch(listUrl, { headers: TN_HEADERS });

    if (!listResp.ok) {
      const detail = await listResp.json().catch(() => ({}));
      console.error("TN_FO_LIST_FAIL", orderTNId, listResp.status, JSON.stringify(detail));
      return res.status(listResp.status).json({ error: "No se pudieron obtener fulfillment orders", detail });
    }

    const foList = await listResp.json();

    if (!Array.isArray(foList) || foList.length === 0) {
      console.warn("TN_FO_EMPTY", orderTNId);
      return res.status(404).json({ error: "Sin fulfillment orders para este pedido" });
    }

    // 2. Elegir el primer FO que no esté ya despachado/entregado
    const TARGET_STATUSES = ["UNPACKED", "PACKED"];
    const fo = foList.find(f => TARGET_STATUSES.includes(f.status)) || foList[0];

    if (["DISPATCHED", "DELIVERED"].includes(fo.status)) {
      console.log("TN_FO_ALREADY_DISPATCHED", orderTNId, fo.id, fo.status);
      return res.status(200).json({ ok: true, skipped: true, status: fo.status, foId: fo.id });
    }

    // 3. PATCH para marcar como despachado
    const patchUrl = `https://api.tiendanube.com/v1/${TN_STOREID}/orders/${orderTNId}/fulfillment-orders/${fo.id}`;
    const patchResp = await fetch(patchUrl, {
      method: "PATCH",
      headers: TN_HEADERS,
      body: JSON.stringify({ status: "DISPATCHED" }),
    });

    const data = await patchResp.json().catch(() => ({}));

    if (!patchResp.ok) {
      console.error("TN_DISPATCH_FAIL", orderTNId, fo.id, patchResp.status, JSON.stringify(data));
      return res.status(patchResp.status).json({ error: "TN error al despachar", status: patchResp.status, detail: data });
    }

    console.log("TN_DISPATCH_OK", orderTNId, fo.id);
    return res.status(200).json({ ok: true, orderTNId, foId: fo.id });

  } catch (e) {
    console.error("TN_DISPATCH_ERROR", orderTNId, e.message);
    return res.status(500).json({ error: e.message });
  }
}
