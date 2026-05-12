import { initDb } from "./_firebase.js";
import { getPagoEstadoInicial } from "./_tn.js";

const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
const TN_STOREID = process.env.TN_STORE_ID;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const dryRun = req.body?.dryRun === true;

  let db;
  try { db = initDb(); } catch(e) { return res.status(500).json({ error: "Firebase init failed", detail: e.message }); }

  // Buscar pedidos con pagoEstado = "cuenta_corriente" (query simple, sin índice compuesto)
  // El filtro de origen="Tienda Nube" se aplica en memoria
  const snap = await db.collection("envios")
    .where("pagoEstado", "==", "cuenta_corriente")
    .get();

  // Filtrar solo los de origen Tienda Nube en memoria
  const docsCC = snap.docs.filter(d => d.data().origen === "Tienda Nube");
  const total = docsCC.length;
  let actualizados = 0;
  let pendientes = 0;
  let errores = 0;
  const detalle = [];

  for (const docSnap of docsCC) {
    const data = docSnap.data();
    const idTN = data.idTN || data.id;
    if (!idTN) { errores++; continue; }

    await sleep(550); // respetar rate limit de TN

    try {
      const resp = await fetch(
        `https://api.tiendanube.com/v1/${TN_STOREID}/orders/${idTN}`,
        { headers: { "Authentication": `bearer ${TN_TOKEN}`, "User-Agent": "EnviosHub-sync (maxidottori@gmail.com)" } }
      );
      if (!resp.ok) { errores++; detalle.push({ id: docSnap.id, error: resp.status }); continue; }

      const orden = await resp.json();
      const nuevoPago = getPagoEstadoInicial(orden);

      if (nuevoPago === "pagado") {
        if (!dryRun) await docSnap.ref.update({ pagoEstado: "pagado" });
        actualizados++;
        detalle.push({ nro: data.nroOrdenTN || idTN, cliente: data.clienteNombre, resultado: "pagado" });
      } else {
        pendientes++;
        detalle.push({ nro: data.nroOrdenTN || idTN, cliente: data.clienteNombre, resultado: "pendiente" });
      }
    } catch(e) {
      errores++;
      detalle.push({ id: docSnap.id, error: e.message });
    }
  }

  return res.status(200).json({
    ok: true,
    dryRun,
    total,
    actualizados,
    pendientes,
    errores,
    detalle,
  });
}
