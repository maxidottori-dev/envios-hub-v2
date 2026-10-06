// TEMPORAL — Encuentra pedidos TN con cobro efectivo que pertenecen a clientes CC
// GET → devuelve los casos
import { initDb } from "./_firebase.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  let db;
  try { db = initDb(); } catch(e) { return res.status(500).json({ error: e.message }); }

  // 1) Todos los clienteKeys con historial en pagosCC
  const pagosSnap = await db.collection("pagosCC").get();
  const ccClientes = new Set();
  pagosSnap.forEach(d => {
    const data = d.data();
    if (data.clienteKey) ccClientes.add(data.clienteKey);
  });

  // 2) También los que tienen pagoEstado=cuenta_corriente en envios
  const ccEnviosSnap = await db.collection("envios")
    .where("pagoEstado", "==", "cuenta_corriente").get();
  ccEnviosSnap.forEach(d => {
    const key = (d.data().clienteNombre || "").toLowerCase().trim().replace(/\s+/g,"_");
    if (key) ccClientes.add(key);
  });

  // 3) Envíos TN con pagoEstado=pagado y cobranza>0 (efectivo a cobrar)
  const enviosSnap = await db.collection("envios")
    .where("origen", "==", "Tienda Nube")
    .where("pagoEstado", "==", "pagado")
    .get();

  const casos = [];
  enviosSnap.forEach(d => {
    const e = { id: d.id, ...d.data() };
    if (!e.cobranza || e.cobranza <= 0) return;
    if (e.estado === "cancelado") return;
    const key = (e.clienteNombre || "").toLowerCase().trim().replace(/\s+/g,"_");
    if (ccClientes.has(key)) {
      casos.push({
        id: e.id,
        nroOrden: e.nroOrdenTN,
        cliente: e.clienteNombre,
        clienteKey: key,
        cobranza: e.cobranza,
        importeOrden: e.importeOrden,
        fecha: e.fecha || e.fechaVenta || "",
        trans: e.trans || "",
        estado: e.estado || "",
        despachado: !!e.despachado,
        formaPago: e.formaPago || "",
      });
    }
  });

  // Ordenar por fecha desc
  casos.sort((a,b) => b.fecha.localeCompare(a.fecha));

  return res.status(200).json({
    ccClientesTotal: ccClientes.size,
    casosTotal: casos.length,
    casos
  });
}
