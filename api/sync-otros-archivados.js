import { initDb } from "./_firebase.js";

const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
const TN_STOREID = process.env.TN_STORE_ID;

// Sincroniza otrosPedidos con TN: archiva los que TN ya cerró o canceló.
// Se llama automáticamente desde el frontend al cargar la app.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let db;
  try { db = initDb(); } catch(e) { return res.status(500).json({ error: "Firebase init failed", detail: e.message }); }

  // Obtener otrosPedidos en estados activos (excluye terminales)
  let snap;
  try {
    snap = await db.collection("otrosPedidos")
      .where("estado", "not-in", ["archivado", "cancelado", "despachado", "convertido_a_ump"])
      .get();
  } catch(e) {
    return res.status(500).json({ error: "Firestore query failed", detail: e.message });
  }

  // Solo los que tienen nroOrdenTN válido (numérico)
  const conOrdenTN = snap.docs.filter(d => {
    const tnId = d.data().nroOrdenTN;
    return tnId && !isNaN(Number(tnId));
  });

  if (conOrdenTN.length === 0) return res.status(200).json({ ok: true, revisados: 0, archivados: 0 });

  let archivados = 0;
  const ts = new Date().toISOString();

  await Promise.all(conOrdenTN.map(async (docSnap) => {
    const data = { id: docSnap.id, ...docSnap.data() };
    const tnId = data.nroOrdenTN;
    try {
      const resp = await fetch(
        `https://api.tiendanube.com/v1/${TN_STOREID}/orders/${tnId}`,
        { headers: { "Authentication": `bearer ${TN_TOKEN}`, "User-Agent": "EnviosHub (maxidottori@gmail.com)" } }
      );
      if (!resp.ok) return;
      const order = await resp.json();

      // Archivar si TN cerró o canceló el pedido
      if (order.status === "closed" || order.status === "cancelled") {
        await db.collection("otrosPedidos").doc(data.id).update({
          estado: "archivado",
          archivadoTs: ts,
          archivadoMotivo: `sync: TN status=${order.status}`
        });
        archivados++;
        console.log("SYNC_ARCHIVADOS", tnId, order.status);
      }
    } catch(err) {
      console.warn("SYNC_ARCHIVADOS error", tnId, err.message);
    }
  }));

  return res.status(200).json({ ok: true, revisados: conOrdenTN.length, archivados });
}
