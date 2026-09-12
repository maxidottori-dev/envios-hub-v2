// TEMPORAL — listar envíos TN despachados para verificar cuáles marcar como enviados en TN
// GET /api/check-despachados-tn
import { initDb } from "./_firebase.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  let db;
  try { db = initDb(); } catch(e) { return res.status(500).json({ error: e.message }); }

  const snap = await db.collection("envios")
    .where("origen", "==", "Tienda Nube")
    .where("despachado", "==", true)
    .get();

  const envios = snap.docs.map(d => {
    const data = d.data();
    return {
      docId: d.id,
      nroOrdenTN: data.nroOrdenTN,
      idTN: data.idTN,
      despachoTs: data.despachoTs,
      despachoLogistica: data.despachoLogistica,
      clienteNombre: data.clienteNombre,
    };
  }).sort((a, b) => (b.despachoTs || "").localeCompare(a.despachoTs || ""));

  return res.status(200).json({ total: envios.length, envios });
}
