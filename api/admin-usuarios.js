import { FieldValue } from "firebase-admin/firestore";
import { initDb } from "./_firebase.js";
import { exigirAuth, hashPassword } from "./_auth.js";

// Solo admin. Body: { accion: "set-password", id, password } | { accion: "migrar" }
//  - set-password: define/cambia la contraseña de un usuario (hash en la colección privada "credenciales").
//  - migrar: mueve a "credenciales" (hasheadas) todas las contraseñas que sigan en el doc del usuario.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const t = await exigirAuth(req, res, ["admin"]);
  if (!t) return;
  const { accion, id, password } = req.body || {};
  try {
    const db = initDb();
    const limpiar = { password: FieldValue.delete(), passwordHash: FieldValue.delete() };
    if (accion === "set-password") {
      if (!id || !password || String(password).length < 6) return res.status(400).json({ error: "Datos inválidos (mínimo 6 caracteres)" });
      await db.collection("credenciales").doc(String(id)).set({ passwordHash: hashPassword(password), intentosFallidos: 0, bloqueadoHasta: FieldValue.delete() }, { merge: true });
      await db.collection("usuarios").doc(String(id)).set(limpiar, { merge: true });
      return res.status(200).json({ ok: true });
    }
    if (accion === "migrar") {
      const snap = await db.collection("usuarios").get();
      let migrados = 0;
      for (const d of snap.docs) {
        const data = d.data();
        if (!data.password && !data.passwordHash) continue;
        const hash = data.passwordHash || hashPassword(data.password);
        await db.collection("credenciales").doc(d.id).set({ passwordHash: hash }, { merge: true });
        await d.ref.update(limpiar);
        migrados++;
      }
      return res.status(200).json({ ok: true, migrados, total: snap.size });
    }
    return res.status(400).json({ error: "Acción inválida" });
  } catch (e) {
    return res.status(500).json({ error: "Error de servidor" });
  }
}
