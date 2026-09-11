import { initDb } from "./_firebase.js";
import { esEfectivo } from "./_tn.js";

// Recuperación única — repara pedidos efectivo TN con cobranza borrada por el bug anterior.
// Idempotente: si cobranzaRecibida===true ya no toca el documento.
// Se llama automáticamente desde la app al montar (fast no-op una vez que todo está sano).

const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
const TN_STOREID = process.env.TN_STORE_ID;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let db;
  try { db = initDb(); } catch(e) { return res.status(500).json({ error: "Firebase init failed", detail: e.message }); }

  // Traer pedidos TN de los últimos 90 días y filtrar efectivo
  const desde = new Date(Date.now() - 90*24*60*60*1000).toISOString();
  const tnOrders = [];
  for (let page = 1; page <= 10; page++) {
    let resp;
    try {
      resp = await fetch(
        `https://api.tiendanube.com/v1/${TN_STOREID}/orders?since_created_at=${desde}&per_page=200&page=${page}`,
        { headers: { "Authentication": `bearer ${TN_TOKEN}`, "User-Agent": "EnviosHub (maxidottori@gmail.com)" } }
      );
    } catch(e) { break; }
    if (!resp.ok) break;
    const batch = await resp.json();
    if (!batch?.length) break;
    tnOrders.push(...batch.filter(esEfectivo));
    if (batch.length < 200) break;
  }

  if (!tnOrders.length) return res.status(200).json({ ok: true, efectivoEncontrados: 0, restaurados: 0, marcadosCobrados: 0 });

  const hoy = new Date().toISOString().split("T")[0];
  let restaurados = 0;
  let marcadosCobrados = 0;

  await Promise.all(tnOrders.map(async (order) => {
    try {
      const docRef = db.collection("envios").doc(String(order.id));
      const snap = await docRef.get();
      if (!snap.exists) return;

      const data = snap.data();
      if (data.cobranzaRecibida === true) return; // ya correcto

      const update = {};

      if (order.payment_status === "paid") {
        // TN confirma que el efectivo fue recibido
        update.cobranzaRecibida = true;
        update.cobranzaFecha = hoy;
        if (!data.cobranza) update.cobranza = parseFloat(order.total) || 0;
        marcadosCobrados++;
      } else if (!data.cobranza) {
        // Cobro pendiente pero el importe fue borrado — restaurar
        update.cobranza = parseFloat(order.total) || 0;
        restaurados++;
      }

      if (Object.keys(update).length > 0) {
        await docRef.update(update);
        console.log("RECOVER_COBRANZA", order.id, update);
      }
    } catch(e) {
      console.warn("RECOVER_COBRANZA error", order.id, e.message);
    }
  }));

  return res.status(200).json({ ok: true, efectivoEncontrados: tnOrders.length, restaurados, marcadosCobrados });
}
