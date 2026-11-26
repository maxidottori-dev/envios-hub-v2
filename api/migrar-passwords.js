import { FieldValue } from "firebase-admin/firestore";
import { initDb } from "./_firebase.js";
import { exigirAuth, hashPassword } from "./_auth.js";

// Solo admin: convierte TODAS las contraseñas que sigan en texto plano a hash.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const t = await exigirAuth(req, res, ["admin"]);
  if (!t) return;
  try {
    const db = initDb();
    const snap = await db.collection("usuarios").get();
    let migrados = 0;
    for (const d of snap.docs) {
      const data = d.data();
      if (data.password && !data.passwordHash) {
        await d.ref.update({ passwordHash: hashPassword(data.password), password: FieldValue.delete() });
        migrados++;
      }
    }
    return res.status(200).json({ ok: true, migrados, total: snap.size });
  } catch (e) {
    return res.status(500).json({ error: "Error de servidor" });
  }
}
