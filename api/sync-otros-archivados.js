import { initDb } from "./_firebase.js";

const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
const TN_STOREID = process.env.TN_STORE_ID;

// Sincroniza otrosPedidos: archiva en Firestore los que TN ya cerró (status=closed).
// Se llama automáticamente desde el frontend al cargar la app.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let db;
  try { db = initDb(); } catch(e) { return res.status(500).json({ error: "Firebase init failed", detail: e.message }); }

  // Traer todos los otrosPedidos en estados activos (excluye terminales)
  const ESTADOS_ACTIVOS = ["pendiente","en_expedicion","por_preparar","preparado","enviado"];
  let snap;
  try {
    snap = await db.collection("otrosPedidos").where("estado","in",ESTADOS_ACTIVOS).get();
  } catch(e) {
    return res.status(500).json({ error: "Firestore query failed", detail: e.message });
  }

  const pedidos = snap.docs.map(d => ({ docId: d.id, ...d.data() }));
  if (pedidos.length === 0) return res.status(200).json({ ok: true, archivados: 0, revisados: 0 });

  let archivados = 0;
  const ts = new Date().toISOString();

  await Promise.all(pedidos.map(async (p) => {
    const tnId = p.idTN || p.id;
    if (!tnId || isNaN(Number(tnId))) return; // no es un pedido TN
    try {
      const resp = await fetch(
        `https://api.tiendanube.com/v1/${TN_STOREID}/orders/${tnId}`,
        { headers: { "Authentication": `bearer ${TN_TOKEN}`, "User-Agent": "EnviosHub (maxidottori@gmail.com)" } }
      );
      if (!resp.ok) return;
      const order = await resp.json();
      if (order.status === "closed" || order.status === "cancelled") {
        const nuevoEstado = order.status === "closed" ? "archivado" : "cancelado";
        await db.collection("otrosPedidos").doc(p.docId).update({
          estado: nuevoEstado,
          archivadoTs: ts,
        });
        console.log(`SYNC_OTROS ${nuevoEstado.toUpperCase()}`, tnId);
        archivados++;
      }
    } catch(e) {
      console.warn("SYNC_OTROS error", tnId, e.message);
    }
  }));

  return res.status(200).json({ ok: true, revisados: pedidos.length, archivados });
}
