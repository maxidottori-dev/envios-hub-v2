import { initDb } from "./_firebase.js";
import { ordenAEnvio, parsearDatepicker, getPagoEstadoInicial } from "./_tn.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Log todos los headers para diagnostico
  const allHeaders = Object.fromEntries(Object.entries(req.headers));
  const topic = req.headers["x-linkedstore-topic"] 
    || req.headers["x-tiendanube-topic"]
    || req.headers["x-topic"]
    || req.headers["topic"]
    || "";

  const order = req.body;
  const orderId = order?.id || "unknown";
  const metodo = (order?.shipping_option || order?.shipping?.name || "").toUpperCase();

  // Log de diagnostico — aparece en Vercel Logs
  console.log("WEBHOOK", {
    topic,
    orderId,
    metodo: metodo.slice(0, 60),
    headerKeys: Object.keys(allHeaders).filter(k => k.includes("topic") || k.includes("store") || k.includes("linked")),
  });

  // Si no hay topic en headers conocidos, intentar inferirlo del body
  const topicFinal = topic || (order?.event) || "";

  if (!topicFinal.startsWith("order/")) {
    console.log("WEBHOOK SKIP - no topic match", { topicFinal, topic });
    return res.status(200).json({ ok: true, skipped: "not an order event", topic: topicFinal });
  }

  if (!order || !order.id) return res.status(200).json({ ok: true, skipped: "no order data" });

  if (!metodo.includes("LOGISTICA UMP")) {
    console.log("WEBHOOK SKIP - not LOGISTICA UMP", { metodo: metodo.slice(0, 80) });
    return res.status(200).json({ ok: true, skipped: "not LOGISTICA UMP", metodo });
  }

  let db;
  try { db = initDb(); } catch(e) { return res.status(500).json({ error: "Firebase init failed", detail: e.message }); }

  const docRef = db.collection("envios").doc(String(order.id));
  const existing = await docRef.get();

  // ORDER CREATED — guardar solo si no existe
  if (topicFinal === "order/created") {
    if (existing.exists) return res.status(200).json({ ok: true, skipped: "already exists" });
    const envio = ordenAEnvio(order);
    await docRef.set(envio);
    console.log("WEBHOOK CREATED", order.id);
    return res.status(200).json({ ok: true, action: "created", id: envio.id });
  }

  // ORDER UPDATED
  if (topicFinal === "order/updated") {
    const notasOrden   = order.owner_note || "";
    const notasCliente = order.note || "";
    const { fecha, turno, datepickerRaw } = parsearDatepicker(notasOrden);

    if (!existing.exists) {
      const envio = ordenAEnvio(order);
      await docRef.set(envio);
      console.log("WEBHOOK CREATED_ON_UPDATE", order.id);
      return res.status(200).json({ ok: true, action: "created_on_update", id: envio.id });
    }

    const data = existing.data();
    if (data.estado === "cancelado") return res.status(200).json({ ok: true, skipped: "cancelled" });

    const update = { notasOrden, notasCliente };

    if (datepickerRaw) {
      update.datepickerRaw = datepickerRaw;
      if (!data.fecha) update.fecha = fecha;
      if (!data.turno) update.turno = turno;
    }

    if (!data.trans) {
      // Solo actualizar notasCliente si no fue asignado
    }

    if (data.pagoEstado !== "cuenta_corriente") {
      update.pagoEstado = getPagoEstadoInicial(order);
    }

    await docRef.update(update);
    console.log("WEBHOOK UPDATED", order.id, update);
    return res.status(200).json({ ok: true, action: "updated", id: String(order.id) });
  }

  return res.status(200).json({ ok: true, skipped: "unhandled topic", topic: topicFinal });
}
