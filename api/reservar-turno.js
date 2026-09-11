import { initDb } from "./_firebase.js";

// Recibe la elección de fecha/turno del datepicker (Fase 3 — checkout NubeSDK).
// Guarda la reserva en Firestore (colección reservasTurno, keyed por session_id).
// No escribe a Tiendanube todavía — la correlación con el pedido real se resuelve en Fase 3.
//
// Body esperado: { session_id, email?, zona, fecha, turno }
// Respuesta:     { ok: true, session_id }

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { session_id, email, zona, fecha, turno } = req.body || {};

  if (!session_id) return res.status(400).json({ error: "Falta session_id" });
  if (!zona)       return res.status(400).json({ error: "Falta zona" });
  if (!fecha)      return res.status(400).json({ error: "Falta fecha" });
  if (!turno)      return res.status(400).json({ error: "Falta turno" });

  let db;
  try { db = initDb(); } catch(e) { return res.status(500).json({ error: "Firebase init failed", detail: e.message }); }

  const reserva = {
    session_id,
    email:    email || "",
    zona,
    fecha,
    turno,
    creadoTs: new Date().toISOString(),
    orderId:  null,   // se completa cuando el pedido se crea (Fase 3 — order:update)
    estado:   "pendiente",
  };

  try {
    await db.collection("reservasTurno").doc(session_id).set(reserva);
    console.log("RESERVA_TURNO_GUARDADA", session_id, zona, fecha, turno);
    return res.status(200).json({ ok: true, session_id });
  } catch(e) {
    return res.status(500).json({ error: "Firestore write failed", detail: e.message });
  }
}
