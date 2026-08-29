/**
 * POST /api/admin-migrar-armadores
 * Migración de armadores:
 *   - JULIAN → JULIAN C (backfill armados + envios)
 *   - RODRIGO → activo: false
 *   - Agrega JULIAN S si no existe
 *
 * Query param: ?secret=ADMIN2024   (protección mínima)
 */

import { initDb } from "./_firebase.js";
import { FieldValue } from "firebase-admin/firestore";

const SECRET = process.env.ADMIN_SECRET || "ADMIN2024";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  if (req.query.secret !== SECRET) return res.status(401).json({ error: "unauthorized" });

  const db = initDb();
  const configRef = db.collection("config").doc("expedicion");
  const configSnap = await configRef.get();
  const config = configSnap.data() || {};
  let armadores = config.armadores || [];

  const log = [];

  // ── 1. Identificar Julian y Rodrigo ──────────────────────────────────────
  const julian = armadores.find(a => a.nombre === "JULIAN");
  const rodrigo = armadores.find(a => a.nombre === "RODRIGO");
  const yaExisteJulianS = armadores.some(a => a.nombre === "JULIAN S");
  const yaExisteJulianC = armadores.some(a => a.nombre === "JULIAN C");

  if (!julian) {
    log.push("⚠️ No se encontró armador JULIAN");
  }
  if (!rodrigo) {
    log.push("⚠️ No se encontró armador RODRIGO");
  }

  // ── 2. Mutar el array de armadores ───────────────────────────────────────
  armadores = armadores.map(a => {
    if (a.nombre === "JULIAN") {
      log.push(`✅ JULIAN (${a.id}) → JULIAN C`);
      return { ...a, nombre: "JULIAN C" };
    }
    if (a.nombre === "RODRIGO") {
      log.push(`✅ RODRIGO (${a.id}) → activo: false`);
      return { ...a, activo: false };
    }
    return a;
  });

  if (!yaExisteJulianS) {
    const newId = "arm_" + Date.now();
    armadores.push({
      id: newId,
      nombre: "JULIAN S",
      color: "#8B5CF6",
      puedeControlar: false,
      activo: true,
    });
    log.push(`✅ JULIAN S agregado con id ${newId}`);
  } else {
    log.push("ℹ️ JULIAN S ya existía, no se agregó");
  }

  // ── 3. Guardar config actualizada ────────────────────────────────────────
  await configRef.update({ armadores });
  log.push("✅ config/expedicion actualizada");

  // ── 4. Backfill si Julian existía ────────────────────────────────────────
  let backfillArmados = 0;
  let backfillEnvios = 0;

  if (julian) {
    const julianId = julian.id;

    // Backfill armados
    const armadosSnap = await db.collection("armados")
      .where("armadorId", "==", julianId)
      .get();

    const batchSize = 400;
    const armadosDocs = armadosSnap.docs;
    for (let i = 0; i < armadosDocs.length; i += batchSize) {
      const batch = db.batch();
      armadosDocs.slice(i, i + batchSize).forEach(d => {
        batch.update(d.ref, { armadorNombre: "JULIAN C" });
      });
      await batch.commit();
      backfillArmados += Math.min(batchSize, armadosDocs.length - i);
    }
    log.push(`✅ Backfill armados: ${backfillArmados} docs`);

    // Backfill envios
    const enviosSnap = await db.collection("envios")
      .where("armadorId", "==", julianId)
      .get();

    const enviosDocs = enviosSnap.docs;
    for (let i = 0; i < enviosDocs.length; i += batchSize) {
      const batch = db.batch();
      enviosDocs.slice(i, i + batchSize).forEach(d => {
        batch.update(d.ref, { armadorNombre: "JULIAN C" });
      });
      await batch.commit();
      backfillEnvios += Math.min(batchSize, enviosDocs.length - i);
    }
    log.push(`✅ Backfill envios: ${backfillEnvios} docs`);
  }

  return res.status(200).json({
    ok: true,
    log,
    stats: {
      backfillArmados,
      backfillEnvios,
      armadoresTotal: armadores.length,
    },
  });
}
