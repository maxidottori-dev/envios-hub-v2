import { initDb } from "./_firebase.js";

const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
const TN_STOREID = process.env.TN_STORE_ID;

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    // 1. Inicializar Firebase
    const db = initDb();

    // 2. Traer todos los envios de Tienda Nube (una sola query, filtrado en memoria)
    const snap = await db.collection("envios")
      .where("origen", "==", "Tienda Nube")
      .get();

    // Fecha de corte: solo revisar pedidos de los últimos 60 días
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 60);
    const cutoffStr = cutoff.toISOString().split("T")[0];

    // 3a. CC: pagoEstado === "cuenta_corriente" O esCC === true (manual CC override)
    const docsCC = snap.docs.filter(d => {
      const data = d.data();
      return data.pagoEstado === "cuenta_corriente" || data.esCC === true;
    });

    // 3b. Efectivo: cobranza > 0 y aun no marcado como pagado
    const docsEfectivo = snap.docs.filter(d => {
      const data = d.data();
      return data.cobranza > 0 && data.pagoEstado !== "pagado";
    });

    // 3c. Pendientes genéricos (transferencias y otros): pagoEstado pendiente/ausente,
    //     sin cobranza, sin CC, de los últimos 60 días
    const docsPendientes = snap.docs.filter(d => {
      const data = d.data();
      if (data.pagoEstado === "pagado" || data.pagoEstado === "cuenta_corriente") return false;
      if (data.esCC === true) return false;
      if (data.cobranza > 0) return false; // ya cubierto por docsEfectivo
      const fecha = data.fechaVenta || data.fecha || "";
      return fecha >= cutoffStr;
    });

    // Unificar (un pedido puede caer en varios grupos — dedup por id)
    const mapaUniq = new Map();
    [...docsCC, ...docsEfectivo, ...docsPendientes].forEach(d => mapaUniq.set(d.id, d));
    const todos = [...mapaUniq.values()];

    let actualizados = 0, pendientes = 0, errores = 0;
    const detalle = [];

    // 4. Consultar TN por cada uno y actualizar si está pagado
    for (const docSnap of todos) {
      const data = docSnap.data();
      const idTN  = data.idTN || data.id;
      if (!idTN) {
        errores++;
        detalle.push({ nro: data.nroOrdenTN || docSnap.id, cliente: data.clienteNombre, error: "Sin ID de TN" });
        continue;
      }

      try {
        const resp = await fetch(
          `https://api.tiendanube.com/v1/${TN_STOREID}/orders/${idTN}`,
          { headers: { "Authentication": `bearer ${TN_TOKEN}`, "User-Agent": "EnviosHub-sync (maxidottori@gmail.com)" } }
        );
        if (!resp.ok) {
          errores++;
          detalle.push({ nro: data.nroOrdenTN || idTN, cliente: data.clienteNombre, idFirestore: docSnap.id, error: `HTTP ${resp.status}` });
          continue;
        }

        const orden = await resp.json();

        if (orden.payment_status === "paid") {
          const syncUpdate = { pagoEstado: "pagado" };
          // Limpiar cobranza si no fue recibida manualmente (igual que webhook UMP)
          if (!data.cobranzaRecibida) syncUpdate.cobranza = null;
          await docSnap.ref.update(syncUpdate);
          actualizados++;

          // Si era CC (cuenta_corriente o esCC), registrar en pagosCC para bajar el saldo
          const wasCC = data.pagoEstado === "cuenta_corriente" || data.esCC === true;
          if (wasCC) {
            const monto = data.cobranza > 0 ? data.cobranza
              : data.importeCC > 0 ? data.importeCC
              : data.importeOrden || 0;
            const clienteKey = (data.clienteNombre || "").toLowerCase().trim().replace(/\s+/g, "_") || null;
            if (monto > 0 && clienteKey) {
              const existing = await db.collection("pagosCC")
                .where("envioIds", "array-contains", docSnap.id)
                .limit(1).get();
              if (existing.empty) {
                await db.collection("pagosCC").add({
                  clienteKey,
                  clienteNombre: data.clienteNombre || "",
                  monto,
                  nota: "Pago automático TN",
                  envioIds: [docSnap.id],
                  montosPorEnvio: { [docSnap.id]: monto },
                  fechaCobro: new Date().toISOString().split("T")[0],
                  creadoEn: new Date(),
                  autoSync: true,
                });
                detalle.push({ nro: data.nroOrdenTN || idTN, cliente: data.clienteNombre, resultado: "pagado+cc_registrado" });
              } else {
                detalle.push({ nro: data.nroOrdenTN || idTN, cliente: data.clienteNombre, resultado: "pagado" });
              }
            } else {
              detalle.push({ nro: data.nroOrdenTN || idTN, cliente: data.clienteNombre, resultado: "pagado" });
            }
          } else {
            detalle.push({ nro: data.nroOrdenTN || idTN, cliente: data.clienteNombre, resultado: "pagado" });
          }
        } else {
          pendientes++;
          detalle.push({ nro: data.nroOrdenTN || idTN, cliente: data.clienteNombre, resultado: orden.payment_status });
        }
      } catch(eTN) {
        errores++;
        detalle.push({ nro: data.nroOrdenTN || idTN, cliente: data.clienteNombre, idFirestore: docSnap.id, error: eTN.message });
      }
    }

    return res.status(200).json({
      ok: true,
      totalCC: docsCC.length,
      totalEfectivo: docsEfectivo.length,
      totalPendientes: docsPendientes.length,
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
