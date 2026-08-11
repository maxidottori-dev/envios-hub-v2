// ENDPOINT TEMPORAL — borrar después
// Actualiza pagoEstado en envios para órdenes convertidas de otrosPedidos a UMP
import { initDb } from "./_firebase.js";

const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
const TN_STOREID = process.env.TN_STORE_ID;

export default async function handler(req, res) {
  const nroOrden = req.query.nro; // ej: 35995
  if (!nroOrden) return res.status(400).json({ error: "Falta ?nro=XXXXX" });

  let db;
  try { db = initDb(); } catch(e) { return res.status(500).json({ error: e.message }); }

  // Buscar en otrosPedidos por nroOrdenTN para obtener el id TN real
  const otroSnap = await db.collection("otrosPedidos")
    .where("nroOrdenTN", "==", nroOrden)
    .limit(1)
    .get();

  if (otroSnap.empty) return res.status(404).json({ error: "No encontrado en otrosPedidos" });

  const otroDoc = otroSnap.docs[0];
  const otroData = otroDoc.data();
  const tnId = otroData.idTN || otroDoc.id;

  // Traer estado actual de TN
  const tnRes = await fetch(`https://api.tiendanube.com/v1/${TN_STOREID}/orders/${tnId}`, {
    headers: { "Authentication": `bearer ${TN_TOKEN}`, "User-Agent": "EnviosHub (maxidottori@gmail.com)" }
  });
  if (!tnRes.ok) return res.status(502).json({ error: "TN API error", status: tnRes.status });
  const order = await tnRes.json();

  // Buscar el envio correspondiente
  const envioRef = db.collection("envios").doc(String(tnId));
  const envioSnap = await envioRef.get();

  if (!envioSnap.exists) return res.status(404).json({ error: "No encontrado en envios", tnId });

  const envioData = envioSnap.data();
  const update = {};

  if (order.payment_status === "paid") {
    update.pagoEstado = "pagado";
  }

  if (Object.keys(update).length === 0) {
    return res.status(200).json({ ok: true, mensaje: "Sin cambios necesarios", tnPaymentStatus: order.payment_status, envioData: { pagoEstado: envioData.pagoEstado } });
  }

  await envioRef.update(update);
  return res.status(200).json({ ok: true, actualizado: update, tnPaymentStatus: order.payment_status, nroOrden, tnId });
}
