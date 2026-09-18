// TEMPORAL — Marca como despachados todos los envios asignados de dias anteriores a HOY
// GET  → dry-run: devuelve listado y conteo sin modificar nada
// POST → ejecuta la actualización en Firestore
import { initDb } from "./_firebase.js";

const hoy = () => new Date().toISOString().split("T")[0];

export default async function handler(req, res) {
  if (!["GET","POST"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });

  let db;
  try { db = initDb(); } catch(e) { return res.status(500).json({ error: e.message }); }

  const HOY = hoy();

  // Traer todos los envios: algunos no tienen el campo "despachado" (campo ausente != false ni null)
  // por lo que no se pueden filtrar con where() — se filtra en JS
  const snap = await db.collection("envios").get();

  // hasta: fecha límite inclusive (default: ayer). Ej: ?hasta=2026-09-10
  const hasta = req.query.hasta || "";
  const limite = hasta || new Date(Date.now() - 86400000).toISOString().split("T")[0];

  const candidatos = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(e => {
      const f = e.fecha || e.fechaVenta || "";
      return f <= limite && e.trans && e.estado !== "cancelado" && !e.despachado;
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
