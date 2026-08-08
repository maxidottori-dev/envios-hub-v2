import { initDb } from "./_firebase.js";
import { ordenAOtroPedido } from "./_tn.js";

const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
const TN_STOREID = process.env.TN_STORE_ID;

export default async function handler(req, res) {
  const orderId = req.query.id;
  if (!orderId) return res.status(400).json({ error: "Missing ?id=" });

  // Fetch order from TN
  const resp = await fetch(`https://api.tiendanube.com/v1/${TN_STOREID}/orders/${orderId}`, {
    headers: { "Authentication": `bearer ${TN_TOKEN}`, "User-Agent": "EnviosHub (maxidottori@gmail.com)" }
  });
  if (!resp.ok) return res.status(502).json({ error: "TN API error", status: resp.status });

  const order = await resp.json();

  const parsed = ordenAOtroPedido(order);

  let db;
  try { db = initDb(); } catch(e) { return res.status(500).json({ error: "Firebase init failed", detail: e.message }); }

  const docRef = db.collection("otrosPedidos").doc(String(orderId));
  const existing = await docRef.get();
  if (!existing.exists) return res.status(404).json({ error: "Document not found in otrosPedidos" });

  const existingData = existing.data();

  // Only update data-quality fields — preserve estado, armado, pago, etc.
  const update = {
    nroOrdenTN:    parsed.nroOrdenTN,
    clienteNombre: parsed.clienteNombre,
    telefono:      parsed.telefono,
    direccion:     parsed.direccion,
    ciudad:        parsed.ciudad,
    localidad:     parsed.localidad,
    cp:            parsed.cp,
    partido:       parsed.partido,
    provincia:     parsed.provincia,
    alertaDireccion: parsed.alertaDireccion,
    carrier:       parsed.carrier,
    tipoOtro:      parsed.tipoOtro,
    metodEnvio:    parsed.metodEnvio,
    formaPago:     parsed.formaPago,
    importeOrden:  parsed.importeOrden,
    notasOrden:    parsed.notasOrden,
    notasCliente:  parsed.notasCliente,
    linkTN:        parsed.linkTN,
    fechaVenta:    parsed.fechaVenta,
    observaciones: parsed.observaciones,
  };

  await docRef.update(update);

  return res.status(200).json({
    ok: true,
    orderId,
    nroOrdenTN:  parsed.nroOrdenTN,
    carrier:     parsed.carrier,
    direccion:   parsed.direccion,
    previousData: {
      nroOrdenTN:  existingData.nroOrdenTN,
      carrier:     existingData.carrier,
      direccion:   existingData.direccion,
    }
  });
}
