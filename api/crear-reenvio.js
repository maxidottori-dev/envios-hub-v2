import { initDb } from "./_firebase.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { envioData } = req.body || {};
  if (!envioData || !envioData.id) return res.status(400).json({ error: "envioData.id requerido" });

  try {
    const db = initDb();
    const ref = db.collection("envios").doc(String(envioData.id));

    // Transacción atómica: chequeo de existencia + escritura en una sola operación
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      if (existing.exists) {
        throw Object.assign(new Error(`Ya existe un documento con ID: ${envioData.id}`), { code: "already_exists" });
      }
      tx.set(ref, envioData);
    });

    console.log("CREAR_REENVIO OK", envioData.id);
    return res.status(200).json({ ok: true, id: envioData.id });

  } catch (err) {
    console.error("CREAR_REENVIO ERROR", err.message);
    if (err.code === "already_exists") {
      return res.status(409).json({ error: err.message });
    }
    return res.status(500).json({ error: err.message });
  }
}
