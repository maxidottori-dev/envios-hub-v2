// sync-pagos-tn.mjs
// Sincroniza pagoEstado de pedidos TN que están como "cuenta_corriente"
// pero ya figuran como pagados en Tienda Nube.
//
// Uso:
//   TN_ACCESS_TOKEN=xxx TN_STORE_ID=yyy FIREBASE_PROJECT_ID=zzz \
//   FIREBASE_CLIENT_EMAIL=aaa FIREBASE_PRIVATE_KEY="bbb" \
//   node scripts/sync-pagos-tn.mjs
//
// Opciones:
//   --dry-run    Muestra qué se actualizaría sin escribir en Firestore
//   --limit=N    Procesa solo los primeros N pedidos (default: todos)

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const DRY_RUN = process.argv.includes("--dry-run");
const limitArg = process.argv.find(a => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1]) : Infinity;

const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
const TN_STOREID = process.env.TN_STORE_ID;

if (!TN_TOKEN || !TN_STOREID) {
  console.error("❌ Faltan TN_ACCESS_TOKEN o TN_STORE_ID");
  process.exit(1);
}

// Inicializar Firebase Admin
function initDb() {
  if (getApps().length > 0) return getFirestore();
  let privateKey = process.env.FIREBASE_PRIVATE_KEY || "";
  if (privateKey.includes("\\n")) privateKey = privateKey.replace(/\\n/g, "\n");
  if (!privateKey.includes("-----BEGIN PRIVATE KEY-----")) {
    privateKey = "-----BEGIN PRIVATE KEY-----\n" + privateKey + "\n-----END PRIVATE KEY-----\n";
  }
  initializeApp({
    credential: cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
  });
  return getFirestore();
}

async function consultarTN(orderId) {
  const resp = await fetch(
    `https://api.tiendanube.com/v1/${TN_STOREID}/orders/${orderId}`,
    { headers: { "Authentication": `bearer ${TN_TOKEN}`, "User-Agent": "EnviosHub-sync (maxidottori@gmail.com)" } }
  );
  if (!resp.ok) return null;
  return resp.json();
}

// Espera entre requests para no sobrecargar la API de TN (rate limit: ~2 req/s)
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log(`\n🔄 Sincronizando pagos TN → Firestore${DRY_RUN ? " [DRY RUN]" : ""}\n`);

  const db = initDb();

  // Buscar todos los pedidos TN con pagoEstado = "cuenta_corriente"
  const snap = await db.collection("envios")
    .where("origen", "==", "Tienda Nube")
    .where("pagoEstado", "==", "cuenta_corriente")
    .get();

  const docs = snap.docs;
  console.log(`📦 Pedidos TN con pagoEstado=cuenta_corriente: ${docs.length}`);
  if (docs.length === 0) { console.log("✅ Nada para sincronizar."); return; }

  const aChequear = docs.slice(0, LIMIT === Infinity ? docs.length : LIMIT);
  console.log(`🔍 Chequeando ${aChequear.length} pedidos contra la API de TN...\n`);

  let actualizados = 0;
  let pendientes = 0;
  let errores = 0;
  let sinIdTN = 0;

  for (const doc of aChequear) {
    const data = doc.data();
    const idTN = data.idTN || data.id;

    if (!idTN) {
      console.log(`  ⚠️  ${doc.id} — sin idTN, saltando`);
      sinIdTN++;
      continue;
    }

    await sleep(550); // ~1.8 req/s para respetar rate limit de TN

    const orden = await consultarTN(idTN);

    if (!orden) {
      console.log(`  ❌ ${doc.id} (TN #${data.nroOrdenTN || idTN}) — error al consultar TN`);
      errores++;
      continue;
    }

    const paymentStatus = orden.payment_status;
    const clienteNombre = orden.contact_name || orden.shipping_address?.name || data.clienteNombre || "?";
    const nroOrden = data.nroOrdenTN || idTN;

    if (paymentStatus === "paid") {
      console.log(`  ✅ #${nroOrden} ${clienteNombre} → PAGADO`);
      if (!DRY_RUN) {
        await doc.ref.update({ pagoEstado: "pagado" });
      }
      actualizados++;
    } else {
      console.log(`  ⏳ #${nroOrden} ${clienteNombre} → ${paymentStatus} (sin cambio)`);
      pendientes++;
    }
  }

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Procesados:  ${aChequear.length}
  Actualizados a "pagado": ${actualizados}${DRY_RUN ? " (simulado)" : ""}
  Siguen pendientes:       ${pendientes}
  Errores TN:              ${errores}
  Sin idTN:                ${sinIdTN}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${DRY_RUN ? "\n⚠️  Modo dry-run: no se escribió nada en Firestore.\n   Quitá --dry-run para aplicar los cambios." : "✅ Sync completo."}
`);
}

main().catch(e => { console.error("❌ Error fatal:", e); process.exit(1); });
