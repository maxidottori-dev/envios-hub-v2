// Marca un pedido de Tienda Nube como enviado (fulfill) al cierre de sesión de Salida.
// Llamado desde TabSalida > generarYCerrar() — best effort, no bloquea el cierre.
//
// Body: { orderTNId, nroSeguimiento? }
//   orderTNId     — ID numérico o string del pedido en TN (e.idTN || e.id)
//   nroSeguimiento — opcional: número de seguimiento para adjuntar al fulfill
//
// Flujo:
//   1. Obtiene el pedido de TN para verificar estado y obtener fulfillmentId
//   2. Si ya está cerrado/enviado → responde ok (idempotente)
//   3. Si tiene fulfillments pendientes → actualiza el primero a "shipped"
//   4. Si no tiene fulfillments → llama POST .../fulfill para crearlo
//
// La TN API usa Authentication: bearer <token> (no Authorization: Bearer)

const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
const TN_STOREID = process.env.TN_STORE_ID;

const HEADERS = {
  "Authentication": `bearer ${TN_TOKEN}`,
  "User-Agent":    "EnviosHub (maxidottori@gmail.com)",
  "Content-Type":  "application/json",
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { orderTNId, nroSeguimiento } = req.body || {};
  if (!orderTNId) return res.status(400).json({ error: "orderTNId requerido" });

  const orderId = String(orderTNId).replace(/\D/g, "");
  if (!orderId) return res.status(400).json({ error: "orderTNId inválido" });

  try {
    // 1. Obtener el pedido actual de TN
    const orderResp = await fetch(
      `https://api.tiendanube.com/v1/${TN_STOREID}/orders/${orderId}`,
      { headers: HEADERS }
    );
    if (!orderResp.ok) {
      const errBody = await orderResp.text().catch(() => "");
      return res.status(500).json({
        error: "TN order fetch failed",
        status: orderResp.status,
        detail: errBody.slice(0, 300),
      });
    }
    const order = await orderResp.json();

    // 2. Si ya está cerrado o enviado → idempotente, nada que hacer
    if (order.status === "closed" || order.shipping_status === "shipped") {
      console.log(`MARCAR_ENVIADO TN #${orderId}: ya cerrado/enviado (status=${order.status}, shipping_status=${order.shipping_status})`);
      return res.status(200).json({ ok: true, skipped: true, reason: "already_shipped" });
    }

    let result;

    // 3. Si tiene fulfillments, actualizar el primero a "shipped"
    const fulfillmentId = order.fulfillments?.[0]?.id;
    if (fulfillmentId) {
      const fulfillBody = { status: "shipped" };
      if (nroSeguimiento) fulfillBody.tracking_number = String(nroSeguimiento);

      const fulfillResp = await fetch(
        `https://api.tiendanube.com/v1/${TN_STOREID}/orders/${orderId}/fulfillments/${fulfillmentId}`,
        { method: "PUT", headers: HEADERS, body: JSON.stringify(fulfillBody) }
      );
      result = await fulfillResp.json().catch(() => ({}));
      console.log(`MARCAR_ENVIADO TN #${orderId}: PUT fulfillment/${fulfillmentId} → ${fulfillResp.status}`, result);
      if (!fulfillResp.ok) {
        // Fallback: intentar fulfill directo
        console.warn(`MARCAR_ENVIADO TN #${orderId}: PUT fulfillment falló (${fulfillResp.status}), intentando POST fulfill...`);
        const directResp = await fetch(
          `https://api.tiendanube.com/v1/${TN_STOREID}/orders/${orderId}/fulfill`,
          { method: "POST", headers: HEADERS, body: JSON.stringify(nroSeguimiento ? { shipping_tracking_number: String(nroSeguimiento) } : {}) }
        );
        result = await directResp.json().catch(() => ({}));
        console.log(`MARCAR_ENVIADO TN #${orderId}: POST fulfill → ${directResp.status}`, result);
        if (!directResp.ok) {
          return res.status(500).json({ error: "TN fulfill failed", status: directResp.status, detail: result });
        }
      }
    } else {
      // 4. Sin fulfillments: crear fulfill directo
      const fulfillBody = nroSeguimiento ? { shipping_tracking_number: String(nroSeguimiento) } : {};
      const fulfillResp = await fetch(
        `https://api.tiendanube.com/v1/${TN_STOREID}/orders/${orderId}/fulfill`,
        { method: "POST", headers: HEADERS, body: JSON.stringify(fulfillBody) }
      );
      result = await fulfillResp.json().catch(() => ({}));
      console.log(`MARCAR_ENVIADO TN #${orderId}: POST fulfill → ${fulfillResp.status}`, result);
      if (!fulfillResp.ok) {
        return res.status(500).json({ error: "TN fulfill failed", status: fulfillResp.status, detail: result });
      }
    }

    return res.status(200).json({ ok: true, orderId, result });

  } catch (err) {
    console.error("MARCAR_ENVIADO_TN error", orderId, err.message);
    return res.status(500).json({ error: "Unexpected error", detail: err.message });
  }
}
