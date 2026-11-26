import { FieldValue } from "firebase-admin/firestore";
import { initDb } from "./_firebase.js";
import { exigirAuth, hashPassword } from "./_auth.js";

// Solo admin. Body: { accion: "set-password", id, password } | { accion: "migrar" }
//  - set-password: define/cambia la contraseña de un usuario (se guarda hasheada).
//  - migrar: convierte TODAS las contraseñas que sigan en texto plano a hash.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const t = await exigirAuth(req, res, ["admin"]);
  if (!t) return;
  const { accion, id, password } = req.body || {};
  try {
    const db = initDb();
    if (accion === "set-password") {
      if (!id || !password || String(password).length < 6) return res.status(400).json({ error: "Datos inválidos (mínimo 6 caracteres)" });
      await db.collection("usuarios").doc(String(id)).set({ passwordHash: hashPassword(password), password: FieldValue.delete() }, { merge: true });
      return res.status(200).json({ ok: true });
    }
    if (accion === "migrar") {
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
    }
    return res.status(400).json({ error: "Acción inválida" });
  } catch (e) {
    return res.status(500).json({ error: "Error de servidor" });
  }
}
