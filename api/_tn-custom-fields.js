// IDs de los Order Custom Fields ya creados en Tienda Nube.
// Uso: escribirCamposTN(tnId, { fecha, turno, zona }) — ver función abajo.
// NO conectar todavía a webhook.js ni al flujo de pedidos (Fase 3).

export const CF_FECHA_ENTREGA  = "1785fbabfd450a6646636025cc48d8b3"; // "Fecha de entrega"  — date
export const CF_TURNO_ENTREGA  = "9249578c64ccb52088816a53260aef33"; // "Turno de entrega"  — text_list (Mañana / Tarde)
export const CF_ZONA_LOGISTICA = "4052711d79e240e3ed913540d182d105"; // "Zona logística"    — text

/**
 * Escribe los custom fields de entrega en un pedido TN.
 * @param {string|number} tnId   - ID numérico del pedido en TN
 * @param {object}        campos - { fecha: "YYYY-MM-DD", turno: "Mañana"|"Tarde", zona: string }
 *
 * IMPORTANTE: `zona` debe venir de extraerZona(order.shipping_option) — no del checkout.
 */
export async function escribirCamposTN(tnId, { fecha, turno, zona } = {}) {
  const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
  const TN_STOREID = process.env.TN_STORE_ID;

  const values = [];
  if (fecha) values.push({ id: CF_FECHA_ENTREGA,  value: fecha  }); // ISO YYYY-MM-DD
  if (turno) values.push({ id: CF_TURNO_ENTREGA,  value: turno  }); // "Mañana" o "Tarde"
  if (zona)  values.push({ id: CF_ZONA_LOGISTICA, value: zona   }); // texto libre

  if (!values.length) return { ok: false, msg: "nada que escribir" };

  try {
    const resp = await fetch(
      `https://api.tiendanube.com/v1/${TN_STOREID}/orders/${tnId}/custom-fields/values`,
      {
        method: "PUT",
        headers: {
          "Authentication": `bearer ${TN_TOKEN}`,
          "User-Agent":     "EnviosHub (maxidottori@gmail.com)",
          "Content-Type":   "application/json"
        },
        body: JSON.stringify(values)
      }
    );
    const data = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, data };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}
