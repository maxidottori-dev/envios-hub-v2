import { initDb } from "./_firebase.js";

// Endpoint temporal — eliminar después de usar
export default async function handler(req, res) {
  const db = initDb();

  // IDs a eliminar: los reenvíos mal generados con el ID interno de Firestore
  const idsAEliminar = ["43566535-R", "43566535-R2"];

  const resultados = [];
  for (const id of idsAEliminar) {
    const ref = db.collection("envios").doc(id);
    const snap = await ref.get();
    if (snap.exists) {
      await ref.delete();
      resultados.push({ id, action: "deleted" });
    } else {
      resultados.push({ id, action: "not_found" });
    }
  }

  return res.status(200).json({ ok: true, resultados });
}
