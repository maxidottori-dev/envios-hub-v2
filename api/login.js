import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { initDb } from "./_firebase.js";
import { hashPassword, verifyHash, safeEqual, CAMPOS_PRIVADOS } from "./_auth.js";

const MAX_INTENTOS = 5;
const BLOQUEO_MIN = 10;

// Login del lado del servidor. Verifica la contraseña (hash scrypt; migra en el acto las
// contraseñas viejas en texto plano) y devuelve un custom token de Firebase Auth con el rol
// como claim, más la sesión SIN datos sensibles.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const usuario = String(req.body?.usuario || "").toLowerCase().trim();
  const password = String(req.body?.password || "");
  if (!usuario || !password) return res.status(400).json({ error: "Completá usuario y contraseña" });

  let db;
  try { db = initDb(); } catch (e) { return res.status(500).json({ error: "Error de servidor" }); }

  const fallo = async (ref, data) => {
    if (ref) {
      const n = (data?.intentosFallidos || 0) + 1;
      const upd = { intentosFallidos: n };
      if (n >= MAX_INTENTOS) { upd.bloqueadoHasta = new Date(Date.now() + BLOQUEO_MIN * 60000).toISOString(); upd.intentosFallidos = 0; }
      await ref.update(upd).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 500)); // frena fuerza bruta
    return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
  };

  try {
    const snap = await db.collection("usuarios").where("usuario", "==", usuario).where("activo", "==", true).limit(1).get();
    if (snap.empty) return fallo(null);
    const ref = snap.docs[0].ref;
    const data = snap.docs[0].data();

    if (data.bloqueadoHasta && new Date().toISOString() < data.bloqueadoHasta) {
      return res.status(429).json({ error: "Demasiados intentos. Probá de nuevo en unos minutos." });
    }

    let ok = false;
    if (data.passwordHash) {
      ok = verifyHash(password, data.passwordHash);
    } else if (data.password) {
      ok = safeEqual(data.password, password);
      if (ok) await ref.update({ passwordHash: hashPassword(password), password: FieldValue.delete() }); // migración
    }
    if (!ok) return fallo(ref, data);

    if (data.intentosFallidos || data.bloqueadoHasta) await ref.update({ intentosFallidos: 0, bloqueadoHasta: FieldValue.delete() }).catch(() => {});

    const sesion = { id: ref.id, ...data };
    CAMPOS_PRIVADOS.forEach(k => delete sesion[k]);

    const claims = { rol: data.rol || "" };
    if (data.logistica) claims.logistica = data.logistica;
    if (data.armadorId) claims.armadorId = data.armadorId;
    const token = await getAuth().createCustomToken(ref.id, claims);

    return res.status(200).json({ ok: true, sesion, token });
  } catch (e) {
    console.error("LOGIN_ERROR", e.message);
    return res.status(500).json({ error: "Error de servidor" });
  }
}
