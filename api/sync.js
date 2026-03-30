import { initDb } from "./_firebase.js";
import { ordenAEnvio } from "./_tn.js";

const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
const TN_STOREID = process.env.TN_STORE_ID;

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  let db;
  try { db = initDb(); } catch(e) { return res.status(500).json({ error: "Firebase init failed", detail: e.message }); }

  let page = 1, guardados = 0, actualizados = 0, saltados = 0;

  while (true) {
    const url = `https://api.tiendanube.com/v1/${TN_STOREID}/orders?page=${page}&per_page=50&status=open`;
    const resp = await fetch(url, {
      headers: { "Authentication": `bearer ${TN_TOKEN}`, "User-Agent": "EnviosHub (maxidottori@gmail.com)" }
    });
    if (!resp.ok) break;
    const orders = await resp.json();
    if (!orders || orders.length === 0) break;

    for (const order of orders) {
      const metodo = (order.shipping_option || order.shipping?.name || "").toUpperCase();
      if (!metodo.includes("LOGISTICA UMP")) { saltados++; continue; }

      const docRef = db.collection("envios").doc(String(order.id));
      const existing = await docRef.get();

      if (!existing.exists) {
        await docRef.set(ordenAEnvio(order));
        guardados++;
      } else {
        // Re-sync: actualizar campos que pueden haber llegado mal en la primera sync
        const data = existing.data();
        const envioFresh = ordenAEnvio(order);
        // Solo actualizar campos de datos de TN, no los operativos
        const update = {
          clienteNombre: envioFresh.clienteNombre,
          telefono:      envioFresh.telefono,
          formaPago:     envioFresh.formaPago,
          importeOrden:  envioFresh.importeOrden,
          notasOrden:    envioFresh.notasOrden,
          notasCliente:  envioFresh.notasCliente,
          datepickerRaw: envioFresh.datepickerRaw,
          nroOrdenTN:    envioFresh.nroOrdenTN,
          ciudad:        envioFresh.ciudad,
          cp:            envioFresh.cp,
          partido:       envioFresh.partido || data.partido,
          metodEnvio:    envioFresh.metodEnvio,
          alertaDireccion: envioFresh.alertaDireccion,
          localidad:     envioFresh.localidad || "",
        };
        // Actualizar pagoEstado solo si no fue manualmente puesto como cuenta_corriente
        if (data.pagoEstado !== "cuenta_corriente") {
          update.pagoEstado = envioFresh.pagoEstado;
        }
        // Actualizar cobranza solo si no fue asignado y cobranza no fue tocada
        if (!data.trans && data.cobranza === null && envioFresh.cobranza !== null) {
          update.cobranza = envioFresh.cobranza;
        }
        // Actualizar fecha/turno solo si estan vacios y el datepicker los trae
        if (!data.fecha && envioFresh.fecha) update.fecha = envioFresh.fecha;
        if (!data.turno && envioFresh.turno) update.turno = envioFresh.turno;

        await docRef.update(update);
        actualizados++;
      }
    }

    if (orders.length < 50) break;
    page++;
  }

  return res.status(200).json({ ok: true, guardados, actualizados, saltados });
}
