import { initDb } from "./_firebase.js";
import { getPagoEstadoInicial, esEfectivo } from "./_tn.js";

const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
const TN_STOREID = process.env.TN_STORE_ID;

// Sincroniza el estado de pago de envíos TN que pueden estar desactualizados.
// Cubre dos casos:
//   1. Pago online pendiente que TN ya confirmó como pagado.
//   2. Efectivo cobrado en TN (payment_status=paid) pero sin cobranzaRecibida en Firestore.
// Se llama automáticamente desde el frontend al cargar la app.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let db;
  try { db = initDb(); } catch(e) { return res.status(500).json({ error: "Firebase init failed", detail: e.message }); }

  // Caso 1: pagos online pendientes
  let snapPendientes;
  try {
    snapPendientes = await db.collection("envios")
      .where("pagoEstado", "==", "pendiente")
      .where("origen", "==", "Tienda Nube")
      .get();
  } catch(e) {
    return res.status(500).json({ error: "Firestore query failed", detail: e.message });
  }

  // Caso 2: efectivo con cobranza pendiente.
  // NO usamos cobranzaRecibida===false porque el campo puede no existir (undefined).
  // En cambio buscamos cobranza > 0, que identifica pedidos efectivo con cobro pendiente.
  let snapEfectivo;
  try {
    snapEfectivo = await db.collection("envios")
      .where("origen", "==", "Tienda Nube")
      .where("cobranza", ">", 0)
      .get();
  } catch(e) {
    snapEfectivo = { docs: [] };
  }

  // Combinar sin duplicados
  const vistos = new Set();
  const todos = [];
  for (const d of [...snapPendientes.docs, ...snapEfectivo.docs]) {
    if (!vistos.has(d.id)) { vistos.add(d.id); todos.push(d); }
  }

  if (todos.length === 0) return res.status(200).json({ ok: true, actualizados: 0, revisados: 0 });

  let actualizados = 0;
  const hoy = new Date().toISOString().split("T")[0];
  const ts  = new Date().toISOString();

  await Promise.all(todos.map(async (docSnap) => {
    const e = { docId: docSnap.id, ...docSnap.data() };
    const tnId = e.nroOrdenTN || e.id;
    if (!tnId || isNaN(Number(tnId))) return;
    try {
      const resp = await fetch(
        `https://api.tiendanube.com/v1/${TN_STOREID}/orders/${tnId}`,
        { headers: { "Authentication": `bearer ${TN_TOKEN}`, "User-Agent": "EnviosHub (maxidottori@gmail.com)" } }
      );
      if (!resp.ok) return;
      const order = await resp.json();

      const update = { pagoSyncTs: ts };
      let cambio = false;

      if (esEfectivo(order)) {
        // Efectivo: marcar cobrado si TN confirma payment_status=paid
        if (order.payment_status === "paid" && !e.cobranzaRecibida) {
          update.cobranzaRecibida = true;
          update.cobranzaFecha = hoy;
          // Restaurar importe si fue borrado por el bug anterior
          if (!e.cobranza) update.cobranza = parseFloat(order.total) || 0;
          cambio = true;
          console.log("SYNC_EFECTIVO_COBRADO", tnId);
        } else if (!e.cobranza && !e.cobranzaRecibida) {
          // Restaurar importe borrado sin que esté cobrado aún
          update.cobranza = parseFloat(order.total) || 0;
          cambio = true;
          console.log("SYNC_COBRANZA_RESTORED", tnId, update.cobranza);
        }
      } else {
        // Pago online: actualizar pagoEstado si cambió
        const nuevoEstado = getPagoEstadoInicial(order);
        if (nuevoEstado !== "pendiente" && e.pagoEstado === "pendiente") {
          update.pagoEstado = nuevoEstado;
          if (!e.cobranzaRecibida) update.cobranza = null;
          cambio = true;
          console.log("SYNC_PAGOS PAGADO", tnId);
        }
      }

      if (cambio) {
        await db.collection("envios").doc(e.docId).update(update);
        actualizados++;
      }
    } catch(err) {
      console.warn("SYNC_PAGOS error", tnId, err.message);
    }
  }));

  return res.status(200).json({ ok: true, revisados: todos.length, actualizados });
}
