// TEMPORAL — Marca como despachados todos los envios asignados de dias anteriores a HOY
// GET  → dry-run: devuelve listado y conteo sin modificar nada
// POST → ejecuta la actualización en Firestore
import { initDb } from "./_firebase.js";

const hoy = () => new Date().toISOString().split("T")[0];

export default async function handler(req, res) {
  if (!["GET","POST"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });

  let db;
  try { db = initDb(); } catch(e) { return res.status(500).json({ error: e.message }); }

  // Traer todos los envios asignados, no despachados y con fecha anterior a hoy
  const snap = await db.collection("envios")
    .where("despachado", "==", false)
    .get();

  const HOY = hoy();
  const candidatos = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(e => {
      const f = e.fecha || e.fechaVenta || "";
      return f < HOY && e.trans && e.estado !== "cancelado";
    });

  // Agrupar por logistica para el resumen
  const resumen = {};
  candidatos.forEach(e => {
    const l = e.trans || "Sin logística";
    if (!resumen[l]) resumen[l] = [];
    resumen[l].push({ id: e.id, nroOrdenTN: e.nroOrdenTN, clienteNombre: e.clienteNombre, fecha: e.fecha || e.fechaVenta || "" });
  });

  if (req.method === "GET") {
    return res.status(200).json({ total: candidatos.length, hoy: HOY, resumen });
  }

  // POST: actualizar
  const ts = new Date().toISOString();
  const batch = db.batch();
  candidatos.forEach(e => {
    const ref = db.collection("envios").doc(e.id);
    batch.update(ref, {
      despachado: true,
      despachoTs: ts,
      despachoLogistica: e.trans,
      despachoPor: "Maxi (bulk anterior)",
      despachado_forzado: true,
    });
  });
  await batch.commit();

  return res.status(200).json({ ok: true, actualizados: candidatos.length, hoy: HOY, resumen });
}
