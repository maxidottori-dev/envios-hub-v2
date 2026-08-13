import { initDb } from "./_firebase.js";

export default async function handler(req, res) {
  const db = initDb();
  const idsAChequear = ["36136-R", "36136-R2", "43566535-R", "43566535-R2"];
  const resultados = [];
  for (const id of idsAChequear) {
    const snap = await db.collection("envios").doc(id).get();
    resultados.push({ id, exists: snap.exists, data: snap.exists ? snap.data() : null });
  }
  return res.status(200).json({ ok: true, resultados });
}
