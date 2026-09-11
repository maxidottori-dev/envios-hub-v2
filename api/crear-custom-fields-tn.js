// Script de alta única — crea los 3 Order Custom Fields del datepicker propio en Tiendanube.
// Llamar una sola vez vía POST /api/crear-custom-fields-tn (desde curl o desde el navegador).
// Guardar los IDs devueltos como constantes en _tn-custom-fields.js.
//
// Campos a crear:
//   Fecha de entrega   → date
//   Turno de entrega   → text_list (Mañana / Tarde)
//   Zona logística     → text

const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
const TN_STOREID = process.env.TN_STORE_ID;

const CAMPOS = [
  { name: "Fecha de entrega",  value_type: "date",      read_only: false, values: [] },
  { name: "Turno de entrega",  value_type: "text_list", read_only: false, values: ["Mañana", "Tarde"] },
  { name: "Zona logística",    value_type: "text",      read_only: false, values: [] },
];

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!TN_TOKEN || !TN_STOREID) return res.status(500).json({ error: "Faltan env vars TN_ACCESS_TOKEN / TN_STORE_ID" });

  const resultados = [];

  for (const campo of CAMPOS) {
    const resp = await fetch(
      `https://api.tiendanube.com/v1/${TN_STOREID}/orders/custom-fields`,
      {
        method: "POST",
        headers: {
          "Authentication": `bearer ${TN_TOKEN}`,
          "User-Agent": "EnviosHub (maxidottori@gmail.com)",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(campo),
      }
    );
    const data = await resp.json();
    resultados.push({ nombre: campo.name, ok: resp.ok, status: resp.status, id: data.id || null, data });
  }

  const todosOk = resultados.every(r => r.ok);

  // Imprimir los IDs en el log para copiarlos a _tn-custom-fields.js
  console.log("CUSTOM_FIELDS_CREADOS", JSON.stringify(resultados.map(r => ({ nombre: r.nombre, id: r.id }))));

  return res.status(todosOk ? 200 : 207).json({
    ok: todosOk,
    instruccion: "Copiar estos IDs a api/_tn-custom-fields.js",
    resultados,
  });
}
