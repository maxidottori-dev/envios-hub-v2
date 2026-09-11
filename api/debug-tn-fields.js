// DEBUG TEMPORAL — ver qué campos devuelve la TN API para un pedido
// Usar: POST /api/debug-tn-fields  body: { "orderId": "2067925861" }
const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
const TN_STOREID = process.env.TN_STORE_ID;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { orderId } = req.body || {};
  if (!orderId) return res.status(400).json({ error: "orderId required" });

  const resp = await fetch(
    `https://api.tiendanube.com/v1/${TN_STOREID}/orders/${orderId}`,
    { headers: { "Authentication": `bearer ${TN_TOKEN}`, "User-Agent": "EnviosHub (maxidottori@gmail.com)" } }
  );
  if (!resp.ok) return res.status(500).json({ error: "TN error", status: resp.status });
  const order = await resp.json();

  // Retornar solo los campos relevantes de nota
  return res.status(200).json({
    id: order.id,
    number: order.number,
    note: order.note,
    customer_note: order.customer_note,
    owner_note: order.owner_note,
    // Listar todas las keys para ver si hay alguna inesperada
    all_keys: Object.keys(order),
  });
}
