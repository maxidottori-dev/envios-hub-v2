// Endpoint de diagnóstico temporal — verificar token TN y scopes
// Llamar: GET /api/test-tn?orderId=XXXX  (orderId = ID numérico de orden TN, no el número visible)
const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
const TN_STOREID = process.env.TN_STORE_ID;

const HEADERS = {
  "Authentication": `bearer ${TN_TOKEN}`,
  "User-Agent":     "EnviosHub-test (maxidottori@gmail.com)",
  "Content-Type":   "application/json",
};

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end();

  const orderId = req.query.orderId;
  const results = {};

  // 1. Config básica
  results.config = {
    storeId: TN_STOREID || "NO CONFIGURADO",
    tokenPresent: !!TN_TOKEN,
    tokenPreview: TN_TOKEN ? TN_TOKEN.slice(0,8)+"..." : "MISSING",
  };

  // 2. GET store info
  try {
    const r = await fetch(`https://api.tiendanube.com/v1/${TN_STOREID}/store`, { headers: HEADERS });
    const d = await r.json().catch(()=>({}));
    results.storeInfo = { status: r.status, ok: r.ok, name: d.name||d.description||null };
  } catch(e) {
    results.storeInfo = { error: e.message };
  }

  // 3. GET recent orders (read_orders)
  try {
    const r = await fetch(`https://api.tiendanube.com/v1/${TN_STOREID}/orders?per_page=1`, { headers: HEADERS });
    const d = await r.json().catch(()=>({}));
    const first = Array.isArray(d) ? d[0] : null;
    results.ordersRead = {
      status: r.status, ok: r.ok,
      sampleOrderId: first?.id || null,
      sampleOrderNumber: first?.number || null,
      sampleShippingStatus: first?.shipping_status || null,
    };
  } catch(e) {
    results.ordersRead = { error: e.message };
  }

  if (orderId) {
    // 4. GET fulfillment-orders V2 (read_fulfillment_orders)
    try {
      const r = await fetch(`https://api.tiendanube.com/v1/${TN_STOREID}/orders/${orderId}/fulfillment-orders`, { headers: HEADERS });
      const d = await r.json().catch(()=>({}));
      results.fulfillmentOrdersV2 = {
        status: r.status, ok: r.ok,
        count: Array.isArray(d) ? d.length : null,
        firstStatus: Array.isArray(d) && d[0] ? d[0].status : null,
        error: r.ok ? null : d?.description || d?.message || null,
      };
    } catch(e) {
      results.fulfillmentOrdersV2 = { error: e.message };
    }

    // 5. GET order detail (para ver shipping_status actual y app_id del token)
    try {
      const r = await fetch(`https://api.tiendanube.com/v1/${TN_STOREID}/orders/${orderId}`, { headers: HEADERS });
      const d = await r.json().catch(()=>({}));
      results.orderDetail = {
        status: r.status, ok: r.ok,
        shipping_status: d.shipping_status || null,
        fulfillment_status: d.fulfillment_status || null,
        payment_status: d.payment_status || null,
        app_id: d.app_id || null,
      };
    } catch(e) {
      results.orderDetail = { error: e.message };
    }

    // 6. GET fulfillments V1 (verifica si el scope write_orders cubre esto)
    try {
      const r = await fetch(`https://api.tiendanube.com/v1/${TN_STOREID}/orders/${orderId}/fulfillments`, { headers: HEADERS });
      const d = await r.json().catch(()=>({}));
      results.fulfillmentsV1 = {
        status: r.status, ok: r.ok,
        count: Array.isArray(d) ? d.length : null,
        data: Array.isArray(d) ? d.slice(0,2) : d,
      };
    } catch(e) {
      results.fulfillmentsV1 = { error: e.message };
    }
  } else {
    results.note = "Pasá ?orderId=XXXX (ID numérico de la orden) para testear fulfillments";
  }

  return res.status(200).json(results);
}
