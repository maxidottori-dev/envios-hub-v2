import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
const TN_STOREID = process.env.TN_STORE_ID;

const CP_P = {"1601":"La Plata","1607":"San Isidro","1608":"Tigre","1609":"San Isidro","1610":"Tigre","1611":"Tigre","1612":"Malvinas Argentinas","1613":"Malvinas Argentinas","1614":"Malvinas Argentinas","1615":"Malvinas Argentinas","1616":"Malvinas Argentinas","1617":"Tigre","1618":"Tigre","1619":"Escobar","1620":"Escobar","1621":"Tigre","1622":"Escobar","1623":"Escobar","1624":"Tigre","1625":"Escobar","1626":"Escobar","1627":"Escobar","1628":"Escobar","1629":"Pilar","1630":"Pilar","1631":"Pilar","1632":"Pilar","1633":"Pilar","1634":"Pilar","1635":"Pilar","1636":"Vicente Lopez","1637":"Vicente Lopez","1638":"Vicente Lopez","1640":"San Isidro","1641":"San Isidro","1642":"San Isidro","1643":"San Isidro","1644":"San Fernando","1645":"San Fernando","1646":"San Fernando","1647":"Zarate","1648":"Tigre","1649":"San Fernando","1650":"San Martin","1651":"San Martin","1653":"San Martin","1655":"San Martin","1657":"San Martin","1659":"San Miguel","1660":"Jose C Paz","1661":"San Miguel","1662":"San Miguel","1663":"San Miguel","1664":"Pilar","1665":"Jose C Paz","1666":"Jose C Paz","1667":"Pilar","1669":"Pilar","1670":"Tigre","1671":"Tigre","1672":"San Martin","1674":"Tres de Febrero","1675":"Tres de Febrero","1676":"Tres de Febrero","1678":"Tres de Febrero","1682":"Tres de Febrero","1683":"Tres de Febrero","1684":"Moron","1685":"Moron","1686":"Hurlingham","1687":"Tres de Febrero","1688":"Hurlingham","1689":"La Matanza Norte","1692":"Tres de Febrero","1702":"Tres de Febrero","1703":"Tres de Febrero","1704":"La Matanza Norte","1706":"Moron","1707":"Moron","1708":"Moron","1712":"Moron","1713":"Ituzaingo","1714":"Ituzaingo","1715":"Ituzaingo","1716":"Merlo","1718":"Merlo","1721":"Merlo","1722":"Merlo","1723":"Merlo","1724":"Merlo","1727":"Marcos Paz","1736":"Moreno","1738":"Moreno","1740":"Moreno","1742":"Moreno","1743":"Moreno","1744":"Moreno","1745":"Moreno","1746":"Moreno","1748":"Gral. Rodriguez","1749":"Gral. Rodriguez","1751":"La Matanza Norte","1752":"La Matanza Norte","1753":"La Matanza Norte","1754":"La Matanza Norte","1755":"La Matanza Norte","1757":"La Matanza Sur","1758":"La Matanza Sur","1759":"La Matanza Sur","1761":"La Matanza Norte","1763":"La Matanza Sur","1764":"La Matanza Sur","1765":"La Matanza Sur","1766":"La Matanza Norte","1768":"La Matanza Norte","1770":"La Matanza Norte","1771":"La Matanza Norte","1772":"La Matanza Norte","1774":"La Matanza Norte","1778":"La Matanza Norte","1785":"La Matanza Norte","1786":"La Matanza Sur","1801":"Ezeiza","1802":"Ezeiza","1803":"Ezeiza","1804":"Ezeiza","1805":"Esteban Echeverria","1806":"Ezeiza","1807":"Ezeiza","1808":"Canuelas","1812":"Canuelas","1813":"Ezeiza","1814":"Canuelas","1815":"Canuelas","1816":"Canuelas","1821":"Lomas de Zamora","1822":"Lanus","1823":"Lanus","1824":"Lanus","1825":"Lanus","1826":"Lanus","1827":"Lomas de Zamora","1828":"Lomas de Zamora","1829":"Lomas de Zamora","1831":"Lomas de Zamora","1832":"Lomas de Zamora","1833":"Lomas de Zamora","1834":"Lomas de Zamora","1835":"Lomas de Zamora","1836":"Lomas de Zamora","1837":"Berazategui","1838":"Esteban Echeverria","1839":"Esteban Echeverria","1840":"Quilmes","1841":"Esteban Echeverria","1842":"Esteban Echeverria","1843":"Almirante Brown","1844":"Almirante Brown","1845":"Almirante Brown","1846":"Almirante Brown","1847":"Almirante Brown","1848":"Almirante Brown","1849":"Almirante Brown","1851":"Almirante Brown","1852":"Almirante Brown","1853":"Florencio Varela","1854":"Almirante Brown","1855":"Almirante Brown","1856":"Almirante Brown","1858":"Presidente Peron","1859":"Florencio Varela","1860":"Berazategui","1861":"Berazategui","1862":"Presidente Peron","1863":"Florencio Varela","1864":"San Vicente","1865":"San Vicente","1867":"Florencio Varela","1868":"Avellaneda","1869":"Avellaneda","1870":"Avellaneda","1871":"Avellaneda","1872":"Avellaneda","1873":"Avellaneda","1874":"Avellaneda","1875":"Avellaneda","1876":"Quilmes","1877":"Quilmes","1878":"Quilmes","1879":"Quilmes","1880":"Berazategui","1881":"Quilmes","1882":"Quilmes","1883":"Quilmes","1884":"Berazategui","1885":"Berazategui","1886":"Berazategui","1887":"Florencio Varela","1888":"Florencio Varela","1889":"Florencio Varela","1890":"Berazategui","1891":"Florencio Varela","1893":"Berazategui","1894":"La Plata","1895":"La Plata","1896":"La Plata","1897":"La Plata","1900":"La Plata","1901":"La Plata","1902":"La Plata","1903":"La Plata","1904":"La Plata","1905":"La Plata","1906":"La Plata","1907":"La Plata","1908":"La Plata","1909":"La Plata","1910":"La Plata","1912":"La Plata","1914":"La Plata","1923":"Berisso","1924":"Berisso","1925":"Ensenada","1926":"Ensenada","1927":"Ensenada","1929":"Berisso","1931":"Ensenada","1984":"San Vicente","2800":"Zarate","2801":"Zarate","2802":"Zarate","2804":"Campana","2805":"Campana","2806":"Zarate","2808":"Zarate","2812":"Campana","2814":"Ex.de la Cruz","2816":"Campana","6700":"Lujan","6701":"Lujan","6702":"Lujan","6703":"Ex.de la Cruz","6706":"Lujan","6708":"Lujan","6712":"Lujan"};

function cpAPartido(cp) {
  const s = String(cp || "").replace(/\D/g, "");
  const n = parseInt(s);
  if (n >= 1000 && n <= 1499) return "CABA";
  return CP_P[s] || "";
}

function parsearDatepicker(notas) {
  if (!notas) return { fecha: "", turno: "", datepickerRaw: "" };
  const match = notas.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),\s*entre las (\d{1,2}):(\d{2})/i);
  if (!match) return { fecha: "", turno: "", datepickerRaw: "" };
  const [, dia, mes, anio, hora] = match;
  const fecha = `${anio}-${String(mes).padStart(2,"0")}-${String(dia).padStart(2,"0")}`;
  const turno = parseInt(hora) < 15 ? "AM" : "PM";
  const datepickerRaw = notas.match(/\[Smile Datepicker\][^\n]*/i)?.[0] || "";
  return { fecha, turno, datepickerRaw };
}

function ordenAEnvio(order) {
  const ship    = order.shipping_address || {};
  const cp      = String(ship.zipcode || "").replace(/\D/g, "");
  const dir     = [ship.address, ship.number, ship.floor, ship.apartment].filter(Boolean).join(" ");
  const ciudad  = ship.city || "";
  const partido = cpAPartido(cp) || ciudad;
  const alertaSinDireccion = !dir || !cp;
  const notasOrden   = order.note || "";
  const notasCliente = order.customer_note || "";
  const { fecha, turno, datepickerRaw } = parsearDatepicker(notasOrden);
  const pagoMethods = order.payment_details || [];
  const formaPago   = Array.isArray(pagoMethods) && pagoMethods.length
    ? pagoMethods.map(p => p.payment_method || p.method || "").filter(Boolean).join(", ")
    : (order.gateway || "");
  const efectivo = formaPago.toLowerCase().includes("efectivo") || formaPago.toLowerCase().includes("cash");
  const importeOrden = parseFloat(order.total) || 0;
  return {
    id: String(order.id), origen: "Tienda Nube", idTN: order.id,
    nroOrdenTN: String(order.number || order.id),
    nroSeguimiento: "",
    linkTN: `https://mitienda.mitiendanube.com/admin/orders/${order.id}`,
    linkML: "",
    clienteNombre: `${order.customer?.name || ""} ${order.customer?.lastname || ""}`.trim(),
    telefono: order.customer?.phone || ship.phone || "",
    direccion: dir || "SIN DIRECCION", ciudad, cp, partido,
    provincia: ship.province || "", alertaDireccion: alertaSinDireccion,
    formaPago, importeOrden,
    cobranza: efectivo ? importeOrden : null,
    notasOrden, notasCliente, datepickerRaw,
    fechaVenta: (order.created_at || "").split("T")[0],
    fecha, turno, trans: "", estado: "sin_asignar",
    importe: 0, bultos: 1, cambio: null, retiro: null,
    observaciones: alertaSinDireccion ? "ALERTA: sin direccion o CP" : "",
    metodEnvio: order.shipping_option || order.shipping?.name || "",
  };
}

function initDb() {
  if (getApps().length === 0) {
    initializeApp({ credential: cert({ projectId: process.env.FIREBASE_PROJECT_ID, clientEmail: process.env.FIREBASE_CLIENT_EMAIL, privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g,"\n") }) });
  }
  return getFirestore();
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const db = initDb();
  let page = 1, guardados = 0, saltados = 0;
  while (true) {
    const url = `https://api.tiendanube.com/v1/${TN_STOREID}/orders?page=${page}&per_page=50&status=open`;
    const resp = await fetch(url, { headers: { "Authentication": `bearer ${TN_TOKEN}`, "User-Agent": "EnviosHub (maxidottori@gmail.com)" } });
    if (!resp.ok) break;
    const orders = await resp.json();
    if (!orders || orders.length === 0) break;
    for (const order of orders) {
      const metodo = (order.shipping_option || order.shipping?.name || "").toUpperCase();
      if (!metodo.includes("LOGISTICA UMP")) { saltados++; continue; }
      const docRef = db.collection("envios").doc(String(order.id));
      const existing = await docRef.get();
      if (existing.exists) { saltados++; continue; }
      await docRef.set(ordenAEnvio(order));
      guardados++;
    }
    if (orders.length < 50) break;
    page++;
  }
  return res.status(200).json({ ok: true, guardados, saltados });
}
