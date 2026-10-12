import { initDb } from "./_firebase.js";

// Recibe la elección de fecha/turno del datepicker (Fase 3 — checkout NubeSDK).
// Guarda la reserva en Firestore (colección reservasTurno, keyed por session_id).
//
// Body esperado: { session_id, email?, zona, fecha, turno }
// Respuesta:     { ok: true, session_id }
//
// NOTAS para Fase 3:
// - `fecha` y `turno` se escribirán al pedido TN vía escribirCamposTN() (ver _tn-custom-fields.js)
//   cuando el pedido se cree/actualice en webhook.js.
// - `zona` recibida del checkout se guarda para validación interna ÚNICAMENTE.
//   El valor definitivo de "Zona logística" que va al Custom Field de TN se deriva
//   del método de envío del pedido real: extraerZona(order.shipping_option) en _tn.js.
//   NO usar reserva.zona para escribir el CF_ZONA_LOGISTICA.

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
