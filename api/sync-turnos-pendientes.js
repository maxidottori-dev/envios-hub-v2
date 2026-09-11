import { initDb } from "./_firebase.js";
import { parsearDatepicker } from "./_tn.js";

const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
const TN_STOREID = process.env.TN_STORE_ID;

// Sincroniza el turno (AM/PM) de envíos TN sin turno.
// Los pedidos en Firestore tienen notasCliente = order.note (nota del cliente del checkout),
// que es donde Smile Datepicker escribe. Primero intenta parsear desde Firestore;
// si notasCliente también está vacío, va a buscar a TN.
// Se llama automáticamente desde el frontend al cargar la app.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let db;
  try { db = initDb(); } catch(e) { return res.status(500).json({ error: "Firebase init failed", detail: e.message }); }

  // Buscar envíos TN sin asignar con turno vacío
  let snap;
  try {
    snap = await db.collection("envios")
      .where("origen", "==", "Tienda Nube")
      .where("estado", "==", "sin_asignar")
      .get();
  } catch(e) {
    return res.status(500).json({ error: "Firestore query failed", detail: e.message });
  }

  // Filtrar en memoria: sin turno
  const candidatos = snap.docs
    .map(d => ({ docId: d.id, ...d.data() }))
    .filter(e => !e.turno);

  if (candidatos.length === 0) return res.status(200).json({ ok: true, actualizados: 0, revisados: 0 });

  let actualizados = 0;
  const ts = new Date().toISOString();

  await Promise.all(candidatos.map(async (e) => {
    try {
      // Primero intentar parsear desde Firestore.
      // e.datepickerRaw contiene el texto raw del datepicker si ya fue guardado.
      // e.notasCliente contiene la nota manual del cliente (no el datepicker).
      let { fecha, turno, datepickerRaw } = parsearDatepicker(e.datepickerRaw || "");

      // Si no hay turno en Firestore, ir a buscar a TN
      if (!turno) {
        const tnId = e.nroOrdenTN || e.id;
        if (!tnId || isNaN(Number(tnId))) return;
        const resp = await fetch(
          `https://api.tiendanube.com/v1/${TN_STOREID}/orders/${tnId}`,
          { headers: { "Authentication": `bearer ${TN_TOKEN}`, "User-Agent": "EnviosHub (maxidottori@gmail.com)" } }
        );
        if (!resp.ok) return;
        const order = await resp.json();
        // Smile Datepicker escribe en order.customer_note; fallback a order.note
        ({ fecha, turno, datepickerRaw } = parsearDatepicker(order.customer_note || order.note || ""));
        if (!turno) return; // genuinamente sin turno todavía
      }

      const update = { turno, turnoSyncTs: ts };
      // Si también faltaba fecha, actualizarla
      if (!e.fecha && fecha) update.fecha = fecha;
      if (datepickerRaw && !e.datepickerRaw) update.datepickerRaw = datepickerRaw;

      await db.collection("envios").doc(e.docId).update(update);
      console.log(`SYNC_TURNOS turno=${turno} fecha=${fecha||e.fecha}`, e.id);
      actualizados++;
    } catch(err) {
      console.warn("SYNC_TURNOS error", e.id, err.message);
    }
  }));

  return res.status(200).json({ ok: true, revisados: candidatos.length, actualizados });
}
