import { initDb } from "./_firebase.js";
import { ordenAEnvio, parsearDatepicker } from "./_tn.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const topic = req.headers["x-linkedstore-topic"] || req.headers["x-tiendanube-topic"] || "";
  if (!topic.startsWith("order/")) return res.status(200).json({ ok: true, skipped: "not an order event" });

  const order = req.body;
  if (!order || !order.id) return res.status(200).json({ ok: true, skipped: "no order data" });

  const metodo = (order.shipping_option || order.shipping?.name || "").toUpperCase();
  if (!metodo.includes("LOGISTICA UMP")) return res.status(200).json({ ok: true, skipped: "not LOGISTICA UMP" });

  let db;
  try { db = initDb(); } catch(e) { return res.status(500).json({ error: "Firebase init failed", detail: e.message }); }

  const docRef = db.collection("envios").doc(String(order.id));
  const existing = await docRef.get();

  // ORDER CREATED — guardar solo si no existe
  if (topic === "order/created") {
    if (existing.exists) return res.status(200).json({ ok: true, skipped: "already exists" });
    const envio = ordenAEnvio(order);
    await docRef.set(envio);
    return res.status(200).json({ ok: true, action: "created", id: envio.id });
  }

  // ORDER UPDATED — actualizar notas y datepicker si no fue asignado aun
  if (topic === "order/updated") {
    const notasOrden = order.owner_note || "";  // mis notas con datepicker
    const notasCliente = order.note || "";       // notas del cliente
    const { fecha, turno, datepickerRaw } = parsearDatepicker(notasOrden);

    if (!existing.exists) {
      // Si no existe aun, crearlo
      const envio = ordenAEnvio(order);
      await docRef.set(envio);
      return res.status(200).json({ ok: true, action: "created_on_update", id: envio.id });
    }

    const data = existing.data();
    const yaAsignado = !!data.trans;
    const yaCancelado = data.estado === "cancelado";

    if (yaCancelado) return res.status(200).json({ ok: true, skipped: "cancelled" });

    // Siempre actualizar notas de la orden y del cliente
    const update = { notasOrden, notasCliente };

    // Actualizar estado de pago si cambio (solo si no fue forzado a cuenta_corriente)
    if (order.payment_status && data.pagoEstado !== "cuenta_corriente") {
      update.pagoEstado = order.payment_status === "paid" ? "pagado" : "pendiente";
    }

    // Solo completar fecha/turno si el datepicker trae info y no estaban asignados
    if (datepickerRaw) {
      update.datepickerRaw = datepickerRaw;
      if (!data.fecha) update.fecha = fecha;
      if (!data.turno) update.turno = turno;
    }

    // Si no fue asignado, actualizar tambien notasCliente
    if (!yaAsignado) {
      update.notasCliente = order.customer_note || data.notasCliente || "";
    }

    await docRef.update(update);
    return res.status(200).json({ ok: true, action: "updated", id: String(order.id), update });
  }

  return res.status(200).json({ ok: true, skipped: "unhandled topic", topic });
}
