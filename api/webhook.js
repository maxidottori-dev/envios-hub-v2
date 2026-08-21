import { initDb } from "./_firebase.js";
import { ordenAEnvio, ordenAOtroPedido, parsearDatepicker, getPagoEstadoInicial } from "./_tn.js";

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

  // TN manda el webhook con body reducido — buscar orden completa si faltan datos clave
  if (!order.shipping_option || !order.fulfillments) {
    try {
      const resp = await fetch(`https://api.tiendanube.com/v1/${TN_STOREID}/orders/${order.id}`, {
        headers: { "Authentication": `bearer ${TN_TOKEN}`, "User-Agent": "EnviosHub (maxidottori@gmail.com)" }
      });
      if (resp.ok) {
        order = await resp.json();
        console.log("WEBHOOK_FETCHED", JSON.stringify({ orderId: order.id, shipping: order.shipping_option || "", fulfillStatus: order.fulfillments?.[0]?.status || "" }));
      } else {
        console.log("WEBHOOK_FETCH_FAIL", resp.status);
      }
    } catch(e) {
      console.log("WEBHOOK_FETCH_ERROR", e.message);
    }
  }

  const metodo = (order.shipping_option || order.shipping?.name || "").toUpperCase();
  const esUMP  = metodo.includes("LOGISTICA UMP");

  let db;
  try { db = initDb(); } catch(e) { return res.status(500).json({ error: "Firebase init failed", detail: e.message }); }

  // ── LOGISTICA UMP → colección "envios" ────────────────────────────────────
  if (esUMP) {
    const docRef  = db.collection("envios").doc(String(order.id));
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

      if (data.trans) {
        console.log("WEBHOOK SKIP_SET - already assigned", order.id, "trans:", data.trans);
      }
      if (data.estado === "cancelado") return res.status(200).json({ ok: true, skipped: "cancelled" });

      if (order.status === "cancelled") {
        await docRef.update({ estado: "cancelado" });
        console.log("WEBHOOK CANCELLED", order.id);
        return res.status(200).json({ ok: true, action: "cancelled", id: String(order.id) });
      }

      const update = { notasOrden, notasCliente };

      if (datepickerRaw) {
        update.datepickerRaw = datepickerRaw;
        if (!data.fecha) update.fecha = fecha;
        if (!data.turno) update.turno = turno;
      }

      if (!data.trans) {
        const ship = order.shipping_address || {};
        const calleNum  = [ship.address, ship.number].filter(Boolean).join(" ");
        const pisoDepto = ship.floor ? "Piso/Dto " + ship.floor : "";
        const newDir    = [calleNum, pisoDepto].filter(Boolean).join(", ");
        const newCp     = String(ship.zipcode || order.billing_zipcode || "").replace(/\D/g, "");
        const newCiudad    = ship.city     || order.billing_city     || "";
        const newLocalidad = ship.locality || order.billing_locality || "";
        if (newDir) {
          update.direccion = newDir    || data.direccion;
          update.cp        = newCp     || data.cp;
          update.ciudad    = newCiudad    || data.ciudad;
          update.localidad = newLocalidad || data.localidad;
          console.log("WEBHOOK DIR_UPDATED", order.id, newDir);
        }
      }

      if (order.payment_status === "paid") {
        update.pagoEstado = "pagado";
      } else if (data.pagoEstado !== "cuenta_corriente") {
        update.pagoEstado = getPagoEstadoInicial(order);
      }

      if (order.payment_status === "paid" && !data.cobranzaRecibida) {
        update.cobranza = null;
        console.log("WEBHOOK COBRANZA_CLEARED", order.id, "payment_status=paid, cobranzaRecibida=false");
      }

      await docRef.update(update);
      console.log("WEBHOOK UPDATED", order.id);

      // Si el pedido era CC y TN lo marca como pagado, registrar en pagosCC
      if (order.payment_status === "paid" && (data.pagoEstado === "cuenta_corriente" || data.esCC === true)) {
        const monto = data.cobranza > 0 ? data.cobranza
          : data.importeCC > 0 ? data.importeCC
          : data.importeOrden || parseFloat(order.total) || 0;
        const clienteKey = (data.clienteNombre || "").toLowerCase().trim().replace(/\s+/g, "_") || null;
        if (monto > 0 && clienteKey) {
          const existing = await db.collection("pagosCC")
            .where("envioIds", "array-contains", String(order.id))
            .limit(1).get();
          if (existing.empty) {
            await db.collection("pagosCC").add({
              clienteKey,
              clienteNombre: data.clienteNombre || "",
              monto,
              nota: "Pago automático TN",
              envioIds: [String(order.id)],
              montosPorEnvio: { [String(order.id)]: monto },
              fechaCobro: new Date().toISOString().split("T")[0],
              creadoEn: new Date(),
              autoSync: true,
            });
            console.log("WEBHOOK CC_PAGO_REGISTRADO", order.id, monto, clienteKey);
          }
        }
      }

      return res.status(200).json({ ok: true, action: "updated", id: String(order.id) });
    }

    return res.status(200).json({ ok: true, skipped: "unhandled topic", topic: topicFinal });
  }

  // ── NO UMP → colección "otrosPedidos" ────────────────────────────────────
  const otroRef     = db.collection("otrosPedidos").doc(String(order.id));
  const otroExisting = await otroRef.get();
  const fulfillStatus = order.fulfillments?.[0]?.status || "";

  console.log("WEBHOOK OTRO", JSON.stringify({ orderId: order.id, metodo: metodo.slice(0, 60), fulfillStatus, topic: topicFinal }));
  console.log("WEBHOOK OTRO FULFILLMENTS", JSON.stringify(order.fulfillments || []));
  console.log("WEBHOOK OTRO ORDER_STATUS", JSON.stringify({ status: order.status, payment_status: order.payment_status, shipping_status: order.shipping_status || "" }));

  if (topicFinal === "order/created") {
    if (otroExisting.exists) return res.status(200).json({ ok: true, skipped: "otro already exists" });
    const otro = ordenAOtroPedido(order);
    await otroRef.set(otro);
    console.log("WEBHOOK OTRO CREATED", order.id, otro.tipoOtro);
    return res.status(200).json({ ok: true, action: "otro_created", tipoOtro: otro.tipoOtro });
  }

  if (topicFinal === "order/updated") {
    if (!otroExisting.exists) {
      // Llegó un updated antes que el created — crear el documento
      const otro = ordenAOtroPedido(order);
      // Si ya viene empaquetado, arrancar en en_expedicion
      const shippingStatusNew = order.shipping_status || "";
      const fulfillStatusNew = order.fulfillments?.[0]?.status || "";
      if (["shipped","fulfilled"].includes(fulfillStatusNew) || shippingStatusNew === "shipped") {
        otro.estado = "enviado";
        otro.enviadoTs = new Date().toISOString();
      } else if (["ready_for_pickup", "packed"].includes(fulfillStatusNew) || shippingStatusNew === "unshipped") {
        otro.estado = "en_expedicion";
      }
      await otroRef.set(otro);
      console.log("WEBHOOK OTRO CREATED_ON_UPDATE", order.id, otro.tipoOtro);
      return res.status(200).json({ ok: true, action: "otro_created_on_update", tipoOtro: otro.tipoOtro });
    }

    const otroData = otroExisting.data();

    // Convertido a UMP: redirigir actualización de pago al doc de envios (mismo ID)
    if (otroData.estado === "convertido_a_ump") {
      const envioRef = db.collection("envios").doc(String(order.id));
      const envioSnap = await envioRef.get();
      if (envioSnap.exists && order.payment_status === "paid") {
        const envioData = envioSnap.data();
        if (envioData.pagoEstado !== "pagado" && envioData.pagoEstado !== "cuenta_corriente") {
          await envioRef.update({ pagoEstado: "pagado" });
          console.log("WEBHOOK OTRO→UMP PAGO ACTUALIZADO", order.id);
          return res.status(200).json({ ok: true, action: "ump_pago_actualizado" });
        }
      }
      return res.status(200).json({ ok: true, skipped: "convertido_a_ump", envioExists: envioSnap.exists });
    }

    // Estados terminales: no tocar
    if (["cancelado", "archivado", "despachado"].includes(otroData.estado)) {
      return res.status(200).json({ ok: true, skipped: "otro terminal state", estado: otroData.estado });
    }

    // TN cancela
    if (order.status === "cancelled") {
      await otroRef.update({ estado: "cancelado" });
      console.log("WEBHOOK OTRO CANCELLED", order.id);
      return res.status(200).json({ ok: true, action: "otro_cancelled" });
    }

    // TN archiva → archivado
    if (order.status === "closed") {
      await otroRef.update({ estado: "archivado", archivadoTs: new Date().toISOString() });
      console.log("WEBHOOK OTRO CLOSED→ARCHIVADO", order.id);
      return res.status(200).json({ ok: true, action: "otro_archivado" });
    }

    const update = { notasOrden: order.owner_note || "", notasCliente: order.note || "" };

    const shippingStatus = order.shipping_status || "";

    // Enviado por TN (Nube Envíos despacha) → enviado
    // fulfillment status "shipped" o "fulfilled", o shipping_status "shipped"
    const esEnviado = ["shipped", "fulfilled"].includes(fulfillStatus)
      || shippingStatus === "shipped";
    if (esEnviado && ["pendiente","en_expedicion","por_preparar","preparado"].includes(otroData.estado)) {
      update.estado = "enviado";
      update.enviadoTs = new Date().toISOString();
      console.log("WEBHOOK OTRO ENVIADO", order.id, { fulfillStatus, shippingStatus });
    }

    // Empaquetado en TN → en_expedicion (solo si todavía está pendiente)
    // retiro_deposito: fulfillments[0].status = "ready_for_pickup"
    // courier (Envio Nube): fulfillments son IDs (strings), no objetos
    //   → usar shipping_status: "unshipped" = empaquetado, "unpacked" = no empaquetado
    const esEmpaquetado = !esEnviado && (
      ["ready_for_pickup", "packed"].includes(fulfillStatus)
      || shippingStatus === "unshipped"
    );
    if (esEmpaquetado && otroData.estado === "pendiente") {
      update.estado = "en_expedicion";
      console.log("WEBHOOK OTRO EN_EXPEDICION", order.id, { fulfillStatus, shippingStatus });
    }
    // Si desmarcan empaquetado en TN → volver a pendiente
    if (shippingStatus === "unpacked" && ["en_expedicion","por_preparar"].includes(otroData.estado)) {
      update.estado = "pendiente";
      console.log("WEBHOOK OTRO VUELVE_PENDIENTE", order.id, shippingStatus);
    }

    // Pago actualizado desde TN
    if (order.payment_status === "paid") {
      update.pagoEstado = "pagado";
    } else if (otroData.pagoEstado !== "cuenta_corriente") {
      update.pagoEstado = getPagoEstadoInicial(order);
    }

    await otroRef.update(update);
    console.log("WEBHOOK OTRO UPDATED", order.id);
    return res.status(200).json({ ok: true, action: "otro_updated" });
  }

  return res.status(200).json({ ok: true, skipped: "unhandled topic", topic: topicFinal });
}
