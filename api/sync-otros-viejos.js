// ENDPOINT TEMPORAL — borra después de ejecutar
// Re-verifica en TN todos los otrosPedidos con estado "pendiente" más viejos que N días
// y los archiva/cancela según el estado real de TN
import { initDb } from "./_firebase.js";

const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
const TN_STOREID = process.env.TN_STORE_ID;
const DIAS_MIN   = 7; // solo tocar los que tienen más de N días

async function getTNOrder(orderId) {
  try {
    const res = await fetch(`https://api.tiendanube.com/v1/${TN_STOREID}/orders/${orderId}`, {
      headers: { "Authentication": `bearer ${TN_TOKEN}`, "User-Agent": "EnviosHub (maxidottori@gmail.com)" }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export default async function handler(req, res) {
  if (!["GET","POST"].includes(req.method)) return res.status(405).end();
  if (req.query.confirm !== "SI_SYNC") {
    return res.status(400).json({ error: "Falta ?confirm=SI_SYNC" });
  }

  let db;
  try { db = initDb(); } catch(e) { return res.status(500).json({ error: e.message }); }

  const hoy = new Date();
  hoy.setHours(0,0,0,0);

  const snap = await db.collection("otrosPedidos")
    .where("estado", "==", "pendiente")
    .get();

  // Filtrar los que superan el umbral de días
  const candidatos = snap.docs.filter(d => {
    const fv = d.data().fechaVenta;
    if (!fv) return false;
    const dias = Math.floor((hoy - new Date(fv + "T00:00:00")) / (1000*60*60*24));
    return dias >= DIAS_MIN;
  });

  if (candidatos.length === 0) {
    return res.status(200).json({ ok: true, procesados: 0, mensaje: "Sin candidatos" });
  }

  const resultados = [];
  const ahora = new Date().toISOString();

  for (const d of candidatos) {
    const data = d.data();
    // Usar idTN si existe, sino el doc id
    const tnId = data.idTN || d.id;
    const order = await getTNOrder(tnId);

    if (!order) {
      resultados.push({ id: d.id, nro: data.nroOrdenTN, accion: "skip_no_fetch" });
      continue;
    }

    let update = null;

    if (order.status === "cancelled") {
      update = { estado: "cancelado" };
    } else if (order.status === "closed") {
      update = { estado: "archivado", archivadoTs: ahora };
    } else {
      // Aún abierta en TN: actualizar estado según fulfillment/shipping
      const fulfillStatus = order.fulfillments?.[0]?.status || "";
      const shippingStatus = order.shipping_status || "";
      if (["shipped","fulfilled"].includes(fulfillStatus) || shippingStatus === "shipped") {
        update = { estado: "enviado", enviadoTs: ahora };
      } else if (["ready_for_pickup","packed"].includes(fulfillStatus) || shippingStatus === "unshipped") {
        update = { estado: "en_expedicion" };
      }
    }

    if (update) {
      await d.ref.update(update);
      resultados.push({ id: d.id, nro: data.nroOrdenTN, tnStatus: order.status, accion: Object.keys(update)[0] === "estado" ? update.estado : "archivado" });
    } else {
      resultados.push({ id: d.id, nro: data.nroOrdenTN, tnStatus: order.status, accion: "sin_cambio" });
    }

    // Pequeña pausa para no saturar TN API
    await new Promise(r => setTimeout(r, 150));
  }

  const resumen = resultados.reduce((acc, r) => {
    acc[r.accion] = (acc[r.accion] || 0) + 1;
    return acc;
  }, {});

  return res.status(200).json({ ok: true, total: candidatos.length, resumen, detalle: resultados });
}
