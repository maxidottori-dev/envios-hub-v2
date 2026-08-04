// Endpoint de diagnóstico temporal — verificar token TN y scopes
// Llamar: GET /api/test-tn?orderId=XXXX  (orderId = cualquier nro de orden TN reciente)
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

  // 2. GET store info (verifica que el token funciona)
  try {
    const r = await fetch(`https://api.tiendanube.com/v1/${TN_STOREID}/store`, { headers: HEADERS });
    const d = await r.json().catch(()=>({}));
    results.storeInfo = { status: r.status, ok: r.ok, name: d.name||d.description||null, error: r.ok?null:d };
  } catch(e) {
    results.storeInfo = { error: e.message };
  }

  // 3. GET recent orders (verifica read_orders)
  try {
    const r = await fetch(`https://api.tiendanube.com/v1/${TN_STOREID}/orders?per_page=1`, { headers: HEADERS });
    const d = await r.json().catch(()=>({}));
    const firstOrder = Array.isArray(d) ? d[0] : null;
    results.ordersRead = {
      status: r.status, ok: r.ok,
      sampleOrderId: firstOrder?.id || null,
      sampleOrderNumber: firstOrder?.number || null,
      error: r.ok ? null : d,
    };
  } catch(e) {
    results.ordersRead = { error: e.message };
  }

  // 4. GET fulfillment-orders (verifica read_fulfillment_orders)
  if (orderId) {
    try {
      const r = await fetch(`https://api.tiendanube.com/v1/${TN_STOREID}/orders/${orderId}/fulfillment-orders`, { headers: HEADERS });
      const d = await r.json().catch(()=>({}));
      results.fulfillmentOrdersRead = {
        status: r.status, ok: r.ok,
        count: Array.isArray(d) ? d.length : null,
        firstFOId: Array.isArray(d) && d[0] ? d[0].id : null,
        firstFOStatus: Array.isArray(d) && d[0] ? d[0].status : null,
        error: r.ok ? null : d,
      };
    } catch(e) {
      results.fulfillmentOrdersRead = { error: e.message };
    }
  } else {
    results.fulfillmentOrdersRead = "Pasá ?orderId=XXXX para testear";
  }

  return res.status(200).json(results);
}
