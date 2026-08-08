// ENDPOINT TEMPORAL — borrar después de ejecutar
// Fuerza despachado:true en todos los envíos con fecha vencida sin despachar
import { initDb } from "./_firebase.js";

const HOY = new Date().toISOString().split("T")[0]; // "2026-08-08"

export default async function handler(req, res) {
  if (!["GET","POST"].includes(req.method)) return res.status(405).json({ error: "Use GET or POST" });
  if (req.query.confirm !== "SI_FORZAR_DESPACHO") {
    return res.status(400).json({ error: "Falta ?confirm=SI_FORZAR_DESPACHO" });
  }

  let db;
  try { db = initDb(); } catch(e) { return res.status(500).json({ error: e.message }); }

  // Traer todos los envíos y filtrar client-side
  // (despachado puede no existir en docs viejos; Firestore !=true no los devuelve)
  const snap = await db.collection("envios").get();

  const ahora = new Date().toISOString();
  const candidatos = snap.docs.filter(d => {
    const e = d.data();
    return (
      e.fecha &&
      e.fecha < HOY &&
      e.trans &&
      e.estado !== "cancelado"
    );
  });

  const sampleAll = snap.docs.slice(0, 3).map(d => ({ id: d.id, ...pick(d.data(), ["fecha","trans","despachado","estado"]) }));
  if (candidatos.length === 0) {
    return res.status(200).json({ ok: true, actualizados: 0, mensaje: "Sin candidatos", totalDocs: snap.size, hoy: HOY, sample: sampleAll });
  }

  // Batch de Firestore (máx 500 por batch)
  const batchSize = 400;
  let actualizados = 0;
  const preview = candidatos.slice(0, 5).map(d => ({ id: d.id, ...pick(d.data(), ["nroOrdenTN","clienteNombre","fecha","trans"]) }));

  for (let i = 0; i < candidatos.length; i += batchSize) {
    const chunk = candidatos.slice(i, i + batchSize);
    const batch = db.batch();
    for (const d of chunk) {
      batch.update(d.ref, {
        despachado: true,
        despachoTs: ahora,
        despachado_forzado: true,
      });
    }
    await batch.commit();
    actualizados += chunk.length;
  }

  return res.status(200).json({
    ok: true,
    actualizados,
    fecha_corte: HOY,
    preview,
  });
}

function pick(obj, keys) {
  return Object.fromEntries(keys.map(k => [k, obj[k]]));
}
