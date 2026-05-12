import { initDb } from "./_firebase.js";

const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
const TN_STOREID = process.env.TN_STORE_ID;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // 1. Inicializar Firebase
    const db = initDb();

    // 2. Buscar pedidos con pagoEstado="cuenta_corriente" (query simple)
    const snap = await db.collection("envios")
      .where("pagoEstado", "==", "cuenta_corriente")
      .get();

    // 3. Filtrar solo Tienda Nube en memoria
    const docsCC = snap.docs.filter(d => d.data().origen === "Tienda Nube");

    let actualizados = 0, pendientes = 0, errores = 0;
    const detalle = [];

    // 4. Consultar TN por cada uno (sin delay — TN tolera ~2 req/s)
    for (const docSnap of docsCC) {
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

    return res.status(200).json({ ok: true, total: docsCC.length, actualizados, pendientes, errores, detalle });

  } catch(e) {
    // Devolver el error real como JSON para poder diagnosticarlo
    return res.status(500).json({ ok: false, error: e.message, stack: e.stack?.slice(0, 300) });
  }
}
