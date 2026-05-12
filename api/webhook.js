import { initDb } from "./_firebase.js";
import { ordenAEnvio, parsearDatepicker, getPagoEstadoInicial } from "./_tn.js";

const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
const TN_STOREID = process.env.TN_STORE_ID;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let order = req.body;
  if (!order || !order.id) return res.status(200).json({ ok: true, skipped: "no order data" });

  const topic = req.headers["x-linkedstore-topic"]
    || req.headers["x-tiendanube-topic"]
    || req.headers["x-topic"]
    || req.headers["topic"]
    || order?.event
    || "";

  const topicFinal = topic.startsWith("order/") ? topic : "order/created";
  if (!topic) console.log("WEBHOOK_NO_TOPIC - defaulting to order/created", order.id);

  console.log("WEBHOOK_IN", JSON.stringify({ topic: topicFinal, orderId: order.id, shipping: order.shipping_option || "" }));

  // TN manda el webhook con body reducido — buscar orden completa si shipping_option esta vacio
  if (!order.shipping_option) {
    try {
      const resp = await fetch(`https://api.tiendanube.com/v1/${TN_STOREID}/orders/${order.id}`, {
        headers: { "Authentication": `bearer ${TN_TOKEN}`, "User-Agent": "EnviosHub (maxidottori@gmail.com)" }
      });
      if (resp.ok) {
        order = await resp.json();
        console.log("WEBHOOK_FETCHED", JSON.stringify({ orderId: order.id, shipping: order.shipping_option || "" }));
      } else {
        console.log("WEBHOOK_FETCH_FAIL", resp.status);
      }
    } catch(e) {
      console.log("WEBHOOK_FETCH_ERROR", e.message);
    }
  }

  const metodo = (order.shipping_option || order.shipping?.name || "").toUpperCase();
  if (!metodo.includes("LOGISTICA UMP")) {
    console.log("WEBHOOK SKIP - not LOGISTICA UMP", metodo.slice(0, 80));
    return res.status(200).json({ ok: true, skipped: "not LOGISTICA UMP", metodo });
  }

  let db;
  try { db = initDb(); } catch(e) { return res.status(500).json({ error: "Firebase init failed", detail: e.message }); }

  const docRef = db.collection("envios").doc(String(order.id));
  const existing = await docRef.get();

  if (topicFinal === "order/created") {
    if (existing.exists) return res.status(200).json({ ok: true, skipped: "already exists" });
    const envio = ordenAEnvio(order);
    await docRef.set(envio);
    console.log("WEBHOOK CREATED", order.id);
    return res.status(200).json({ ok: true, action: "created", id: envio.id });
  }

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

    // PROTECCION: si ya tiene trans asignado, nunca sobreescribir con set()
    // Esto evita que un webhook mal clasificado borre la asignacion
    if (data.trans) {
      console.log("WEBHOOK SKIP_SET - already assigned", order.id, "trans:", data.trans);
    }
    if (data.estado === "cancelado") return res.status(200).json({ ok: true, skipped: "cancelled" });

    // Si TN cancela la orden → marcar como cancelado en Firestore
    if (order.status === "cancelled") {
      await docRef.update({ estado: "cancelado" });
      console.log("WEBHOOK CANCELLED", order.id);
      return res.status(200).json({ ok: true, action: "cancelled", id: String(order.id) });
    }

    const update = { notasOrden, notasCliente };

    // Actualizar fecha/turno si viene del datepicker y no estaban asignados
    if (datepickerRaw) {
      update.datepickerRaw = datepickerRaw;
      if (!data.fecha) update.fecha = fecha;
      if (!data.turno) update.turno = turno;
    }

    // Actualizar dirección si el envío todavía no fue asignado a ninguna logística
    if (!data.trans) {
      const ship = order.shipping_address || {};
      const calleNum = [ship.address, ship.number].filter(Boolean).join(" ");
      const pisoDepto = ship.floor ? "Piso/Dto " + ship.floor : "";
      const newDir = [calleNum, pisoDepto].filter(Boolean).join(", ");
      const newCp = String(ship.zipcode || order.billing_zipcode || "").replace(/\D/g, "");
      const newCiudad = ship.city || order.billing_city || "";
      const newLocalidad = ship.locality || order.billing_locality || "";
      if (newDir) {
        update.direccion = newDir || data.direccion;
        update.cp = newCp || data.cp;
        update.ciudad = newCiudad || data.ciudad;
        update.localidad = newLocalidad || data.localidad;
        console.log("WEBHOOK DIR_UPDATED", order.id, newDir);
      }
    }

    // Actualizar pagoEstado
    // Si TN confirma el pago, actualizar siempre (incluso en pedidos CC)
    if (order.payment_status === "paid") {
      update.pagoEstado = "pagado";
    } else if (data.pagoEstado !== "cuenta_corriente") {
      update.pagoEstado = getPagoEstadoInicial(order);
    }

    // Si TN marca como pagado y la cobranza no fue recibida aún → limpiar cobranza
    if (order.payment_status === "paid" && !data.cobranzaRecibida) {
      update.cobranza = null;
      console.log("WEBHOOK COBRANZA_CLEARED", order.id, "payment_status=paid, cobranzaRecibida=false");
    }

    await docRef.update(update);
    console.log("WEBHOOK UPDATED", order.id);
    return res.status(200).json({ ok: true, action: "updated", id: String(order.id) });
  }

  return res.status(200).json({ ok: true, skipped: "unhandled topic", topic: topicFinal });
}
