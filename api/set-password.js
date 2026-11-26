import { FieldValue } from "firebase-admin/firestore";
import { initDb } from "./_firebase.js";
import { exigirAuth, hashPassword } from "./_auth.js";

// Solo admin: define/cambia la contraseña de un usuario (se guarda hasheada).
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const t = await exigirAuth(req, res, ["admin"]);
  if (!t) return;
  const { id, password } = req.body || {};
  if (!id || !password || String(password).length < 6) return res.status(400).json({ error: "Datos inválidos (mínimo 6 caracteres)" });
  try {
    const db = initDb();
    await db.collection("usuarios").doc(String(id)).set({ passwordHash: hashPassword(password), password: FieldValue.delete() }, { merge: true });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "Error de servidor" });
  }
}
