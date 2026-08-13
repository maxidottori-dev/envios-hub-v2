import { initDb } from "./_firebase.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { envioData } = req.body || {};
  if (!envioData || !envioData.id) return res.status(400).json({ error: "envioData.id requerido" });

  const db = initDb();
  const ref = db.collection("envios").doc(String(envioData.id));

  // Verificar que no exista ya
  const existing = await ref.get();
  if (existing.exists) {
    return res.status(409).json({ error: "Ya existe un documento con ese ID", id: envioData.id });
  }

  await ref.set(envioData);
  console.log("CREAR_REENVIO OK", envioData.id);
  return res.status(200).json({ ok: true, id: envioData.id });
}
