// Helpers de autenticación para las Vercel Functions.
// - Hash de contraseñas con scrypt (nativo de Node, sin dependencias).
// - Verificación del ID token de Firebase (emitido por /api/login vía custom token).
import crypto from "node:crypto";
import { getAuth } from "firebase-admin/auth";
import { initDb } from "./_firebase.js";

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const h = crypto.scryptSync(String(pw), salt, 64).toString("hex");
  return `scrypt$${salt}$${h}`;
}

export function verifyHash(pw, stored) {
  const [alg, salt, h] = String(stored || "").split("$");
  if (alg !== "scrypt" || !salt || !h) return false;
  const calc = crypto.scryptSync(String(pw), salt, 64);
  const buf = Buffer.from(h, "hex");
  return buf.length === calc.length && crypto.timingSafeEqual(buf, calc);
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Devuelve el token decodificado (con claims rol, logistica, ...) o null.
export async function verificarToken(req) {
  const m = (req.headers.authorization || "").match(/^Bearer (.+)$/);
  if (!m) return null;
  try { initDb(); return await getAuth().verifyIdToken(m[1]); } catch { return null; }
}

// Exige sesión válida y (opcional) rol dentro de `roles`. Si falla, responde y devuelve null.
export async function exigirAuth(req, res, roles) {
  const t = await verificarToken(req);
  if (!t) { res.status(401).json({ error: "No autorizado" }); return null; }
  if (roles && !roles.includes(t.rol)) { res.status(403).json({ error: "Sin permiso" }); return null; }
  return t;
}

export const CAMPOS_PRIVADOS = ["password", "passwordHash", "intentosFallidos", "bloqueadoHasta"];
