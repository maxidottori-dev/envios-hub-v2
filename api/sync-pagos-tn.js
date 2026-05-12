import { initDb } from "./_firebase.js";

const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
const TN_STOREID = process.env.TN_STORE_ID;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // 1. Inicializar Firebase
    const db = initDb();

    // 2. Traer todos los envios de Tienda Nube (una sola query, filtrado en memoria)
    const snap = await db.collection("envios")
      .where("origen", "==", "Tienda Nube")
      .get();

    // 3a. CC: pagoEstado === "cuenta_corriente"
    const docsCC = snap.docs.filter(d => d.data().pagoEstado === "cuenta_corriente");

    // 3b. Efectivo: cobranza > 0 y aun no marcado como pagado
    const docsEfectivo = snap.docs.filter(d => {
      const data = d.data();
      return data.cobranza > 0 && data.pagoEstado !== "pagado";
    });

    // Unificar (un pedido puede caer en ambos grupos — dedup por id)
    const mapaUniq = new Map();
    [...docsCC, ...docsEfectivo].forEach(d => mapaUniq.set(d.id, d));
    const todos = [...mapaUniq.values()];

    let actualizados = 0, pendientes = 0, errores = 0;
    const detalle = [];

    // 4. Consultar TN por cada uno y actualizar si está pagado
    for (const docSnap of todos) {
      const data = docSnap.data();
      const idTN  = data.idTN || data.id;
      if (!idTN) { errores++; continue; }

      try {
        const resp = await fetch(
          `https://api.tiendanube.com/v1/${TN_STOREID}/orders/${idTN}`,
          { headers: { "Authentication": `bearer ${TN_TOKEN}`, "User-Agent": "EnviosHub-sync (maxidottori@gmail.com)" } }
        );
        if (!resp.ok) { errores++; detalle.push({ nro: data.nroOrdenTN, error: resp.status }); continue; }

        const orden = await resp.json();

        if (orden.payment_status === "paid") {
          await docSnap.ref.update({ pagoEstado: "pagado" });
          actualizados++;
          detalle.push({ nro: data.nroOrdenTN || idTN, cliente: data.clienteNombre, resultado: "pagado" });
        } else {
          pendientes++;
          detalle.push({ nro: data.nroOrdenTN || idTN, cliente: data.clienteNombre, resultado: orden.payment_status });
        }
      } catch(eTN) {
        errores++;
        detalle.push({ id: docSnap.id, error: eTN.message });
      }
    }

    return res.status(200).json({
      ok: true,
      totalCC: docsCC.length,
      totalEfectivo: docsEfectivo.length,
      total: todos.length,
      actualizados,
      pendientes,
      errores,
      detalle
    });

  } catch(e) {
    return res.status(500).json({ ok: false, error: e.message, stack: e.stack?.slice(0, 300) });
  }
}
