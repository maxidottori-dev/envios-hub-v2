import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import * as XLSXLib from "xlsx";
import jsQR from "jsqr";
import { jsPDF } from "jspdf";
import { db } from "./firebase.js";
import { collection, onSnapshot, doc, getDoc, setDoc, deleteDoc, updateDoc, query, where, getDocs, addDoc, serverTimestamp, limit, orderBy, writeBatch } from "firebase/firestore";

const VERSION = "2.1";

// Estado derivado: si tiene trans asignado = asignado, si fue cancelado = cancelado, sino = sin_asignar
function getEstado(e) {
  if (e.estado === "cancelado") return "cancelado";
  if (e.trans) return "asignado";
  return "sin_asignar";
}


// ════════════════════════════════════════════════════════════════════
// AUTH — sistema de usuarios simple con Firebase
// ════════════════════════════════════════════════════════════════════
const AUTH_KEY = "envhub_session";

function getSession() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY) || "null"); } catch { return null; }
}
function setSession(u) { localStorage.setItem(AUTH_KEY, JSON.stringify(u)); }
function clearSession() { localStorage.removeItem(AUTH_KEY); }

async function loginUsuario(usuario, password) {
  try {
    const snap = await getDocs(
      query(collection(db,"usuarios"), where("usuario","==",usuario), where("activo","==",true), limit(1))
    );
    if (snap.empty) return null;
    const data = snap.docs[0].data();
    if (data.password !== password) return null;
    return { id: snap.docs[0].id, ...data };
  } catch(e) { console.error("login error:", e); return null; }
}


// ════════════════════════════════════════════════════════════════════
// SISTEMA DE PERMISOS — features por usuario
// ════════════════════════════════════════════════════════════════════
const FEATURES=[
  // ── Tabs ─────────────────────────────────────────────────────────
  {key:"tab_tablero",     grupo:"tabs",    label:"Tablero",           desc:"Dashboard principal: métricas, resumen de envíos del día y estadísticas rápidas"},
  {key:"tab_noflex",      grupo:"tabs",    label:"NO FLEX",           desc:"Lista de envíos NO FLEX: Tienda Nube y manuales. Permite editar, filtrar y exportar"},
  {key:"tab_flex",        grupo:"tabs",    label:"FLEX",              desc:"Lista de envíos FLEX (Mercado Libre). Permite editar, filtrar y exportar"},
  {key:"tab_despacho",    grupo:"tabs",    label:"Despacho",          desc:"Preparar despachos del día: confirmar envíos, generar hojas de ruta y notificar por WhatsApp"},
  {key:"tab_manual",      grupo:"tabs",    label:"+ Manual",          desc:"Formulario para agregar envíos manualmente al sistema"},
  {key:"tab_tarifas",     grupo:"tabs",    label:"Tarifas / Log.",    desc:"Configurar logísticas activas, zonas de reparto y tarifas por zona y bultos"},
  {key:"tab_informe",     grupo:"tabs",    label:"Informe",           desc:"Informes y estadísticas de envíos por período, logística y zona"},
  {key:"tab_cobranzaslog",grupo:"tabs",    label:"Cobranzas Log.",    desc:"Gestionar cobranzas de envíos y ver pagos de logísticas a clientes"},
  {key:"tab_liquidacionlog",grupo:"tabs",  label:"Liquidación Log.",  desc:"Registrar y controlar los pagos que se le realizan a cada logística"},
  {key:"tab_ctasctes",    grupo:"tabs",    label:"Ctas. Ctes.",       desc:"Estado de cuenta corriente por cliente: saldo pendiente, deuda y pagos"},
  {key:"tab_localidades", grupo:"tabs",    label:"Localidades",       desc:"Administrar localidades y partidos: agregar CPs y reglas de mapeo"},
  {key:"tab_expedicion",  grupo:"tabs",    label:"Expedición",        desc:"Vista de expedición para preparar bultos y controlar salidas"},
  {key:"tab_statsarmado",    grupo:"tabs",    label:"Stats Armado",      desc:"Estadísticas de armado: ranking de velocidad por armador, actividad por hora y log detallado de escaneos"},
  {key:"tab_consultaarmado", grupo:"tabs",    label:"Consulta Armado",   desc:"Consultar pedidos armados por rango de fecha; busca por nro de seguimiento, orden, venta, pack id, dirección, usuario o nombre"},
  {key:"tab_salida",      grupo:"tabs",    label:"Salida",            desc:"Escanear pedidos al entregarlos a la logística: despacho controlado por logística"},
  {key:"tab_usuarios",    grupo:"tabs",    label:"Usuarios",          desc:"Administrar usuarios del sistema, sus roles, contraseñas y permisos"},
  // ── Acciones ─────────────────────────────────────────────────────
  {key:"accion_cargaexcel",   grupo:"acciones", label:"Cargar Excel",       desc:"Importar envíos desde un archivo Excel con fecha de entrega seleccionable"},
  {key:"accion_asignartN",    grupo:"acciones", label:"Asignar TN",         desc:"Asignar logística a pedidos de Tienda Nube que aún no tienen transportista"},
  {key:"accion_editarenvio",  grupo:"acciones", label:"Editar envío",       desc:"Abrir el panel de edición de un envío: cambiar logística, turno, zona, cobranza, etc."},
  {key:"accion_cancelarenvio",grupo:"acciones", label:"Cancelar envíos",    desc:"Cancelar envíos seleccionados en modo selección múltiple"},
  {key:"accion_verimportes",  grupo:"acciones", label:"Ver importes",       desc:"Ver el importe calculado de cada envío en la lista"},
  {key:"accion_exportar",     grupo:"acciones", label:"Exportar Excel",     desc:"Exportar la lista filtrada de envíos o informes a un archivo Excel descargable"},
  {key:"accion_imprimir",     grupo:"acciones", label:"Imprimir etiquetas", desc:"Imprimir etiquetas de envíos individuales con código QR y datos de entrega"},
  {key:"accion_abonar",       grupo:"acciones", label:"Abonar logística",   desc:"Registrar el pago de una liquidación completa o parcial a la logística"},
  {key:"accion_autorizarcc",  grupo:"acciones", label:"Autorizar Cta. Corriente", desc:"Autorizar que un pedido de Tienda Nube con pago pendiente de acreditación pase a Cuenta Corriente, para poder asignarlo a una logística sin esperar el pago"},
  {key:"accion_verhistorialdespacho", grupo:"acciones", label:"Ver historial de despacho", desc:"Ver el registro histórico de envíos despachados, agrupado por fecha y logística"},
];

// Devuelve true si la sesión puede usar esa feature
// Admin: siempre true. Colaborador: true por defecto, salvo que permisos[key]===false.
function puedeVer(sesion,feature){
  if(!sesion)return false;
  if(sesion.rol==="admin")return true;
  if(sesion.rol!=="colaborador")return false;
  const p=sesion.permisos||{};
  return p[feature]!==false;
}


// ════════════════════════════════════════════════════════════════════
// IMPORTAR ETIQUETAS FLEX (PDF)
// ════════════════════════════════════════════════════════════════════
const cargarPDFLib=()=>new Promise(resolve=>{
  if(window.pdfjsLib){resolve(window.pdfjsLib);return;}
  const s=document.createElement("script");
  s.src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  s.onload=()=>{
    window.pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    resolve(window.pdfjsLib);
  };
  document.head.appendChild(s);
});


// ════════════════════════════════════════════════════════════════════
// ML ARMADO — helper para procesar PDF y descargar resultado
// ════════════════════════════════════════════════════════════════════
const ML_ARMADO_URL = "https://ml-armado.onrender.com";

async function procesarConMLArmado(file, envioType, onProgress, logisticaMap = {}) {
  // 1. Obtener estado actual (para continuar numeracion del dia)
  let startNumber = 1;
  try {
    const stateRes = await fetch(ML_ARMADO_URL + "/api/state");
    if (stateRes.ok) {
      const state = await stateRes.json();
      startNumber = envioType === "Flex"
        ? (state.flex_next || 1)
        : (state.colecta_next || 1);
    }
  } catch(e) { /* Si no responde usar 1 */ }

  if (onProgress) onProgress("Procesando con ML Armado (puede tardar ~1 min)...");

  // 2. Enviar PDF a ML Armado
  const formData = new FormData();
  formData.append("file", file);
  formData.append("start_number", String(startNumber));
  formData.append("header_offset", "20");
  formData.append("font_size_num", "30");
  formData.append("font_size_lbl", "25");
  formData.append("logistica_map", JSON.stringify(logisticaMap));
  // Keywords se toman del estado guardado en Firebase, no hace falta enviarlas

  const res = await fetch(ML_ARMADO_URL + "/api/process", {
    method: "POST",
    body: formData,
  });
  if (!res.ok) throw new Error("ML Armado error: " + res.status);
  const data = await res.json();

  // 3. Descargar el PDF anotado
  const dlUrl = ML_ARMADO_URL + "/api/download/" + data.filename;
  const a = document.createElement("a");
  a.href = dlUrl;
  a.download = data.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  return data;
}

const MESES_ES={"ENE":"01","FEB":"02","MAR":"03","ABR":"04","MAY":"05","JUN":"06","JUL":"07","AGO":"08","SEP":"09","OCT":"10","NOV":"11","DIC":"12"};
const parsarFechaFlex=(txt)=>{
  const m=txt.match(/FLEX\s+(\d{1,2})\s+([A-Z]{3})/i);
  if(!m)return"";
  const dia=String(m[1]).padStart(2,"0");
  const mes=MESES_ES[(m[2]||"").toUpperCase()]||"01";
  const anio=new Date().getFullYear();
  return`${anio}-${mes}-${dia}`;
};
const parsearEtiquetasPDF=async(file)=>{
  const lib=await cargarPDFLib();
  const buf=await file.arrayBuffer();
  const pdf=await lib.getDocument({data:buf}).promise;
  const etiquetas=[];
  for(let i=1;i<=pdf.numPages;i++){
    const page=await pdf.getPage(i);
    const tc=await page.getTextContent();
    const txt=tc.items.map(x=>x.str).join("\n");
    if(!txt.includes("FLEX")||!txt.includes("Destinatario:"))continue;
    const nroM=txt.match(/Envio:\s*(\d+)\s+(\d+)/i);
    if(!nroM)continue;
    const nroSeguimiento=(nroM[1]+nroM[2]).trim();
    const cpM=txt.match(/CP:\s*(\d{4,5})/);
    const tipoM=txt.match(/(COMERCIAL|RESIDENCIAL)/);
    const dirM=txt.match(/Direccion:\s*([^\n]+)/i);
    const barrioM=txt.match(/Barrio:\s*([^\n]+)/i);
    const refM=txt.match(/Referencia:\s*([\s\S]+?)(?=Destinatario:|$)/i);
    const destM=txt.match(/Destinatario:\s*([^\n]+)/i);
    etiquetas.push({
      nroSeguimiento,
      cp:cpM?cpM[1].trim():"",
      tipoEntrega:tipoM?tipoM[1]:"",
      direccion:dirM?dirM[1].trim():"",
      localidad:barrioM?barrioM[1].trim():"",
      referencia:refM?refM[1].replace(/\n/g," ").trim():"",
      destinatario:destM?destM[1].trim():"",
      fecha:parsarFechaFlex(txt),
    });
  }
  return etiquetas;
};

// ════════════════════════════════════════════════════════════════════
// IMPORTAR ETIQUETAS COLECTA (PDF) — formato distinto a FLEX:
// cada página trae "Pack ID:" (colecta) en vez de "Venta:" (flex/venta individual).
// ════════════════════════════════════════════════════════════════════
const parsarFechaColecta=(txt)=>{
  const m=txt.match(/Despachar:\s*\S+\s+(\d{1,2})\/([a-zA-Z]{3})/);
  if(!m)return"";
  const dia=String(m[1]).padStart(2,"0");
  const mes=MESES_ES[(m[2]||"").toUpperCase()]||"01";
  const anio=new Date().getFullYear();
  return`${anio}-${mes}-${dia}`;
};
const parsearEtiquetasColectaPDF=async(file)=>{
  const lib=await cargarPDFLib();
  const buf=await file.arrayBuffer();
  const pdf=await lib.getDocument({data:buf}).promise;
  const etiquetas=[];
  const noProcesadas=[]; // páginas que parecían etiqueta de colecta pero no se pudo extraer el nro de envío
  for(let i=1;i<=pdf.numPages;i++){
    const page=await pdf.getPage(i);
    const tc=await page.getTextContent();
    const txt=tc.items.map(x=>x.str).join("\n");
    if(/\bFLEX\b/.test(txt))continue; // etiqueta de Flex real (palabra FLEX a la izq. de la fecha), no es Colecta
    const idxDesp=txt.indexOf("Despachar:");
    const idxValida=txt.indexOf("Etiqueta válida para envíos");
    if(idxDesp<0&&idxValida<0)continue; // no es etiqueta individual (ej. página resumen "Identificación/Productos")
    // Nro de envío: el número impreso debajo del código de barras.
    // Formato A ("Despachar:"): dos grupos de 4-6 dígitos justo después del label (ej. "473609"+"22937").
    // Formato B ("Etiqueta válida para envíos"): número único de 8-15 dígitos en línea propia
    //   inmediatamente después de esa frase; en PDF.js puede llegar partido en dos items por cambio
    //   de fuente bold, por eso se intenta primero el número único y luego el par de chunks.
    let nroSeguimiento="";
    if(idxDesp>=0){
      const winDesp=txt.slice(idxDesp,idxDesp+200);
      const mBarra=winDesp.match(/(\d{4,6})\D+(\d{4,6})/);
      nroSeguimiento=mBarra?(mBarra[1]+mBarra[2]):"";
    } else {
      // Formato B: buscar número del código de barras después de "Etiqueta válida para envíos"
      const winValida=txt.slice(idxValida,idxValida+150);
      const mSingle=winValida.match(/\n(\d{8,15})\n/);        // número único
      if(mSingle){nroSeguimiento=mSingle[1];}
      else{
        const mDouble=winValida.match(/\n(\d{4,6})\n(\d{4,6})/); // partido en dos por bold
        if(mDouble)nroSeguimiento=mDouble[1]+mDouble[2];
      }
    }
    if(!nroSeguimiento){
      const packIdM0=txt.match(/Pack ID:\s*(\d{3,6})\s*(\d{6,})/);
      noProcesadas.push({pagina:i,packId:packIdM0?(packIdM0[1]+packIdM0[2]):""});
      continue;
    }
    // Nro de Venta y/o Nro de Pack ID: secundarios, puede haber uno, el otro, o ambos.
    const ventaM=txt.match(/Venta:\s*(\d{3,6})\s*(\d{6,})/);
    const nroVenta=ventaM?(ventaM[1]+ventaM[2]):"";
    const packIdM=txt.match(/Pack ID:\s*(\d{3,6})\s*(\d{6,})/);
    const nroPackId=packIdM?(packIdM[1]+packIdM[2]):"";
    // Destinatario y Usuario: el usuario siempre va entre paréntesis, a veces en la misma línea
    // que el nombre ("Juan Perez (JUANP123)") y a veces en la línea siguiente
    // ("Juan Perez" / "(JUANP123)"). Se buscan como dos campos separados.
    const lineas=txt.split("\n").map(s=>s.trim()).filter(Boolean);
    let destinatario="",usuario="";
    for(let li=0;li<lineas.length;li++){
      const soloUsuario=lineas[li].match(/^\(([A-Za-z0-9_ ]{4,})\)$/);
      if(soloUsuario){usuario=soloUsuario[1].trim();destinatario=(lineas[li-1]||"").trim();break;}
      const mismaLinea=lineas[li].match(/^(.+?)\s*\(([A-Za-z0-9_ ]{4,})\)$/);
      if(mismaLinea){destinatario=mismaLinea[1].trim();usuario=mismaLinea[2].trim();break;}
    }
    // Domicilio/CP/Ciudad/Referencia: opcionales — algunas colectas no traen dirección.
    const dirM=txt.match(/Domicilio:\s*([^\n]+)/);
    const cpM=txt.match(/CP:\s*(\d{3,5})/);
    const ciudadM=txt.match(/Ciudad de destino:\s*([^\n]+)/);
    const refM=txt.match(/Referencia:\s*([\s\S]*)/);
    etiquetas.push({
      nroSeguimiento,
      nroVenta,
      nroPackId,
      destinatario,
      usuario,
      direccion:dirM?dirM[1].trim():"",
      cp:cpM?cpM[1].trim():"",
      localidad:ciudadM?ciudadM[1].trim():"",
      referencia:refM?refM[1].replace(/\n/g," ").replace(/\s+/g," ").trim().slice(0,200):"",
      fecha:parsarFechaColecta(txt),
    });
  }
  return {etiquetas,noProcesadas};
};
function cargarXLSX() { return Promise.resolve(XLSXLib); }

const CP_P = {"1601":"La Plata","1607":"San Isidro","1608":"Tigre","1609":"San Isidro","1610":"Tigre","1611":"Tigre","1612":"Malvinas Argentinas","1613":"Malvinas Argentinas","1614":"Malvinas Argentinas","1615":"Malvinas Argentinas","1616":"Malvinas Argentinas","1617":"Tigre","1618":"Tigre","1619":"Escobar","1620":"Escobar","1621":"Tigre","1622":"Escobar","1623":"Escobar","1624":"Tigre","1625":"Escobar","1626":"Escobar","1627":"Escobar","1628":"Escobar","1629":"Pilar","1630":"Pilar","1631":"Pilar","1632":"Pilar","1633":"Pilar","1634":"Pilar","1635":"Pilar","1636":"Vicente Lopez","1637":"Vicente Lopez","1638":"Vicente Lopez","1640":"San Isidro","1641":"San Isidro","1642":"San Isidro","1643":"San Isidro","1644":"San Fernando","1645":"San Fernando","1646":"San Fernando","1647":"Zarate","1648":"Tigre","1649":"San Fernando","1650":"San Martin","1651":"San Martin","1653":"San Martin","1655":"San Martin","1657":"San Martin","1659":"San Miguel","1660":"Jose C Paz","1661":"San Miguel","1662":"San Miguel","1663":"San Miguel","1664":"Pilar","1665":"Jose C Paz","1666":"Jose C Paz","1667":"Pilar","1669":"Pilar","1670":"Tigre","1671":"Tigre","1672":"San Martin","1674":"Tres de Febrero","1675":"Tres de Febrero","1676":"Tres de Febrero","1678":"Tres de Febrero","1682":"Tres de Febrero","1683":"Tres de Febrero","1684":"Moron","1685":"Moron","1686":"Hurlingham","1687":"Tres de Febrero","1688":"Hurlingham","1689":"La Matanza Norte","1692":"Tres de Febrero","1702":"Tres de Febrero","1703":"Tres de Febrero","1704":"La Matanza Norte","1706":"Moron","1707":"Moron","1708":"Moron","1712":"Moron","1713":"Ituzaingo","1714":"Ituzaingo","1715":"Ituzaingo","1716":"Merlo","1718":"Merlo","1721":"Merlo","1722":"Merlo","1723":"Merlo","1724":"Merlo","1727":"Marcos Paz","1736":"Moreno","1738":"Moreno","1740":"Moreno","1742":"Moreno","1743":"Moreno","1744":"Moreno","1745":"Moreno","1746":"Moreno","1748":"Gral. Rodriguez","1749":"Gral. Rodriguez","1751":"La Matanza Norte","1752":"La Matanza Norte","1753":"La Matanza Norte","1754":"La Matanza Norte","1755":"La Matanza Norte","1757":"La Matanza Sur","1758":"La Matanza Sur","1759":"La Matanza Sur","1761":"La Matanza Norte","1763":"La Matanza Sur","1764":"La Matanza Sur","1765":"La Matanza Sur","1766":"La Matanza Norte","1768":"La Matanza Norte","1770":"La Matanza Norte","1771":"La Matanza Norte","1772":"La Matanza Norte","1774":"La Matanza Norte","1778":"La Matanza Norte","1785":"La Matanza Norte","1786":"La Matanza Sur","1801":"Ezeiza","1802":"Ezeiza","1803":"Ezeiza","1804":"Ezeiza","1805":"Esteban Echeverria","1806":"Ezeiza","1807":"Ezeiza","1808":"Canuelas","1812":"Canuelas","1813":"Ezeiza","1814":"Canuelas","1815":"Canuelas","1816":"Canuelas","1821":"Lomas de Zamora","1822":"Lanus","1823":"Lanus","1824":"Lanus","1825":"Lanus","1826":"Lanus","1827":"Lomas de Zamora","1828":"Lomas de Zamora","1829":"Lomas de Zamora","1831":"Lomas de Zamora","1832":"Lomas de Zamora","1833":"Lomas de Zamora","1834":"Lomas de Zamora","1835":"Lomas de Zamora","1836":"Lomas de Zamora","1837":"Berazategui","1838":"Esteban Echeverria","1839":"Esteban Echeverria","1840":"Quilmes","1841":"Esteban Echeverria","1842":"Esteban Echeverria","1843":"Almirante Brown","1844":"Almirante Brown","1845":"Almirante Brown","1846":"Almirante Brown","1847":"Almirante Brown","1848":"Almirante Brown","1849":"Almirante Brown","1851":"Almirante Brown","1852":"Almirante Brown","1853":"Florencio Varela","1854":"Almirante Brown","1855":"Almirante Brown","1856":"Almirante Brown","1858":"Presidente Peron","1859":"Florencio Varela","1860":"Berazategui","1861":"Berazategui","1862":"Presidente Peron","1863":"Florencio Varela","1864":"San Vicente","1865":"San Vicente","1867":"Florencio Varela","1868":"Avellaneda","1869":"Avellaneda","1870":"Avellaneda","1871":"Avellaneda","1872":"Avellaneda","1873":"Avellaneda","1874":"Avellaneda","1875":"Avellaneda","1876":"Quilmes","1877":"Quilmes","1878":"Quilmes","1879":"Quilmes","1880":"Berazategui","1881":"Quilmes","1882":"Quilmes","1883":"Quilmes","1884":"Berazategui","1885":"Berazategui","1886":"Berazategui","1887":"Florencio Varela","1888":"Florencio Varela","1889":"Florencio Varela","1890":"Berazategui","1891":"Florencio Varela","1893":"Berazategui","1894":"La Plata","1895":"La Plata","1896":"La Plata","1897":"La Plata","1900":"La Plata","1901":"La Plata","1902":"La Plata","1903":"La Plata","1904":"La Plata","1905":"La Plata","1906":"La Plata","1907":"La Plata","1908":"La Plata","1909":"La Plata","1910":"La Plata","1912":"La Plata","1914":"La Plata","1923":"Berisso","1924":"Berisso","1925":"Ensenada","1926":"Ensenada","1927":"Ensenada","1929":"Berisso","1931":"Ensenada","1984":"San Vicente","2800":"Zarate","2801":"Zarate","2802":"Zarate","2804":"Campana","2805":"Campana","2806":"Zarate","2808":"Zarate","2812":"Campana","2814":"Ex.de la Cruz","2816":"Campana","6700":"Lujan","6701":"Lujan","6702":"Lujan","6703":"Ex.de la Cruz","6706":"Lujan","6708":"Lujan","6712":"Lujan"};

function cpAPartido(cp) {
  const s = String(cp||"").replace(/\D/g,"");
  const n = parseInt(s);
  if (n >= 1000 && n <= 1499) return "CABA";
  if (CP_P[s]) return CP_P[s];
  try {
    const extra = JSON.parse(localStorage.getItem("envhub_cp_extra") || "{}");
    if (extra[s]) return extra[s];
  } catch(e) {}
  return "";
}

const ZONA_ML = {"CABA":"CABA","Avellaneda":"PL","Lanus":"PL","Quilmes":"PL","Lomas de Zamora":"LOMAS","Almirante Brown":"SUR","Berazategui":"SUR","Esteban Echeverria":"SUR","Florencio Varela":"SUR","Hurlingham":"NOE","Ituzaingo":"NOE","Jose C Paz":"NOE","La Matanza Norte":"NOE","La Matanza Sur":"NOE","Malvinas Argentinas":"NOE","Merlo":"NOE","Moreno":"NOE","Moron":"NOE","San Fernando":"NOE","San Isidro":"NOE","San Martin":"NOE","San Miguel":"NOE","Tigre":"NOE","Tres de Febrero":"NOE","Vicente Lopez":"NOE","La Plata":"GBA2","Zarate":"GBA2","Ensenada":"GBA2","Berisso":"GBA2","Escobar":"GBA2","Marcos Paz":"GBA2","Pilar":"GBA2","Presidente Peron":"GBA2","Canuelas":"GBA2","Lujan":"GBA2","Gral. Rodriguez":"GBA2","Ex.de la Cruz":"GBA2","San Vicente":"GBA2","Campana":"GBA2","Ezeiza":"GBA2"};
const ZONAS_ML_LIST = ["CABA","NOE","SUR","PL","LOMAS","GBA2"];
const ZONA_ML_COLOR = {CABA:"#84cc16",NOE:"#f59e0b",SUR:"#ef4444",PL:"#10b981",LOMAS:"#ec4899",GBA2:"#8b5cf6"};
const ZONA_ML_BG    = {CABA:"#0d1c04",NOE:"#1c1400",SUR:"#1c0404",PL:"#021a0e",LOMAS:"#1c0514",GBA2:"#130d2a"};
function getZonaML(p) { return ZONA_ML[p] || ""; }

function fechaLocal()  { const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().split("T")[0]; }
function fechaHoy()    { return fechaLocal(); }
function mkAudit(sesion){return sesion?{id:sesion.id,nombre:sesion.nombre||sesion.usuario||sesion.email||sesion.id,fecha:new Date().toISOString()}:null;}
function fechaAyer()   { const d=new Date();d.setDate(d.getDate()-1);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().split("T")[0]; }
function fechaManana() { const d=new Date();d.setDate(d.getDate()+1);return d.toISOString().split("T")[0]; }
function fechaInicioSemana() { const d=new Date();d.setDate(d.getDate()-((d.getDay()||7)-1));return d.toISOString().split("T")[0]; }
function fmtCorta(ds) { if(!ds)return"";const[,m,d]=ds.split("-");return d+"/"+m; }
const norm=s=>s?String(s).normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase():"";

// Genera el HTML completo del PDF de despacho a partir de datos serializados
function generarHTMLDespacho({logistica,fecha,envios:lista,pdfOrient="landscape",pdfFontSize:fs=14,pdfVersion="completa"}){
  const ahora=new Date();
  const ts=ahora.toLocaleDateString("es-AR",{weekday:"long",day:"numeric",month:"long",year:"numeric"})+" "+ahora.toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit",hour12:false});
  const totalImp=lista.reduce((s,e)=>s+(e.importe||0),0);
  const cobTotal=lista.filter(e=>e.cobranza>0).reduce((s,e)=>s+(e.cobranza||0),0);
  const hayCobro=lista.some(e=>e.cobranza>0);
  const esSimple=pdfVersion==="simple";
  const thPDF="background:#e8e8e8;padding:3px 4px;text-align:left;font-size:"+(fs-2)+"px;font-weight:700;text-transform:uppercase;color:#555;border-bottom:1.5px solid #333;";
  const rows=lista.map((e,i)=>{
    const esFlex=e.origen==="ML";
    const dir=[e.direccion,e.localidad,e.partido,e.cp].filter(Boolean).join(" · ");
    const dirCorta=(e.direccion||"").split("/")[0].split("-")[0].split(",")[0].trim();
    const nroRef=esFlex?(e.nroSeguimiento||e.id||""):("#"+(e.nroOrdenTN||""));
    const zml=esFlex?(getZonaML(e.partido)||""):(e.partido||"");
    const refExtra=(e.referencia&&!e.direccion.toLowerCase().includes((e.referencia||"").toLowerCase().slice(0,20)))?" — "+e.referencia:"";
    const cobrar=e.cobranza?"$"+Number(e.cobranza).toLocaleString("es-AR"):"—";
    const loteCell=e.loteImportacion?new Date(e.loteImportacion).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit",hour12:false}):"—";
    const tipoColor=e.tipoEntrega==="COMERCIAL"?"#1d4ed8":"#15803d";
    const tipoBg=e.tipoEntrega==="COMERCIAL"?"#dbeafe":"#dcfce7";
    const tipoCell=e.tipoEntrega?`<span style="background:${tipoBg};color:${tipoColor};border-radius:3px;padding:0 4px;font-size:${fs-2}px;font-weight:700;">${e.tipoEntrega==="COMERCIAL"?"COM":"RES"}</span>`:"—";
    if(esSimple)return`<tr style="background:${i%2===0?"#fff":"#f9f9f9"};border-bottom:0.5px solid #e5e7eb;page-break-inside:avoid;break-inside:avoid;">
      <td style="padding:3px 4px;text-align:center;color:#888;width:20px;">${i+1}</td>
      <td style="padding:3px 4px;width:50px;color:#16a34a;font-weight:700;font-size:${fs-1}px;">${loteCell}</td>
      <td style="padding:3px 4px;font-family:monospace;font-size:${fs-1}px;color:#444;width:100px;">${nroRef}</td>
      <td style="padding:3px 4px;text-align:center;width:35px;">${tipoCell}</td>
      <td style="padding:3px 4px;text-align:center;width:25px;font-weight:${(e.bultos||1)>1?700:400};">${e.bultos||1}</td>
      <td style="padding:3px 4px;text-align:center;width:18px;"><div style="width:11px;height:11px;border:1px solid #aaa;border-radius:1px;display:inline-block;"></div></td>
      <td style="padding:3px 4px;font-weight:700;"><strong>${dirCorta}</strong></td>
      <td style="padding:3px 4px;color:#555;">${(e.localidad&&!/referencia/i.test(e.localidad))?e.localidad:""}</td>
      <td style="padding:3px 4px;color:#555;">${e.partido||""}</td>
      <td style="padding:3px 4px;white-space:nowrap;font-size:${fs-1}px;">${zml}</td>
      <td style="padding:3px 4px;width:30px;text-align:center;">${e.turno||"—"}</td>
      <td style="padding:3px 4px;width:40px;text-align:center;">${e.fecha?fmtCorta(e.fecha):"—"}</td>
      ${hayCobro?`<td style="padding:3px 4px;width:70px;text-align:right;font-weight:${e.cobranza?"600":"400"};color:${e.cobranza?"#b45309":"#aaa"};">${cobrar}</td>`:""}
    </tr>`;
    const td=(w,extra,val)=>`<td style="border-bottom:0.5px solid #ddd;padding:3px 4px;${w?"width:"+w+"px;":""}${extra||""}">${val}</td>`;
    const dirHTML=(e.direccion?`<strong>${e.direccion}</strong>`:"")+[e.localidad,e.partido,e.cp].filter(Boolean).map(v=>" · "+v).join("")+refExtra;
    return`<tr style="background:${i%2===0?"#fff":"#f9f9f9"};page-break-inside:avoid;break-inside:avoid;">
      ${td(20,"text-align:center;color:#888;",i+1)}
      ${td(55,"text-align:center;font-size:"+(fs-2)+"px;font-weight:700;color:#16a34a;",loteCell)}
      ${td(110,"font-family:monospace;font-size:"+(fs-1)+"px;color:#444;",nroRef)}
      ${e.tipoEntrega?`<td style="border-bottom:0.5px solid #ddd;padding:3px 4px;width:38px;text-align:center;font-size:${fs-2}px;font-weight:700;color:${tipoColor};background:${tipoBg};">${e.tipoEntrega==="COMERCIAL"?"COM":"RES"}</td>`:`<td style="border-bottom:0.5px solid #ddd;padding:3px 4px;width:38px;text-align:center;color:#aaa;">—</td>`}
      ${td(28,"text-align:center;font-weight:"+(((e.bultos||1)>1)?700:400)+";",e.bultos||1)}
      <td style="border-bottom:0.5px solid #ddd;padding:3px 4px;width:18px;text-align:center;"><div style="width:11px;height:11px;border:1px solid #aaa;border-radius:1px;display:inline-block;"></div></td>
      ${td("","",dirHTML)}
      ${td("","white-space:nowrap;font-size:"+(fs-1)+"px;",zml)}
      ${td(32,"text-align:center;",e.turno||"—")}
      ${td(42,"text-align:center;",e.fecha?fmtCorta(e.fecha):"—")}
      ${hayCobro?td(72,"text-align:right;font-weight:"+(e.cobranza?600:400)+";color:"+(e.cobranza?"#b45309":"#aaa")+";",cobrar):""}
    </tr>`;
  }).join("");
  const headerRow=esSimple
    ?`<tr><th style="${thPDF}width:20px;">#</th><th style="${thPDF}width:50px;">Lote</th><th style="${thPDF}width:100px;">Nro envio</th><th style="${thPDF}width:35px;text-align:center;">Tipo</th><th style="${thPDF}width:25px;text-align:center;">Blts</th><th style="${thPDF}width:18px;text-align:center;">Chk</th><th style="${thPDF}">Direccion</th><th style="${thPDF}">Ciudad</th><th style="${thPDF}">Partido</th><th style="${thPDF}white-space:nowrap;">Zona</th><th style="${thPDF}width:30px;text-align:center;">Turno</th><th style="${thPDF}width:40px;text-align:center;">Fecha</th>${hayCobro?`<th style="${thPDF}width:70px;text-align:right;">Cobrar</th>`:""}</tr>`
    :`<tr><th style="${thPDF}width:20px;">#</th><th style="${thPDF}width:55px;text-align:center;">Lote</th><th style="${thPDF}width:100px;">Nro envio / orden</th><th style="${thPDF}width:38px;text-align:center;">Tipo</th><th style="${thPDF}width:28px;text-align:center;">Blts</th><th style="${thPDF}width:18px;text-align:center;">Chk</th><th style="${thPDF}">Direccion · Localidad · Partido · CP · Referencia</th><th style="${thPDF}white-space:nowrap;">Zona</th><th style="${thPDF}width:32px;text-align:center;">Turno</th><th style="${thPDF}width:42px;text-align:center;">Fecha</th>${hayCobro?`<th style="${thPDF}width:72px;text-align:right;">Cobrar</th>`:""}</tr>`;
  return`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Envios ${fecha||"hoy"}</title><style>
    @page{size:A4 ${pdfOrient};margin:8mm 10mm;}
    body{font-family:Arial,sans-serif;font-size:${fs}px;margin:0;color:#111;}
    table{width:100%;border-collapse:collapse;}
    th{${thPDF}}
    td{font-size:${fs}px;}
    thead{display:table-header-group;}
    .page-header{margin-bottom:4px;}
    @media print{button{display:none!important;}.page-header{page-break-inside:avoid;}}
  </style></head><body>
  <div class="page-header" style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;">
    <span style="font-weight:700;font-size:${fs+2}px;">${logistica} · ${ts}</span>
    <span style="font-size:${fs-1}px;color:#888;">${lista.length} envios · Total: $${Math.round(totalImp).toLocaleString("es-AR")}${cobTotal?" · A cobrar: $"+cobTotal.toLocaleString("es-AR"):""}</span>
  </div>
  <table><thead>${headerRow}</thead><tbody>${rows}</tbody></table>
  <div style="border-top:1.5px solid #333;margin-top:4px;padding-top:3px;font-size:${fs-2}px;color:#555;">${lista.length} envios</div>
  <script>window.onload=function(){window.print();};<\/script>
  </body></html>`;
}
// Valor de referencia que paga ML por envío (por partido)
const ML_FINAL={"CABA":6490,"Lomas de Zamora":6490,"Avellaneda":4490,"Lanus":4490,"Quilmes":4490,"Almirante Brown":8490,"Berazategui":8490,"Berisso":8490,"Campana":8490,"Canuelas":8490,"Ensenada":8490,"Escobar":8490,"Esteban Echeverria":8490,"Ezeiza":8490,"Florencio Varela":8490,"Gral. Rodriguez":8490,"Hurlingham":8490,"Ituzaingo":8490,"Jose C Paz":8490,"La Matanza Norte":8490,"La Matanza Sur":8490,"La Plata":8490,"Lujan":8490,"Malvinas Argentinas":8490,"Marcos Paz":8490,"Merlo":8490,"Moreno":8490,"Moron":8490,"Pilar":8490,"Presidente Peron":8490,"San Fernando":8490,"San Isidro":8490,"San Martin":8490,"San Miguel":8490,"San Vicente":8490,"Tigre":8490,"Tres de Febrero":8490,"Vicente Lopez":8490,"Zarate":8490};
const MESES={enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12};
function parseFechaES(str){const m=String(str||"").toLowerCase().match(/(\d+)\s+de\s+(\w+)\s+de\s+(\d{4})/);if(!m)return"";const mes=MESES[m[2]];if(!mes)return"";return m[3]+"-"+String(mes).padStart(2,"0")+"-"+String(m[1]).padStart(2,"0");}

// Columnas esperadas en el template propio
const TEMPLATE_COLS=["nro_seguimiento","direccion","ciudad","cp","fecha"];

function descargarTemplate(){
  const ws=XLSXLib.utils.aoa_to_sheet([
    ["nro_seguimiento","direccion","ciudad","cp","fecha"],
    ["42186559870","Corrientes 1820","CABA","1037","06/04/2026"],
    ["42186891240","Boyaca 340","Floresta","1407","06/04/2026"],
  ]);
  ws["!cols"]=[{wch:18},{wch:35},{wch:20},{wch:8},{wch:12}];
  const wb=XLSXLib.utils.book_new();
  XLSXLib.utils.book_append_sheet(wb,ws,"Envios");
  XLSXLib.writeFile(wb,"template_envios_flex.xlsx");
}

function parsearExcel(file) {
  return new Promise((resolve,reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Error al leer el archivo"));
    reader.onload = async (ev) => {
      try {
        const XLSX = await cargarXLSX();
        const wb = XLSX.read(new Uint8Array(ev.target.result),{type:"array",raw:false});
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const filas = XLSX.utils.sheet_to_json(sheet,{header:1,raw:false,defval:""});

        // Detectar si es template propio o formato ML
        let esTemplate=false;
        let hFila=-1;
        for(let i=0;i<Math.min(filas.length,5);i++){
          if(filas[i].some(c=>typeof c==="string"&&c.toLowerCase().includes("nro_seguimiento"))){hFila=i;esTemplate=true;break;}
        }
        if(!esTemplate){
          for(let i=0;i<Math.min(filas.length,15);i++){
            if(filas[i].some(c=>typeof c==="string"&&c.includes("# de venta"))){hFila=i;break;}
          }
        }
        if(hFila<0) throw new Error("Formato no reconocido. Usa el reporte de ML o la plantilla de EnviosHub.");

        const h=filas[hFila];
        const col=t=>h.findIndex(c=>typeof c==="string"&&c.toLowerCase().includes(t.toLowerCase()));
        const envios=[];

        if(esTemplate){
          // Formato template propio
          const iSeg=col("nro_seguimiento"),iDir=col("direccion"),iCiudad=col("ciudad"),iCP=col("cp"),iFecha=col("fecha");
          if(iDir<0||iSeg<0) throw new Error("El template no tiene las columnas correctas.");
          for(let i=hFila+1;i<filas.length;i++){
            const r=filas[i];
            const nroSeguimiento=String(r[iSeg]||"").trim();
            if(!nroSeguimiento) continue;
            const dir=String(r[iDir]||"").trim(); if(!dir) continue;
            const cp=String(r[iCP]||"").replace(/\D/g,"");
            const ciudad=String(r[iCiudad]||"").trim();
            const partido=cpAPartido(cp)||ciudad;
            const fechaVenta=parseFechaES(r[iFecha])||fechaHoy();
            const orden=nroSeguimiento;
            envios.push({id:orden,direccion:dir,ciudad,cp,fechaVenta,
              fecha:"",turno:"",trans:"",partido,importe:0,estado:"sin_asignar",
              nroSeguimiento,linkML:"https://www.mercadolibre.com.ar/ventas/"+orden+"/detalle",
              cobranza:null,cambio:null,retiro:null,observaciones:"",bultos:1,origen:"ML"});
          }
        } else {
          // Formato ML original
          const iOrden=col("# de venta"),iFecha=col("fecha"),iDir=col("domicilio");
          const iCiudad=col("ciudad"),iCP=col("postal"),iSeg=col("seguimiento");
          if(iDir<0) throw new Error("No se encontro la columna Domicilio.");
          for(let i=hFila+1;i<filas.length;i++){
            const r=filas[i];
            const orden=String(r[iOrden]||"").trim();
            if(!orden||orden.length<5||!/^\d/.test(orden)) continue;
            const dir=String(r[iDir]||"").trim(); if(!dir) continue;
            const cp=String(r[iCP]||"").replace(/\D/g,"");
            const fechaVenta=parseFechaES(r[iFecha]); if(!fechaVenta) continue;
            const partido=cpAPartido(cp)||String(r[iCiudad]||"").trim();
            const nroSeguimiento=String(r[iSeg]||"").trim();
            envios.push({id:orden,direccion:dir,ciudad:String(r[iCiudad]||"").trim(),cp,fechaVenta,
              fecha:"",turno:"",trans:"",partido,importe:0,estado:"sin_asignar",
              nroSeguimiento,linkML:"https://www.mercadolibre.com.ar/ventas/"+orden+"/detalle",
              cobranza:null,cambio:null,retiro:null,observaciones:"",bultos:1,origen:"ML"});
          }
        }
        if(envios.length===0) throw new Error("No se encontraron envios validos.");
        // Marcar todos los envios del lote con el mismo timestamp de importacion
        const lote=new Date().toISOString();
        envios.forEach(e=>{e.loteImportacion=lote;});
        resolve(envios);
      } catch(err) { reject(err); }
    };
    reader.readAsArrayBuffer(file);
  });
}

const LOGISTICAS_INIT = {
  CARLOS:  {nombre:"CARLOS", color:"#f59e0b",bg:"#1c1400",activa:true,preciosBultos:[{b:1,p:0},{b:2,p:0},{b:3,p:0}]},
  GUS:     {nombre:"GUS",    color:"#3b82f6",bg:"#0c1a2e",activa:true,preciosBultos:[{b:1,p:0},{b:2,p:0},{b:3,p:0}]},
  SYM:     {nombre:"SYM",    color:"#ec4899",bg:"#1c0514",activa:true,preciosBultos:[{b:1,p:0},{b:2,p:0},{b:3,p:0}]},
  HNOS:    {nombre:"HNOS",   color:"#8b5cf6",bg:"#130d2a",activa:true,preciosBultos:[{b:1,p:0},{b:2,p:0},{b:3,p:0}]},
  UMPAPEL: {nombre:"UMPAPEL",color:"#14b8a6",bg:"#042f2e",activa:true,preciosBultos:[{b:1,p:0},{b:2,p:0},{b:3,p:0}]},
  LOG_1:   {nombre:"LOG 1",  color:"#f97316",bg:"rgba(249,115,22,0.15)",activa:true,preciosBultos:[{b:1,p:0},{b:2,p:0},{b:3,p:0}]},
};

const TURNOS=["AM","PM"];
const ARM_COLORS=["#60a5fa","#34d399","#f472b6","#fb923c","#a78bfa","#fbbf24","#38bdf8","#f87171"];
const TURNO_C={AM:{c:"#60a5fa",bg:"#0c1a2e"},MD:{c:"#a78bfa",bg:"#130d2a"},PM:{c:"#93c5fd",bg:"#0c1a2e"},Turbo:{c:"#f472b6",bg:"#1c0514"}};
const ESTADO_C={sin_asignar:{t:"#f59e0b",bg:"#1c1400",label:"Sin asignar"},asignado:{t:"#34d399",bg:"#041f14",label:"Asignado"},cancelado:{t:"#f87171",bg:"#1c0a0a",label:"Cancelado"},no_cancelado:{t:"#e5e7eb",bg:"#1a1f2e",label:"Todos (sin cancelados)"}};
const PAGO_C={pagado:{t:"#34d399",bg:"#041f14",label:"Pagado"},pendiente:{t:"#fb923c",bg:"#1c0a00",label:"Pago pendiente"},cuenta_corriente:{t:"#a78bfa",bg:"#130d2a",label:"Cta. Corriente"}};
function getPagoEstado(e){return e.pagoEstado||"pagado";}
function puedeAsignar(e){const p=getPagoEstado(e);return p==="pagado"||p==="cuenta_corriente";}

const ZONAS_INIT={
  HNOS:{zonas:[{id:"CABA",nombre:"CABA",color:"#84cc16",precio:5808,partidos:["CABA"]},{id:"ZONA1",nombre:"ZONA 1",color:"#f97316",precio:5808,partidos:["San Isidro","Vicente Lopez","San Martin","Tres de Febrero","Moron","Hurlingham","La Matanza Norte","Lanus","Avellaneda"]},{id:"ZONA2",nombre:"ZONA 2",color:"#3b82f6",precio:7986,partidos:["Tigre","Malvinas Argentinas","Jose C Paz","San Miguel","Ituzaingo","Merlo","Ezeiza","Esteban Echeverria","Almirante Brown","Lomas de Zamora","Quilmes","Florencio Varela","Berazategui","San Fernando","La Matanza Sur"]},{id:"ZONA3",nombre:"ZONA 3",color:"#6b7280",precio:10164,partidos:["La Plata","Zarate","Ensenada","Berisso","Escobar","Marcos Paz","Pilar","Presidente Peron","Canuelas","Lujan","Gral. Rodriguez","Ex.de la Cruz","San Vicente","Campana","Moreno"]}]},
  CARLOS:{zonas:[{id:"CABA",nombre:"CABA",color:"#6366f1",precio:7371,partidos:["CABA"]},{id:"PL",nombre:"PL",color:"#10b981",precio:4611,partidos:["Avellaneda","Lanus","Quilmes"]},{id:"LOMAS",nombre:"LOMAS",color:"#ec4899",precio:7371,partidos:["Lomas de Zamora"]},{id:"NOE",nombre:"NOE",color:"#f59e0b",precio:10246,partidos:["Hurlingham","Ituzaingo","Jose C Paz","La Matanza Norte","La Matanza Sur","Malvinas Argentinas","Merlo","Moreno","Moron","San Fernando","San Isidro","San Martin","San Miguel","Tigre","Tres de Febrero","Vicente Lopez"]},{id:"SUR",nombre:"SUR",color:"#ef4444",precio:10246,partidos:["Almirante Brown","Berazategui","Esteban Echeverria","Florencio Varela"]},{id:"GBA2",nombre:"GBA2",color:"#8b5cf6",precio:0,partidos:["La Plata","Zarate","Ensenada","Berisso","Escobar","Marcos Paz","Pilar","Presidente Peron","Canuelas","Lujan","Gral. Rodriguez","Ex.de la Cruz","San Vicente","Campana","Ezeiza"]}]},
  GUS:{zonas:[{id:"CABA",nombre:"CABA",color:"#6366f1",precio:7371,partidos:["CABA"]},{id:"PL",nombre:"PL",color:"#10b981",precio:4611,partidos:["Avellaneda","Lanus","Quilmes"]},{id:"LOMAS",nombre:"LOMAS",color:"#ec4899",precio:7371,partidos:["Lomas de Zamora"]},{id:"NOE",nombre:"NOE",color:"#f59e0b",precio:10246,partidos:["Hurlingham","Ituzaingo","Jose C Paz","La Matanza Norte","La Matanza Sur","Malvinas Argentinas","Merlo","Moreno","Moron","San Fernando","San Isidro","San Martin","San Miguel","Tigre","Tres de Febrero","Vicente Lopez"]},{id:"SUR",nombre:"SUR",color:"#ef4444",precio:10246,partidos:["Almirante Brown","Berazategui","Esteban Echeverria","Florencio Varela"]},{id:"GBA2",nombre:"GBA2",color:"#8b5cf6",precio:0,partidos:["La Plata","Zarate","Ensenada","Berisso","Escobar","Marcos Paz","Pilar","Presidente Peron","Canuelas","Lujan","Gral. Rodriguez","Ex.de la Cruz","San Vicente","Campana","Ezeiza"]}]},
  DELFRAN:{zonas:[{id:"CABA",nombre:"CABA",color:"#6366f1",precio:6792,partidos:["CABA"]},{id:"PL",nombre:"PL",color:"#10b981",precio:4249,partidos:["Avellaneda","Lanus","Quilmes"]},{id:"LOMAS",nombre:"LOMAS",color:"#ec4899",precio:6792,partidos:["Lomas de Zamora"]},{id:"NOE",nombre:"NOE",color:"#f59e0b",precio:9443,partidos:["Hurlingham","Ituzaingo","Jose C Paz","La Matanza Norte","La Matanza Sur","Malvinas Argentinas","Merlo","Moreno","Moron","San Fernando","San Isidro","San Martin","San Miguel","Tigre","Tres de Febrero","Vicente Lopez"]},{id:"SUR",nombre:"SUR",color:"#ef4444",precio:9443,partidos:["Almirante Brown","Berazategui","Esteban Echeverria","Florencio Varela"]},{id:"GBA2",nombre:"GBA2",color:"#8b5cf6",precio:10246,partidos:["La Plata","Zarate","Ensenada","Berisso","Escobar","Marcos Paz","Pilar","Presidente Peron","Canuelas","Lujan","Gral. Rodriguez","Ex.de la Cruz","San Vicente","Campana","Ezeiza"]}]},
  SYM:{zonas:[{id:"CABA",nombre:"CABA",color:"#6366f1",precio:3509,partidos:["CABA"]},{id:"PL",nombre:"PL",color:"#10b981",precio:3509,partidos:["Avellaneda","Lanus"]},{id:"LOMAS",nombre:"LOMAS",color:"#ec4899",precio:3509,partidos:["Lomas de Zamora"]},{id:"QUILMES",nombre:"QUILMES",color:"#14b8a6",precio:7865,partidos:["Quilmes"]},{id:"NOE",nombre:"NOE",color:"#f59e0b",precio:7865,partidos:["Hurlingham","Ituzaingo","Jose C Paz","La Matanza Norte","La Matanza Sur","Malvinas Argentinas","Merlo","Moreno","Moron","San Fernando","San Isidro","San Martin","San Miguel","Tigre","Tres de Febrero","Vicente Lopez"]},{id:"SUR",nombre:"SUR",color:"#ef4444",precio:7865,partidos:["Almirante Brown","Berazategui","Esteban Echeverria","Florencio Varela"]},{id:"GBA2",nombre:"GBA2",color:"#8b5cf6",precio:10527,partidos:["La Plata","Zarate","Ensenada","Berisso","Escobar","Marcos Paz","Pilar","Presidente Peron","Canuelas","Lujan","Gral. Rodriguez","Ex.de la Cruz","San Vicente","Campana","Ezeiza"]}]},
  LOG_1:{zonas:[
    {id:"LOG1_PL",  nombre:"PL ($4.490)", color:"#10b981",precio:4490,partidos:["Avellaneda","Lanus","Quilmes"]},
    {id:"LOG1_CABA",nombre:"CABA/LOMAS ($6.490)",color:"#84cc16",precio:6490,partidos:["CABA","Lomas de Zamora"]},
    {id:"LOG1_GBA", nombre:"GBA ($8.490)", color:"#f97316",precio:8490,partidos:["Almirante Brown","Berazategui","Berisso","Campana","Canuelas","Ensenada","Escobar","Esteban Echeverria","Ezeiza","Florencio Varela","Gral. Rodriguez","Hurlingham","Ituzaingo","Jose C Paz","La Matanza Norte","La Matanza Sur","La Plata","Lujan","Malvinas Argentinas","Marcos Paz","Merlo","Moreno","Moron","Pilar","Presidente Peron","San Fernando","San Isidro","San Martin","San Miguel","San Vicente","Tigre","Tres de Febrero","Vicente Lopez","Zarate"]}
  ]}
};

const ALL_PARTIDOS=["CABA","Avellaneda","Lanus","Quilmes","Lomas de Zamora","Almirante Brown","Berazategui","Esteban Echeverria","Florencio Varela","Hurlingham","Ituzaingo","Jose C Paz","La Matanza Norte","La Matanza Sur","Malvinas Argentinas","Merlo","Moreno","Moron","San Fernando","San Isidro","San Martin","San Miguel","Tigre","Tres de Febrero","Vicente Lopez","La Plata","Zarate","Ensenada","Berisso","Escobar","Marcos Paz","Pilar","Presidente Peron","Canuelas","Lujan","Gral. Rodriguez","Ex.de la Cruz","San Vicente","Campana","Ezeiza"];

function buildTarifaMap(zc){const m={};Object.entries(zc).forEach(([l,c])=>c.zonas.forEach(z=>z.partidos.forEach(p=>{if(!m[p])m[p]={};m[p][l]=z.precio;})));return m;}
function getZonaLogistica(zc,trans,partido){return zc[trans]?zc[trans].zonas.find(z=>z.partidos.includes(partido))||null:null;}
function getMatrizVigente(cfg,fechaEnvio){
  // Devuelve la tarifaMatrix vigente para una fecha dada
  if(!cfg)return null;
  const fecha=fechaEnvio||fechaHoy();
  // Construir lista de versiones: [{desde, matrix}]
  const versiones=[
    {desde:cfg.tarifaVigenciaDesde||"2000-01-01",matrix:cfg.tarifaMatrix},
    ...(cfg.tarifaHistorial||[]).map(h=>({desde:h.vigenciaDesde,matrix:h.tarifaMatrix}))
  ].filter(v =>v.matrix).sort((a,b)=>b.desde.localeCompare(a.desde));
  // La mas reciente que sea <= fechaEnvio
  const v=versiones.find(v=>v.desde<=fecha);
  return v?.matrix||cfg.tarifaMatrix||null;
}

function calcImp(e,tmap,lc,zc){
  if(!e.trans)return 0;
  const bultos=e.bultos||1;
  const cfg=lc[e.trans];
  const fechaEnvio=e.fecha||e.fechaVenta||fechaHoy();
  const esFlex=e.origen==="ML";
  // Helper: intentar calcular desde un partido dado
  const calcDesdePartido=(partido)=>{
    if(!partido)return 0;
    if(zc){
      const zona=getZonaLogistica(zc,e.trans,partido);
      if(zona){
        let bk=bultos;
        if(bultos>=4&&bultos<=10)bk=10;
        else if(bultos>=11)bk=11;
        if(esFlex&&cfg?.tarifaMatrixFlex){const mxF=cfg.tarifaMatrixFlex[zona.id]||{};const pF=mxF[String(bk)];if(pF!==undefined&&pF>0)return pF;}
        const mx=getMatrizVigente(cfg,fechaEnvio);
        if(mx){const mxZ=mx[zona.id]||{};const p=mxZ[String(bk)];if(p!==undefined&&p>0)return p;}
      }
    }
    if(cfg&&bultos>1){const pb=cfg.preciosBultos?.find(x =>x.b===bultos);if(pb&&pb.p>0)return pb.p;}
    return tmap[partido]?.[e.trans]||0;
  };
  // 1. Intentar con el partido guardado
  const r1=calcDesdePartido(e.partido);
  if(r1>0)return r1;
  // 2. Fallback: derivar partido desde CP (cubre casos donde el partido guardado es una localidad)
  const partidoCP=e.cp?cpAPartido(String(e.cp)):"";
  if(partidoCP&&partidoCP!==e.partido){
    const r2=calcDesdePartido(partidoCP);
    if(r2>0)return r2;
  }
  return 0;
}

function getWeekNum(ds){const d=new Date(ds+"T00:00:00"),day=d.getDay()||7;d.setDate(d.getDate()+4-day);const y=new Date(d.getFullYear(),0,1);return{w:Math.ceil((((d-y)/86400000)+1)/7),y:d.getFullYear()};}
function weekLabel(ds){const d=new Date(ds+"T00:00:00"),day=d.getDay()||7;const mon=new Date(d);mon.setDate(d.getDate()-(day-1));const sun=new Date(mon);sun.setDate(mon.getDate()+6);const f=x=>String(x.getDate()).padStart(2,"0")+"/"+String(x.getMonth()+1).padStart(2,"0");return"Sem."+getWeekNum(ds).w+" ("+f(mon)+"-"+f(sun)+")";}

const fmt=n=>n?"$"+Number(n).toLocaleString("es-AR"):"-";
function beepOK(){try{const ctx=new(window.AudioContext||window.webkitAudioContext)();const o=ctx.createOscillator();const g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.frequency.setValueAtTime(880,ctx.currentTime);o.frequency.setValueAtTime(1100,ctx.currentTime+0.1);g.gain.setValueAtTime(0.3,ctx.currentTime);g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.3);o.start(ctx.currentTime);o.stop(ctx.currentTime+0.3);}catch(e){}}
function beepError(){try{const ctx=new(window.AudioContext||window.webkitAudioContext)();const o=ctx.createOscillator();const g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.type="sawtooth";o.frequency.setValueAtTime(280,ctx.currentTime);o.frequency.setValueAtTime(180,ctx.currentTime+0.15);g.gain.setValueAtTime(0.35,ctx.currentTime);g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.45);o.start(ctx.currentTime);o.stop(ctx.currentTime+0.45);}catch(e){}}

// Scoring de búsqueda — compartido entre VistaExpedicion y TabSalida
function scoreBusqueda(e,srch,nums){
  const sTN=String(e.nroOrdenTN||"");
  const sSeg=String(e.nroSeguimiento||"");
  if(sSeg===srch||sTN===srch||e.id===srch)return 3;
  if(nums&&(sSeg===nums||sTN===nums))return 3;
  if(nums&&sSeg&&(nums.startsWith(sSeg)||sSeg.startsWith(nums)))return 2;
  if(nums&&sTN&&(nums.startsWith(sTN)||sTN.startsWith(nums)))return 2;
  const s=norm(srch);
  if(s.length>=4&&(norm(e.direccion).includes(s)||norm(e.partido||"").includes(s)))return 1;
  return 0;
}
const fmtN=n=>Number(n).toLocaleString("es-AR");
const fmtHora=ts=>{if(!ts)return"";const d=new Date(ts);return d.getHours().toString().padStart(2,"0")+":"+d.getMinutes().toString().padStart(2,"0");};
const UMBRAL_ACTIVO_MIN=15; // pausa ≥ 15 min = corte de sesión activa
const fmtMin=m=>{if(!m||m<=0)return"";const h=Math.floor(m/60),mm=m%60;return h>0?h+"h "+String(mm).padStart(2,"0")+"m":mm+"m";};
const calcTiempoActivo=(times,umbralMin=UMBRAL_ACTIVO_MIN)=>{if(!times||times.length===0)return 0;const umbralMs=umbralMin*60000;let total=0,inicio=times[0];for(let i=1;i<times.length;i++){if(times[i]-times[i-1]>umbralMs){total+=times[i-1]-inicio;inicio=times[i];}}total+=times[times.length-1]-inicio;return Math.round(total/60000);};

function exportarXLSX(filas,nombreArchivo){
  const ws=XLSXLib.utils.json_to_sheet(filas);
  const wb=XLSXLib.utils.book_new();
  XLSXLib.utils.book_append_sheet(wb,ws,"Datos");
  XLSXLib.writeFile(wb,nombreArchivo+".xlsx");
}

const S={
  card:{background:"#1a1f2e",border:"1px solid #252d40",borderRadius:"14px"},
  input:{background:"#0f1420",border:"1px solid #252d40",borderRadius:"8px",padding:"0.45rem 0.75rem",color:"#e5e7eb",fontFamily:"sans-serif",fontSize:"0.85rem",outline:"none",boxSizing:"border-box"},
  btn:(on,col)=>({padding:"0.4rem 0.85rem",borderRadius:"8px",fontWeight:700,fontSize:"0.78rem",cursor:"pointer",border:"none",background:on?(col||"#6366f1"):"#12172a",color:on?"#fff":"#6b7280"}),
  btnSm:(on,col)=>({padding:"0.2rem 0.6rem",borderRadius:"6px",fontWeight:700,fontSize:"0.72rem",cursor:"pointer",border:"none",background:on?(col||"#6366f1"):"#0f1420",color:on?"#fff":"#6b7280"}),
  chip:(on,col,bg)=>({padding:"3px 10px",borderRadius:"20px",fontWeight:700,fontSize:"0.72rem",cursor:"pointer",border:"1px solid "+(on?col:"#252d40"),background:on?bg:"transparent",color:on?col:"#6b7280"}),
};
const thSt={padding:"0.5rem 0.8rem",textAlign:"left",color:"#6b7280",fontWeight:700,fontSize:"0.62rem",textTransform:"uppercase",letterSpacing:"0.06em",whiteSpace:"nowrap"};
const tdSt={padding:"0.4rem 0.8rem",whiteSpace:"nowrap"};

function Bdg({label,bg,t,style}){return <span style={{padding:"2px 8px",background:bg||"#252d40",color:t||"#9ca3af",borderRadius:"6px",fontSize:"0.67rem",fontWeight:700,whiteSpace:"nowrap",...style}}>{label}</span>;}
function Chk({checked,onChange,size=16}){return(<div onClick={onChange} style={{width:size,height:size,borderRadius:"4px",border:"1.5px solid "+(checked?"#6366f1":"#374151"),background:checked?"#6366f1":"transparent",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>{checked&&<svg width="10" height="8" viewBox="0 0 10 8"><path d="M1 4L3.5 6.5L9 1" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" fill="none"/></svg>}</div>);}


// ════════════════════════════════════════════════════════════════════
// PANTALLA LOGIN
// ════════════════════════════════════════════════════════════════════
function PantallaLogin({onLogin}){
  const [usuario,setUsuario]=useState("");
  const [password,setPassword]=useState("");
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(false);

  const handleLogin=async()=>{
    if(!usuario||!password){setError("Completá usuario y contraseña");return;}
    setLoading(true);setError("");
    try{
      const snap=await getDocs(query(collection(db,"usuarios"),where("usuario","==",usuario),where("activo","==",true),limit(1)));
      if(snap.empty){setError("Usuario o contraseña incorrectos");setLoading(false);return;}
      const data=snap.docs[0].data();
      if(data.password!==password){setError("Usuario o contraseña incorrectos");setLoading(false);return;}
      const sesion={id:snap.docs[0].id,...data};
      setSession(sesion);
      onLogin(sesion);
    }catch(e){setError("Error de conexion. Intentá de nuevo.");}
    setLoading(false);
  };

  return(
    <div style={{minHeight:"100vh",background:"#0a0e1a",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"sans-serif"}}>
      <style>{`*{box-sizing:border-box;}`}</style>
      <div style={{width:"100%",maxWidth:"380px",padding:"0 24px"}}>
        <div style={{textAlign:"center",marginBottom:"32px"}}>
          <div style={{width:"56px",height:"56px",background:"linear-gradient(135deg,#6366f1,#8b5cf6)",borderRadius:"14px",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"26px",margin:"0 auto 16px"}}>🛵</div>
          <div style={{fontWeight:800,fontSize:"1.5rem",color:"#fff"}}>EnviosHub</div>
          <div style={{color:"#4b5563",fontSize:"0.8rem",marginTop:"4px"}}>v{VERSION} · UMP Papel Distribuidora</div>
        </div>
        <div style={{background:"#1a1f2e",border:"1px solid #252d40",borderRadius:"16px",padding:"28px"}}>
          <div style={{marginBottom:"16px"}}>
            <div style={{color:"#6b7280",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",marginBottom:"6px"}}>Usuario</div>
            <input value={usuario} onChange={e=>setUsuario(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleLogin()} placeholder="tu usuario" style={{width:"100%",background:"#0f1420",border:"1px solid #252d40",borderRadius:"8px",padding:"0.55rem 0.75rem",color:"#e5e7eb",fontSize:"0.9rem",outline:"none"}}/>
          </div>
          <div style={{marginBottom:"20px"}}>
            <div style={{color:"#6b7280",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",marginBottom:"6px"}}>Contraseña</div>
            <input type="password" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleLogin()} placeholder="••••••••" style={{width:"100%",background:"#0f1420",border:"1px solid #252d40",borderRadius:"8px",padding:"0.55rem 0.75rem",color:"#e5e7eb",fontSize:"0.9rem",outline:"none"}}/>
          </div>
          {error&&<div style={{background:"#1c0a0a",border:"1px solid #7f1d1d",borderRadius:"8px",padding:"0.5rem 0.75rem",color:"#fca5a5",fontSize:"0.78rem",marginBottom:"16px"}}>{error}</div>}
          <button onClick={handleLogin} disabled={loading} style={{width:"100%",padding:"0.65rem",borderRadius:"10px",background:"linear-gradient(135deg,#6366f1,#8b5cf6)",color:"#fff",fontWeight:700,fontSize:"0.9rem",cursor:"pointer",border:"none",opacity:loading?0.7:1}}>
            {loading?"Ingresando...":"Ingresar"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PantallaAsignacion({borrador,fileName,onConfirmar,onCancelar,lc,envios=[],sesion=null}){
  const hoy=fechaHoy();
  const [asig,setAsig]=useState({});
  const [modo,setModo]=useState("zona");
  const [flotanteOpen,setFlotanteOpen]=useState(true);
  const logActivas=Object.entries(lc).filter(([,v])=>v.activa).map(([k])=>k);
  const getA=id=>asig[id]||{trans:"",fecha:hoy,turno:""};
  const setA=(id,k,v)=>setAsig(p=>({...p,[id]:{...getA(id),[k]:v}}));
  const setGrupo=(ids,k,v)=>setAsig(p=>{const n={...p};ids.forEach(id=>{n[id]={...getA(id),[k]:v}});return n;});
  const getGrupo=(ids,k)=>{const vals=[...new Set(ids.map(id=>getA(id)[k]||""))];return vals.length===1?vals[0]:"";};
  const grupos={};
  borrador.forEach(e=>{const key=modo==="zona"?(getZonaML(e.partido)||"Otra"):(e.partido||"Sin partido");if(!grupos[key])grupos[key]=[];grupos[key].push(e);});
  const grupoKeys=modo==="zona"?[...ZONAS_ML_LIST,"Otra"].filter(k =>grupos[k]):Object.keys(grupos).sort();
  const totalAsig=borrador.filter(e=>getA(e.id).trans).length;
  // Envíos con solo uno de los dos campos — no se puede confirmar hasta resolverlos
  const incompletos=borrador.filter(e=>{const a=getA(e.id);return(a.trans&&!a.turno)||(!a.trans&&a.turno);});
  // Envíos sin partido — bloquean la confirmación porque el costo no se puede calcular
  const sinPartido=borrador.filter(e=>!e.partido);
  const puedeConfirmar=incompletos.length===0&&sinPartido.length===0;
  const [confirmando,setConfirmando]=useState(false);
  const audit=mkAudit(sesion);
  const confirmar=()=>{if(!puedeConfirmar||confirmando)return;setConfirmando(true);onConfirmar(borrador.map(e=>({...e,...getA(e.id),estado:getA(e.id).trans?"asignado":"sin_asignar",...(getA(e.id).trans&&audit?{asignadoPor:audit}:{})})));};

  // === Resumen flotante: FLEX hoy ya en sistema + borrador en curso ===
  const flexHoy=envios.filter(e=>e.origen==="ML"&&e.trans&&e.estado!=="cancelado"&&(e.fecha||e.fechaVenta||"")===hoy);
  const borradorHoy=borrador.filter(e=>{const a=getA(e.id);return a.trans&&(a.fecha||hoy)===hoy;});
  const resumen={};
  logActivas.forEach(l=>{resumen[l]={};[...TURNOS,"—"].forEach(t=>{resumen[l][t]={ex:0,nc:0};});});
  flexHoy.forEach(e=>{const t=e.turno||"—";if(resumen[e.trans]&&resumen[e.trans][t]!==undefined)resumen[e.trans][t].ex++;});
  borradorHoy.forEach(e=>{const a=getA(e.id);const t=a.turno||"—";if(resumen[a.trans]&&resumen[a.trans][t]!==undefined)resumen[a.trans][t].nc++;});
  const logsConDatos=logActivas.filter(l=>[...TURNOS,"—"].some(t=>resumen[l][t].ex+resumen[l][t].nc>0));

  const imprimirLote=()=>{
    const asignados=borrador.filter(e=>getA(e.id).trans).map(e=>({...e,...getA(e.id)}));
    if(!asignados.length){alert("No hay envios asignados para imprimir.");return;}
    const porLog={};
    asignados.forEach(e=>{if(!porLog[e.trans])porLog[e.trans]=[];porLog[e.trans].push(e);});
    const ts=new Date().toLocaleString("es-AR",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
    const thSt="background:#e8e8e8;padding:3px 5px;text-align:left;font-size:9px;font-weight:700;text-transform:uppercase;color:#555;border-bottom:1.5px solid #333;";
    let body="";
    Object.entries(porLog).forEach(([log,envs])=>{
      const color=lc[log]?.color||"#6366f1";
      const rows=envs.map((e,i)=>{
        const dir=e.direccion+(e.referencia&&!e.direccion.toLowerCase().includes(e.referencia.toLowerCase().slice(0,20))?" — "+e.referencia:"");
        const loc=(e.localidad&&!/referencia/i.test(e.localidad))?e.localidad:"";
        return`<tr style="background:${i%2===0?"#fff":"#f9f9f9"}"><td style="text-align:center;padding:3px 5px;color:#888;border-bottom:0.5px solid #ddd;">${i+1}</td><td style="padding:3px 5px;font-weight:500;border-bottom:0.5px solid #ddd;">${dir}</td><td style="padding:3px 5px;color:#555;border-bottom:0.5px solid #ddd;">${loc}</td><td style="padding:3px 5px;color:#555;border-bottom:0.5px solid #ddd;">${e.partido||""}</td><td style="padding:3px 5px;color:#555;border-bottom:0.5px solid #ddd;">${e.cp||""}</td><td style="padding:3px 5px;font-family:monospace;font-size:9px;color:#444;border-bottom:0.5px solid #ddd;">${e.id}</td><td style="padding:3px 5px;text-align:center;border-bottom:0.5px solid #ddd;">${e.turno||"—"}</td><td style="padding:3px 5px;text-align:center;border-bottom:0.5px solid #ddd;">${e.fecha?fmtCorta(e.fecha):"—"}</td><td style="padding:3px 5px;text-align:center;border-bottom:0.5px solid #ddd;"><div style="width:11px;height:11px;border:1px solid #aaa;border-radius:1px;display:inline-block;"></div></td></tr>`;
      }).join("");
      body+=`<div style="margin-bottom:18px;"><div style="background:${color}22;border-left:4px solid ${color};padding:5px 10px;margin-bottom:4px;display:flex;justify-content:space-between;align-items:baseline;"><span style="font-weight:800;font-size:13px;color:${color};">${log}</span><span style="font-size:10px;color:#888;">${envs.length} envios</span></div><table style="width:100%;border-collapse:collapse;"><thead><tr><th style="${thSt}width:20px;">#</th><th style="${thSt}">Direccion</th><th style="${thSt}width:90px;">Localidad</th><th style="${thSt}width:90px;">Partido</th><th style="${thSt}width:45px;">CP</th><th style="${thSt}width:110px;">Nro envio</th><th style="${thSt}width:38px;">Turno</th><th style="${thSt}width:50px;">Fecha</th><th style="${thSt}width:18px;">Chk</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    });
    const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Lote FLEX ${ts}</title><style>@page{size:A4 portrait;margin:8mm 10mm;}body{font-family:Arial,sans-serif;font-size:11px;margin:0;color:#111;}@media print{button{display:none!important;}}</style></head><body><div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;border-bottom:2px solid #333;padding-bottom:4px;"><span style="font-weight:800;font-size:13px;">Lote FLEX — ${ts}</span><span style="font-size:10px;color:#888;">${asignados.length} envios · ${Object.keys(porLog).length} logisticas</span></div>${body}<script>window.onload=function(){window.print();}<\/script></body></html>`;
    const w=window.open("","_blank");w.document.write(html);w.document.close();
  };
  return(
    <div style={{minHeight:"100vh",background:"#0a0e1a",color:"#fff",fontFamily:"sans-serif"}}>
      <style>{`*{box-sizing:border-box;}select option{background:#1a1f2e;}@keyframes pulse{0%,100%{opacity:1;}50%{opacity:0.3;}}@keyframes spin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}`}</style>
      <div style={{position:"sticky",top:0,zIndex:100,background:"#0f1420",borderBottom:"1px solid #1a1f2e",padding:"0.75rem 1rem",display:"flex",alignItems:"center",gap:"0.75rem",flexWrap:"wrap"}}>
        <div style={{width:"28px",height:"28px",background:"linear-gradient(135deg,#6366f1,#8b5cf6)",borderRadius:"7px",display:"flex",alignItems:"center",justifyContent:"center"}}>🛵</div>
        <div><div style={{fontWeight:800,fontSize:"0.95rem"}}>Asignar envios</div><div style={{color:"#4b5563",fontSize:"0.62rem"}}>{fileName} · {borrador.length} envios</div></div>
        <div style={{display:"flex",gap:"4px"}}>
          <button onClick={()=>setModo("zona")} style={S.btn(modo==="zona","#6366f1")}>Por zona ML</button>
          <button onClick={()=>setModo("partido")} style={S.btn(modo==="partido","#6366f1")}>Por partido</button>
        </div>
        <div style={{marginLeft:"auto",display:"flex",gap:"0.5rem",alignItems:"center",flexWrap:"wrap"}}>
          <span style={{color:totalAsig===borrador.length?"#10b981":"#f59e0b",fontSize:"0.82rem",fontWeight:700}}>{totalAsig}/{borrador.length}</span>
          <button onClick={imprimirLote} disabled={totalAsig===0} style={{...S.btn(false),color:totalAsig>0?"#84cc16":"#4b5563",borderColor:totalAsig>0?"#84cc16":"#252d40",opacity:totalAsig>0?1:0.5}}>Imprimir lote</button>
          <button onClick={onCancelar} style={S.btn(false)}>Cancelar</button>
          <button onClick={confirmar} disabled={confirmando} style={{...S.btn(true),background:confirmando?"#1e2535":"linear-gradient(135deg,#6366f1,#8b5cf6)",display:"flex",alignItems:"center",gap:"6px"}}>
            {confirmando&&<span style={{width:"10px",height:"10px",border:"2px solid #a5b4fc",borderTopColor:"transparent",borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite"}}/>}
            {confirmando?"Guardando...":"Confirmar"}
          </button>
        </div>
      </div>
      <div style={{padding:"1rem",maxWidth:"980px",margin:"0 auto"}}>
        {incompletos.length>0&&(
          <div style={{background:"#1c0a00",border:"1px solid #92400e",borderRadius:"8px",padding:"8px 14px",marginBottom:"0.75rem",display:"flex",alignItems:"center",gap:"8px",flexWrap:"wrap"}}>
            <span style={{color:"#fbbf24",fontSize:"0.78rem",fontWeight:700}}>⚠ {incompletos.length} envío{incompletos.length>1?"s":""} con logística o turno incompleto</span>
            <span style={{color:"#78350f",fontSize:"0.72rem"}}>Asigná los dos campos o dejá ambos vacíos para continuar</span>
          </div>
        )}
        {sinPartido.length>0&&(
          <div style={{background:"#1c0a00",border:"1px solid #b45309",borderRadius:"8px",padding:"8px 14px",marginBottom:"0.75rem",display:"flex",alignItems:"center",gap:"8px",flexWrap:"wrap"}}>
            <span style={{color:"#fb923c",fontSize:"0.78rem",fontWeight:700}}>⚠ {sinPartido.length} envío{sinPartido.length>1?"s":""} sin partido definido</span>
            <span style={{color:"#78350f",fontSize:"0.72rem"}}>El costo logístico se calcula por partido — completá el campo antes de confirmar</span>
          </div>
        )}
        {grupoKeys.map(key=>{
          const grupo=grupos[key];const ids=grupo.map(e=>e.id);
          const gT=getGrupo(ids,"trans"),gF=getGrupo(ids,"fecha"),gTu=getGrupo(ids,"turno");
          const zcolor=modo==="zona"?(ZONA_ML_COLOR[key]||"#6b7280"):"#6b7280";
          const asigCount=ids.filter(id=>getA(id).trans).length;
          return(
            <div key={key} style={{...S.card,marginBottom:"0.75rem",overflow:"hidden"}}>
              <div style={{padding:"0.6rem 1rem",background:"#12172a",borderBottom:"1px solid #1e2535"}}>
                <div style={{display:"flex",alignItems:"center",gap:"0.5rem",marginBottom:"0.5rem",flexWrap:"wrap"}}>
                  <span style={{display:"inline-block",padding:"2px 10px",borderRadius:"20px",background:modo==="zona"?(ZONA_ML_BG[key]||"#1a1f2e"):"#1a1f2e",color:zcolor,fontWeight:800,fontSize:"0.82rem",border:"1px solid "+zcolor}}>{key}</span>
                  <span style={{color:"#4b5563",fontSize:"0.72rem"}}>{grupo.length} envios</span>
                  <span style={{color:asigCount===grupo.length?"#10b981":"#4b5563",fontSize:"0.7rem",marginLeft:"auto"}}>{asigCount}/{grupo.length}</span>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"70px 1fr",rowGap:"5px",columnGap:"0.75rem",alignItems:"center"}}>
                  <span style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase"}}>Logistica</span>
                  <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>
                    {logActivas.map(l =><button key={l} onClick={()=>setGrupo(ids,"trans",gT===l?"":l)} style={S.btnSm(gT===l,lc[l]?.color||"#6366f1")}>{l}</button>)}
                    {gT&&<button onClick={()=>setGrupo(ids,"trans","")} style={{...S.btnSm(false),color:"#6b7280",fontSize:"0.68rem"}}>x</button>}
                  </div>
                  <span style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase"}}>Fecha</span>
                  <div style={{display:"flex",gap:"3px",flexWrap:"wrap",alignItems:"center"}}>
                    <button onClick={()=>setGrupo(ids,"fecha",gF===fechaHoy()?"":fechaHoy())} style={S.btnSm(gF===fechaHoy(),"#6366f1")}>Hoy</button>
                    <button onClick={()=>{const d=fechaManana();setGrupo(ids,"fecha",gF===d?"":d);}} style={S.btnSm(gF===fechaManana(),"#6366f1")}>Manana</button>
                    <input type="date" value={gF||""} onChange={e=>setGrupo(ids,"fecha",e.target.value)} style={{...S.input,padding:"1px 6px",fontSize:"0.7rem",height:"22px",width:"112px"}}/>
                  </div>
                  <span style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase"}}>Turno</span>
                  <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>
                    {TURNOS.map(t =><button key={t} onClick={()=>setGrupo(ids,"turno",gTu===t?"":t)} style={S.btnSm(gTu===t,"#8b5cf6")}>{t}</button>)}
                  </div>
                </div>
              </div>
              {grupo.map((e,i)=>{
                const a=getA(e.id);
                const incompleto=(a.trans&&!a.turno)||(!a.trans&&a.turno);
                return(
                  <div key={e.id} style={{padding:"0.45rem 1rem",borderBottom:i<grupo.length-1?"1px solid #1a1f2e":"none",display:"flex",alignItems:"center",gap:"0.6rem",flexWrap:"wrap",background:incompleto?"#1c0a00":undefined,borderLeft:incompleto?"3px solid #f59e0b":"3px solid transparent"}}>
                    <div style={{flex:1,minWidth:"140px"}}>
                      <div style={{color:"#d1d5db",fontSize:"0.78rem"}}>{e.direccion.slice(0,68)}{e.direccion.length>68?"...":""}</div>
                      <div style={{color:"#4b5563",fontSize:"0.66rem",marginTop:"1px"}}>CP {e.cp} · {e.partido} · ...{e.id.slice(-8)}</div>
                    </div>
                    <div style={{display:"flex",gap:"3px",flexWrap:"wrap",alignItems:"center"}}>
                      {logActivas.map(l =><button key={l} onClick={()=>setA(e.id,"trans",a.trans===l?"":l)} style={S.btnSm(a.trans===l,lc[l]?.color||"#6366f1")}>{l}</button>)}
                      <span style={{color:"#252d40",padding:"0 2px"}}>|</span>
                      {TURNOS.map(t =><button key={t} onClick={()=>setA(e.id,"turno",a.turno===t?"":t)} style={S.btnSm(a.turno===t,"#8b5cf6")}>{t}</button>)}
                      {a.trans&&<Bdg label={a.fecha?fmtCorta(a.fecha):"sin fecha"} bg="#12172a" t="#6b7280"/>}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
        <div style={{display:"flex",justifyContent:"flex-end",gap:"0.75rem",marginTop:"1rem",paddingBottom:"5rem"}}>
          <button onClick={imprimirLote} disabled={totalAsig===0} style={{...S.btn(false),color:totalAsig>0?"#84cc16":"#4b5563",borderColor:totalAsig>0?"#84cc16":"#252d40",opacity:totalAsig>0?1:0.5}}>Imprimir lote</button>
          <button onClick={onCancelar} style={S.btn(false)}>Cancelar</button>
          <button onClick={confirmar} disabled={!puedeConfirmar||confirmando} title={!puedeConfirmar?[incompletos.length>0&&`${incompletos.length} incompletos`,sinPartido.length>0&&`${sinPartido.length} sin partido`].filter(Boolean).join(" · "):""} style={{...S.btn(true),background:puedeConfirmar&&!confirmando?"linear-gradient(135deg,#6366f1,#8b5cf6)":"#1e2535",color:puedeConfirmar&&!confirmando?"#fff":"#4b5563",border:puedeConfirmar&&!confirmando?"none":"1px solid #374151",padding:"0.55rem 1.4rem",cursor:puedeConfirmar&&!confirmando?"pointer":"not-allowed",opacity:1,display:"flex",alignItems:"center",gap:"6px"}}>
            {confirmando&&<span style={{width:"11px",height:"11px",border:"2px solid #a5b4fc",borderTopColor:"transparent",borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite"}}/>}
            {confirmando?`Guardando ${borrador.length} envíos...`:`Confirmar (${totalAsig}/${borrador.length})`}
            {!puedeConfirmar&&!confirmando&&<span style={{fontSize:"0.68rem",marginLeft:"5px",color:"#f59e0b"}}>⚠ {incompletos.length+sinPartido.length}</span>}
          </button>
        </div>
      </div>

      {/* FLOTANTE — resumen FLEX hoy por logística y turno */}
      <div style={{position:"fixed",bottom:"16px",right:"16px",zIndex:200,width:flotanteOpen?"360px":"auto",background:"#0f1420",border:"1px solid #252d40",borderRadius:"12px",boxShadow:"0 4px 24px rgba(0,0,0,0.6)",overflow:"hidden"}}>
        {/* Header */}
        <div onClick={()=>setFlotanteOpen(p=>!p)} style={{padding:"8px 12px",display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer",background:"#12172a",borderBottom:flotanteOpen?"1px solid #252d40":"none"}}>
          <div style={{display:"flex",alignItems:"center",gap:"6px"}}>
            <span style={{fontSize:"0.72rem",fontWeight:700,color:"#e5e7eb"}}>FLEX hoy</span>
            <span style={{background:"#1a1f2e",border:"1px solid #252d40",borderRadius:"5px",padding:"1px 7px",fontSize:"0.68rem",color:"#9ca3af"}}>{flexHoy.length} exist · <span style={{color:"#818cf8"}}>{borradorHoy.length} asig</span></span>
          </div>
          <span style={{color:"#6b7280",fontSize:"0.75rem"}}>{flotanteOpen?"▼":"▲"}</span>
        </div>
        {/* Tabla */}
        {flotanteOpen&&(
          <div style={{padding:"8px 10px",overflowY:"auto",maxHeight:"340px"}}>
            {logsConDatos.length===0&&<div style={{color:"#4b5563",fontSize:"0.72rem",textAlign:"center",padding:"8px"}}>Sin envíos FLEX hoy aún</div>}
            {logsConDatos.length>0&&(
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:"0.72rem"}}>
                <thead>
                  <tr style={{borderBottom:"1px solid #1a1f2e"}}>
                    <th style={{textAlign:"left",padding:"3px 6px",color:"#4b5563",fontWeight:600}}>Log.</th>
                    {TURNOS.map(t=><th key={t} style={{textAlign:"center",padding:"3px 5px",color:"#4b5563",fontWeight:600,width:"44px"}}>{t}</th>)}
                    <th style={{textAlign:"center",padding:"3px 5px",color:"#4b5563",fontWeight:600,width:"40px"}}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {logsConDatos.map(l=>{
                    const lcol=lc[l]?.color||"#6366f1";
                    const totalEx=[...TURNOS,"—"].reduce((s,t)=>s+resumen[l][t].ex,0);
                    const totalNc=[...TURNOS,"—"].reduce((s,t)=>s+resumen[l][t].nc,0);
                    return(
                      <tr key={l} style={{borderBottom:"1px solid #1a1f2e"}}>
                        <td style={{padding:"4px 6px",fontWeight:700,color:lcol}}>{l}</td>
                        {TURNOS.map(t=>{
                          const ex=resumen[l][t].ex;
                          const nc=resumen[l][t].nc;
                          return(
                            <td key={t} style={{textAlign:"center",padding:"4px 2px"}}>
                              {(ex+nc)===0?<span style={{color:"#1e2535"}}>—</span>:(
                                <span>
                                  {ex>0&&<span style={{color:"#6b7280"}}>{ex}</span>}
                                  {ex>0&&nc>0&&<span style={{color:"#374151"}}>+</span>}
                                  {nc>0&&<span style={{color:"#818cf8",fontWeight:700}}>{nc}</span>}
                                </span>
                              )}
                            </td>
                          );
                        })}
                        <td style={{textAlign:"center",padding:"4px 5px",fontWeight:700}}>
                          {totalEx>0&&<span style={{color:"#9ca3af"}}>{totalEx}</span>}
                          {totalEx>0&&totalNc>0&&<span style={{color:"#374151"}}>+</span>}
                          {totalNc>0&&<span style={{color:"#818cf8"}}>{totalNc}</span>}
                          {totalEx===0&&totalNc===0&&<span style={{color:"#1e2535"}}>—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <div style={{marginTop:"6px",fontSize:"0.62rem",color:"#374151",display:"flex",gap:"10px"}}>
              <span><span style={{color:"#6b7280"}}>■</span> ya en sistema</span>
              <span><span style={{color:"#818cf8"}}>■</span> asignando ahora</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}



// ════════════════════════════════════════════════════════════════════
// MODAL OPCIONES PDF FLEX
// ════════════════════════════════════════════════════════════════════
function ModalOpcionesPDF({onConfirm, onCancel}){
  const [cargarEnvios, setCargarEnvios] = useState(true);
  const [procesarArmado, setProcesarArmado] = useState(true);
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{background:"#12172a",border:"1px solid #6366f1",borderRadius:"16px",padding:"28px 32px",minWidth:"320px",boxShadow:"0 8px 40px #0008"}}>
        <div style={{color:"#e5e7eb",fontWeight:800,fontSize:"1rem",marginBottom:"6px"}}>¿Qué querés hacer con este PDF?</div>
        <div style={{color:"#6b7280",fontSize:"0.75rem",marginBottom:"20px"}}>Podés elegir una o ambas opciones</div>
        <div style={{display:"flex",flexDirection:"column",gap:"12px",marginBottom:"24px"}}>
          <label style={{display:"flex",alignItems:"center",gap:"12px",cursor:"pointer",padding:"12px 16px",background:cargarEnvios?"#1a2640":"#0f1420",border:"1px solid "+(cargarEnvios?"#6366f1":"#252d40"),borderRadius:"10px",transition:"all 0.15s"}}>
            <input type="checkbox" checked={cargarEnvios} onChange={e=>setCargarEnvios(e.target.checked)} style={{width:"16px",height:"16px",accentColor:"#6366f1"}}/>
            <div>
              <div style={{color:"#e5e7eb",fontWeight:700,fontSize:"0.85rem"}}>Cargar / actualizar envíos</div>
              <div style={{color:"#6b7280",fontSize:"0.72rem",marginTop:"2px"}}>Crea o actualiza los envíos en EnviosHub</div>
            </div>
          </label>
          <label style={{display:"flex",alignItems:"center",gap:"12px",cursor:"pointer",padding:"12px 16px",background:procesarArmado?"#0d1c04":"#0f1420",border:"1px solid "+(procesarArmado?"#84cc16":"#252d40"),borderRadius:"10px",transition:"all 0.15s"}}>
            <input type="checkbox" checked={procesarArmado} onChange={e=>setProcesarArmado(e.target.checked)} style={{width:"16px",height:"16px",accentColor:"#84cc16"}}/>
            <div>
              <div style={{color:"#e5e7eb",fontWeight:700,fontSize:"0.85rem"}}>Procesar armado</div>
              <div style={{color:"#6b7280",fontSize:"0.72rem",marginTop:"2px"}}>Anota el PDF con numeración y resaltado (ML Armado)</div>
            </div>
          </label>
        </div>
        <div style={{display:"flex",gap:"10px",justifyContent:"flex-end"}}>
          <button onClick={onCancel} style={{background:"#1a1f2e",border:"1px solid #252d40",color:"#9ca3af",padding:"8px 20px",borderRadius:"8px",cursor:"pointer",fontSize:"0.82rem"}}>Cancelar</button>
          <button onClick={()=>onConfirm({cargarEnvios,procesarArmado})} disabled={!cargarEnvios&&!procesarArmado} style={{background:(!cargarEnvios&&!procesarArmado)?"#252d40":"linear-gradient(135deg,#6366f1,#8b5cf6)",color:"#fff",border:"none",padding:"8px 24px",borderRadius:"8px",cursor:(!cargarEnvios&&!procesarArmado)?"not-allowed":"pointer",fontWeight:700,fontSize:"0.82rem"}}>Continuar</button>
        </div>
      </div>
    </div>
  );
}

function ModalOpcionesColecta({onConfirm, onCancel}){
  const [cargarColectas, setCargarColectas] = useState(true);
  const [procesarArmado, setProcesarArmado] = useState(true);
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{background:"#12172a",border:"1px solid #a78bfa",borderRadius:"16px",padding:"28px 32px",minWidth:"320px",boxShadow:"0 8px 40px #0008"}}>
        <div style={{color:"#e5e7eb",fontWeight:800,fontSize:"1rem",marginBottom:"6px"}}>¿Qué querés hacer con este PDF de Colecta?</div>
        <div style={{color:"#6b7280",fontSize:"0.75rem",marginBottom:"20px"}}>Podés elegir una o ambas opciones</div>
        <div style={{display:"flex",flexDirection:"column",gap:"12px",marginBottom:"24px"}}>
          <label style={{display:"flex",alignItems:"center",gap:"12px",cursor:"pointer",padding:"12px 16px",background:cargarColectas?"#1a0d2e":"#0f1420",border:"1px solid "+(cargarColectas?"#a78bfa":"#252d40"),borderRadius:"10px",transition:"all 0.15s"}}>
            <input type="checkbox" checked={cargarColectas} onChange={e=>setCargarColectas(e.target.checked)} style={{width:"16px",height:"16px",accentColor:"#a78bfa"}}/>
            <div>
              <div style={{color:"#e5e7eb",fontWeight:700,fontSize:"0.85rem"}}>Cargar colectas pendientes</div>
              <div style={{color:"#6b7280",fontSize:"0.72rem",marginTop:"2px"}}>Registra cada colecta en EnviosHub para poder trazar quién la armó</div>
            </div>
          </label>
          <label style={{display:"flex",alignItems:"center",gap:"12px",cursor:"pointer",padding:"12px 16px",background:procesarArmado?"#0d1c04":"#0f1420",border:"1px solid "+(procesarArmado?"#84cc16":"#252d40"),borderRadius:"10px",transition:"all 0.15s"}}>
            <input type="checkbox" checked={procesarArmado} onChange={e=>setProcesarArmado(e.target.checked)} style={{width:"16px",height:"16px",accentColor:"#84cc16"}}/>
            <div>
              <div style={{color:"#e5e7eb",fontWeight:700,fontSize:"0.85rem"}}>Procesar armado</div>
              <div style={{color:"#6b7280",fontSize:"0.72rem",marginTop:"2px"}}>Anota el PDF con numeración y resaltado (ML Armado)</div>
            </div>
          </label>
        </div>
        <div style={{display:"flex",gap:"10px",justifyContent:"flex-end"}}>
          <button onClick={onCancel} style={{background:"#1a1f2e",border:"1px solid #252d40",color:"#9ca3af",padding:"8px 20px",borderRadius:"8px",cursor:"pointer",fontSize:"0.82rem"}}>Cancelar</button>
          <button onClick={()=>onConfirm({cargarColectas,procesarArmado})} disabled={!cargarColectas&&!procesarArmado} style={{background:(!cargarColectas&&!procesarArmado)?"#252d40":"linear-gradient(135deg,#a78bfa,#8b5cf6)",color:"#fff",border:"none",padding:"8px 24px",borderRadius:"8px",cursor:(!cargarColectas&&!procesarArmado)?"not-allowed":"pointer",fontWeight:700,fontSize:"0.82rem"}}>Continuar</button>
        </div>
      </div>
    </div>
  );
}

function PanelEdit({envio,onSave,onClose,lc,envios=[],onSaveMultiple,getImp,esAdmin=false,sesion=null}){
  const [e,setE]=useState({...envio});
  const set=(k,v)=>setE(p=>({...p,[k]:v}));
  const [costoOverride,setCostoOverride]=useState(envio.importeOverride>0?envio.importeOverride:null);
  const [editandoCosto,setEditandoCosto]=useState(false);
  const [dividido,setDividido]=useState(false);
  const costoBase=getImp?getImp(envio):0;
  const costoMostrar=costoOverride!==null?costoOverride:costoBase;
  const normDir=d=>(d||"").toLowerCase().trim().replace(/\s+/g," ");
  const duplicados=envios.filter(o=>o.id!==envio.id&&o.fecha===envio.fecha&&normDir(o.direccion)===normDir(envio.direccion)&&getEstado(o)!=="cancelado");
  const handleDividir=()=>{
    const total=costoMostrar||costoBase;
    const n=duplicados.length+1;
    const porPedido=Math.round(total/n);
    setCostoOverride(porPedido);
    if(onSaveMultiple)onSaveMultiple(duplicados.map(d=>({...d,importeOverride:porPedido})));
    setDividido(true);
  };
  const [guardando,setGuardando]=useState(false);
  const audit=mkAudit(sesion);
  const transAsignado=e.trans&&e.trans!==envio.trans;
  // Si el envío ya fue despachado y se cambia fecha/turno/logística → marcar reprogramado
  const esReprogramado=envio.despachado&&(e.fecha!==envio.fecha||e.turno!==envio.turno||e.trans!==envio.trans);
  const handleSave=()=>{setGuardando(true);onSave({...e,importeOverride:costoOverride||null,
    ...(esReprogramado?{reprogramado:true}:{}),
    ...(audit?{ultimaEdicionPor:audit}:{}),
    ...(transAsignado&&audit?{asignadoPor:audit}:{}),
    ...(costoOverride!==null&&costoOverride!==(envio.importeOverride||null)&&audit?{importeEditadoPor:audit}:{})});}
  const logActivas=Object.entries(lc).filter(([,v])=>v.activa).map(([k])=>k);
  const handleTrans=l=>{const t=e.trans===l?"":l;setE(p=>({...p,trans:t,estado:t?"asignado":(p.estado==="cancelado"?"cancelado":"sin_asignar")}));};
  // Cuando un envío ya despachado pasa a Cancelado, se marca devolucionPendiente + Sin cargo en liq.
  const handleEstado=v=>{
    if(v==="cancelado"&&envio.despachado){
      setE(p=>({...p,estado:v,devolucionPendiente:true,estadoLiq:"cancelado_liq"}));
    } else {
      set("estado",v);
    }
  };
  const esTN = e.origen === "Tienda Nube";
  const confirmado=envio.estadoPago==="confirmado"||envio.estadoPago==="abonado";
  const bloqueado=confirmado&&!esAdmin;
  const handleConfirmar=()=>onSave({...e,importeOverride:costoOverride||null,estadoPago:"confirmado",estadoPagoFecha:fechaHoy()});
  const handleDesconfirmar=()=>onSave({...e,importeOverride:costoOverride||null,estadoPago:envio.estadoPago==="abonado"?"confirmado":null,estadoPagoFecha:null});
  const pagoOk = puedeAsignar(e);
  const autorizarCC=()=>setE(p=>({...p,pagoEstado:"cuenta_corriente"}));
  return(
    <div style={{background:"#12172a",border:"1px solid #6366f1",borderRadius:"12px",padding:"0.9rem 1rem",marginTop:"2px"}}>

      {/* Datos TN — solo lectura */}
      {esTN && (
        <div style={{...S.card,padding:"0.65rem 1rem",marginBottom:"0.75rem",background:"#0d1119",border:"1px solid #1e2535"}}>
          <div style={{color:"#6366f1",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"6px"}}>Datos de Tienda Nube</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.35rem 1rem",fontSize:"0.78rem"}}>
            {e.clienteNombre&&<div><span style={{color:"#6b7280"}}>Cliente: </span><span style={{color:"#e5e7eb"}}>{e.clienteNombre}</span></div>}
            {e.telefono&&<div><span style={{color:"#6b7280"}}>Tel: </span><span style={{color:"#e5e7eb"}}>{e.telefono}</span></div>}
            {e.formaPago&&<div><span style={{color:"#6b7280"}}>Pago: </span><span style={{color:"#e5e7eb"}}>{e.formaPago}</span></div>}
            {e.importeOrden>0&&<div><span style={{color:"#6b7280"}}>Total orden: </span><span style={{color:"#10b981",fontWeight:700}}>${Number(e.importeOrden).toLocaleString("es-AR")}</span></div>}
          </div>
          {e.notasCliente&&<div style={{marginTop:"6px",padding:"5px 8px",background:"#12172a",borderRadius:"6px",fontSize:"0.75rem",color:"#9ca3af",fontStyle:"italic"}}>
            <span style={{color:"#6b7280",fontStyle:"normal",fontWeight:700,fontSize:"0.62rem",textTransform:"uppercase"}}>Notas del cliente: </span>{e.notasCliente}
          </div>}
          {e.datepickerRaw&&<div style={{marginTop:"4px",fontSize:"0.7rem",color:"#4b5563"}}>📅 {e.datepickerRaw}</div>}
          {e.linkTN&&<a href={e.linkTN} target="_blank" rel="noreferrer" style={{display:"inline-block",marginTop:"6px",fontSize:"0.7rem",color:"#6366f1",textDecoration:"none"}}>Ver orden en Tienda Nube →</a>}
        </div>
      )}

      {/* Bloque pago pendiente — solo TN */}
      {esTN && e.pagoEstado === "pendiente" && (
        <div style={{background:"#1c0a00",border:"1px solid #fb923c",borderRadius:"10px",padding:"0.65rem 1rem",marginBottom:"0.75rem",display:"flex",alignItems:"center",gap:"0.75rem",flexWrap:"wrap"}}>
          <span style={{fontSize:"1.1rem"}}>⚠️</span>
          <div style={{flex:1}}>
            <div style={{color:"#fb923c",fontWeight:700,fontSize:"0.85rem"}}>Pago pendiente de acreditacion</div>
            <div style={{color:"#9ca3af",fontSize:"0.72rem",marginTop:"2px"}}>El pago no fue confirmado. Podés esperar o autorizar la entrega igualmente.</div>
          </div>
          {puedeVer(sesion,"accion_autorizarcc")
            ?<button onClick={autorizarCC} style={{...S.btn(true,"#7c3aed"),padding:"0.35rem 0.9rem",fontSize:"0.72rem",whiteSpace:"nowrap"}}>Autorizar — Cta. Corriente</button>
            :<span style={{fontSize:"0.68rem",color:"#6b7280",fontStyle:"italic",whiteSpace:"nowrap"}}>No tenés permiso para autorizar</span>}
        </div>
      )}
      {esTN && e.pagoEstado === "cuenta_corriente" && (
        <div style={{background:"#130d2a",border:"1px solid #a78bfa",borderRadius:"10px",padding:"0.5rem 1rem",marginBottom:"0.75rem",display:"flex",alignItems:"center",gap:"0.5rem"}}>
          <span style={{color:"#a78bfa",fontWeight:700,fontSize:"0.82rem"}}>✓ Autorizado como Cuenta Corriente</span>
        </div>
      )}

      {/* Banner reprogramado */}
      {envio.reprogramado&&(
        <div style={{background:"#1c1500",border:"1px solid #78350f",borderRadius:"10px",padding:"0.5rem 1rem",marginBottom:"0.75rem",display:"flex",alignItems:"center",gap:"0.6rem"}}>
          <span style={{fontSize:"1.1rem"}}>⟳</span>
          <div style={{flex:1}}>
            <div style={{color:"#fbbf24",fontWeight:700,fontSize:"0.85rem"}}>Envío reprogramado</div>
            <div style={{color:"#9ca3af",fontSize:"0.72rem",marginTop:"2px"}}>Este envío fue despachado y luego se modificó su fecha, turno o logística.</div>
          </div>
        </div>
      )}

      {/* Banner confirmado/abonado */}
      {confirmado&&(
        <div style={{background:envio.estadoPago==="abonado"?"#041f14":"#0f0b2a",border:"1px solid "+(envio.estadoPago==="abonado"?"#065f46":"#4c1d95"),borderRadius:"8px",padding:"0.5rem 1rem",marginBottom:"0.65rem",display:"flex",alignItems:"center",justifyContent:"space-between",gap:"0.5rem"}}>
          <div>
            <div style={{color:envio.estadoPago==="abonado"?"#34d399":"#a78bfa",fontWeight:700,fontSize:"0.82rem"}}>{envio.estadoPago==="abonado"?"✓ Abonado a la logística":"🔒 Confirmado — envío anclado"}</div>
            {!esAdmin&&<div style={{color:"#4b5563",fontSize:"0.68rem",marginTop:"2px"}}>Solo administradores pueden modificar este envío</div>}
          </div>
          {esAdmin&&<button onClick={handleDesconfirmar} style={{...S.btnSm(false),color:"#f59e0b",borderColor:"#78350f",fontSize:"0.7rem",flexShrink:0}}>↩ Desconfirmar</button>}
        </div>
      )}
      {/* Wrapper de bloqueo */}
      <div style={{opacity:bloqueado?0.45:1,pointerEvents:bloqueado?"none":"auto"}}>
      {/* Costo logística editable */}
      <div style={{display:"flex",alignItems:"center",gap:"0.6rem",marginBottom:"0.65rem",flexWrap:"wrap"}}>
        <span style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase"}}>Costo logística:</span>
        {editandoCosto?(
          <div style={{display:"flex",alignItems:"center",gap:"4px"}}>
            <span style={{fontSize:"0.8rem",color:"#6b7280"}}>$</span>
            <input autoFocus type="number" value={costoOverride!==null?costoOverride:costoBase} onChange={ev=>setCostoOverride(parseFloat(ev.target.value)||0)}
              onBlur={()=>setEditandoCosto(false)} onKeyDown={ev=>{if(ev.key==="Enter")setEditandoCosto(false);if(ev.key==="Escape"){setCostoOverride(null);setEditandoCosto(false);}}}
              style={{...S.input,width:"90px",padding:"2px 8px",fontSize:"0.82rem",fontWeight:700}}/>
            {costoOverride!==null&&<button onClick={()=>{setCostoOverride(null);setEditandoCosto(false);}} style={{fontSize:"0.68rem",color:"#6b7280",background:"none",border:"none",cursor:"pointer",padding:"0 4px"}}>↩ base</button>}
          </div>
        ):(
          <button onClick={()=>setEditandoCosto(true)} style={{display:"flex",alignItems:"center",gap:"4px",background:"none",border:"0.5px solid #252d40",borderRadius:"6px",padding:"2px 8px",cursor:"pointer"}}>
            <span style={{fontSize:"0.82rem",fontWeight:700,color:costoOverride!==null?"#fbbf24":"#10b981"}}>{costoMostrar>0?"$"+Math.round(costoMostrar).toLocaleString("es-AR"):"—"}</span>
            {costoOverride!==null&&<span style={{fontSize:"0.62rem",color:"#fbbf24",opacity:.7}}>*</span>}
            <span style={{fontSize:"0.65rem",color:"#374151",marginLeft:"2px"}}>✏</span>
          </button>
        )}
        {costoBase>0&&costoOverride!==null&&<span style={{fontSize:"0.68rem",color:"#4b5563"}}>base: ${Math.round(costoBase).toLocaleString("es-AR")}</span>}
      </div>
      {/* Alerta dirección duplicada */}
      {duplicados.length>0&&!dividido&&(
        <div style={{background:"#1c1400",border:"1px solid #78350f",borderRadius:"8px",padding:"8px 12px",marginBottom:"0.65rem"}}>
          <div style={{display:"flex",alignItems:"flex-start",gap:"8px"}}>
            <span style={{color:"#fbbf24",fontSize:"0.85rem",flexShrink:0}}>⚠</span>
            <div style={{flex:1}}>
              <div style={{color:"#fbbf24",fontWeight:700,fontSize:"0.78rem",marginBottom:"3px"}}>{duplicados.length} pedido{duplicados.length>1?"s":"+"} más a esta dirección el {envio.fecha?fmtCorta(envio.fecha):"mismo día"}</div>
              <div style={{color:"#92400e",fontSize:"0.72rem",marginBottom:"6px"}}>{duplicados.map(d=>d.nroOrdenTN?"#"+d.nroOrdenTN:d.id.slice(-6)).join(" · ")}</div>
              <button onClick={handleDividir} style={{fontSize:"0.72rem",padding:"3px 10px",borderRadius:"5px",border:"1px solid #78350f",background:"#12172a",color:"#fbbf24",cursor:"pointer",fontWeight:600}}>
                Dividir ${costoMostrar>0?Math.round(costoMostrar).toLocaleString("es-AR"):"?"} entre {duplicados.length+1} pedidos → ${costoMostrar>0?Math.round(costoMostrar/(duplicados.length+1)).toLocaleString("es-AR"):"?"} c/u
              </button>
            </div>
          </div>
        </div>
      )}
      {dividido&&<div style={{background:"#041f14",border:"1px solid #065f46",borderRadius:"8px",padding:"6px 12px",marginBottom:"0.65rem",fontSize:"0.75rem",color:"#34d399"}}>✓ Costo dividido aplicado a {duplicados.length+1} pedidos</div>}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.6rem 1rem",marginBottom:"0.65rem",opacity:(esTN&&e.pagoEstado==="pendiente")?0.35:1,pointerEvents:(esTN&&e.pagoEstado==="pendiente")?"none":"auto"}}>
        <div>
          <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>Logistica</div>
          <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{logActivas.map(l =><button key={l} onClick={()=>handleTrans(l)} style={S.chip(e.trans===l,lc[l].color,lc[l].bg)}>{l}</button>)}</div>
        </div>
        <div>
          <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>Turno</div>
          <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{TURNOS.map(t =>{const tc=TURNO_C[t]||{c:"#a78bfa",bg:"#130d2a"};return <button key={t} onClick={()=>set("turno",e.turno===t?"":t)} style={S.chip(e.turno===t,tc.c,tc.bg)}>{t}</button>;})}</div>
        </div>
        <div>
          <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>Fecha entrega</div>
          <div style={{display:"flex",gap:"3px",flexWrap:"wrap",alignItems:"center"}}>
            <button onClick={()=>set("fecha",fechaHoy())} style={S.btnSm(e.fecha===fechaHoy(),"#6366f1")}>Hoy</button>
            <button onClick={()=>set("fecha",fechaManana())} style={S.btnSm(e.fecha===fechaManana(),"#6366f1")}>Manana</button>
            <input type="date" value={e.fecha||""} onChange={ev=>set("fecha",ev.target.value)} style={{...S.input,padding:"2px 6px",fontSize:"0.72rem",height:"24px",width:"120px"}}/>
          </div>
        </div>
        <div>
          <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>Estado</div>
          <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{Object.entries(ESTADO_C).map(([k,v])=><button key={k} onClick={()=>handleEstado(k)} style={S.chip(e.estado===k,v.t,v.bg)}>{v.label}</button>)}</div>
        </div>
        <div>
          <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>Bultos</div>
          <div style={{display:"flex",gap:"8px",alignItems:"center"}}>
            <input type="number" min="1" value={e.bultos||""} onChange={ev=>{
              const v=parseInt(ev.target.value);
              set("bultos",v>0?v:null);
              // Auto-preparado solo si NO FLEX y el usuario está ingresando el valor por primera vez
              if(v>0&&e.origen!=="ML"&&!e.preparado) set("preparado",true);
            }} placeholder="Ingresá cantidad..." style={{...S.input,width:"140px",padding:"4px 10px"}}/>
            {e.origen!=="ML"&&e.preparado&&<span style={{color:"#10b981",fontSize:"0.72rem",fontWeight:700}}>✓ Preparado</span>}
          </div>
        </div>
        <div>
          <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>Cobranza</div>
          <div style={{display:"flex",gap:"3px",alignItems:"center",flexWrap:"wrap"}}>
            {!e.esCC&&<>
              <button onClick={()=>set("cobranza",e.cobranza!==null?null:0)} style={S.btnSm(e.cobranza!==null,"#f59e0b")}>{e.cobranza!==null?"Activa":"Agregar"}</button>
              {e.cobranza!==null&&<input type="number" placeholder="Monto" value={e.cobranza||""} onChange={ev=>set("cobranza",parseFloat(ev.target.value)||0)} style={{...S.input,width:"120px",padding:"3px 8px",fontSize:"0.8rem"}}/>}
            </>}
            <button onClick={()=>{if(e.esCC){setE(p=>({...p,esCC:false,importeCC:0}));}else{setE(p=>({...p,esCC:true,importeCC:0,cobranza:null}));}}} style={S.btnSm(e.esCC,"#a78bfa")}>CC</button>
            {e.esCC&&<input type="number" placeholder="Importe CC" value={e.importeCC||""} onChange={ev=>setE(p=>({...p,importeCC:parseFloat(ev.target.value)||0}))} style={{...S.input,width:"120px",padding:"3px 8px",fontSize:"0.8rem"}}/>}
          </div>
        </div>
      </div>

      {/* Dirección editable */}
      <div style={{marginBottom:"0.5rem"}}>
        <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>Dirección</div>
        <textarea value={e.direccion||""} onChange={ev=>set("direccion",ev.target.value)} placeholder="Calle, número..." style={{...S.input,display:"block",width:"100%",height:"48px",resize:"vertical",fontSize:"0.8rem"}}/>
        <div style={{display:"flex",gap:"6px",marginTop:"4px"}}>
          <input value={e.localidad||""} onChange={ev=>set("localidad",ev.target.value)} placeholder="Barrio/Localidad" style={{...S.input,flex:1,padding:"3px 8px",fontSize:"0.75rem"}}/>
          <input value={e.partido||""} onChange={ev=>set("partido",ev.target.value)} placeholder="Partido" style={{...S.input,flex:1,padding:"3px 8px",fontSize:"0.75rem"}}/>
          <input value={e.cp||""} onChange={ev=>set("cp",ev.target.value)} placeholder="CP" style={{...S.input,width:"70px",padding:"3px 8px",fontSize:"0.75rem"}}/>
        </div>
      </div>
      {/* Datos FLEX — destinatario, tipo entrega, referencia, QR */}
      {e.origen==="ML"&&(
        <div style={{marginBottom:"0.65rem",background:"#0d1119",border:"1px solid #1a3008",borderRadius:"10px",padding:"0.65rem 1rem"}}>
          <div style={{color:"#84cc16",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"8px"}}>Datos de la etiqueta FLEX</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.35rem 1rem",marginBottom:"8px",fontSize:"0.78rem"}}>
            {e.destinatario&&<div style={{gridColumn:"1/-1"}}><span style={{color:"#6b7280"}}>Destinatario: </span><span style={{color:"#e5e7eb",fontWeight:600}}>{e.destinatario}</span></div>}
            {e.tipoEntrega&&<div><span style={{background:e.tipoEntrega==="COMERCIAL"?"#0c1a40":"#0a1a0a",color:e.tipoEntrega==="COMERCIAL"?"#38bdf8":"#86efac",border:"1px solid "+(e.tipoEntrega==="COMERCIAL"?"#38bdf8":"#86efac"),borderRadius:"4px",padding:"1px 8px",fontSize:"0.7rem",fontWeight:700}}>{e.tipoEntrega}</span></div>}

          </div>

          <div>
            <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>Referencia / instrucciones</div>
            <textarea value={e.referencia||""} onChange={ev=>set("referencia",ev.target.value)} placeholder="Indicaciones de entrega..." style={{...S.input,display:"block",width:"100%",height:"52px",resize:"vertical",fontSize:"0.78rem"}}/>
          </div>
        </div>
      )}

      {/* Nro Factura */}
      <div style={{marginBottom:"0.5rem"}}>
        <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>Nro. Factura</div>
        <input value={e.nroFactura||""} onChange={ev=>set("nroFactura",ev.target.value)} placeholder="ej. FA-00001" style={{...S.input,width:"100%",fontSize:"0.8rem"}}/>
      </div>

      {/* Notas de la orden — editable (incluye datepicker) */}
      <div style={{marginBottom:"0.5rem"}}>
        <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>{esTN?"Notas de la orden":"Observaciones"}</div>
        <textarea value={esTN?(e.notasOrden||""):(e.observaciones||"")} onChange={ev=>set(esTN?"notasOrden":"observaciones",ev.target.value)} placeholder={esTN?"Notas de la orden...":"Notas adicionales..."} style={{...S.input,display:"block",width:"100%",height:"52px",resize:"vertical",fontSize:"0.8rem"}}/>
      </div>

      {/* Estado de liquidacion */}
      {e.trans&&<div style={{marginBottom:"0.65rem"}}>
        <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"6px"}}>Estado de liquidacion</div>
        <div style={{display:"flex",gap:"4px",flexWrap:"wrap"}}>
          {[{k:"normal",l:"Normal",c:"#10b981"},{k:"cancelado_liq",l:"Sin cargo",c:"#f87171"},{k:"no_abonado",l:"No abonado por demora",c:"#f59e0b"}].map(x =>(
            <button key={x.k} onClick={()=>set("estadoLiq",x.k)} style={{...S.btnSm((e.estadoLiq||"normal")===x.k,x.c),padding:"3px 10px",fontSize:"0.72rem"}}>{x.l}</button>
          ))}
        </div>
        {(e.estadoLiq==="cancelado_liq"||e.estadoLiq==="no_abonado")&&(
          <textarea value={e.notaLiq||""} onChange={ev=>set("notaLiq",ev.target.value)} placeholder="Motivo..." style={{...S.input,display:"block",width:"100%",marginTop:"6px",height:"38px",resize:"vertical",fontSize:"0.78rem"}}/>
        )}
      </div>}
      {/* Etiquetas por bulto */}
      {e.bultos>0&&e.trans&&<div style={{marginBottom:"0.65rem",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{color:"#6b7280",fontSize:"0.72rem"}}>{e.bultos} bulto{e.bultos>1?"s":""} — {e.trans}</div>
        {puedeVer(sesion,"accion_imprimir")&&<button onClick={()=>imprimirEtiquetas(e,lc)} style={{...S.btnSm(false),color:"#6366f1",border:"1px solid #6366f1",padding:"3px 12px",fontSize:"0.72rem"}}>🖨 Imprimir etiquetas</button>}
      </div>}
      {/* Nota del envio */}
      <div style={{marginBottom:"0.65rem"}}>
        <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>Nota interna</div>
        <textarea value={e.nota||""} onChange={ev=>set("nota",ev.target.value)} placeholder="Nota interna sobre este envio..." style={{...S.input,display:"block",width:"100%",height:"44px",resize:"vertical",fontSize:"0.8rem"}}/>
      </div>
      <div style={{marginBottom:"0.4rem"}}>
        <button onClick={()=>set("cambio",e.cambio!==null?null:"")} style={S.btnSm(e.cambio!==null,"#ec4899")}>Cambio</button>
        {e.cambio!==null&&<textarea value={e.cambio||""} onChange={ev=>set("cambio",ev.target.value)} placeholder="Que tiene que retirar para el cambio..." style={{...S.input,display:"block",width:"100%",marginTop:"4px",height:"42px",resize:"vertical",fontSize:"0.8rem"}}/>}
      </div>
      <div style={{marginBottom:"0.75rem"}}>
        <button onClick={()=>set("retiro",e.retiro!==null?null:"")} style={S.btnSm(e.retiro!==null,"#f97316")}>Retiro</button>
        {e.retiro!==null&&<textarea value={e.retiro||""} onChange={ev=>set("retiro",ev.target.value)} placeholder="Que tiene que retirar..." style={{...S.input,display:"block",width:"100%",marginTop:"4px",height:"42px",resize:"vertical",fontSize:"0.8rem"}}/>}
      </div>
      </div>{/* fin wrapper bloqueo */}
      {/* Auditoría */}
      {(envio.creadoPor||envio.asignadoPor||envio.ultimaEdicionPor||envio.canceladoPor||envio.importeEditadoPor||envio.armadorNombre||envio.despachoPor)&&(
        <div style={{borderTop:"1px solid #1e2535",marginTop:"0.65rem",paddingTop:"0.6rem",display:"flex",flexWrap:"wrap",gap:"6px 20px"}}>
          {[
            {label:"Creado por",data:envio.creadoPor},
            {label:"Asignado por",data:envio.asignadoPor},
            {label:"Editado por",data:envio.ultimaEdicionPor},
            {label:"Importe editado por",data:envio.importeEditadoPor},
            {label:"Cancelado por",data:envio.canceladoPor},
            {label:"Armado por",data:envio.armadorNombre?{nombre:envio.armadorNombre,fecha:envio.armadoTs}:null},
            {label:"Despachado por",data:envio.despachoPor?{nombre:envio.despachoPor,fecha:envio.despachoTs}:null},
          ].filter(x=>x.data).map(x=>(
            <div key={x.label} style={{display:"flex",alignItems:"center",gap:"5px"}}>
              <span style={{color:"#6b7280",fontSize:"0.68rem",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.04em"}}>{x.label}:</span>
              <span style={{color:"#e2e8f0",fontSize:"0.75rem",fontWeight:700}}>{x.data.nombre}</span>
              <span style={{color:"#4b5563",fontSize:"0.68rem"}}>{x.data.fecha?new Date(x.data.fecha).toLocaleString("es-AR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}):""}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{display:"flex",gap:"0.5rem",justifyContent:"flex-end",flexWrap:"wrap",marginTop:"0.5rem"}}>
        <button onClick={onClose} style={S.btn(false)}>Cancelar</button>
        {!bloqueado&&<button onClick={handleSave} disabled={guardando} style={{...S.btn(true),background:"linear-gradient(135deg,#6366f1,#8b5cf6)",opacity:guardando?0.7:1,display:"flex",alignItems:"center",gap:"6px"}}>{guardando&&<span style={{width:"10px",height:"10px",border:"2px solid #a5b4fc",borderTopColor:"transparent",borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite"}}/>}{guardando?"Guardando...":"Guardar"}</button>}
      </div>
    </div>
  );
}

function TabEnvios({envios,setEnvios,zc,lc,onReasignar,esAdmin=false,sesion=null,mostrarResumenFlex=false,facturaClientes={}}){
  const hoy=fechaHoy();
  const [modFecha,setModFecha]=useState("hoy");
  const [rangoD,setRangoD]=useState(hoy);
  const [rangoH,setRangoH]=useState(hoy);
  const [filTrans,setFilTrans]=useState("TODOS");
  const [filEstado,setFilEstado]=useState("no_cancelado");
  const [filZona,setFilZona]=useState("TODAS");
  const [filTurno,setFilTurno]=useState("TODOS");
  const [filOrigen,setFilOrigen]=useState("TODOS");
  const [filTipoEntrega,setFilTipoEntrega]=useState("TODOS");
  const [soloReprog,setSoloReprog]=useState(false);
  const [busqueda,setBusqueda]=useState("");
  const [editId,setEditId]=useState(null);
  const [seleccionados,setSeleccionados]=useState(new Set());
  const [modoSel,setModoSel]=useState(false);
  const tmap=buildTarifaMap(zc);
  const getImp=e=>calcImp(e,tmap,lc,zc);
  const logActivas=Object.entries(lc).filter(([,v])=>v.activa).map(([k])=>k);
  const getRango=()=>{
    if(modFecha==="todos") return{d:"",h:""};
    if(modFecha==="hoy")    return{d:hoy,h:hoy};
    if(modFecha==="ayer")   return{d:fechaAyer(),h:fechaAyer()};
    if(modFecha==="manana") return{d:fechaManana(),h:fechaManana()};
    if(modFecha==="semana") return{d:fechaInicioSemana(),h:hoy};
    return{d:rangoD,h:rangoH};
  };
  const{d:desde,h:hasta}=getRango();
  const filtrados=envios.filter(e=>{
    const f=e.fecha||e.fechaVenta||"";
    if(desde&&f<desde)return false;
    if(hasta&&f>hasta)return false;
    if(filTrans==="SIN ASIGNAR"&&e.trans)return false;
    if(filTrans!=="TODOS"&&filTrans!=="SIN ASIGNAR"&&e.trans!==filTrans)return false;
    const est=getEstado(e);
    if(filEstado==="no_cancelado"&&est==="cancelado")return false;
    else if(filEstado!=="TODOS"&&filEstado!=="no_cancelado"&&est!==filEstado)return false;
    if(filZona!=="TODAS"&&getZonaML(e.partido)!==filZona)return false;
    if(filTurno==="SIN_TURNO"){if(e.turno)return false;}else if(filTurno!=="TODOS"&&e.turno!==filTurno)return false;
    if(filOrigen!=="TODOS"){
      const origenVal=e.origen==="Tienda Nube"?"TN":e.origen==="ML"?"FLEX":"Manual";
      if(origenVal!==filOrigen)return false;
    }
    if(mostrarResumenFlex&&filTipoEntrega!=="TODOS"){
      if(filTipoEntrega==="SIN_TIPO"){if(e.tipoEntrega)return false;}
      else if(e.tipoEntrega!==filTipoEntrega)return false;
    }
    if(soloReprog&&!e.reprogramado)return false;
    if(busqueda){const srch=norm(busqueda);return norm(e.direccion).includes(srch)||e.id.includes(srch)||norm(e.partido).includes(srch)||(e.nroSeguimiento||"").includes(srch)||norm(e.clienteNombre).includes(srch)||(e.nroOrdenTN||"").includes(srch);}
    return true;
  });
  const activos=filtrados.filter(e=>getEstado(e)!=="cancelado");
  const totalImp=activos.reduce((s,e)=>s+getImp(e),0);
  const sinAsig=filtrados.filter(e=>getEstado(e)==="sin_asignar").length;
  const porTrans=logActivas.map(l =>({l,n:activos.filter(e=>e.trans===l).length,v:activos.filter(e=>e.trans===l).reduce((s,e)=>s+getImp(e),0)})).filter(x =>x.n>0);
  const filtrarPorLogistica=(l)=>setFilTrans(filTrans===l?"TODOS":l);
  const toggleSel=id=>setSeleccionados(p=>{const n=new Set(p);n.has(id)?n.delete(id):n.add(id);return n;});
  const saveEnvio=updated=>{
    const est=getEstado(updated);
    // Guardia defensiva: si sale despachado+cancelado sin devolucionPendiente, marcarlo.
    // Cubre el caso en que handleEstado no fue llamado (bundle viejo, envío ya cancelado antes, etc.)
    const devPend=(updated.despachado&&est==="cancelado"&&!updated.devolucionPendiente)
      ?{devolucionPendiente:true,estadoLiq:updated.estadoLiq||"cancelado_liq"}:{};
    setEnvios(p=>p.map(e=>e.id===updated.id?{...updated,...devPend,estado:est}:e));
    setEditId(null);
  };
  const saveMultipleEnvios=updates=>{setEnvios(p=>p.map(e=>{const u=updates.find(x=>x.id===e.id);return u?{...u,estado:getEstado(u)}:e;}));};
  const [accionMasiva,setAccionMasiva]=useState(null); // {tipo:"fecha"|"turno", valor:""}
  const aplicarAccionMasiva=()=>{
    if(!accionMasiva?.valor)return;
    const campo=accionMasiva.tipo;
    setEnvios(p=>p.map(e=>seleccionados.has(e.id)?{...e,[campo]:accionMasiva.valor}:e));
    setSeleccionados(new Set());setModoSel(false);setAccionMasiva(null);
  };
  const eliminar=async id=>{if(window.confirm("Eliminar este envio?")){await deleteDoc(doc(db,"envios",id));setEnvios(p=>p.filter(e=>e.id!==id));}};
  const eliminarSel=async()=>{if(!window.confirm(`Eliminar ${seleccionados.size} envio(s)?`))return;await Promise.all([...seleccionados].map(id=>deleteDoc(doc(db,"envios",id))));setEnvios(p=>p.filter(e=>!seleccionados.has(e.id)));setSeleccionados(new Set());setModoSel(false);};
  const reasignarSel=()=>{const items=envios.filter(e=>seleccionados.has(e.id));onReasignar(items);setSeleccionados(new Set());setModoSel(false);};
  const [cancelando,setCancelando]=useState(false);
  const cancelarSel=async()=>{if(!window.confirm(`Cancelar ${seleccionados.size} envio(s)?`))return;setCancelando(true);const auditC=mkAudit(sesion);await Promise.all([...seleccionados].map(id=>setDoc(doc(db,"envios",id),{estado:"cancelado",...(auditC?{canceladoPor:auditC}:{})},{merge:true})));setEnvios(p=>p.map(e=>seleccionados.has(e.id)?{...e,estado:"cancelado"}:e));setSeleccionados(new Set());setModoSel(false);setCancelando(false);};
  // Resumen FLEX hoy (solo cuando mostrarResumenFlex=true)
  const [resumenOpen,setResumenOpen]=useState(true);
  const flexHoy=mostrarResumenFlex?envios.filter(e=>e.trans&&e.estado!=="cancelado"&&(e.fecha||e.fechaVenta||"")===hoy):[];
  const resumenFlex=(()=>{
    if(!mostrarResumenFlex)return{};
    const r={};
    logActivas.forEach(l=>{r[l]={};[...TURNOS,"—"].forEach(t=>{r[l][t]=0;});});
    flexHoy.forEach(e=>{const t=e.turno||"—";if(r[e.trans]&&r[e.trans][t]!==undefined)r[e.trans][t]++;});
    return r;
  })();
  const logsConFlex=mostrarResumenFlex?logActivas.filter(l=>[...TURNOS,"—"].some(t=>resumenFlex[l]?.[t]>0)):[];
  // Resumen NO FLEX hoy (solo cuando !mostrarResumenFlex)
  const noFlexHoy=!mostrarResumenFlex?envios.filter(e=>e.origen!=="ML"&&e.estado!=="cancelado"&&(e.fecha||e.fechaVenta||"")===hoy):[];
  const resumenNoFlex=(()=>{
    if(mostrarResumenFlex)return{};
    const r={sinAsignar:0};
    logActivas.forEach(l=>{r[l]={};[...TURNOS,"—"].forEach(t=>{r[l][t]=0;});});
    noFlexHoy.forEach(e=>{
      const t=e.turno||"—";
      if(e.trans&&r[e.trans]!==undefined)r[e.trans][t]=(r[e.trans][t]||0)+1;
      else if(!e.trans)r.sinAsignar++;
    });
    return r;
  })();
  const logsConNoFlex=!mostrarResumenFlex?logActivas.filter(l=>[...TURNOS,"—"].some(t=>(resumenNoFlex[l]?.[t]||0)>0)):[];
  // Ordenar por nroOrdenTN descendente (mas nuevo arriba)
  const filtradosOrdenados=[...filtrados].sort((a,b)=>{
    const nA=parseInt(a.nroOrdenTN||a.id)||0;
    const nB=parseInt(b.nroOrdenTN||b.id)||0;
    return nB-nA;
  });

  // Badge de origen
  const ORIGEN_C={
    "Tienda Nube":{label:"TN",bg:"#0d1c2e",t:"#38bdf8",border:"#38bdf8"},
    "ML":{label:"FLEX",bg:"#0d1c04",t:"#84cc16",border:"#84cc16"},
    "Manual":{label:"Manual",bg:"#1c1400",t:"#f59e0b",border:"#f59e0b"},
  };
  function origenBadge(e){
    const o=e.origen==="Tienda Nube"?"Tienda Nube":e.origen==="ML"?"ML":"Manual";
    const c=ORIGEN_C[o]||{label:o,bg:"#1a1f2e",t:"#6b7280",border:"#252d40"};
    return <span style={{padding:"1px 7px",background:c.bg,color:c.t,borderRadius:"5px",fontSize:"0.65rem",fontWeight:700,border:"1px solid "+c.border,flexShrink:0}}>{c.label}</span>;
  }

  return(
    <div style={{width:"100%",overflow:"hidden",boxSizing:"border-box"}}>

      {/* ── Filtros + Panel FLEX hoy lado a lado ── */}
      <div style={{display:"flex",gap:"0.7rem",marginBottom:"0.7rem",alignItems:"flex-start"}}>

      <div style={{...S.card,padding:"0.6rem 1rem",flex:1,display:"flex",flexDirection:"column",gap:"6px"}}>
        {/* Fila 1: Fecha + Estado + Origen */}
        <div style={{display:"flex",gap:"6px",alignItems:"center",flexWrap:"wrap"}}>
          <span style={{color:"#4b5563",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",minWidth:"38px"}}>Fecha</span>
          <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>
            {[{k:"todos",l:"Todos"},{k:"hoy",l:"Hoy"},{k:"manana",l:"Manana"},{k:"ayer",l:"Ayer"},{k:"semana",l:"Semana"},{k:"rango",l:"Rango"}].map(x =><button key={x.k} onClick={()=>setModFecha(x.k)} style={S.btnSm(modFecha===x.k)}>{x.l}</button>)}
            {modFecha==="rango"&&<><input type="date" value={rangoD} onChange={e=>setRangoD(e.target.value)} style={{...S.input,padding:"3px 7px",width:"128px",fontSize:"0.75rem"}}/><input type="date" value={rangoH} onChange={e=>setRangoH(e.target.value)} style={{...S.input,padding:"3px 7px",width:"128px",fontSize:"0.75rem"}}/></>}
          </div>
          <span style={{color:"#252d40",fontSize:"0.6rem"}}>|</span>
          <span style={{color:"#4b5563",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",minWidth:"38px"}}>Estado</span>
          <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>
            {[{k:"no_cancelado",l:"Todos"},{k:"sin_asignar",l:"Sin asignar"},{k:"asignado",l:"Asignado"},{k:"cancelado",l:"Cancelado"}].map(x =><button key={x.k} onClick={()=>setFilEstado(x.k)} style={S.btnSm(filEstado===x.k,ESTADO_C[x.k]?.t||"#6366f1")}>{x.l}</button>)}
          </div>
          <span style={{color:"#252d40",fontSize:"0.6rem"}}>|</span>
          <span style={{color:"#4b5563",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",minWidth:"38px"}}>Origen</span>
          <div style={{display:"flex",gap:"3px"}}>
            {[{k:"TODOS",l:"Todos"},{k:"TN",l:"TN"},{k:"Manual",l:"Manual"}].map(x =><button key={x.k} onClick={()=>setFilOrigen(x.k)} style={S.btnSm(filOrigen===x.k,x.k==="TN"?"#38bdf8":"#6366f1")}>{x.l}</button>)}
          </div>
        </div>
        {/* Fila 2: Logistica */}
        <div style={{display:"flex",gap:"6px",alignItems:"center",flexWrap:"wrap",borderTop:"1px solid #252d40",paddingTop:"5px"}}>
          <span style={{color:"#4b5563",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",minWidth:"38px"}}>Logist.</span>
          <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>
            {["TODOS",...logActivas,"SIN ASIGNAR"].map(t =><button key={t} onClick={()=>setFilTrans(t)} style={S.btnSm(filTrans===t,t==="SIN ASIGNAR"?"#f59e0b":lc[t]?.color||"#6366f1")}>{t}</button>)}
          </div>
        </div>
        {/* Fila 3: Zona + Turno + Buscar */}
        <div style={{display:"flex",gap:"6px",alignItems:"center",flexWrap:"wrap",borderTop:"1px solid #252d40",paddingTop:"5px"}}>
          <span style={{color:"#4b5563",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",minWidth:"38px"}}>Zona</span>
          <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>
            {["TODAS",...ZONAS_ML_LIST].map(z=><button key={z} onClick={()=>setFilZona(z)} style={S.btnSm(filZona===z,ZONA_ML_COLOR[z]||"#6366f1")}>{z}</button>)}
          </div>
          <span style={{color:"#252d40",fontSize:"0.6rem"}}>|</span>
          <span style={{color:"#4b5563",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",minWidth:"38px"}}>Turno</span>
          <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>
            {["TODOS",...TURNOS].map(t =><button key={t} onClick={()=>setFilTurno(t)} style={S.btnSm(filTurno===t,"#8b5cf6")}>{t}</button>)}<button onClick={()=>setFilTurno("SIN_TURNO")} style={S.btnSm(filTurno==="SIN_TURNO","#6b7280")}>Sin turno</button>
          </div>
          {mostrarResumenFlex&&<>
            <span style={{color:"#252d40",fontSize:"0.6rem"}}>|</span>
            <span style={{color:"#4b5563",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",minWidth:"38px"}}>Tipo</span>
            <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>
              {[{k:"TODOS",l:"Todos",c:"#6366f1"},{k:"COMERCIAL",l:"COM",c:"#38bdf8"},{k:"RESIDENCIAL",l:"RES",c:"#86efac"},{k:"SIN_TIPO",l:"Sin tipo",c:"#6b7280"}].map(x =><button key={x.k} onClick={()=>setFilTipoEntrega(x.k)} style={S.btnSm(filTipoEntrega===x.k,x.c)}>{x.l}</button>)}
            </div>
          </>}
          <button onClick={()=>setSoloReprog(!soloReprog)} style={{...S.btnSm(soloReprog,"#fbbf24"),marginLeft:mostrarResumenFlex?"0":"auto"}}>⟳ Reprog.</button>
          <input value={busqueda} onChange={e=>setBusqueda(e.target.value)} placeholder="🔍 Buscar..." style={{...S.input,width:"190px",marginLeft:mostrarResumenFlex?"auto":"0"}}/>
          <button onClick={()=>{
            const tmap2=buildTarifaMap(zc);
            const filas=filtradosOrdenados.map((e,i)=>({
              "#":i+1,Origen:e.origen,Estado:getEstado(e),
              NroOrdenTN:e.nroOrdenTN||"",Cliente:e.clienteNombre||"",
              Direccion:e.direccion,Localidad:e.localidad||"",Partido:e.partido,CP:e.cp||"",
              Logistica:lc[e.trans]?.nombreFormal||e.trans||"",Zona:getZonaML(e.partido)||"",Turno:e.turno||"",
              Fecha:e.fecha||"",FechaVenta:e.fechaVenta||"",Bultos:e.bultos||1,
              Importe:calcImp(e,tmap2,lc,zc),Cobranza:e.cobranza||"",
              Cambio:e.cambio||"",Retiro:e.retiro||"",Nota:e.nota||"",
              EstadoLiq:e.estadoLiq||"normal",NotaLiq:e.notaLiq||"",
            }));
            exportarXLSX(filas,"envios_"+fechaHoy());
          }} style={{...S.btnSm(false),color:"#10b981",border:"1px solid #10b981",padding:"4px 10px",fontSize:"0.72rem",display:puedeVer(sesion,"accion_exportar")?"":"none"}}>⬇ Excel</button>
        </div>
        {/* Fila 4: Acciones */}
        <div style={{display:"flex",gap:"6px",alignItems:"center",flexWrap:"wrap",borderTop:"1px solid #252d40",paddingTop:"5px"}}>
          <span style={{color:"#4b5563",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",minWidth:"38px"}}>Accion</span>
          <button onClick={()=>{setModoSel(!modoSel);if(modoSel)setSeleccionados(new Set());}} style={S.btnSm(modoSel,"#6366f1")}>{modoSel?"Cancelar seleccion":"Seleccionar"}</button>
          {modoSel&&<button onClick={()=>setSeleccionados(new Set(filtradosOrdenados.map(e=>e.id)))} style={S.btnSm(false)}>Todos ({filtrados.length})</button>}
          {modoSel&&seleccionados.size>0&&<button onClick={()=>setSeleccionados(new Set())} style={S.btnSm(false)}>Ninguno</button>}
        </div>
      </div>

      {/* ── Panel FLEX hoy (derecha, mismo nivel que filtros) ── */}
      {mostrarResumenFlex&&(
        <div style={{...S.card,padding:0,overflow:"hidden",border:"1px solid #1a3008",width:"260px",flexShrink:0}}>
          <div onClick={()=>setResumenOpen(p=>!p)} style={{padding:"0.4rem 0.75rem",background:"#0a1a04",borderBottom:resumenOpen?"1px solid #1a3008":"none",display:"flex",alignItems:"center",gap:"0.5rem",cursor:"pointer",userSelect:"none"}}>
            <span style={{color:"#84cc16",fontWeight:700,fontSize:"0.75rem"}}>FLEX hoy</span>
            <span style={{background:"#0d1c04",border:"1px solid #1a3008",borderRadius:"4px",padding:"1px 6px",fontSize:"0.62rem",color:"#9ca3af"}}>{flexHoy.length} env</span>
            <span style={{color:"#4b7a10",fontSize:"0.6rem",fontWeight:600}}>{flexHoy.filter(e=>e.turno).length}✓ · {flexHoy.filter(e=>!e.turno).length}✗</span>
            <span style={{marginLeft:"auto",color:"#4b7a10",fontSize:"0.65rem"}}>{resumenOpen?"▲":"▼"}</span>
          </div>
          {resumenOpen&&(
            <div style={{overflowX:"auto"}}>
              {logsConFlex.length===0
                ?<div style={{color:"#374151",fontSize:"0.68rem",padding:"6px 10px"}}>Sin envíos FLEX asignados hoy</div>
                :<table style={{width:"100%",borderCollapse:"collapse",fontSize:"0.68rem"}}>
                  <thead>
                    <tr style={{borderBottom:"1px solid #1a3008"}}>
                      <th style={{textAlign:"left",padding:"3px 8px",color:"#4b7a10",fontWeight:700,fontSize:"0.6rem",textTransform:"uppercase"}}>Log.</th>
                      {TURNOS.map(t=><th key={t} style={{textAlign:"center",padding:"3px 4px",color:"#4b7a10",fontWeight:700,fontSize:"0.6rem",width:"32px"}}>{t}</th>)}
                      <th style={{textAlign:"center",padding:"3px 4px",color:"#4b7a10",fontWeight:700,fontSize:"0.6rem",width:"32px"}}>Sin</th>
                      <th style={{textAlign:"center",padding:"3px 5px",color:"#84cc16",fontWeight:700,fontSize:"0.6rem",width:"32px"}}>Tot</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logsConFlex.map(l=>{
                      const col=lc[l]?.color||"#6366f1";
                      const total=[...TURNOS,"—"].reduce((s,t)=>s+(resumenFlex[l]?.[t]||0),0);
                      return(
                        <tr key={l} style={{borderBottom:"1px solid #0d1c04"}}>
                          <td style={{padding:"3px 8px",fontWeight:700,color:col,fontSize:"0.65rem",maxWidth:"80px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l}</td>
                          {TURNOS.map(t=>{
                            const n=resumenFlex[l]?.[t]||0;
                            return<td key={t} style={{textAlign:"center",padding:"3px 4px",color:n>0?"#e5e7eb":"#1e2535",fontWeight:n>0?600:400}}>{n>0?n:"—"}</td>;
                          })}
                          <td style={{textAlign:"center",padding:"3px 4px",color:(resumenFlex[l]?.["—"]||0)>0?"#f59e0b":"#1e2535",fontWeight:600}}>{(resumenFlex[l]?.["—"]||0)>0?resumenFlex[l]["—"]:"—"}</td>
                          <td style={{textAlign:"center",padding:"3px 5px",color:"#84cc16",fontWeight:700}}>{total}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{borderTop:"1px solid #1a3008"}}>
                      <td style={{padding:"3px 8px",color:"#4b5563",fontSize:"0.62rem",fontWeight:600}}>Total</td>
                      {TURNOS.map(t=>{
                        const s=logsConFlex.reduce((acc,l)=>acc+(resumenFlex[l]?.[t]||0),0);
                        return<td key={t} style={{textAlign:"center",padding:"3px 4px",color:s>0?"#9ca3af":"#1e2535",fontWeight:s>0?700:400,fontSize:"0.65rem"}}>{s>0?s:"—"}</td>;
                      })}
                      <td style={{textAlign:"center",padding:"3px 4px",color:logsConFlex.reduce((s,l)=>s+(resumenFlex[l]?.["—"]||0),0)>0?"#f59e0b":"#1e2535",fontWeight:700,fontSize:"0.65rem"}}>{(()=>{const s=logsConFlex.reduce((acc,l)=>acc+(resumenFlex[l]?.["—"]||0),0);return s>0?s:"—";})()}</td>
                      <td style={{textAlign:"center",padding:"3px 5px",color:"#84cc16",fontWeight:800,fontSize:"0.72rem"}}>{flexHoy.length}</td>
                    </tr>
                  </tfoot>
                </table>
              }
            </div>
          )}
        </div>
      )}

      {/* ── Panel NO FLEX hoy (derecha, cuando NO es tab FLEX) ── */}
      {!mostrarResumenFlex&&noFlexHoy.length>0&&(
        <div style={{...S.card,padding:0,overflow:"hidden",border:"1px solid #252d40",width:"260px",flexShrink:0}}>
          <div onClick={()=>setResumenOpen(p=>!p)} style={{padding:"0.4rem 0.75rem",background:"#111827",borderBottom:resumenOpen?"1px solid #252d40":"none",display:"flex",alignItems:"center",gap:"0.5rem",cursor:"pointer",userSelect:"none"}}>
            <span style={{color:"#6366f1",fontWeight:700,fontSize:"0.75rem"}}>Hoy</span>
            <span style={{background:"#1a1f2e",border:"1px solid #252d40",borderRadius:"4px",padding:"1px 6px",fontSize:"0.62rem",color:"#9ca3af"}}>{noFlexHoy.length} env</span>
            {resumenNoFlex.sinAsignar>0&&<span style={{color:"#f59e0b",fontSize:"0.6rem",fontWeight:600}}>{resumenNoFlex.sinAsignar} sin asig.</span>}
            <span style={{marginLeft:"auto",color:"#4b5563",fontSize:"0.65rem"}}>{resumenOpen?"▲":"▼"}</span>
          </div>
          {resumenOpen&&(
            <div>
              {logsConNoFlex.length===0&&resumenNoFlex.sinAsignar===0
                ?<div style={{color:"#374151",fontSize:"0.68rem",padding:"6px 10px"}}>Sin envíos hoy</div>
                :<table style={{width:"100%",borderCollapse:"collapse",fontSize:"0.68rem"}}>
                  <thead>
                    <tr style={{borderBottom:"1px solid #252d40"}}>
                      <th style={{textAlign:"left",padding:"3px 8px",color:"#4b5563",fontWeight:700,fontSize:"0.6rem",textTransform:"uppercase"}}>Log.</th>
                      {TURNOS.map(t=><th key={t} style={{textAlign:"center",padding:"3px 4px",color:"#4b5563",fontWeight:700,fontSize:"0.6rem",width:"32px"}}>{t}</th>)}
                      <th style={{textAlign:"center",padding:"3px 4px",color:"#4b5563",fontWeight:700,fontSize:"0.6rem",width:"32px"}}>Sin</th>
                      <th style={{textAlign:"center",padding:"3px 5px",color:"#6366f1",fontWeight:700,fontSize:"0.6rem",width:"32px"}}>Tot</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logsConNoFlex.map(l=>{
                      const col=lc[l]?.color||"#6366f1";
                      const total=[...TURNOS,"—"].reduce((s,t)=>s+(resumenNoFlex[l]?.[t]||0),0);
                      return(
                        <tr key={l} style={{borderBottom:"1px solid #0d1117"}}>
                          <td style={{padding:"3px 8px",fontWeight:700,color:col,fontSize:"0.65rem",maxWidth:"70px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l}</td>
                          {TURNOS.map(t=>{
                            const n=resumenNoFlex[l]?.[t]||0;
                            return<td key={t} style={{textAlign:"center",padding:"3px 4px",color:n>0?"#e5e7eb":"#1e2535",fontWeight:n>0?600:400}}>{n>0?n:"—"}</td>;
                          })}
                          <td style={{textAlign:"center",padding:"3px 4px",color:(resumenNoFlex[l]?.["—"]||0)>0?"#f59e0b":"#1e2535",fontWeight:600}}>{(resumenNoFlex[l]?.["—"]||0)>0?resumenNoFlex[l]["—"]:"—"}</td>
                          <td style={{textAlign:"center",padding:"3px 5px",color:"#6366f1",fontWeight:700}}>{total}</td>
                        </tr>
                      );
                    })}
                    {resumenNoFlex.sinAsignar>0&&(
                      <tr style={{borderBottom:"1px solid #0d1117"}}>
                        <td style={{padding:"3px 8px",color:"#f59e0b",fontWeight:700,fontSize:"0.65rem"}}>Sin asignar</td>
                        {TURNOS.map(t=><td key={t} style={{textAlign:"center",padding:"3px 4px",color:"#1e2535"}}>—</td>)}
                        <td style={{textAlign:"center",padding:"3px 4px",color:"#1e2535"}}>—</td>
                        <td style={{textAlign:"center",padding:"3px 5px",color:"#f59e0b",fontWeight:700}}>{resumenNoFlex.sinAsignar}</td>
                      </tr>
                    )}
                  </tbody>
                  <tfoot>
                    <tr style={{borderTop:"1px solid #252d40"}}>
                      <td style={{padding:"3px 8px",color:"#4b5563",fontSize:"0.62rem",fontWeight:600}}>Total</td>
                      {TURNOS.map(t=>{
                        const s=logsConNoFlex.reduce((acc,l)=>acc+(resumenNoFlex[l]?.[t]||0),0);
                        return<td key={t} style={{textAlign:"center",padding:"3px 4px",color:s>0?"#9ca3af":"#1e2535",fontWeight:s>0?700:400,fontSize:"0.65rem"}}>{s>0?s:"—"}</td>;
                      })}
                      <td style={{textAlign:"center",padding:"3px 4px",color:logsConNoFlex.reduce((s,l)=>s+(resumenNoFlex[l]?.["—"]||0),0)>0?"#f59e0b":"#1e2535",fontWeight:700,fontSize:"0.65rem"}}>{(()=>{const s=logsConNoFlex.reduce((acc,l)=>acc+(resumenNoFlex[l]?.["—"]||0),0);return s>0?s:"—";})()}</td>
                      <td style={{textAlign:"center",padding:"3px 5px",color:"#6366f1",fontWeight:800,fontSize:"0.72rem"}}>{noFlexHoy.length}</td>
                    </tr>
                  </tfoot>
                </table>
              }
            </div>
          )}
        </div>
      )}

      </div>{/* fin wrapper filtros+panel */}

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(110px,1fr))",gap:"0.55rem",marginBottom:"0.7rem"}}>
        <div onClick={()=>{setFilTrans("TODOS");setFilEstado("TODOS");}} style={{...S.card,padding:"0.75rem 1rem",cursor:"pointer",borderLeft:(filTrans==="TODOS"&&filEstado==="TODOS")?"3px solid #6366f1":"3px solid transparent"}}><div style={{color:"#6366f1",fontWeight:800,fontSize:"1.8rem",lineHeight:1}}>{filtrados.length}</div><div style={{color:"#6b7280",fontSize:"0.62rem",marginTop:"2px"}}>Todos</div></div>
        <div style={{...S.card,padding:"0.75rem 1rem"}}><div style={{color:"#10b981",fontWeight:800,fontSize:"1.05rem"}}>{fmt(totalImp)}</div><div style={{color:"#6b7280",fontSize:"0.62rem",marginTop:"2px"}}>Total</div></div>
        {sinAsig>0&&<div onClick={()=>setFilEstado(filEstado==="sin_asignar"?"TODOS":"sin_asignar")} style={{...S.card,padding:"0.75rem 1rem",borderLeft:"3px solid #f59e0b",cursor:"pointer",opacity:filEstado==="sin_asignar"?1:0.75}}><div style={{color:"#f59e0b",fontWeight:800,fontSize:"1.8rem",lineHeight:1}}>{sinAsig}</div><div style={{color:"#6b7280",fontSize:"0.62rem",marginTop:"2px"}}>Sin asignar</div></div>}
        {porTrans.map(({l,n,v})=><div key={l} onClick={()=>filtrarPorLogistica(l)} style={{...S.card,padding:"0.75rem 1rem",borderLeft:"3px solid "+lc[l].color,cursor:"pointer",opacity:filTrans===l?1:0.75,outline:filTrans===l?"2px solid "+lc[l].color:"none"}}><div style={{color:lc[l].color,fontWeight:800,fontSize:"1.8rem",lineHeight:1}}>{n}</div><div style={{color:"#6b7280",fontSize:"0.62rem",marginTop:"2px"}}>{l}</div><div style={{color:"#10b981",fontSize:"0.72rem",fontWeight:600,marginTop:"2px"}}>{fmt(v)}</div></div>)}
      </div>

      <div style={{display:"grid",gap:"4px",paddingBottom:"80px",width:"100%",overflow:"hidden",boxSizing:"border-box"}}>
        {filtradosOrdenados.length===0&&<div style={{textAlign:"center",padding:"3rem",color:"#4b5563"}}><div style={{fontSize:"2rem"}}>📭</div><p>Sin envios</p></div>}
        {filtradosOrdenados.map((e,i)=>{
          const zi=getZonaLogistica(zc,e.trans,e.partido);
          const zml=getZonaML(e.partido);
          const isEdit=editId===e.id;
          const isSel=seleccionados.has(e.id);
          const imp=e.importeOverride>0?e.importeOverride:getImp(e);
          const estKey=getEstado(e);
          const estC=ESTADO_C[estKey]||ESTADO_C.sin_asignar;
          const esTN=e.origen==="Tienda Nube";
          return(
            <div key={e.id} style={{width:"100%",minWidth:0,overflow:"hidden"}}>
              <div style={{...S.card,padding:"0.55rem 0.75rem",display:"flex",alignItems:"flex-start",gap:"0.5rem",opacity:getEstado(e)==="cancelado"?0.45:1,borderColor:isEdit||isSel?"#6366f1":e.alertaDireccion||!e.partido?"#f59e0b":"#252d40",background:isSel?"#12172a":"#1a1f2e",minWidth:0,overflow:"hidden"}}>
                {modoSel
                  ?<div style={{paddingTop:"2px"}}><Chk checked={isSel} onChange={()=>toggleSel(e.id)}/></div>
                  :puedeVer(sesion,"accion_editarenvio")
                    ?<button onClick={ev=>{ev.stopPropagation();setEditId(isEdit?null:e.id);}} style={{flexShrink:0,width:"36px",height:"36px",borderRadius:"7px",border:"1px solid "+(isEdit?"#6366f1":"#252d40"),background:isEdit?"#13102a":"#0f1420",color:isEdit?"#a78bfa":"#6b7280",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"0.85rem"}}>✏️</button>
                    :<span style={{color:"#374151",fontSize:"0.65rem",minWidth:"20px",textAlign:"right",paddingTop:"3px"}}>{i+1}</span>
                }
                <div style={{flex:1,minWidth:0}} onClick={()=>{if(modoSel)toggleSel(e.id);}}>
                  <div style={{display:"flex",gap:"3px",flexWrap:"wrap",alignItems:"center",marginBottom:"3px"}}>
                    {origenBadge(e)}
                    <Bdg label={estC.label} bg={estC.bg} t={estC.t}/>
                    {e.trans&&<Bdg label={e.trans} bg={lc[e.trans]?.bg||"#1a1f2e"} t={lc[e.trans]?.color||"#6b7280"}/>}
                    {zml&&<Bdg label={zml} bg={ZONA_ML_BG[zml]||"#1a1f2e"} t={ZONA_ML_COLOR[zml]||"#6b7280"}/>}
                    {zi&&<Bdg label={zi.nombre} bg={zi.color+"22"} t={zi.color}/>}
                    {e.turno&&<Bdg label={e.turno} bg={TURNO_C[e.turno]?.bg||"#130d2a"} t={TURNO_C[e.turno]?.c||"#a78bfa"}/>}
                    {e.fecha&&<Bdg label={fmtCorta(e.fecha)} bg="#12172a" t="#6b7280"/>}
                    {e.cobranza!==null&&<Bdg label={"$"+Number(e.cobranza).toLocaleString("es-AR")} bg="#1c1500" t="#fbbf24"/>}
                    {e.cambio!==null&&<Bdg label="Cambio" bg="#1c0514" t="#ec4899"/>}
                    {e.retiro!==null&&<Bdg label="Retiro" bg="#1c1000" t="#f97316"/>}
                    {e.alertaDireccion&&<Bdg label="Sin CP/Dir" bg="#1c0a00" t="#fb923c"/>}
                    {!e.partido&&getEstado(e)!=="cancelado"&&<Bdg label="Sin partido" bg="#1c0a00" t="#fb923c"/>}
                    {e.estadoLiq==="cancelado_liq"&&<Bdg label="Sin cargo" bg="#1c0a0a" t="#f87171" style={{border:"1px solid #f87171"}}/>}
                    {e.estadoLiq==="no_abonado"&&<Bdg label="No abonado" bg="#1c1400" t="#f59e0b" style={{border:"1px solid #f59e0b"}}/>}
                    {getPagoEstado(e)==="pendiente"&&<Bdg label="Pago pendiente" bg="#1c0a00" t="#fb923c" style={{border:"1px solid #fb923c"}}/>}
                    {getPagoEstado(e)==="cuenta_corriente"&&<Bdg label="Cta. Corriente" bg="#130d2a" t="#a78bfa"/>}
                    {facturaClientes[mkClienteKey(e.clienteNombre)]&&e.trans&&!e.nroFactura&&<Bdg label="FC ⚠" bg="#1c0d00" t="#fb923c" style={{border:"1px solid #c2410c",fontWeight:800}}/>}
                    {e.reprogramado&&<Bdg label="⟳ Reprog." bg="#1c1500" t="#fbbf24" style={{border:"1px solid #78350f",fontWeight:700}}/>}
                  </div>
                  {/* Nro orden + Nombre en la misma linea, luego direccion */}
                  {esTN&&<div style={{display:"flex",gap:"8px",alignItems:"baseline",marginBottom:"1px",overflow:"hidden"}}>
                    <span style={{color:"#7dd3fc",fontWeight:700,fontSize:"0.82rem",flexShrink:0}}>#{e.nroOrdenTN}</span>
                    {e.clienteNombre&&<span style={{color:"#e5e7eb",fontWeight:600,fontSize:"0.82rem",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.clienteNombre}</span>}
                  </div>}
                  <div style={{color:esTN&&e.clienteNombre?"#9ca3af":"#e5e7eb",fontSize:"0.8rem",lineHeight:1.35,textDecoration:getEstado(e)==="cancelado"?"line-through":"none",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",width:"100%",display:"block"}}>{e.direccion}{e.referencia&&!e.direccion.toLowerCase().includes(e.referencia.toLowerCase().slice(0,20))?" — "+e.referencia:""}</div>
                  <div style={{color:"#9ca3af",fontSize:"0.74rem",marginTop:"2px",display:"flex",gap:"6px",flexWrap:"wrap",alignItems:"center"}}>
                    {!esTN&&<span style={{fontFamily:"monospace",color:"#94a3b8"}}>...{e.id.slice(-10)}</span>}
                    {e.nroSeguimiento&&<span style={{background:"#0f1420",padding:"0 5px",borderRadius:"4px",border:"1px solid #252d40",color:"#94a3b8"}}>📦 {e.nroSeguimiento}</span>}
                    {e.tipoEntrega&&<span style={{background:e.tipoEntrega==="COMERCIAL"?"#0c1a40":"#0a1a0a",color:e.tipoEntrega==="COMERCIAL"?"#38bdf8":"#86efac",border:"1px solid "+(e.tipoEntrega==="COMERCIAL"?"#1e4060":"#1a3a1a"),borderRadius:"4px",padding:"0 5px",fontSize:"0.68rem",fontWeight:700}}>{e.tipoEntrega}</span>}
                    {e.destinatario&&<span style={{color:"#cbd5e1",fontWeight:500,fontSize:"0.74rem"}}>· {e.destinatario}</span>}
                    <span style={{color:"#cbd5e1",fontWeight:500,fontSize:"14px"}}>· {e.localidad?e.localidad+" · ":""}{e.partido}{e.cp?" · "+e.cp:""}</span>
                    {e.fechaVenta&&<span style={{color:"#6b7280"}}>· venta {fmtCorta(e.fechaVenta)}</span>}
                    {e.formaPago&&esTN&&<span style={{color:e.formaPago==="Efectivo"?"#fbbf24":"#9ca3af",fontWeight:e.formaPago==="Efectivo"?700:400}}>· {e.formaPago}</span>}
                    {e.observaciones&&<span style={{color:"#6b7280",fontStyle:"italic"}}>· "{e.observaciones.slice(0,30)}{e.observaciones.length>30?"...":""}"</span>}
                  </div>
                </div>
                <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:"3px",flexShrink:0}}>
                  <div style={{display:"flex",gap:"3px",alignItems:"center"}}>
                    {esTN&&e.linkTN&&<a href={e.linkTN} target="_blank" rel="noreferrer" onClick={ev=>ev.stopPropagation()} title="Ver en Tienda Nube" style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:"26px",height:"26px",borderRadius:"6px",background:"#0d1c2e",border:"1px solid #38bdf8",textDecoration:"none",flexShrink:0,fontSize:"0.7rem"}}>TN</a>}
                    {e.linkML&&<a href={e.linkML} target="_blank" rel="noreferrer" onClick={ev=>ev.stopPropagation()} title="Ver en ML" style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:"26px",height:"26px",borderRadius:"6px",background:"#0f1420",border:"1px solid #252d40",textDecoration:"none",flexShrink:0}}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>}
                    {!modoSel&&esAdmin&&<button onClick={ev=>{ev.stopPropagation();eliminar(e.id);}} style={{...S.btnSm(false),padding:"1px 6px",fontSize:"0.68rem",color:"#f87171"}}>x</button>}
                  </div>
                  <span style={{color:"#60a5fa",fontSize:"0.68rem",fontWeight:700}}>{e.bultos||1} bulto{(e.bultos||1)===1?"":"s"}</span>
                  {e.preparado&&e.armadorNombre&&<span style={{color:"#10b981",fontSize:"0.68rem",fontWeight:700}}>📦 {e.armadorNombre}</span>}
                  {e.despachado&&e.despachoTs&&<span style={{color:"#10b981",fontSize:"0.68rem",fontWeight:700}}>🚚 {fmtHora(e.despachoTs)}{e.despachoPor?" · "+e.despachoPor:""}</span>}
                  {imp>0&&puedeVer(sesion,"accion_verimportes")&&<span style={{color:e.importeOverride>0?"#fbbf24":"#10b981",fontWeight:700,fontSize:"0.82rem"}}>{fmt(imp)}{e.importeOverride>0&&<span style={{fontSize:"0.62rem",opacity:.65,marginLeft:"2px"}}>*</span>}</span>}
                  {esTN&&e.importeOrden>0&&puedeVer(sesion,"accion_verimportes")&&<span style={{color:"#6b7280",fontSize:"0.7rem"}}>{fmt(e.importeOrden)}</span>}
                  {e.origen==="ML"&&ML_FINAL[e.partido]&&<span style={{color:"#64748b",fontSize:"0.68rem",marginTop:"1px"}}>ML {fmt(ML_FINAL[e.partido])}</span>}
                </div>
              </div>
              {isEdit&&!modoSel&&puedeVer(sesion,"accion_editarenvio")&&<PanelEdit envio={e} onSave={saveEnvio} onSaveMultiple={saveMultipleEnvios} onClose={()=>setEditId(null)} lc={lc} envios={envios} getImp={getImp} esAdmin={esAdmin} sesion={sesion}/>}
            </div>
          );
        })}
      </div>

      {modoSel&&seleccionados.size>0&&(
        <div style={{position:"fixed",bottom:"20px",left:"50%",transform:"translateX(-50%)",background:"#1a1f2e",border:"1px solid #6366f1",borderRadius:"12px",padding:"0.7rem 1.25rem",display:"flex",gap:"0.6rem",alignItems:"center",zIndex:50,boxShadow:"0 4px 20px rgba(0,0,0,0.5)",flexWrap:"wrap",maxWidth:"95vw"}}>
          <span style={{color:"#e5e7eb",fontWeight:700,fontSize:"0.9rem"}}>{seleccionados.size} selec.</span>
          <button onClick={reasignarSel} style={{...S.btn(true),background:"linear-gradient(135deg,#6366f1,#8b5cf6)",padding:"0.4rem 0.9rem",fontSize:"0.75rem"}}>Reasignar</button>
          {accionMasiva?.tipo==="fecha"
            ?<><input autoFocus type="date" value={accionMasiva.valor} onChange={ev=>setAccionMasiva(p=>({...p,valor:ev.target.value}))} onKeyDown={ev=>{if(ev.key==="Enter")aplicarAccionMasiva();if(ev.key==="Escape")setAccionMasiva(null);}} style={{...S.input,padding:"3px 7px",fontSize:"0.75rem",height:"32px"}}/><button onClick={aplicarAccionMasiva} style={{...S.btn(true),padding:"0.3rem 0.7rem",fontSize:"0.75rem"}}>OK</button><button onClick={()=>setAccionMasiva(null)} style={{...S.btn(false),padding:"0.3rem 0.7rem",fontSize:"0.75rem"}}>✕</button></>
            :<button onClick={()=>setAccionMasiva({tipo:"fecha",valor:fechaHoy()})} style={{...S.btn(false),padding:"0.4rem 0.9rem",fontSize:"0.75rem"}}>Cambiar fecha</button>}
          {accionMasiva?.tipo==="turno"
            ?<><div style={{display:"flex",gap:"3px"}}>{TURNOS.map(t=><button key={t} onClick={()=>setAccionMasiva(p=>({...p,valor:t}))} style={{...S.btnSm(accionMasiva.valor===t,"#a78bfa"),fontSize:"0.72rem"}}>{t}</button>)}</div><button onClick={aplicarAccionMasiva} disabled={!accionMasiva.valor} style={{...S.btn(true),padding:"0.3rem 0.7rem",fontSize:"0.75rem",opacity:accionMasiva.valor?1:0.5}}>OK</button><button onClick={()=>setAccionMasiva(null)} style={{...S.btn(false),padding:"0.3rem 0.7rem",fontSize:"0.75rem"}}>✕</button></>
            :<button onClick={()=>setAccionMasiva({tipo:"turno",valor:""})} style={{...S.btn(false),padding:"0.4rem 0.9rem",fontSize:"0.75rem"}}>Cambiar turno</button>}
          {puedeVer(sesion,"accion_cancelarenvio")&&<button onClick={cancelarSel} disabled={cancelando} style={{...S.btn(true),background:"#7f1d1d",padding:"0.4rem 0.9rem",fontSize:"0.75rem",display:"flex",alignItems:"center",gap:"5px",opacity:cancelando?0.7:1}}>{cancelando&&<span style={{width:"9px",height:"9px",border:"2px solid #fca5a5",borderTopColor:"transparent",borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite"}}/>}{cancelando?"Cancelando...":"Cancelar"}</button>}
          {esAdmin&&<button onClick={eliminarSel} style={{...S.btn(true),background:"#450a0a",padding:"0.4rem 0.9rem",fontSize:"0.75rem",color:"#fca5a5"}}>Eliminar</button>}
          <button onClick={()=>{setModoSel(false);setSeleccionados(new Set());}} style={{...S.btn(false),padding:"0.4rem 0.9rem",fontSize:"0.75rem"}}>Salir</button>
        </div>
      )}
    </div>
  );
}

function TabImprimir({envios,setEnvios,zc,lc}){
  const hoy=fechaHoy();
  const [fecha,setFecha]=useState(hoy);
  const [trans,setTrans]=useState("TODOS");
  const [turno,setTurno]=useState("TODOS");
  const [filZona,setFilZona]=useState("TODAS");
  const [filOrigen,setFilOrigen]=useState("TODOS"); // TODOS | FLEX | NO_FLEX
  const [busqueda,setBusqueda]=useState("");
  const logActivas=Object.entries(lc).filter(([,v])=>v.activa).map(([k])=>k);
  const tmap=buildTarifaMap(zc);
  const getImp=e=>calcImp(e,tmap,lc,zc);
  const lista=[...envios].filter(e=>{
    const f=e.fecha||e.fechaVenta||"";
    if(fecha&&f!==fecha)return false;
    if(trans!=="TODOS"&&e.trans!==trans)return false;
    if(turno!=="TODOS"&&e.turno!==turno)return false;
    if(filZona!=="TODAS"&&getZonaML(e.partido)!==filZona)return false;
    if(filOrigen==="FLEX"&&e.origen!=="ML")return false;
    if(filOrigen==="NO_FLEX"&&e.origen==="ML")return false;
    if(busqueda){const s=norm(busqueda);if(!(norm(e.direccion).includes(s)||norm(e.partido).includes(s)||norm(e.clienteNombre).includes(s)||(e.nroOrdenTN||"").includes(s)||(e.nroSeguimiento||"").includes(s)))return false;}
    return e.estado!=="cancelado";
  }).sort((a,b)=>{
    // NO FLEX primero, FLEX después
    const orA=a.origen==="ML"?1:0;
    const orB=b.origen==="ML"?1:0;
    if(orA!==orB)return orA-orB;
    // Dentro de cada grupo: por lote ASC, sin lote al final
    const la=a.loteImportacion||"9";
    const lb=b.loteImportacion||"9";
    if(la!==lb)return la.localeCompare(lb);
    const na=parseInt(a.nroOrdenTN||a.nroSeguimiento||a.id)||0;
    const nb=parseInt(b.nroOrdenTN||b.nroSeguimiento||b.id)||0;
    return na-nb;
  });
  const totalImp=lista.reduce((s,e)=>s+getImp(e),0);
  const cobTotal=lista.filter(e=>e.cobranza).reduce((s,e)=>s+(e.cobranza||0),0);
  const hayCobro=lista.some(e=>e.cobranza!==null&&e.cobranza>0);

  // WhatsApp: guardar despacho en Firestore y generar link copiable
  const [waCopied,setWaCopied]=useState(false);
  const [waSaving,setWaSaving]=useState(false);
  const [waModal,setWaModal]=useState(null); // {msg, url, token}
  const notificarWA=async()=>{
    if(waSaving||trans==="TODOS"||lista.length===0)return;
    setWaSaving(true);
    try{
      const token=Math.random().toString(36).slice(2,9)+Date.now().toString(36).slice(-4);
      const cfg=lc[trans];
      const fechaStr=fecha?new Date(fecha+"T00:00:00").toLocaleDateString("es-AR",{weekday:"long",day:"numeric",month:"long"}):"hoy";
      const url=window.location.origin+"/?d="+token;
      const nombreMostrar=cfg?.nombreFormal||cfg?.nombre||trans;
      const msg=`🛵 *${nombreMostrar} — ${fechaStr}*\n📋 ${lista.length} envío${lista.length!==1?"s":""} para entregar.\n\n📄 Descargá el detalle acá:\n${url}\n\n_EnviosHub_`;
      await setDoc(doc(db,"despachos",token),{
        token,
        logistica:trans,
        logisticaNombre:nombreMostrar,
        fecha:fecha||fechaHoy(),
        envios:lista.map(e=>({
          id:e.id,
          nroSeguimiento:e.nroSeguimiento||"",
          nroOrdenTN:e.nroOrdenTN||"",
          direccion:e.direccion||"",
          localidad:e.localidad||"",
          partido:e.partido||"",
          cp:e.cp||"",
          bultos:e.bultos||1,
          cobranza:e.cobranza||0,
          importe:getImp(e),
          origen:e.origen||"",
          loteImportacion:e.loteImportacion||"",
          turno:e.turno||"",
          referencia:e.referencia||"",
          tipoEntrega:e.tipoEntrega||"",
          fecha:e.fecha||"",
        })),
        pdfOrient,
        pdfFontSize,
        pdfVersion,
        creadoAt:new Date().toISOString(),
        expiresAt:new Date(Date.now()+48*60*60*1000).toISOString(),
      });
      setWaModal({msg,url,token});
    }catch(err){alert("Error al generar link: "+err.message);}
    setWaSaving(false);
  };
  const puedeWA=trans!=="TODOS"&&lista.length>0;

  // Cierre del día
  const [cierreModal,setCierreModal]=useState(null);
  const [cierreSaving,setCierreSaving]=useState(false);
  const [cierreCopied,setCierreCopied]=useState(false);
  const generarCierre=async()=>{
    if(cierreSaving||trans==="TODOS"||lista.length===0)return;
    setCierreSaving(true);
    try{
      const token=Math.random().toString(36).slice(2,9)+Date.now().toString(36).slice(-4);
      const cfg=lc[trans];
      const fechaStr=fecha?new Date(fecha+"T00:00:00").toLocaleDateString("es-AR",{weekday:"long",day:"numeric",month:"long"}):"hoy";
      const url=window.location.origin+"/?t="+token;
      const nombreMostrarC=cfg?.nombreFormal||cfg?.nombre||trans;
      const msg=`🛵 *${nombreMostrarC} — Cierre del ${fechaStr}*\n📋 ${lista.length} envío${lista.length!==1?"s":""} asignados.\n\n✅ Confirmá las entregas acá:\n${url}\n\n_EnviosHub · Solo confirmación_`;
      await setDoc(doc(db,"cierres",token),{
        token,
        logistica:trans,
        logisticaNombre:nombreMostrarC,
        fecha:fecha||fechaHoy(),
        envios:lista.map(e=>({
          id:e.id,
          nroSeguimiento:e.nroSeguimiento||"",
          nroOrdenTN:e.nroOrdenTN||"",
          direccion:e.direccion||"",
          localidad:e.localidad||"",
          partido:e.partido||"",
          bultos:e.bultos||1,
          cobranza:e.cobranza||0,
          importe:getImp(e),
        })),
        confirmado:false,
        confirmadoAt:null,
        incidentes:[],
        creadoAt:new Date().toISOString(),
      });
      setCierreModal({token,msg,url});
    }catch(err){alert("Error al generar cierre: "+err.message);}
    setCierreSaving(false);
  };

  const [pdfOrient,setPdfOrient]=useState("landscape");
  const [pdfFontSize,setPdfFontSize]=useState(14);
  const [pdfVersion,setPdfVersion]=useState("completa"); // "completa" | "simple"
  const generarPDF=()=>{
    const ahora=new Date();
    const ts=ahora.toLocaleDateString("es-AR",{weekday:"long",day:"numeric",month:"long",year:"numeric"})+" "+ahora.toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit",hour12:false});
    const origenLabel=filOrigen==="FLEX"?"Solo FLEX":filOrigen==="NO_FLEX"?"NO FLEX":"Todos";
    const fs=pdfFontSize;
    const esSimple=pdfVersion==="simple";

    const rows=lista.map((e,i)=>{
      const esFlex=e.origen==="ML";
      const dir=[e.direccion,e.localidad,e.partido,e.cp].filter(Boolean).join(" · ");
      const dirCorta=(e.direccion||"").split("/")[0].split("-")[0].split(",")[0].trim();
      const nroRef=esFlex?(e.nroSeguimiento||e.id.slice(-10)):("#"+(e.nroOrdenTN||e.id.slice(-8)));
      const zml=esFlex?(getZonaML(e.partido)||""):(e.partido||"");
      const refExtra=(e.referencia&&!e.direccion.toLowerCase().includes(e.referencia.toLowerCase().slice(0,20)))?" — "+e.referencia:"";
      const cobrar=e.cobranza?"$"+Number(e.cobranza).toLocaleString("es-AR"):"—";
      const loteCell=e.loteImportacion?new Date(e.loteImportacion).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit",hour12:false}):"—";
      const tipoCell=e.tipoEntrega?`<span style="background:${e.tipoEntrega==="COMERCIAL"?"#dbeafe":"#dcfce7"};color:${e.tipoEntrega==="COMERCIAL"?"#1d4ed8":"#15803d"};border-radius:3px;padding:0 4px;font-size:${fs-2}px;font-weight:700;">${e.tipoEntrega==="COMERCIAL"?"COM":"RES"}</span>`:"—";
      const origenBadge=esFlex?`<span style="background:#1a3008;color:#84cc16;border-radius:3px;padding:0 4px;font-size:${fs-3}px;font-weight:700;">FLEX</span>`:`<span style="background:#0c1a40;color:#38bdf8;border-radius:3px;padding:0 4px;font-size:${fs-3}px;font-weight:700;">TN</span>`;
      const reprogBadge=e.reprogramado?`<span style="background:#1c1500;color:#d97706;border:1px solid #78350f;border-radius:3px;padding:0 4px;font-size:${fs-3}px;font-weight:700;margin-right:4px;white-space:nowrap;">&#x21BB; Reprog.</span>`:"";

      if(esSimple){
        return`<tr style="background:${i%2===0?"#fff":"#f9f9f9"};border-bottom:0.5px solid #e5e7eb;">
          <td style="padding:3px 4px;text-align:center;color:#888;width:20px;">${i+1}</td>
          <td style="padding:3px 4px;width:50px;color:#16a34a;font-weight:700;font-size:${fs-1}px;">${loteCell}</td>
          <td style="padding:3px 4px;font-family:monospace;font-size:${fs-1}px;color:#444;width:100px;">${nroRef}</td>
          <td style="padding:3px 4px;text-align:center;width:35px;">${tipoCell}</td>
          <td style="padding:3px 4px;text-align:center;width:25px;font-weight:${(e.bultos||1)>1?700:400};">${e.bultos||1}</td>
          <td style="padding:3px 4px;text-align:center;width:18px;"><div style="width:11px;height:11px;border:1px solid #aaa;border-radius:1px;display:inline-block;"></div></td>
          <td style="padding:3px 4px;font-weight:600;">${reprogBadge}${dirCorta}</td>
          <td style="padding:3px 4px;color:#555;">${(e.localidad&&!/referencia/i.test(e.localidad))?e.localidad:""}</td>
          <td style="padding:3px 4px;color:#555;">${e.partido||""}</td>
          <td style="padding:3px 4px;white-space:nowrap;font-size:${fs-1}px;">${zml}</td>
          <td style="padding:3px 4px;width:30px;text-align:center;">${e.turno||"—"}</td>
          <td style="padding:3px 4px;width:40px;text-align:center;">${e.fecha?fmtCorta(e.fecha):"—"}</td>
          ${hayCobro?`<td style="padding:3px 4px;width:70px;text-align:right;font-weight:${e.cobranza?"600":"400"};color:${e.cobranza?"#b45309":"#aaa"};">${cobrar}</td>`:""}
        </tr>`;
      } else {
        const td=(w,extra,val)=>`<td style="border-bottom:0.5px solid #ddd;padding:3px 4px;${w?"width:"+w+"px;":""}${extra||""}">${val}</td>`;
        return`<tr style="background:${i%2===0?"#fff":"#f9f9f9"}">
          ${td(20,"text-align:center;color:#888;",i+1)}
          ${td(55,"text-align:center;font-size:"+(fs-2)+"px;font-weight:700;color:#16a34a;",loteCell)}
          ${td(110,"font-family:monospace;font-size:"+(fs-1)+"px;color:#444;",nroRef)}
          ${e.tipoEntrega?`<td style="border-bottom:0.5px solid #ddd;padding:3px 4px;width:38px;text-align:center;font-size:${fs-2}px;font-weight:700;color:${e.tipoEntrega==="COMERCIAL"?"#1d4ed8":"#15803d"};background:${e.tipoEntrega==="COMERCIAL"?"#dbeafe":"#dcfce7"};">${e.tipoEntrega==="COMERCIAL"?"COM":"RES"}</td>`:`<td style="border-bottom:0.5px solid #ddd;padding:3px 4px;width:38px;text-align:center;color:#aaa;">—</td>`}
          ${td(28,"text-align:center;font-weight:"+(((e.bultos||1)>1)?700:400)+";",e.bultos||1)}
          <td style="border-bottom:0.5px solid #ddd;padding:3px 4px;width:18px;text-align:center;"><div style="width:11px;height:11px;border:1px solid #aaa;border-radius:1px;display:inline-block;"></div></td>
          ${td("","font-weight:500;",reprogBadge+dir+refExtra)}
          ${td("","white-space:nowrap;font-size:"+(fs-1)+"px;",zml)}
          ${td(32,"text-align:center;",e.turno||"—")}
          ${td(42,"text-align:center;",e.fecha?fmtCorta(e.fecha):"—")}
          ${hayCobro?td(72,"text-align:right;font-weight:"+(e.cobranza?600:400)+";color:"+(e.cobranza?"#b45309":"#aaa")+";",cobrar):""}
        </tr>`;
      }
    }).join("");

    const thPDF="background:#e8e8e8;padding:3px 4px;text-align:left;font-size:"+(fs-2)+"px;font-weight:700;text-transform:uppercase;color:#555;border-bottom:1.5px solid #333;";
    const headerRow=esSimple
      ?`<tr><th style="${thPDF}width:20px;">#</th><th style="${thPDF}width:50px;">Lote</th><th style="${thPDF}width:100px;">Nro envio</th><th style="${thPDF}width:35px;text-align:center;">Tipo</th><th style="${thPDF}width:25px;text-align:center;">Blts</th><th style="${thPDF}width:18px;text-align:center;">Chk</th><th style="${thPDF}">Direccion</th><th style="${thPDF}">Ciudad</th><th style="${thPDF}">Partido</th><th style="${thPDF}white-space:nowrap;">Zona</th><th style="${thPDF}width:30px;text-align:center;">Turno</th><th style="${thPDF}width:40px;text-align:center;">Fecha</th>${hayCobro?`<th style="${thPDF}width:70px;text-align:right;">Cobrar</th>`:""}</tr>`
      :`<tr><th style="${thPDF}width:20px;">#</th><th style="${thPDF}width:55px;text-align:center;">Lote</th><th style="${thPDF}width:100px;">Nro envio / orden</th><th style="${thPDF}width:38px;text-align:center;">Tipo</th><th style="${thPDF}width:28px;text-align:center;">Blts</th><th style="${thPDF}width:18px;text-align:center;">Chk</th><th style="${thPDF}">Direccion · Localidad · Partido · CP · Referencia</th><th style="${thPDF}white-space:nowrap;">Zona</th><th style="${thPDF}width:32px;text-align:center;">Turno</th><th style="${thPDF}width:42px;text-align:center;">Fecha</th>${hayCobro?`<th style="${thPDF}width:72px;text-align:right;">Cobrar</th>`:""}</tr>`;

    const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Envios ${fecha||"hoy"}</title><style>
      @page{size:A4 ${pdfOrient};margin:8mm 10mm;}
      body{font-family:Arial,sans-serif;font-size:${fs}px;margin:0;color:#111;}
      table{width:100%;border-collapse:collapse;}
      th{${thPDF}}
      td{font-size:${fs}px;}
      thead{display:table-header-group;}
      .page-header{margin-bottom:4px;}
      @media print{button{display:none!important;}.page-header{page-break-inside:avoid;}}
    </style></head><body>
    <div class="page-header" style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;">
      <span style="font-weight:700;font-size:${fs+2}px;">${trans!=="TODOS"?(lc[trans]?.nombreFormal||trans):origenLabel} · ${ts}</span>
      <span style="font-size:${fs-1}px;color:#888;">${lista.length} envios · Total: $${totalImp.toLocaleString("es-AR")}${cobTotal?" · A cobrar: $"+cobTotal.toLocaleString("es-AR"):""}</span>
    </div>
    <table>
      <thead>${headerRow}</thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="border-top:1.5px solid #333;margin-top:4px;padding-top:3px;font-size:${fs-2}px;color:#555;">${lista.length} envios</div>
    <script>
      window.onload=function(){
        // Numerar páginas
        window.print();
      };
    <\/script>
    </body></html>`;
    const w=window.open("","_blank");if(!w){alert("Permite ventanas emergentes.");return;}w.document.write(html);w.document.close();
  };
  return(
    <div>
      <div style={{...S.card,padding:"0.75rem 1rem",marginBottom:"0.9rem",display:"flex",gap:"0.5rem",flexWrap:"wrap",alignItems:"center"}}>
        <div style={{display:"flex",alignItems:"center",gap:"0.5rem"}}>
          <span style={{color:"#6b7280",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase"}}>Fecha</span>
          <input type="date" value={fecha} onChange={e=>setFecha(e.target.value)} style={{...S.input,padding:"5px 10px",width:"140px"}}/>
        </div>
        <span style={{color:"#252d40",fontSize:"0.6rem"}}>|</span>
        <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>
          {["TODOS","FLEX","NO_FLEX"].map(o =><button key={o} onClick={()=>setFilOrigen(o)} style={o==="FLEX"?{...S.btnSm(filOrigen===o,"#84cc16"),border:filOrigen===o?"1px solid #84cc16":"1px solid #1a3008",color:filOrigen===o?"#84cc16":"#4b7a10"}:S.btnSm(filOrigen===o,"#6366f1")}>{o==="TODOS"?"Todos":o==="FLEX"?"Solo FLEX":"NO FLEX"}</button>)}
        </div>
        <span style={{color:"#252d40",fontSize:"0.6rem"}}>|</span>
        <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{["TODOS",...logActivas].map(t =><button key={t} onClick={()=>setTrans(t)} style={S.btnSm(trans===t,lc[t]?.color||"#6366f1")}>{t}</button>)}</div>
        <span style={{color:"#252d40",fontSize:"0.6rem"}}>|</span>
        <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{["TODAS",...ZONAS_ML_LIST].map(z=><button key={z} onClick={()=>setFilZona(z)} style={S.btnSm(filZona===z,ZONA_ML_COLOR[z]||"#6366f1")}>{z}</button>)}</div>
        <span style={{color:"#252d40",fontSize:"0.6rem"}}>|</span>
        <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{["TODOS",...TURNOS].map(t =><button key={t} onClick={()=>setTurno(t)} style={S.btnSm(turno===t,"#8b5cf6")}>{t}</button>)}</div>
        <input value={busqueda} onChange={e=>setBusqueda(e.target.value)} placeholder="Buscar..." style={{...S.input,width:"160px",padding:"0.3rem 0.65rem",fontSize:"0.78rem"}}/>
        <div style={{marginLeft:"auto",display:"flex",gap:"6px",alignItems:"center"}}>
          <button onClick={()=>{
            const filas=lista.map((e,i)=>{
              const esFlex=e.origen==="ML";
              const lote=esFlex&&e.loteImportacion?new Date(e.loteImportacion).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit",hour12:false}):"";
              return{"#":i+1,
                Lote:lote,
                Tipo:e.tipoEntrega==="COMERCIAL"?"COM":e.tipoEntrega==="RESIDENCIAL"?"RES":"",
                Reprogramado:e.reprogramado?"SI":"",
                Direccion:[e.direccion,e.localidad,e.partido,e.cp].filter(Boolean).join(" · "),
                Referencia:e.referencia||"",
                NroEnvio:esFlex?(e.nroSeguimiento||""):"",
                NroOrden:esFlex?"":"#"+(e.nroOrdenTN||""),
                Zona:getZonaML(e.partido)||"",
                Turno:e.turno||"",
                Fecha:e.fecha||"",
                Bultos:e.bultos||1,
                Cobrar:e.cobranza||""};
            });
            exportarXLSX(filas,"imprimir_"+fechaHoy());
          }} style={{...S.btn(false),border:"1px solid #10b981",color:"#10b981",padding:"0.4rem 0.9rem",fontSize:"0.78rem"}}>⬇ Excel</button>
          <div style={{display:"flex",gap:"4px",alignItems:"center"}}>
            <button onClick={()=>setPdfVersion(pdfVersion==="completa"?"simple":"completa")} style={{...S.btnSm(pdfVersion==="simple","#f59e0b"),padding:"4px 10px",fontSize:"0.72rem"}} title="Cambiar versión">{pdfVersion==="simple"?"📋 Simple":"📄 Completa"}</button>
          <button onClick={()=>setPdfOrient(pdfOrient==="landscape"?"portrait":"landscape")} style={{...S.btnSm(false),padding:"4px 10px",fontSize:"0.72rem",color:"#9ca3af"}} title="Cambiar orientación">{pdfOrient==="landscape"?"↔ Horizontal":"↕ Vertical"}</button>
            <select value={pdfFontSize} onChange={e=>setPdfFontSize(Number(e.target.value))} style={{...S.input,padding:"3px 6px",fontSize:"0.72rem",width:"70px"}} title="Tamaño de letra">
              {[9,10,11,12,13,14].map(n=><option key={n} value={n}>{n}px</option>)}
            </select>
          </div>
          <button onClick={generarPDF} style={{...S.btn(true),background:"linear-gradient(135deg,#6366f1,#8b5cf6)",padding:"0.5rem 1.1rem"}}>Generar PDF</button>
          {puedeWA&&<button onClick={notificarWA} disabled={waSaving} style={{...S.btn(true),background:waSaving?"#1a2a1a":waCopied?"linear-gradient(135deg,#059669,#047857)":"linear-gradient(135deg,#25d366,#128c7e)",padding:"0.5rem 1.1rem",border:"none",opacity:waSaving?0.6:1}}>
            {waSaving?"Generando...":"📲 Notificar WA"}
          </button>}
          {trans!=="TODOS"&&lista.length>0&&(
            <button onClick={generarCierre} disabled={cierreSaving} style={{...S.btn(true),background:cierreSaving?"#1a1a2e":"linear-gradient(135deg,#4f46e5,#7c3aed)",padding:"0.5rem 1.1rem",border:"none",opacity:cierreSaving?0.6:1}}>
              {cierreSaving?"Generando...":"🔒 Cierre del día"}
            </button>
          )}
        </div>
      </div>
      {/* Modal Notificar WA */}
      {waModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.72)",zIndex:500,display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}>
          <div style={{background:"#12172a",border:"1px solid #1e2640",borderRadius:"14px",padding:"1.5rem",maxWidth:"480px",width:"100%"}}>
            <div style={{fontWeight:800,fontSize:"1rem",marginBottom:"0.25rem"}}>📲 Link generado</div>
            <div style={{color:"#6b7280",fontSize:"0.8rem",marginBottom:"1rem"}}>Copiá el mensaje y envialo por WhatsApp. Al abrir el link se descarga el PDF de la hoja de ruta.</div>
            <textarea value={waModal.msg} readOnly style={{width:"100%",background:"#0a0e1a",border:"1px solid #252d40",borderRadius:"8px",padding:"0.75rem",color:"#e5e7eb",fontSize:"0.78rem",resize:"none",height:"140px",outline:"none",lineHeight:1.6,fontFamily:"monospace"}} onClick={e=>e.target.select()}/>
            <div style={{display:"flex",gap:"0.5rem",marginTop:"0.75rem",flexWrap:"wrap"}}>
              <button onClick={()=>{navigator.clipboard.writeText(waModal.msg).catch(()=>{});setWaCopied(true);setTimeout(()=>setWaCopied(false),2500);}} style={{flex:2,padding:"0.6rem",borderRadius:"9px",background:waCopied?"#0d1c14":"#1e2640",border:`1px solid ${waCopied?"#10b981":"#374151"}`,color:waCopied?"#10b981":"#e5e7eb",fontWeight:700,cursor:"pointer",fontSize:"0.82rem"}}>
                {waCopied?"✓ Copiado":"📋 Copiar mensaje"}
              </button>
              <button onClick={()=>{setWaModal(null);setWaCopied(false);}} style={{padding:"0.6rem 1rem",borderRadius:"9px",background:"transparent",border:"1px solid #374151",color:"#6b7280",fontWeight:600,cursor:"pointer",fontSize:"0.82rem"}}>
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Modal cierre del día */}
      {cierreModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.72)",zIndex:500,display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}>
          <div style={{background:"#12172a",border:"1px solid #1e2640",borderRadius:"14px",padding:"1.5rem",maxWidth:"480px",width:"100%"}}>
            <div style={{fontWeight:800,fontSize:"1rem",marginBottom:"0.25rem"}}>🔒 Cierre generado</div>
            <div style={{color:"#6b7280",fontSize:"0.8rem",marginBottom:"1rem"}}>Copiá el mensaje y envialo por WhatsApp o al grupo que prefieras.</div>
            <textarea value={cierreModal.msg} readOnly style={{width:"100%",background:"#0a0e1a",border:"1px solid #252d40",borderRadius:"8px",padding:"0.75rem",color:"#e5e7eb",fontSize:"0.78rem",resize:"none",height:"148px",outline:"none",lineHeight:1.6,fontFamily:"monospace"}} onClick={e=>e.target.select()}/>
            <div style={{display:"flex",gap:"0.5rem",marginTop:"0.75rem",flexWrap:"wrap"}}>
              <button onClick={()=>{navigator.clipboard.writeText(cierreModal.msg).catch(()=>{});setCierreCopied(true);setTimeout(()=>setCierreCopied(false),2500);}} style={{flex:2,padding:"0.6rem",borderRadius:"9px",background:cierreCopied?"#0d1c14":"#1e2640",border:`1px solid ${cierreCopied?"#10b981":"#374151"}`,color:cierreCopied?"#10b981":"#e5e7eb",fontWeight:700,cursor:"pointer",fontSize:"0.82rem"}}>
                {cierreCopied?"✓ Copiado":"📋 Copiar mensaje"}
              </button>
              <button onClick={()=>{setCierreModal(null);setCierreCopied(false);}} style={{padding:"0.6rem 1rem",borderRadius:"9px",background:"transparent",border:"1px solid #374151",color:"#6b7280",fontWeight:600,cursor:"pointer",fontSize:"0.82rem"}}>
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}
      <div style={{...S.card,padding:"0.65rem 1rem",marginBottom:"0.9rem",display:"flex",gap:"1.5rem",flexWrap:"wrap"}}>
        <div><span style={{color:"#6b7280",fontSize:"0.72rem"}}>Envios: </span><span style={{color:"#e5e7eb",fontWeight:700}}>{lista.length}</span></div>
        <div><span style={{color:"#6b7280",fontSize:"0.72rem"}}>Total: </span><span style={{color:"#10b981",fontWeight:700}}>{fmt(totalImp)}</span></div>
        {cobTotal>0&&<div><span style={{color:"#6b7280",fontSize:"0.72rem"}}>A cobrar: </span><span style={{color:"#fbbf24",fontWeight:700}}>{fmt(cobTotal)}</span></div>}
      </div>
      {lista.length===0?<div style={{textAlign:"center",padding:"3rem",color:"#4b5563"}}><div style={{fontSize:"2rem"}}>📋</div><p>Sin envios para los filtros seleccionados</p></div>:(
        <div style={{...S.card,overflow:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:"0.78rem"}}>
            <thead><tr style={{background:"#12172a",borderBottom:"1px solid #252d40"}}>
              <th style={{...thSt,width:"28px",textAlign:"center"}}>#</th>
              <th style={{...thSt,width:"60px",textAlign:"center"}}>Lote</th>
              <th style={{...thSt,width:"42px",textAlign:"center"}}>Tipo</th>
              <th style={thSt}>Direccion · Localidad · Partido · CP · Referencia</th>
              <th style={{...thSt,width:"110px"}}>Nro envio / orden</th>
              <th style={{...thSt,width:"50px"}}>Zona</th>
              <th style={{...thSt,width:"45px"}}>Turno</th>
              <th style={{...thSt,width:"55px"}}>Fecha</th>
              {hayCobro&&<th style={{...thSt,width:"80px",textAlign:"right"}}>Cobrar</th>}
              <th style={{...thSt,textAlign:"center",width:"35px"}}>Blts</th>
              <th style={{...thSt,textAlign:"center",width:"28px"}}>Chk</th>
            </tr></thead>
            <tbody>{lista.map((e,i)=>{
              const zml=getZonaML(e.partido)||"-";
              const esFlex=e.origen==="ML";
              const nroRef=esFlex?(e.nroSeguimiento||"..."+e.id.slice(-8)):"#"+(e.nroOrdenTN||e.id.slice(-8));
              const dir=[e.direccion,e.localidad,e.partido,e.cp].filter(Boolean).join(" · ");
      const tipoBadge=e.tipoEntrega?`<span style="background:${e.tipoEntrega==="COMERCIAL"?"#dbeafe":"#dcfce7"};color:${e.tipoEntrega==="COMERCIAL"?"#1d4ed8":"#15803d"};border-radius:3px;padding:0 4px;font-size:8px;font-weight:700;margin-right:4px;">${e.tipoEntrega==="COMERCIAL"?"COM":"RES"}</span>`:"";
              return(
              <tr key={e.id} style={{borderBottom:"1px solid #1a1f2e",background:i%2===0?"transparent":"#0d1119"}}>
                <td style={{...tdSt,textAlign:"center",color:"#4b5563"}}>{i+1}</td>
                <td style={{...tdSt,textAlign:"center",width:"52px"}}>
                  {esFlex&&e.loteImportacion
                    ?<span style={{background:"#0d1c04",color:"#84cc16",padding:"1px 5px",borderRadius:"4px",fontSize:"0.68rem",fontWeight:700,whiteSpace:"nowrap"}}>{new Date(e.loteImportacion).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit",hour12:false})}</span>
                    :<span style={{color:"#374151"}}>—</span>}
                </td>
                <td style={{...tdSt,textAlign:"center"}}>
                  {e.tipoEntrega
                    ?<span style={{padding:"1px 6px",borderRadius:"3px",fontSize:"0.65rem",fontWeight:700,background:e.tipoEntrega==="COMERCIAL"?"#0c1a40":"#0a1a0a",color:e.tipoEntrega==="COMERCIAL"?"#38bdf8":"#86efac"}}>{e.tipoEntrega==="COMERCIAL"?"COM":"RES"}</span>
                    :<span style={{color:"#374151"}}>—</span>}
                </td>
                <td style={{...tdSt,whiteSpace:"normal",lineHeight:1.3}}>
                  {e.reprogramado&&<span style={{background:"#1c1500",color:"#fbbf24",border:"1px solid #78350f",padding:"1px 5px",borderRadius:"4px",fontSize:"0.65rem",fontWeight:700,marginRight:"5px",whiteSpace:"nowrap"}}>⟳ Reprog.</span>}
                  {dir}{e.referencia&&!e.direccion.toLowerCase().includes(e.referencia.toLowerCase().slice(0,20))?<span style={{color:"#6b7280",fontSize:"0.72rem"}}> — {e.referencia}</span>:null}
                </td>
                <td style={{...tdSt,fontFamily:"monospace",fontSize:"0.72rem",color:esFlex?"#9ca3af":"#7dd3fc"}}>{nroRef}</td>
                <td style={tdSt}>{zml}</td>
                <td style={{...tdSt,textAlign:"center"}}>{e.turno||"—"}</td>
                <td style={{...tdSt,color:"#9ca3af"}}>{e.fecha?fmtCorta(e.fecha):"—"}</td>
                {hayCobro&&<td style={{...tdSt,textAlign:"right"}}>{e.cobranza?<span style={{color:"#fbbf24",fontWeight:700}}>{fmt(e.cobranza)}</span>:<span style={{color:"#374151"}}>—</span>}</td>}
                <td style={{...tdSt,textAlign:"center",fontWeight:(e.bultos||1)>1?700:400}}>{e.bultos||1}</td>
                <td style={{...tdSt,textAlign:"center"}}><div style={{width:"13px",height:"13px",border:"1px solid #374151",borderRadius:"2px",margin:"auto"}}/></td>
              </tr>);})}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TabManual({setEnvios,onSuccess,lc,enviosExistentes,sesion=null}){
  const hoy=fechaHoy();
  const vacio={id:"",nroSeguimiento:"",linkML:"",direccion:"",ciudad:"",cp:"",origen:"Manual",trans:"",fecha:hoy,turno:"",estado:"sin_asignar",cobranza:null,cambio:null,retiro:null,observaciones:"",bultos:null,partido:"",importe:0,fechaVenta:hoy,clienteNombre:"",telefono:"",esCC:false,importeCC:0,nroFactura:""};
  const [f,setF]=useState(vacio);
  const [err,setErr]=useState("");
  const [dupWarn,setDupWarn]=useState("");
  const [sugsVisible,setSugsVisible]=useState(false);
  const [dirsCliente,setDirsCliente]=useState([]); // direcciones del cliente seleccionado para elegir
  const set=(k,v)=>setF(p=>({...p,[k]:v}));

  // Mapa de clientes con teléfono y direcciones únicas de pedidos anteriores
  const clientesData=useMemo(()=>{
    const map={};
    (enviosExistentes||[]).sort((a,b)=>(b.fecha||"").localeCompare(a.fecha||"")).forEach(e=>{
      const nombre=e.clienteNombre?.trim();
      if(!nombre)return;
      if(!map[nombre])map[nombre]={telefono:"",direcciones:[]};
      if(e.telefono&&!map[nombre].telefono)map[nombre].telefono=e.telefono;
      if(e.direccion){
        const normD=e.direccion.toLowerCase().trim();
        if(!map[nombre].direcciones.find(d=>d.norm===normD)){
          map[nombre].direcciones.push({direccion:e.direccion,cp:e.cp||"",ciudad:e.ciudad||"",partido:e.partido||"",norm:normD});
        }
      }
    });
    return map;
  },[enviosExistentes]);

  // Seleccionar cliente: autocompleta todos los campos
  const seleccionarCliente=(nombre)=>{
    set("clienteNombre",nombre);
    setSugsVisible(false);
    const data=clientesData[nombre];
    if(!data)return;
    if(data.telefono)set("telefono",data.telefono);
    if(data.direcciones.length===1){
      const d=data.direcciones[0];
      setF(p=>({...p,clienteNombre:nombre,telefono:data.telefono||p.telefono,
        direccion:d.direccion,cp:d.cp,ciudad:d.ciudad,partido:d.partido||cpAPartido(d.cp)||""}));
      setDirsCliente([]);
    } else if(data.direcciones.length>1){
      setDirsCliente(data.direcciones);
    } else {
      setDirsCliente([]);
    }
  };

  // Lista de clientes únicos para el dropdown
  const clientesExistentes=useMemo(()=>Object.keys(clientesData).sort((a,b)=>a.localeCompare(b)),[clientesData]);
  const sugerencias=sugsVisible&&f.clienteNombre.length>=2
    ?clientesExistentes.filter(n=>norm(n).includes(norm(f.clienteNombre))&&norm(n)!==norm(f.clienteNombre)).slice(0,8)
    :[];
  const logActivas=Object.entries(lc).filter(([,v])=>v.activa).map(([k])=>k);
  useEffect(()=>{const p=cpAPartido(f.cp);if(p)set("partido",p);},[f.cp]);
  useEffect(()=>{if(f.nroSeguimiento&&(enviosExistentes||[]).some(e=>e.nroSeguimiento===f.nroSeguimiento)){setDupWarn("Ya existe un envio con este numero de seguimiento.");}else{setDupWarn("");};},[f.nroSeguimiento]);
  const handleTrans=l=>{const t=f.trans===l?"":l;setF(p=>({...p,trans:t,estado:t?"asignado":"sin_asignar"}));};
  const guardar=()=>{
    if(!f.id.trim()){setErr("El numero de venta es obligatorio.");return;}
    if(!f.direccion.trim()){setErr("La direccion es obligatoria.");return;}
    if(!f.fecha){setErr("La fecha es obligatoria.");return;}
    if(dupWarn){setErr(dupWarn);return;}
    const audit=mkAudit(sesion);
    setEnvios(p=>[{...f,id:f.id.trim(),partido:f.partido||(cpAPartido(f.cp)||f.ciudad),...(audit?{creadoPor:audit}:{})},...p]);
    setF(vacio);setErr("");setDupWarn("");onSuccess();
  };
  return(
    <div style={{maxWidth:"620px"}}>
      {err&&<div style={{...S.card,padding:"0.6rem 1rem",marginBottom:"0.75rem",background:"#1c0a0a",border:"1px solid #7f1d1d",color:"#fca5a5",fontSize:"0.82rem"}}>{err}</div>}
      {dupWarn&&!err&&<div style={{...S.card,padding:"0.6rem 1rem",marginBottom:"0.75rem",background:"#1c1500",border:"1px solid #78350f",color:"#fbbf24",fontSize:"0.82rem"}}>Advertencia: {dupWarn}</div>}
      <div style={{...S.card,padding:"1rem 1.1rem"}}>
        <h3 style={{margin:"0 0 0.9rem",fontWeight:800,fontSize:"0.95rem",color:"#e5e7eb"}}>Nuevo envio manual</h3>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.7rem",marginBottom:"0.7rem"}}>
          <div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Nro. venta / referencia</label><input value={f.id} onChange={e=>set("id",e.target.value)} style={{...S.input,width:"100%"}} placeholder="ej. 2000012345"/></div>
          <div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Nro. seguimiento</label><input value={f.nroSeguimiento} onChange={e=>set("nroSeguimiento",e.target.value)} style={{...S.input,width:"100%",borderColor:dupWarn?"#f59e0b":"#252d40"}} placeholder="ej. 46669555629"/></div>
          <div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Nro. Factura</label><input value={f.nroFactura||""} onChange={e=>set("nroFactura",e.target.value)} style={{...S.input,width:"100%"}} placeholder="ej. FA-00001"/></div>
          <div style={{position:"relative",gridColumn:"1/-1"}}><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Nombre cliente</label>
            <input value={f.clienteNombre} onChange={e=>{set("clienteNombre",e.target.value);setSugsVisible(true);setDirsCliente([]);}} onFocus={()=>setSugsVisible(true)} onBlur={()=>setTimeout(()=>setSugsVisible(false),150)} style={{...S.input,width:"100%"}} placeholder="Nombre completo o buscar existente"/>
            {sugerencias.length>0&&(
              <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:200,background:"#1a1f2e",border:"1px solid #6366f1",borderRadius:"6px",marginTop:"2px",boxShadow:"0 6px 16px rgba(0,0,0,0.5)",overflow:"hidden"}}>
                {sugerencias.map(n=>{
                  const d=clientesData[n];
                  return(
                    <div key={n} onMouseDown={()=>seleccionarCliente(n)} style={{padding:"0.45rem 0.75rem",cursor:"pointer",borderBottom:"1px solid #252d40",transition:"background 0.1s"}} onMouseEnter={e=>e.currentTarget.style.background="#252d40"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                      <div style={{color:"#e5e7eb",fontSize:"0.82rem",fontWeight:600}}>{n}</div>
                      <div style={{fontSize:"0.68rem",color:"#4b5563",marginTop:"1px",display:"flex",gap:"8px"}}>
                        {d?.telefono&&<span>📞 {d.telefono}</span>}
                        {d?.direcciones?.length===1&&<span>📍 {d.direcciones[0].direccion}</span>}
                        {d?.direcciones?.length>1&&<span>📍 {d.direcciones.length} direcciones</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {/* Picker de direcciones cuando hay más de una */}
            {dirsCliente.length>1&&(
              <div style={{marginTop:"6px",background:"#0f1420",border:"1px solid #6366f1",borderRadius:"6px",overflow:"hidden"}}>
                <div style={{padding:"5px 10px",fontSize:"0.62rem",color:"#6366f1",fontWeight:700,textTransform:"uppercase",borderBottom:"1px solid #252d40"}}>Elegí una dirección</div>
                {dirsCliente.map((d,i)=>(
                  <div key={i} onMouseDown={()=>{
                    setF(p=>({...p,direccion:d.direccion,cp:d.cp,ciudad:d.ciudad,partido:d.partido||cpAPartido(d.cp)||""}));
                    setDirsCliente([]);
                  }} style={{padding:"7px 10px",cursor:"pointer",borderBottom:i<dirsCliente.length-1?"1px solid #1a1f2e":"none",transition:"background 0.1s"}} onMouseEnter={e=>e.currentTarget.style.background="#1a1f2e"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                    <div style={{fontSize:"0.78rem",color:"#e2e8f0",fontWeight:600}}>{d.direccion}</div>
                    <div style={{fontSize:"0.65rem",color:"#4b5563",marginTop:"1px",display:"flex",gap:"8px"}}>
                      {d.ciudad&&<span>{d.ciudad}</span>}
                      {d.partido&&<span>· {d.partido}</span>}
                      {d.cp&&<span>· CP {d.cp}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Teléfono</label><input value={f.telefono} onChange={e=>set("telefono",e.target.value)} style={{...S.input,width:"100%"}} placeholder="ej. 1165432100"/></div>
          <div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Origen</label><div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{["ML","Tienda Nube","Particular","Otro"].map(o =><button key={o} onClick={()=>set("origen",o)} style={S.btnSm(f.origen===o,"#6366f1")}>{o}</button>)}</div></div>
          <div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Bultos</label><input type="number" min="1" value={f.bultos||""} onChange={ev=>{const v=parseInt(ev.target.value);set("bultos",v>0?v:"");}} placeholder="1" style={{...S.input,width:"120px",padding:"4px 10px"}}/></div>
        </div>
        <div style={{marginBottom:"0.7rem"}}><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Direccion completa</label><textarea value={f.direccion} onChange={e=>set("direccion",e.target.value)} style={{...S.input,width:"100%",height:"56px",resize:"vertical"}} placeholder="Calle, numero..."/></div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.7rem",marginBottom:"0.7rem"}}>
          <div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>CP</label><input value={f.cp} onChange={e=>set("cp",e.target.value)} style={{...S.input,width:"100%"}} placeholder="1642"/></div>
          <div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Ciudad</label><input value={f.ciudad||""} onChange={e=>set("ciudad",e.target.value)} style={{...S.input,width:"100%"}} placeholder="ej. Buenos Aires"/></div>
          <div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Partido (auto)</label><input value={f.partido} onChange={e=>set("partido",e.target.value)} style={{...S.input,width:"100%",color:f.partido?"#10b981":"#6b7280"}} placeholder="Por CP"/></div>
          <div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Zona ML</label><div style={{...S.input,padding:"0.45rem 0.6rem",color:ZONA_ML_COLOR[getZonaML(f.partido)]||"#6b7280",fontSize:"0.8rem",fontWeight:700}}>{getZonaML(f.partido)||"-"}</div></div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.7rem",marginBottom:"0.7rem"}}>
          <div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Logistica</label><div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{logActivas.map(l =><button key={l} onClick={()=>handleTrans(l)} style={S.btnSm(f.trans===l,lc[l]?.color||"#6366f1")}>{l}</button>)}</div></div>
          <div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Turno</label><div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{TURNOS.map(t =><button key={t} onClick={()=>set("turno",f.turno===t?"":t)} style={S.btnSm(f.turno===t,"#8b5cf6")}>{t}</button>)}</div></div>
          <div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Fecha entrega</label><input type="date" value={f.fecha} onChange={e=>set("fecha",e.target.value)} style={{...S.input,width:"100%"}}/></div>
        </div>
        <div style={{marginBottom:"0.6rem"}}><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Observaciones</label><textarea value={f.observaciones} onChange={e=>set("observaciones",e.target.value)} style={{...S.input,display:"block",width:"100%",height:"44px",resize:"vertical",fontSize:"0.8rem"}} placeholder="Notas adicionales..."/></div>
        <div style={{...S.card,padding:"0.65rem 1rem",marginBottom:"0.55rem",background:"#0f1420"}}><div style={{display:"flex",alignItems:"center",gap:"0.75rem"}}><button onClick={()=>set("cobranza",f.cobranza!==null?null:0)} style={S.btnSm(f.cobranza!==null,"#f59e0b")}>Cobranza</button>{f.cobranza!==null?<input type="number" placeholder="Monto" value={f.cobranza||""} onChange={e=>set("cobranza",parseFloat(e.target.value)||0)} style={{...S.input,width:"150px",padding:"4px 10px"}}/>:<span style={{color:"#374151",fontSize:"0.78rem"}}>Sin cobranza</span>}</div></div>
        <div style={{...S.card,padding:"0.65rem 1rem",marginBottom:"0.9rem",background:"#0f1420"}}>
          <div style={{fontSize:"0.62rem",color:"#6b7280",fontWeight:700,textTransform:"uppercase",marginBottom:"8px"}}>Cambio / Retiro</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.7rem"}}>
            <div><label style={{display:"block",color:"#ec4899",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Lo que se entrega</label><textarea value={f.cambio||""} onChange={e=>set("cambio",e.target.value||null)} placeholder="Qué dejamos..." style={{...S.input,display:"block",width:"100%",height:"56px",resize:"vertical",fontSize:"0.8rem"}}/></div>
            <div><label style={{display:"block",color:"#f97316",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Lo que se retira</label><textarea value={f.retiro||""} onChange={e=>set("retiro",e.target.value||null)} placeholder="Qué buscamos..." style={{...S.input,display:"block",width:"100%",height:"56px",resize:"vertical",fontSize:"0.8rem"}}/></div>
          </div>
        </div>
        <div style={{...S.card,padding:"0.65rem 1rem",marginBottom:"0.9rem",background:f.esCC?"#130d2a":"#0f1420",border:f.esCC?"1px solid #a78bfa":"1px solid #1e2535"}}><div style={{display:"flex",alignItems:"center",gap:"0.75rem"}}><button onClick={()=>set("esCC",!f.esCC)} style={S.btnSm(f.esCC,"#a78bfa")}>Cta. Corriente</button>{f.esCC?<><span style={{color:"#6b7280",fontSize:"0.78rem"}}>Importe:</span><input type="number" placeholder="Monto" value={f.importeCC||""} onChange={e=>set("importeCC",parseFloat(e.target.value)||0)} style={{...S.input,width:"150px",padding:"4px 10px"}}/><span style={{color:"#a78bfa",fontSize:"0.72rem"}}>El cliente te debe este monto</span></>:<span style={{color:"#374151",fontSize:"0.78rem"}}>Marcar como Cuenta Corriente</span>}</div></div>
        <div style={{display:"flex",justifyContent:"flex-end",gap:"0.5rem"}}><button onClick={()=>{setF(vacio);setErr("");setDupWarn("");setDirsCliente([]);}} style={S.btn(false)}>Limpiar</button><button onClick={guardar} style={{...S.btn(true),background:"linear-gradient(135deg,#6366f1,#8b5cf6)",padding:"0.5rem 1.2rem"}}>Agregar envio</button></div>
      </div>
    </div>
  );
}

function TabTarifas({zc,setZc,lc,setLc}){
  const [subTab,setSubTab]=useState("zonas");
  const [logSel,setLogSel]=useState("");
  const [tipoMx,setTipoMx]=useState("noflex");
  const [guardado,setGuardado]=useState(false);
  const [editando,setEditando]=useState(null);
  const [moverModal,setMoverModal]=useState(null);
  const [addModal,setAddModal]=useState(false);
  const [newZona,setNewZona]=useState({nombre:"",color:"#6366f1",precio:0});
  const elimLog=async(k,nombre)=>{
    if(!window.confirm(`¿Eliminar "${nombre}"? Esta acción no se puede deshacer.`))return;
    const newLc={...lc};
    delete newLc[k];
    setLc(newLc);
    await setDoc(doc(db,"config","logisticas"),newLc);
    if(logSel===k)setLogSel(Object.keys(newLc).find(x=>newLc[x].activa)||"");
  };
  const logActivas=Object.keys(lc).filter(k =>lc[k].activa);
  useEffect(()=>{if((!logSel||!lc[logSel]?.activa)&&logActivas.length>0)setLogSel(logActivas[0]);},[lc]);
  const cfg=zc[logSel]||{zonas:[]};
  const asig=new Set(cfg.zonas.flatMap(z=>z.partidos));
  const sinAsig=ALL_PARTIDOS.filter(p =>!asig.has(p));
  const upd=fn=>setZc(p=>({...p,[logSel]:{...p[logSel],zonas:fn(p[logSel]?.zonas||[])}}));
  const updP=(id,v)=>upd(zs=>zs.map(z=>z.id===id?{...z,precio:parseInt(v)||0}:z));
  const updC=(id,c)=>upd(zs=>zs.map(z=>z.id===id?{...z,color:c}:z));
  const updN=(id,n)=>upd(zs=>zs.map(z=>z.id===id?{...z,nombre:n}:z));
  const elimZ=id=>{if(!window.confirm("Eliminar zona?"))return;upd(zs=>zs.filter(z=>z.id!==id));};
  const moverP=(p,dest)=>upd(zs=>zs.map(z=>({...z,partidos:z.id===dest?[...new Set([...z.partidos,p])]:z.partidos.filter(x=>x!==p)})));
  const quitarP=p=>upd(zs=>zs.map(z=>({...z,partidos:z.partidos.filter(x=>x!==p)})));
  const addZ=()=>{if(!newZona.nombre.trim())return;const id=newZona.nombre.toUpperCase().replace(/\s+/g,"_")+"_"+Date.now();upd(zs=>[...zs,{id,...newZona,partidos:[]}]);setAddModal(false);setNewZona({nombre:"",color:"#6366f1",precio:0});};
  const toggleLog=k=>setLc(p=>({...p,[k]:{...p[k],activa:!p[k].activa}}));
  const updNombreFormal=(k,v)=>setLc(p=>({...p,[k]:{...p[k],nombreFormal:v}}));
  const updBulto=(k,b,p2)=>setLc(p=>({...p,[k]:{...p[k],preciosBultos:p[k].preciosBultos.map(x =>x.b===b?{...x,p:parseInt(p2)||0}:x)}}));
  const addBulto=k=>setLc(p=>{const lk=p[k];const maxB=Math.max(...(lk.preciosBultos||[]).map(x =>x.b),0);return{...p,[k]:{...lk,preciosBultos:[...(lk.preciosBultos||[]),{b:maxB+1,p:0}]}};});
  const delBulto=(k,b)=>setLc(p=>({...p,[k]:{...p[k],preciosBultos:p[k].preciosBultos.filter(x =>x.b!==b)}}));
  return(
    <div>
      <div style={{...S.card,padding:"0.65rem 1rem",marginBottom:"1rem",display:"flex",gap:"4px",flexWrap:"wrap",alignItems:"center"}}>
        <button onClick={()=>setSubTab("zonas")} style={S.btn(subTab==="zonas")}>Zonas y precios</button>
        <button onClick={()=>setSubTab("bultos")} style={S.btn(subTab==="bultos")}>Matriz de precios</button>
        <button onClick={()=>setSubTab("logisticas")} style={S.btn(subTab==="logisticas")}>Logisticas</button>
        {subTab!=="logisticas"&&<><span style={{color:"#374151",fontSize:"0.65rem",margin:"0 4px"}}>|</span>{Object.entries(lc).filter(([,v])=>v.activa).map(([k,v])=><button key={k} onClick={()=>setLogSel(k)} style={S.btn(logSel===k,v.color)}>{k}</button>)}</>}
        {guardado&&<span style={{color:"#10b981",fontSize:"0.72rem",marginLeft:"8px"}}>✓ Guardado</span>}
        <button onClick={()=>{setZc(p=>{const next={...p};setDoc(doc(db,"config","zonas"),next).catch(console.error);return next;});setLc(p=>{const next={...p};setDoc(doc(db,"config","logisticas"),next).catch(console.error);return next;});setGuardado(true);setTimeout(()=>setGuardado(false),2000);}} style={{...S.btn(true),background:"linear-gradient(135deg,#6366f1,#8b5cf6)",padding:"0.35rem 1rem",marginLeft:"auto",fontSize:"0.78rem"}}>Guardar</button>
      </div>
      {subTab==="zonas"&&<>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(245px,1fr))",gap:"0.85rem",marginBottom:"0.9rem"}}>
          {cfg.zonas.map(zona=>(
            <div key={zona.id} style={{...S.card,borderTop:"3px solid "+zona.color,overflow:"hidden"}}>
              <div style={{padding:"0.55rem 0.9rem 0.45rem",display:"flex",alignItems:"center",gap:"0.45rem",borderBottom:"1px solid #1e2535"}}>
                <input type="color" value={zona.color} onChange={e=>updC(zona.id,e.target.value)} style={{width:"18px",height:"18px",border:"none",borderRadius:"50%",cursor:"pointer",padding:0,flexShrink:0}}/>
                <input value={zona.nombre} onChange={e=>updN(zona.id,e.target.value)} style={{...S.input,flex:1,padding:"0.2rem 0.4rem",background:"transparent",border:"none",color:zona.color,fontWeight:700,fontSize:"0.85rem"}}/>
                <button onClick={()=>elimZ(zona.id)} style={{background:"none",border:"none",color:"#374151",cursor:"pointer",fontSize:"0.85rem"}}>x</button>
              </div>
              <div style={{padding:"0.45rem 0.9rem",borderBottom:"1px solid #1e2535",display:"flex",alignItems:"center",gap:"0.6rem"}}>
                <span style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase"}}>Precio 1 bulto</span>
                {editando&&editando.id===zona.id?<input autoFocus value={editando.val} onChange={e=>setEditando({...editando,val:e.target.value})} onBlur={()=>{updP(zona.id,editando.val);setEditando(null);}} onKeyDown={e=>{if(e.key==="Enter"){updP(zona.id,editando.val);setEditando(null);}if(e.key==="Escape")setEditando(null);}} style={{...S.input,width:"100px",textAlign:"right",border:"1px solid "+zona.color,fontWeight:700}}/>:<span onDoubleClick={()=>setEditando({id:zona.id,val:String(zona.precio)})} style={{color:zona.precio>0?"#10b981":"#374151",fontWeight:800,fontSize:"1.1rem",cursor:"pointer",padding:"2px 8px",borderRadius:"5px"}}>{fmt(zona.precio)}</span>}
                <span style={{color:"#374151",fontSize:"0.65rem",marginLeft:"auto"}}>{zona.partidos.length}</span>
              </div>
              <div style={{padding:"0.45rem 0.65rem",minHeight:"50px",display:"flex",flexWrap:"wrap",gap:"0.25rem",alignContent:"flex-start"}}>
                {zona.partidos.length===0&&<div style={{color:"#374151",fontSize:"0.7rem",width:"100%",textAlign:"center"}}>Sin partidos</div>}
                {zona.partidos.map(p =><div key={p} style={{display:"flex",alignItems:"center",gap:"0.2rem",padding:"2px 6px",background:"#0f1420",border:"1px solid "+zona.color+"44",borderRadius:"5px"}}><button onClick={()=>setMoverModal({p,from:zona.id})} style={{background:"none",border:"none",color:"#d1d5db",cursor:"pointer",fontSize:"0.68rem",padding:0}}>{p}</button><button onClick={()=>quitarP(p)} style={{background:"none",border:"none",color:"#374151",cursor:"pointer",fontSize:"0.6rem",padding:0}}>x</button></div>)}
              </div>
            </div>
          ))}
          <div onClick={()=>setAddModal(true)} style={{...S.card,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:"0.4rem",minHeight:"130px",cursor:"pointer",border:"1px dashed #252d40",background:"transparent"}}><span style={{color:"#374151",fontSize:"1.6rem"}}>+</span><span style={{color:"#4b5563",fontSize:"0.78rem"}}>Nueva zona</span></div>
        </div>
        {sinAsig.length>0&&<div style={{...S.card,padding:"0.65rem 1rem"}}><div style={{color:"#f59e0b",fontWeight:700,fontSize:"0.68rem",marginBottom:"0.4rem"}}>Sin asignar ({sinAsig.length})</div><div style={{display:"flex",flexWrap:"wrap",gap:"0.3rem"}}>{sinAsig.map(p =><button key={p} onClick={()=>setMoverModal({p,from:null})} style={{padding:"2px 8px",background:"#1c1500",border:"1px solid #78350f",borderRadius:"5px",color:"#fbbf24",fontSize:"0.7rem",cursor:"pointer"}}>{p}</button>)}</div></div>}
      </>}
      {subTab==="bultos"&&(()=>{
        const BULTOS_FIJOS=[1,2,3,10,11];
        const zonas=cfg.zonas||[];
        const mxKey=tipoMx==="flex"?"tarifaMatrixFlex":"tarifaMatrix";
        const matrix=lc[logSel]?.[mxKey]||{};
        const getM=(zid,b)=>(matrix[zid]?.[String(b)])||"";
        const setM=(zid,b,val)=>setLc(p=>({...p,[logSel]:{...p[logSel],[mxKey]:{...(p[logSel]?.[mxKey]||{}),[zid]:{...(p[logSel]?.[mxKey]?.[zid]||{}),[String(b)]:parseInt(val)||0}}}}));
        const vigDesde=lc[logSel]?.tarifaVigenciaDesde||"";
        const historial=lc[logSel]?.tarifaHistorial||[];
        const crearNuevaVigencia=()=>{
          const nuevaFecha=window.prompt("Vigencia desde (YYYY-MM-DD):",fechaHoy());
          if(!nuevaFecha)return;
          // Guardar version actual en historial
          const matrizActual=lc[logSel]?.tarifaMatrix||{};
          const vigActual=lc[logSel]?.tarifaVigenciaDesde||"2000-01-01";
          const histActual=lc[logSel]?.tarifaHistorial||[];
          if(Object.keys(matrizActual).length>0){
            setLc(p=>({...p,[logSel]:{...p[logSel],
              tarifaMatrix:{},
              tarifaVigenciaDesde:nuevaFecha,
              tarifaHistorial:[...histActual,{vigenciaDesde:vigActual,tarifaMatrix:matrizActual}]
            }}));
          } else {
            setLc(p=>({...p,[logSel]:{...p[logSel],tarifaVigenciaDesde:nuevaFecha}}));
          }
        };
        if(!zonas.length)return<div style={{...S.card,padding:"1.5rem",textAlign:"center",color:"#4b5563"}}>Primero creá zonas en el tab "Zonas y precios"</div>;
        return(
          <div>
            <div style={{...S.card,padding:"0.65rem 1rem",marginBottom:"0.75rem",display:"flex",gap:"0.75rem",alignItems:"flex-start",flexWrap:"wrap"}}>
              <div style={{flex:1}}>
                <div style={{display:"flex",gap:"4px",marginBottom:"8px"}}>
                  <button onClick={()=>setTipoMx("noflex")} style={{...S.btn(tipoMx==="noflex"),padding:"3px 14px",fontSize:"0.75rem"}}>NO FLEX</button>
                  <button onClick={()=>setTipoMx("flex")} style={tipoMx==="flex"?{...S.btn(true,"#84cc16"),background:"#0d1c04",color:"#84cc16",border:"1px solid #84cc16",padding:"3px 14px",fontSize:"0.75rem"}:{...S.btn(false),color:"#4b7a10",border:"1px solid #1a3008",padding:"3px 14px",fontSize:"0.75rem"}}>FLEX</button>
                  {tipoMx==="flex"&&<span style={{color:"#6b7280",fontSize:"0.7rem",alignSelf:"center"}}>Si una celda está en 0, usa el precio de la matriz NO FLEX</span>}
                </div>
                <div style={{color:"#6b7280",fontSize:"0.78rem",marginBottom:"4px"}}>
                  Ingresá el precio para cada zona y cantidad de bultos. Dejá en 0 para usar el precio base de la zona.
                </div>
                <div style={{display:"flex",gap:"8px",alignItems:"center",flexWrap:"wrap"}}>
                  <span style={{color:"#4b5563",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase"}}>Vigente desde:</span>
                  <span style={{color:vigDesde?"#10b981":"#f59e0b",fontWeight:700,fontSize:"0.82rem"}}>{vigDesde||"Sin fecha definida"}</span>
                  <button onClick={crearNuevaVigencia} style={{...S.btnSm(false),color:"#6366f1",border:"1px solid #6366f1",padding:"2px 10px",fontSize:"0.7rem"}}>+ Nueva vigencia</button>
                </div>
                <div style={{color:"#f59e0b",fontSize:"0.7rem",marginTop:"4px"}}>⚠ 4-10 bultos usa precio de "10 bultos" · 11+ usa "11 bultos"</div>
              </div>
              {historial.length>0&&<div style={{minWidth:"180px"}}>
                <div style={{color:"#4b5563",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>Historial</div>
                {[...historial].sort((a,b)=>b.vigenciaDesde.localeCompare(a.vigenciaDesde)).map((h,i)=>(
                  <div key={i} style={{fontSize:"0.72rem",color:"#6b7280",padding:"2px 0",borderBottom:"1px solid #1a1f2e"}}>
                    Desde {h.vigenciaDesde} · {Object.keys(h.tarifaMatrix||{}).length} zonas
                  </div>
                ))}
              </div>}
            </div>
            <div style={{...S.card,overflow:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:"0.82rem",minWidth:"500px"}}>
                <thead>
                  <tr style={{background:"#12172a",borderBottom:"1px solid #252d40"}}>
                    <th style={{...thSt,width:"80px"}}>Bultos</th>
                    {zonas.map(z=><th key={z.id} style={{...thSt,textAlign:"center"}}>
                      <span style={{color:z.color,fontWeight:700}}>{z.nombre}</span>
                    </th>)}
                  </tr>
                </thead>
                <tbody>
                  {BULTOS_FIJOS.map((b,i)=>(
                    <tr key={b} style={{borderBottom:"1px solid #1a1f2e",background:i%2===0?"transparent":"#0d1119"}}>
                      <td style={{...tdSt,fontWeight:700,color:"#e5e7eb",whiteSpace:"nowrap"}}>
                        {b===10?"4-10 bultos":b===11?"11+ bultos":b===1?"1 bulto":b+" bultos"}
                      </td>
                      {zonas.map(z=>{
                        const val=getM(z.id,b);
                        return(
                          <td key={z.id} style={{...tdSt,textAlign:"center",padding:"4px 8px"}}>
                            <input
                              type="number"
                              value={val||""}
                              onChange={ev=>setM(z.id,b,ev.target.value)}
                              placeholder="0"
                              style={{...S.input,width:"100px",padding:"4px 8px",textAlign:"right",fontSize:"0.8rem",border:val>0?"1px solid "+z.color+"66":"1px solid #252d40"}}
                            />
                            {val>0&&<div style={{color:"#10b981",fontSize:"0.68rem",marginTop:"1px"}}>{fmt(val)}</div>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}
      {subTab==="logisticas"&&<div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:"0.85rem",marginBottom:"1rem"}}>
          {Object.entries(lc).map(([k,v])=>(
            <div key={k} style={{...S.card,borderTop:"3px solid "+(v.activa?v.color:"#374151"),overflow:"hidden",opacity:v.activa?1:0.6}}>
              <div style={{padding:"0.75rem 1rem",display:"flex",alignItems:"center",justifyContent:"space-between",gap:"6px"}}>
                <span style={{color:v.activa?v.color:"#6b7280",fontWeight:800,fontSize:"1rem",flex:1}}>{v.nombre}</span>
                <button onClick={()=>elimLog(k,v.nombre||k)} title="Eliminar" style={{background:"none",border:"none",color:"#4b5563",cursor:"pointer",fontSize:"0.78rem",padding:"2px 4px"}}>🗑️</button>
                <button onClick={()=>toggleLog(k)} style={{...S.btnSm(v.activa,v.color),padding:"4px 12px"}}>{v.activa?"Activa":"Desactivar"}</button>
              </div>
              <div style={{padding:"0 1rem 0.75rem",display:"flex",flexDirection:"column",gap:"6px"}}>
                <div style={{color:"#4b5563",fontSize:"0.75rem"}}>{v.activa?"Visible en la app":"No aparece en asignacion ni filtros"}</div>
                {v.activa&&<div style={{display:"flex",flexDirection:"column",gap:"4px"}}>
                  <span style={{color:"#4b5563",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase"}}>Nombre formal (reportes)</span>
                  <input value={v.nombreFormal||""} onChange={e=>updNombreFormal(k,e.target.value)} placeholder={k} style={{...S.input,fontSize:"0.78rem",padding:"4px 8px"}}/>
                </div>}
                {v.activa&&<div style={{display:"flex",alignItems:"center",gap:"8px"}}>
                  <div onClick={()=>setLc(p=>({...p,[k]:{...p[k],mostrarImporteLg:!p[k].mostrarImporteLg}}))} style={{width:"32px",height:"18px",borderRadius:"9px",background:v.mostrarImporteLg?"#6366f1":"#252d40",cursor:"pointer",position:"relative",transition:"background 0.2s"}}>
                    <div style={{position:"absolute",top:"2px",left:v.mostrarImporteLg?"14px":"2px",width:"14px",height:"14px",borderRadius:"50%",background:"white",transition:"left 0.2s"}}/>
                  </div>
                  <span style={{color:"#6b7280",fontSize:"0.7rem"}}>Mostrar importe a logistica</span>
                </div>}
              </div>
            </div>
          ))}
        </div>
        {/* Agregar nueva logistica */}
        <div style={{...S.card,padding:"1rem"}}>
          <div style={{fontWeight:700,fontSize:"0.85rem",marginBottom:"0.75rem",color:"#e5e7eb"}}>+ Nueva logistica</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 100px 80px auto",gap:"0.5rem",alignItems:"center"}}>
            <input id="nl-nombre" placeholder="Nombre (ej. NUEVO)" style={{...S.input,textTransform:"uppercase"}}/>
            <input id="nl-color" type="color" defaultValue="#6366f1" style={{height:"36px",width:"100%",border:"1px solid #252d40",borderRadius:"7px",background:"#0f1420",cursor:"pointer"}}/>
            <span style={{color:"#6b7280",fontSize:"0.72rem",textAlign:"center"}}>Color</span>
            <button onClick={()=>{
              const nombre=document.getElementById("nl-nombre")?.value?.trim().toUpperCase();
              const color=document.getElementById("nl-color")?.value||"#6366f1";
              if(!nombre)return;
              const key=nombre.replace(/\s+/g,"_");
              if(lc[key])return;
              const r=parseInt(color.slice(1,3),16),g=parseInt(color.slice(3,5),16),b=parseInt(color.slice(5,7),16);
              const bg="rgba("+r+","+g+","+b+",0.15)";
              setLc(p=>({...p,[key]:{nombre,color,bg,activa:true,preciosBultos:[{b:1,p:0},{b:2,p:0},{b:3,p:0}]}}));
              document.getElementById("nl-nombre").value="";
            }} style={{...S.btn(true),whiteSpace:"nowrap"}}>Agregar</button>
          </div>
        </div>
      </div>}
      {moverModal&&<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}><div style={{...S.card,padding:"1.1rem",width:"100%",maxWidth:"320px"}}><h3 style={{margin:"0 0 0.2rem",fontWeight:800,fontSize:"0.95rem"}}>Mover: {moverModal.p}</h3><p style={{margin:"0 0 0.9rem",color:"#9ca3af",fontSize:"0.82rem"}}>A que zona?</p><div style={{display:"grid",gap:"0.35rem"}}>{cfg.zonas.filter(z=>z.id!==moverModal.from).map(z=><button key={z.id} onClick={()=>{moverP(moverModal.p,z.id);setMoverModal(null);}} style={{padding:"0.5rem 0.9rem",background:"#0f1420",border:"1px solid "+z.color,borderRadius:"8px",color:z.color,fontWeight:700,cursor:"pointer",textAlign:"left",fontSize:"0.82rem",display:"flex",justifyContent:"space-between"}}><span>{z.nombre}</span><span style={{color:"#6b7280",fontWeight:400}}>{fmt(z.precio)}</span></button>)}</div><button onClick={()=>setMoverModal(null)} style={{...S.btn(false),marginTop:"0.65rem",width:"100%"}}>Cancelar</button></div></div>}
      {addModal&&<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}><div style={{...S.card,padding:"1.25rem",width:"100%",maxWidth:"320px"}}><h3 style={{margin:"0 0 0.9rem",fontWeight:800}}>Nueva zona - {logSel}</h3><div style={{display:"grid",gap:"0.65rem"}}><div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Nombre</label><input value={newZona.nombre} onChange={e=>setNewZona(p=>({...p,nombre:e.target.value}))} style={{...S.input,width:"100%"}} placeholder="ej. ZONA 4"/></div><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.65rem"}}><div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Color</label><input type="color" value={newZona.color} onChange={e=>setNewZona(p=>({...p,color:e.target.value}))} style={{width:"100%",height:"34px",borderRadius:"7px",border:"1px solid #252d40",cursor:"pointer"}}/></div><div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Precio</label><input type="number" value={newZona.precio} onChange={e=>setNewZona(p=>({...p,precio:parseInt(e.target.value)||0}))} style={{...S.input,width:"100%"}}/></div></div></div><div style={{display:"flex",gap:"0.5rem",marginTop:"1rem",justifyContent:"flex-end"}}><button onClick={()=>setAddModal(false)} style={S.btn(false)}>Cancelar</button><button onClick={addZ} style={{...S.btn(true),background:lc[logSel]?.color||"#6366f1"}}>Crear</button></div></div></div>}
    </div>
  );
}

function TabInforme({envios,zc,lc}){
  const initSem=()=>{
    const d=new Date();const day=d.getDay()||7;
    const lun=new Date(d);lun.setDate(d.getDate()-(day-1));
    const dom=new Date(lun);dom.setDate(lun.getDate()+6);
    const s=x=>x.toISOString().split("T")[0];
    return{d:s(lun),h:s(dom)};
  };
  const sem=initSem();
  const [desde,setDesde]=useState(sem.d);
  const [hasta,setHasta]=useState(sem.h);
  const [logSel,setLogSel]=useState("TODAS");
  const [filTipos,setFilTipos]=useState(new Set());
  const [showCaros,setShowCaros]=useState(false);
  const toggleTipo=t=>setFilTipos(prev=>{const n=new Set(prev);n.has(t)?n.delete(t):n.add(t);return n;});
  const logActivas=Object.entries(lc).filter(([,v])=>v.activa).map(([k])=>k);
  const tmap=buildTarifaMap(zc);
  const getImp=e=>e.importeOverride>0?e.importeOverride:calcImp(e,tmap,lc,zc);
  const getTipo=e=>e.origen==="ML"?"FLEX":e.origen==="Tienda Nube"?"TN":"Manual";
  const envSem=envios.filter(e=>{
    const ds=e.fecha||e.fechaVenta||"";
    if(e.estado==="cancelado")return false;
    if(logSel!=="TODAS"&&e.trans!==logSel)return false;
    if(filTipos.size>0&&!filTipos.has(getTipo(e)))return false;
    return ds>=desde&&ds<=hasta;
  });
  const logsMost=logSel==="TODAS"?logActivas:[logSel];

  // Análisis FLEX vs ML
  const envFlex=envSem.filter(e=>e.origen==="ML");
  const flexCaros=envFlex.filter(e=>{const mlF=ML_FINAL[e.partido];return mlF&&getImp(e)>mlF;});
  const totalMLPaga=envFlex.reduce((s,e)=>s+(ML_FINAL[e.partido]||0),0);
  const totalCostoFlex=envFlex.reduce((s,e)=>s+getImp(e),0);
  const porPartidoFlex=(()=>{
    const m={};
    envFlex.forEach(e=>{
      const p=e.partido||"Sin partido";
      if(!m[p])m[p]={partido:p,mlFinal:ML_FINAL[e.partido]||0,count:0,costo:0,caros:[]};
      const imp=getImp(e);m[p].count++;m[p].costo+=imp;
      if(m[p].mlFinal>0&&imp>m[p].mlFinal)m[p].caros.push(e);
    });
    return Object.values(m).sort((a,b)=>b.count-a.count);
  })();

  if(!envios.length)return<div style={{textAlign:"center",padding:"3rem",color:"#4b5563"}}><div style={{fontSize:"2rem"}}>📊</div><p>Sin envios para mostrar</p></div>;
  return(
    <div>
      {/* Filtros fecha */}
      <div style={{...S.card,padding:"0.65rem 1rem",marginBottom:"0.8rem",display:"flex",gap:"8px",alignItems:"center",flexWrap:"wrap"}}>
        <span style={{color:"#4b5563",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase"}}>Desde</span>
        <input type="date" value={desde} onChange={ev=>setDesde(ev.target.value)} style={{...S.input,padding:"4px 8px",width:"140px"}}/>
        <span style={{color:"#4b5563",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase"}}>Hasta</span>
        <input type="date" value={hasta} onChange={ev=>setHasta(ev.target.value)} style={{...S.input,padding:"4px 8px",width:"140px"}}/>
        <button onClick={()=>{const s=initSem();setDesde(s.d);setHasta(s.h);}} style={S.btnSm(false)}>Esta semana</button>
      </div>
      {/* Filtro tipo */}
      <div style={{...S.card,padding:"0.55rem 1rem",marginBottom:"0.8rem",display:"flex",gap:"0.35rem",flexWrap:"wrap",alignItems:"center"}}>
        <span style={{color:"#4b5563",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",marginRight:"4px"}}>Tipo</span>
        {[{k:"FLEX",c:"#84cc16"},{k:"TN",c:"#38bdf8"},{k:"Manual",c:"#a78bfa"}].map(({k,c})=>(
          <button key={k} onClick={()=>toggleTipo(k)} style={{...S.btnSm(filTipos.has(k),c),opacity:filTipos.size>0&&!filTipos.has(k)?0.45:1}}>{k}</button>
        ))}
        {filTipos.size>0&&<button onClick={()=>setFilTipos(new Set())} style={{...S.btnSm(false),fontSize:"0.65rem",padding:"2px 8px",color:"#6b7280"}}>✕ Limpiar</button>}
      </div>
      {/* Filtro logística + Excel */}
      <div style={{...S.card,padding:"0.55rem 1rem",marginBottom:"0.8rem",display:"flex",gap:"0.35rem",flexWrap:"wrap",alignItems:"center"}}>
        <button onClick={()=>setLogSel("TODAS")} style={S.btn(logSel==="TODAS")}>TODAS</button>
        {logActivas.map(l=><button key={l} onClick={()=>setLogSel(l)} style={S.btn(logSel===l,lc[l]?.color||"#6366f1")}>{l}</button>)}
        <button onClick={()=>{
          const filas=envSem.map((e,i)=>{
            const tipo=getTipo(e);
            const mlF=tipo==="FLEX"?(ML_FINAL[e.partido]||""):"";
            const imp=getImp(e);
            const dif=tipo==="FLEX"&&mlF!==""?mlF-imp:"";
            return{
              "#":i+1,
              Tipo:tipo,
              NroSeguimiento:e.nroSeguimiento||"",
              NroOrden:e.nroOrdenTN||"",
              Cliente:e.clienteNombre||"",
              Logistica:lc[e.trans]?.nombreFormal||e.trans||"",
              Partido:e.partido||"",
              Localidad:e.localidad||"",
              Direccion:e.direccion||"",
              Fecha:e.fecha||e.fechaVenta||"",
              Turno:e.turno||"",
              Bultos:e.bultos||1,
              Zona:(()=>{const zi=getZonaLogistica(zc,e.trans,e.partido);return zi?zi.nombre:"";})(),
              Importe:imp,
              MLFinal:mlF,
              Diferencia:dif,
              Cobranza:e.cobranza||"",
              EstadoPago:e.estadoPago||"",
              EstadoLiq:e.estadoLiq||"normal",
              NotaLiq:e.notaLiq||"",
            };
          });
          exportarXLSX(filas,"informe_"+desde+"_"+hasta);
        }} style={{...S.btnSm(false),color:"#10b981",border:"1px solid #10b981",marginLeft:"auto",padding:"3px 12px",fontSize:"0.72rem"}}>⬇ Excel</button>
      </div>

      {/* Tablas por logística */}
      {logsMost.map(l=>{
        const lcD=lc[l];const envL=envSem.filter(e=>e.trans===l);if(!envL.length)return null;
        const envLNormal=envL.filter(e=>!e.estadoLiq||e.estadoLiq==="normal");
        const envLNoAbonado=envL.filter(e=>e.estadoLiq==="cancelado_liq"||e.estadoLiq==="no_abonado");
        const porZona={};
        envLNormal.forEach(e=>{const zi=getZonaLogistica(zc,l,e.partido);const k=zi?zi.nombre:"Sin zona";if(!porZona[k])porZona[k]={nombre:k,color:zi?.color||"#374151",envios:[]};porZona[k].envios.push(e);});
        if(envLNoAbonado.length){if(!porZona["_no_abonado"])porZona["_no_abonado"]={nombre:"No abonados / Cancelados",color:"#f87171",envios:[]};envLNoAbonado.forEach(e=>porZona["_no_abonado"].envios.push(e));}
        const totalL=envLNormal.reduce((s,e)=>s+getImp(e),0);
        const totalNoAbonado=envLNoAbonado.reduce((s,e)=>s+getImp(e),0);
        return(
          <div key={l} style={{...S.card,marginBottom:"1rem",overflow:"hidden"}}>
            <div style={{padding:"0.7rem 1rem",background:"#12172a",borderBottom:"1px solid #252d40",display:"flex",alignItems:"center",gap:"0.75rem",flexWrap:"wrap"}}>
              <span style={{color:lcD.color,fontWeight:800,fontSize:"1rem"}}>{l}</span>
              <span style={{color:"#e5e7eb",fontWeight:700}}>{envL.length} envios</span>
              {envLNoAbonado.length>0&&<span style={{color:"#f87171",fontSize:"0.72rem"}}>({envLNoAbonado.length} no abonado{envLNoAbonado.length>1?"s":""})</span>}
              <span style={{color:"#10b981",fontWeight:700,marginLeft:"auto"}}>{fmt(totalL)}</span>
              {totalNoAbonado>0&&<span style={{color:"#f87171",fontSize:"0.72rem",textDecoration:"line-through"}}>{fmt(totalNoAbonado)}</span>}
            </div>
            <div style={{overflow:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:"0.82rem"}}>
                <thead><tr style={{borderBottom:"1px solid #1e2535",background:"#0f1420"}}>
                  <th style={thSt}>Zona / Partido</th>
                  <th style={{...thSt,textAlign:"center"}}>Envios</th>
                  <th style={{...thSt,textAlign:"right"}}>Valor unitario</th>
                  <th style={{...thSt,textAlign:"right"}}>Total</th>
                </tr></thead>
                <tbody>
                  {Object.values(porZona).map(zona=>{
                    const porValor={};
                    zona.envios.forEach(e=>{
                      const imp=getImp(e);const vk=String(imp);
                      if(!porValor[vk])porValor[vk]={valor:imp,count:0,total:0,partidos:new Set(),tieneCaro:false};
                      porValor[vk].count++;porValor[vk].total+=imp;porValor[vk].partidos.add(e.partido);
                      if(e.origen==="ML"&&ML_FINAL[e.partido]&&imp>ML_FINAL[e.partido])porValor[vk].tieneCaro=true;
                    });
                    const zonaTotal=zona.envios.reduce((s,e)=>s+getImp(e),0);
                    return([
                      <tr key={zona.nombre+"_h"} style={{background:"#12172a",borderTop:"1px solid #252d40"}}>
                        <td colSpan={4} style={{...tdSt,padding:"0.35rem 0.8rem"}}>
                          <span style={{display:"inline-block",padding:"1px 8px",borderRadius:"5px",background:zona.color+"22",color:zona.color,fontWeight:700,fontSize:"0.75rem"}}>{zona.nombre}</span>
                          <span style={{color:"#4b5563",fontSize:"0.7rem",marginLeft:"8px"}}>{zona.envios.length} envios · {fmt(zonaTotal)}</span>
                        </td>
                      </tr>,
                      ...Object.values(porValor).sort((a,b)=>b.valor-a.valor).map(({valor,count,total,partidos,tieneCaro})=>(
                        <tr key={zona.nombre+valor} style={{borderBottom:"1px solid #1a1f2e"}}>
                          <td style={{...tdSt,color:"#6b7280",paddingLeft:"1.5rem",fontSize:"0.75rem",whiteSpace:"normal"}}>{[...partidos].join(", ")}</td>
                          <td style={{...tdSt,textAlign:"center",color:"#e5e7eb"}}>{count}</td>
                          <td style={{...tdSt,textAlign:"right",color:"#9ca3af"}}>
                            {fmt(valor)}{tieneCaro&&<span title="Algún envío cuesta más que lo que paga ML" style={{marginLeft:"5px",fontSize:"0.75rem",cursor:"default"}}>⚠️</span>}
                          </td>
                          <td style={{...tdSt,textAlign:"right",color:"#10b981",fontWeight:600}}>{fmt(total)}</td>
                        </tr>
                      ))
                    ]);
                  })}
                </tbody>
                <tfoot>
                  <tr style={{borderTop:"2px solid #252d40",background:"#12172a"}}>
                    <td style={{...tdSt,color:lcD.color,fontWeight:800}}>TOTAL {l}</td>
                    <td style={{...tdSt,textAlign:"center",color:"#e5e7eb",fontWeight:700}}>{envL.length}</td>
                    <td style={tdSt}></td>
                    <td style={{...tdSt,textAlign:"right",color:"#10b981",fontWeight:800}}>{fmt(totalL)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        );
      })}

      {/* Sección Análisis FLEX vs ML */}
      {envFlex.length>0&&(()=>{
        const difNeta=totalMLPaga-totalCostoFlex;
        return(
          <div style={{...S.card,marginBottom:"1rem",overflow:"hidden",border:"1px solid #1a3008"}}>
            <div style={{padding:"0.7rem 1rem",background:"#0a1a04",borderBottom:"1px solid #1a3008",display:"flex",alignItems:"center",gap:"0.75rem",flexWrap:"wrap"}}>
              <span style={{color:"#84cc16",fontWeight:800,fontSize:"1rem"}}>📦 Análisis FLEX vs ML</span>
              <span style={{color:"#6b7280",fontSize:"0.75rem"}}>{envFlex.length} envíos FLEX en el período</span>
              {flexCaros.length>0&&(
                <button onClick={()=>setShowCaros(p=>!p)} style={{marginLeft:"auto",...S.btnSm(showCaros,"#f59e0b"),border:"1px solid #f59e0b",fontSize:"0.72rem"}}>
                  ⚠️ {flexCaros.length} más caro{flexCaros.length>1?"s":""} que ML {showCaros?"▲":"▼"}
                </button>
              )}
            </div>
            {/* Cards resumen */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(155px,1fr))",gap:"0.65rem",padding:"0.75rem 1rem",borderBottom:"1px solid #1a3008"}}>
              <div style={{background:"#0f1420",borderRadius:"8px",padding:"0.65rem 0.85rem",border:"1px solid #1a3008"}}>
                <div style={{color:"#6b7280",fontSize:"0.6rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>ML paga (total)</div>
                <div style={{color:"#84cc16",fontWeight:800,fontSize:"1.05rem"}}>{fmt(totalMLPaga)}</div>
              </div>
              <div style={{background:"#0f1420",borderRadius:"8px",padding:"0.65rem 0.85rem",border:"1px solid #1a3008"}}>
                <div style={{color:"#6b7280",fontSize:"0.6rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Nuestro costo FLEX</div>
                <div style={{color:"#10b981",fontWeight:800,fontSize:"1.05rem"}}>{fmt(totalCostoFlex)}</div>
              </div>
              <div style={{background:"#0f1420",borderRadius:"8px",padding:"0.65rem 0.85rem",border:"1px solid "+(difNeta>=0?"#1a3008":"#7f1d1d")}}>
                <div style={{color:"#6b7280",fontSize:"0.6rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Diferencia neta</div>
                <div style={{color:difNeta>=0?"#4ade80":"#f87171",fontWeight:800,fontSize:"1.05rem"}}>{difNeta>=0?"+":""}{fmt(difNeta)}</div>
                <div style={{color:"#374151",fontSize:"0.6rem"}}>{difNeta>=0?"ML cubre el costo":"Costo supera lo que paga ML"}</div>
              </div>
              {flexCaros.length>0&&(
                <div style={{background:"#1c0a00",borderRadius:"8px",padding:"0.65rem 0.85rem",border:"1px solid #92400e"}}>
                  <div style={{color:"#f59e0b",fontSize:"0.6rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Caros ({flexCaros.length})</div>
                  <div style={{color:"#f87171",fontWeight:800,fontSize:"1.05rem"}}>{fmt(flexCaros.reduce((s,e)=>s+(getImp(e)-(ML_FINAL[e.partido]||0)),0))}</div>
                  <div style={{color:"#6b7280",fontSize:"0.6rem"}}>exceso sobre lo que paga ML</div>
                </div>
              )}
            </div>
            {/* Tabla por partido */}
            <div style={{overflow:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:"0.8rem"}}>
                <thead>
                  <tr style={{background:"#0a1a04",borderBottom:"1px solid #1a3008"}}>
                    <th style={{...thSt,color:"#84cc16"}}>Partido</th>
                    <th style={{...thSt,textAlign:"center"}}>Envíos</th>
                    <th style={{...thSt,textAlign:"right"}}>ML paga</th>
                    <th style={{...thSt,textAlign:"right"}}>Nuestro costo (prom.)</th>
                    <th style={{...thSt,textAlign:"right"}}>Dif. unit.</th>
                    <th style={{...thSt,textAlign:"center"}}>⚠️</th>
                  </tr>
                </thead>
                <tbody>
                  {porPartidoFlex.map(({partido,mlFinal,count,costo,caros})=>{
                    const costoUnit=count?Math.round(costo/count):0;
                    const dif=mlFinal?mlFinal-costoUnit:null;
                    const esCaro=dif!==null&&dif<0;
                    return(
                      <tr key={partido} style={{borderBottom:"1px solid #1a1f2e",background:esCaro?"rgba(127,29,29,0.15)":"transparent"}}>
                        <td style={{...tdSt,color:"#e5e7eb",fontWeight:600}}>{partido}</td>
                        <td style={{...tdSt,textAlign:"center",color:"#9ca3af"}}>{count}</td>
                        <td style={{...tdSt,textAlign:"right",color:"#84cc16",fontWeight:600}}>{mlFinal?fmt(mlFinal):"—"}</td>
                        <td style={{...tdSt,textAlign:"right",color:"#10b981"}}>{fmt(costoUnit)}</td>
                        <td style={{...tdSt,textAlign:"right",fontWeight:dif!==null?700:400,color:dif===null?"#6b7280":dif>=0?"#4ade80":"#f87171"}}>
                          {dif===null?"—":(dif>=0?"+":"")+fmt(dif)}
                        </td>
                        <td style={{...tdSt,textAlign:"center",color:caros.length>0?"#f59e0b":"#374151",fontWeight:700}}>
                          {caros.length>0?caros.length:"—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {/* Lista de envíos caros (expandible) */}
            {showCaros&&flexCaros.length>0&&(
              <div style={{borderTop:"1px solid #1a3008",padding:"0.75rem 1rem"}}>
                <div style={{color:"#f59e0b",fontWeight:700,fontSize:"0.78rem",marginBottom:"0.6rem"}}>
                  Envíos donde el costo supera lo que paga ML
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:"5px"}}>
                  {flexCaros.map(e=>{
                    const imp=getImp(e);const mlF=ML_FINAL[e.partido]||0;const exceso=imp-mlF;
                    const nroRef=e.nroSeguimiento||("#"+(e.nroOrdenTN||e.id.slice(-10)));
                    return(
                      <div key={e.id} style={{display:"flex",gap:"8px",alignItems:"center",padding:"6px 10px",background:"#1c0a00",borderRadius:"6px",border:"1px solid #92400e",flexWrap:"wrap"}}>
                        <span style={{color:"#fbbf24",fontFamily:"monospace",fontSize:"0.75rem",flexShrink:0}}>{nroRef}</span>
                        <span style={{color:"#e5e7eb",fontSize:"0.78rem",flex:1,minWidth:"120px"}}>{e.direccion}</span>
                        <span style={{color:"#9ca3af",fontSize:"0.72rem",flexShrink:0}}>{e.partido}</span>
                        <span style={{color:"#f87171",fontWeight:700,fontSize:"0.78rem",flexShrink:0}}>
                          {fmt(imp)} <span style={{color:"#6b7280",fontWeight:400,fontSize:"0.72rem"}}>vs ML {fmt(mlF)}</span>
                        </span>
                        <span style={{color:"#f87171",fontWeight:700,fontSize:"0.75rem",background:"#7f1d1d",padding:"1px 7px",borderRadius:"4px",flexShrink:0}}>
                          +{fmt(exceso)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* Total período */}
      {logSel==="TODAS"&&(()=>{
        const totNorm=envSem.filter(e=>!e.estadoLiq||e.estadoLiq==="normal").reduce((s,e)=>s+getImp(e),0);
        const totNoAb=envSem.filter(e=>e.estadoLiq==="cancelado_liq"||e.estadoLiq==="no_abonado").reduce((s,e)=>s+getImp(e),0);
        return<div style={{...S.card,padding:"0.8rem 1rem",background:"#12172a",display:"flex",gap:"1.5rem",flexWrap:"wrap",alignItems:"center"}}>
          <span style={{color:"#6366f1",fontWeight:800,fontSize:"0.9rem"}}>TOTAL PERIODO</span>
          <span style={{color:"#e5e7eb",fontWeight:700}}>{envSem.length} envios</span>
          <span style={{color:"#10b981",fontWeight:800,fontSize:"1rem"}}>{fmt(totNorm)}</span>
          {totNoAb>0&&<span style={{color:"#4b5563",fontSize:"0.78rem"}}>No abonado: <span style={{color:"#f87171",textDecoration:"line-through"}}>{fmt(totNoAb)}</span></span>}
        </div>;
      })()}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// TAB MAPA
// ════════════════════════════════════════════════════════════════════
const LC_COLOR = {HNOS:"#8b5cf6",CARLOS:"#f59e0b",GUS:"#3b82f6",DELFRAN:"#10b981",SYM:"#ec4899"};
const TC_COLOR = {AM:"#60a5fa",MD:"#a78bfa",PM:"#f97316",Turbo:"#f472b6"};
const GEO_CACHE_KEY = "envhub_geocache";

function cargarLeaflet() {
  return new Promise(resolve => {
    if (window.L) return resolve();
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
    document.head.appendChild(css);
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
    script.onload = resolve;
    document.head.appendChild(script);
  });
}

async function geocodificar(direccion, cp, ciudad) {
  const cache = JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || "{}");
  const key = (direccion + cp).replace(/\s+/g, "").toLowerCase();
  if (cache[key]) return cache[key];
  const query = encodeURIComponent(direccion + ", " + (ciudad || "") + ", Buenos Aires, Argentina");
  try {
    const res = await fetch("https://nominatim.openstreetmap.org/search?q=" + query + "&format=json&limit=1&countrycodes=ar", {
      headers: { "Accept-Language": "es", "User-Agent": "EnviosHub/1.2" }
    });
    const data = await res.json();
    if (data && data[0]) {
      const coords = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
      cache[key] = coords;
      localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(cache));
      return coords;
    }
  } catch(e) { /* sin red o error */ }
  return null;
}

function TabMapa({ envios, lc }) {
  const hoy = fechaHoy();
  const [modFecha, setModFecha] = useState("hoy");
  const [rangoD, setRangoD] = useState(hoy);
  const [rangoH, setRangoH] = useState(hoy);
  const [filTrans, setFilTrans] = useState("TODOS");
  const [filTurno, setFilTurno] = useState("TODOS");
  const [modColor, setModColor] = useState("logistica");
  const [geoData, setGeoData] = useState([]);
  const [cargando, setCargando] = useState(false);
  const [progreso, setProgreso] = useState(0);
  const [total, setTotal] = useState(0);
  const mapRef = useRef(null);
  const leafletMap = useRef(null);
  const markersRef = useRef([]);

  const logActivas = Object.entries(lc).filter(([,v]) => v.activa).map(([k]) => k);

  const getRango = () => {
    if (modFecha === "todos") return { d: "", h: "" };
    if (modFecha === "hoy")    return { d: hoy, h: hoy };
    if (modFecha === "ayer")   return { d: fechaAyer(), h: fechaAyer() };
    if (modFecha === "semana") return { d: fechaInicioSemana(), h: hoy };
    return { d: rangoD, h: rangoH };
  };

  const { d: desde, h: hasta } = getRango();

  const filtrados = envios.filter(e => {
    const f = e.fecha || e.fechaVenta || "";
    if (desde && f < desde) return false;
    if (hasta && f > hasta) return false;
    if (filTrans !== "TODOS" && e.trans !== filTrans) return false;
    if(filTurno==="SIN_TURNO"){if(e.turno)return false;}else if(filTurno!=="TODOS"&&e.turno!==filTurno)return false;
    return getEstado(e) !== "cancelado";
  });

  // Inicializar mapa
  useEffect(() => {
    cargarLeaflet().then(() => {
      if (!mapRef.current || leafletMap.current) return;
      leafletMap.current = window.L.map(mapRef.current, { center: [-34.62, -58.48], zoom: 10 });
      window.L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution: "CartoDB", maxZoom: 19
      }).addTo(leafletMap.current);
    });
    return () => {
      if (leafletMap.current) { leafletMap.current.remove(); leafletMap.current = null; }
    };
  }, []);

  // Geocodificar envios filtrados
  useEffect(() => {
    if (!filtrados.length) { setGeoData([]); return; }
    let cancelled = false;
    const run = async () => {
      setCargando(true); setProgreso(0); setTotal(filtrados.length);
      const results = [];
      for (let i = 0; i < filtrados.length; i++) {
        if (cancelled) break;
        const e = filtrados[i];
        const coords = await geocodificar(e.direccion, e.cp, e.ciudad);
        if (coords) results.push({ ...e, lat: coords.lat, lng: coords.lng });
        setProgreso(i + 1);
        if (i < filtrados.length - 1) await new Promise(r => setTimeout(r, 1100)); // respetar limite Nominatim
      }
      if (!cancelled) { setGeoData(results); setCargando(false); }
    };
    run();
    return () => { cancelled = true; };
  }, [filtrados.map(e => e.id + e.trans + e.turno).join(",")]);

  // Renderizar markers
  useEffect(() => {
    if (!leafletMap.current || !window.L) return;
    markersRef.current.forEach(m => leafletMap.current.removeLayer(m));
    markersRef.current = [];
    geoData.forEach(e => {
      const color = modColor === "logistica" ? (LC_COLOR[e.trans] || "#6b7280") : (TC_COLOR[e.turno] || "#6b7280");
      const icon = window.L.divIcon({
        html: `<div style="width:13px;height:13px;border-radius:50%;background:${color};border:2px solid rgba(255,255,255,0.4);box-shadow:0 0 5px ${color}88;"></div>`,
        className: "", iconSize: [13, 13], iconAnchor: [6, 6]
      });
      const m = window.L.marker([e.lat, e.lng], { icon }).addTo(leafletMap.current);
      m.bindPopup(`
        <div style="font-size:12px;font-weight:700;color:#e5e7eb;margin-bottom:4px;">${e.direccion}</div>
        <div style="margin-bottom:3px;">
          <span style="background:${LC_COLOR[e.trans] || "#252d40"}22;color:${LC_COLOR[e.trans] || "#6b7280"};padding:1px 7px;border-radius:4px;font-size:11px;font-weight:700;margin-right:4px;">${e.trans || "Sin asignar"}</span>
          <span style="background:${TC_COLOR[e.turno] || "#252d40"}22;color:${TC_COLOR[e.turno] || "#6b7280"};padding:1px 7px;border-radius:4px;font-size:11px;font-weight:700;">${e.turno || "-"}</span>
        </div>
        <div style="color:#6b7280;font-size:11px;">${e.partido}${e.fecha ? " · " + fmtCorta(e.fecha) : ""}</div>
      `);
      markersRef.current.push(m);
    });
  }, [geoData, modColor]);

  const pct = total > 0 ? Math.round((progreso / total) * 100) : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.7rem" }}>
      {/* Filtros */}
      <div style={{ ...S.card, padding: "0.65rem 1rem", display: "flex", gap: "0.4rem", flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ color: "#4b5563", fontSize: "0.65rem", fontWeight: 700, textTransform: "uppercase" }}>Fecha</span>
        {[{k:"todos",l:"Todos"},{k:"hoy",l:"Hoy"},{k:"ayer",l:"Ayer"},{k:"semana",l:"Semana"},{k:"rango",l:"Rango"}].map(x => (
          <button key={x.k} onClick={() => setModFecha(x.k)} style={S.btn(modFecha === x.k)}>{x.l}</button>
        ))}
        {modFecha === "rango" && <>
          <input type="date" value={rangoD} onChange={e => setRangoD(e.target.value)} style={{ ...S.input, padding: "4px 8px", width: "132px" }} />
          <input type="date" value={rangoH} onChange={e => setRangoH(e.target.value)} style={{ ...S.input, padding: "4px 8px", width: "132px" }} />
        </>}
        <span style={{ color: "#374151", fontSize: "0.6rem" }}>|</span>
        {["TODOS", ...logActivas].map(t => <button key={t} onClick={() => setFilTrans(t)} style={S.btnSm(filTrans === t, lc[t]?.color || "#6366f1")}>{t}</button>)}
        <span style={{ color: "#374151", fontSize: "0.6rem" }}>|</span>
        {["TODOS", ...TURNOS].map(t => <button key={t} onClick={() => setFilTurno(t)} style={S.btnSm(filTurno === t, "#8b5cf6")}>{t}</button>)}<button onClick={() => setFilTurno("SIN_TURNO")} style={S.btnSm(filTurno === "SIN_TURNO", "#6b7280")}>Sin turno</button>
        <span style={{ color: "#374151", fontSize: "0.6rem" }}>|</span>
        <span style={{ color: "#4b5563", fontSize: "0.65rem", fontWeight: 700, textTransform: "uppercase" }}>Color</span>
        <button onClick={() => setModColor("logistica")} style={S.btnSm(modColor === "logistica", "#6366f1")}>Logistica</button>
        <button onClick={() => setModColor("turno")} style={S.btnSm(modColor === "turno", "#8b5cf6")}>Turno</button>
      </div>

      {/* Barra de progreso geocodificacion */}
      {cargando && (
        <div style={{ ...S.card, padding: "0.65rem 1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
            <span style={{ color: "#9ca3af", fontSize: "0.78rem" }}>Geocodificando direcciones... {progreso}/{total}</span>
            <span style={{ color: "#6366f1", fontSize: "0.78rem", fontWeight: 700 }}>{pct}%</span>
          </div>
          <div style={{ background: "#0f1420", borderRadius: "4px", height: "6px", overflow: "hidden" }}>
            <div style={{ background: "linear-gradient(90deg,#6366f1,#8b5cf6)", height: "100%", width: pct + "%", borderRadius: "4px", transition: "width 0.3s" }} />
          </div>
          <div style={{ color: "#4b5563", fontSize: "0.7rem", marginTop: "4px" }}>Las direcciones se guardan en cache — la proxima vez es instantaneo</div>
        </div>
      )}

      {/* Info */}
      {!cargando && (
        <div style={{ ...S.card, padding: "0.55rem 1rem", display: "flex", gap: "1.25rem", flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ color: "#e5e7eb", fontSize: "0.8rem" }}><span style={{ color: "#6366f1", fontWeight: 700 }}>{geoData.length}</span> envios en mapa</span>
          {filtrados.length > geoData.length && <span style={{ color: "#6b7280", fontSize: "0.75rem" }}>{filtrados.length - geoData.length} sin coordenadas</span>}
          {/* Leyenda */}
          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginLeft: "auto" }}>
            {modColor === "logistica"
              ? logActivas.filter(l => geoData.some(e => e.trans === l)).map(l => (
                  <div key={l} style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                    <div style={{ width: "10px", height: "10px", borderRadius: "50%", background: LC_COLOR[l] || "#6b7280" }} />
                    <span style={{ color: "#9ca3af", fontSize: "0.72rem" }}>{l}</span>
                  </div>
                ))
              : TURNOS.filter(t => geoData.some(e => e.turno === t)).map(t => (
                  <div key={t} style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                    <div style={{ width: "10px", height: "10px", borderRadius: "50%", background: TC_COLOR[t] || "#6b7280" }} />
                    <span style={{ color: "#9ca3af", fontSize: "0.72rem" }}>{t}</span>
                  </div>
                ))
            }
          </div>
        </div>
      )}

      {/* Mapa */}
      <div ref={mapRef} style={{ height: "520px", borderRadius: "14px", overflow: "hidden", border: "1px solid #252d40", background: "#0f1420" }} />

      {envios.length === 0 && (
        <div style={{ textAlign: "center", padding: "3rem", color: "#4b5563" }}>
          <div style={{ fontSize: "2rem" }}>🗺️</div>
          <p style={{ marginTop: "0.5rem" }}>Carga un Excel primero</p>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// TAB LIQUIDACION LOG — envíos confirmados y pagos a logísticas
// ════════════════════════════════════════════════════════════════════
function TabLiquidacionLog({envios,setEnvios,zc,lc,esAdmin=false,sesion=null}){
  const hoy=fechaHoy();
  const [filTrans,setFilTrans]=useState("TODOS");
  const [filVista,setFilVista]=useState("pendiente");
  const [filDesde,setFilDesde]=useState("");
  const [filHasta,setFilHasta]=useState("");
  const [modalPago,setModalPago]=useState(null);
  const [pago,setPago]=useState({monto:"",fecha:hoy,notas:""});
  const [guardandoPago,setGuardandoPago]=useState(false);
  const [confirmEliminarPago,setConfirmEliminarPago]=useState(null);
  const [historial,setHistorial]=useState([]);
  const [vista,setVista]=useState("envios"); // "envios" | "historial"
  const logActivas=Object.entries(lc).filter(([,v])=>v.activa).map(([k])=>k);
  const tmap=buildTarifaMap(zc);
  const getImp=e=>calcImp(e,tmap,lc,zc);
  const fmt=n=>"$"+Math.round(n||0).toLocaleString("es-AR");
  const fmtF=f=>f?f.split("-").reverse().join("/"):"";

  useEffect(()=>{
    const unsub=onSnapshot(collection(db,"pagosLogistica"),snap=>{
      setHistorial(snap.docs.map(d=>({id:d.id,...d.data()}))
        .sort((a,b)=>(b.creadoEn?.seconds||0)-(a.creadoEn?.seconds||0)));
    });
    return()=>unsub();
  },[]);

  // Excluir cancelados y envíos marcados como incumplidos (no_abonado / cancelado_liq)
  // — esos no se le pagan a la logística
  const envRelevantes=envios.filter(e=>
    e.trans&&
    e.estado!=="cancelado"&&
    e.estadoLiq!=="cancelado_liq"&&
    e.estadoLiq!=="no_abonado"
  );

  const cardsPorLog=logActivas.map(l=>{
    const pend=envRelevantes.filter(e=>e.trans===l&&e.estadoPago!=="abonado");
    const abon=envRelevantes.filter(e=>e.trans===l&&e.estadoPago==="abonado");
    const saldo=pend.reduce((s,e)=>s+(e.importeOverride||getImp(e)||0),0);
    const pagado=abon.reduce((s,e)=>s+(e.importeOverride||getImp(e)||0),0);
    return{l,saldo,pagado,pendCount:pend.length,abonCount:abon.length};
  }).filter(x=>x.pendCount>0||x.abonCount>0);

  const envFil=envRelevantes.filter(e=>{
    if(filTrans!=="TODOS"&&e.trans!==filTrans)return false;
    if(filVista==="pendiente"&&e.estadoPago==="abonado")return false;
    if(filVista==="abonado"&&e.estadoPago!=="abonado")return false;
    const f=e.fecha||e.fechaVenta||"";
    if(filDesde&&f<filDesde)return false;
    if(filHasta&&f>filHasta)return false;
    return true;
  }).sort((a,b)=>{
    const la=a.trans||"",lb=b.trans||"";
    if(la!==lb)return la.localeCompare(lb);
    return(a.fecha||"").localeCompare(b.fecha||"");
  });

  const porLog={};
  envFil.forEach(e=>{if(!porLog[e.trans])porLog[e.trans]=[];porLog[e.trans].push(e);});

  const abrirModalPago=(logistica,enviosAPagar)=>{
    const total=enviosAPagar.reduce((s,e)=>s+(e.importeOverride||getImp(e)||0),0);
    setModalPago({logistica,envios:enviosAPagar,total});
    setPago({monto:Math.round(total).toString(),fecha:hoy,notas:""});
  };

  const registrarPago=async()=>{
    if(!modalPago||guardandoPago)return;
    setGuardandoPago(true);
    const monto=parseFloat((pago.monto||"").toString().replace(",","."))||0;
    const ids=modalPago.envios.map(e=>e.id);
    setEnvios(prev=>prev.map(e=>ids.includes(e.id)?{...e,estadoPago:"abonado",estadoPagoFecha:hoy}:e));
    const auditPL=mkAudit(sesion);
    await addDoc(collection(db,"pagosLogistica"),{
      logistica:modalPago.logistica,
      enviosIds:ids,
      cantEnvios:ids.length,
      montoSistema:modalPago.total,
      montoPagado:monto,
      fecha:pago.fecha,
      notas:pago.notas,
      creadoEn:serverTimestamp(),
      ...(auditPL?{abonoPor:auditPL}:{}),
    });
    setGuardandoPago(false);
    setModalPago(null);
  };

  const eliminarPago=async(h)=>{
    if(guardandoPago)return;
    setGuardandoPago(true);
    try{
      // Revertir estadoPago en Firestore (batch, máx 400 por batch)
      if(h.enviosIds?.length){
        const CHUNK=400;
        for(let i=0;i<h.enviosIds.length;i+=CHUNK){
          const batch=writeBatch(db);
          h.enviosIds.slice(i,i+CHUNK).forEach(id=>{
            batch.update(doc(db,"envios",id),{estadoPago:null,estadoPagoFecha:null});
          });
          await batch.commit();
        }
        setEnvios(prev=>prev.map(e=>h.enviosIds.includes(e.id)?{...e,estadoPago:null,estadoPagoFecha:null}:e));
      }
      await deleteDoc(doc(db,"pagosLogistica",h.id));
      setConfirmEliminarPago(null);
    }catch(err){
      console.error("Error eliminando pago:",err);
      setConfirmEliminarPago(null); // cierra el confirm aunque falle
    }finally{
      setGuardandoPago(false);
    }
  };

  const totalSaldoPendiente=envRelevantes.filter(e=>e.estadoPago!=="abonado").reduce((s,e)=>s+(e.importeOverride||getImp(e)||0),0);

  return(
    <div>
      {/* Resumen global */}
      {totalSaldoPendiente>0&&(
        <div style={{...S.card,padding:"0.65rem 1rem",marginBottom:"0.8rem",background:"#1c1400",border:"1px solid #78350f",display:"flex",alignItems:"center",gap:"1rem",flexWrap:"wrap"}}>
          <span style={{color:"#f59e0b",fontWeight:700,fontSize:"0.85rem"}}>Saldo pendiente de pago a logísticas</span>
          <span style={{color:"#fbbf24",fontWeight:800,fontSize:"1.2rem"}}>{fmt(totalSaldoPendiente)}</span>
        </div>
      )}

      {/* Cards por logística */}
      {cardsPorLog.length>0&&(
        <div style={{display:"flex",gap:"0.6rem",flexWrap:"wrap",marginBottom:"0.8rem"}}>
          {cardsPorLog.map(c=>(
            <div key={c.l} onClick={()=>setFilTrans(filTrans===c.l?"TODOS":c.l)}
              style={{...S.card,padding:"0.65rem 1rem",cursor:"pointer",border:filTrans===c.l?"1px solid "+(lc[c.l]?.color||"#6366f1"):"1px solid #1e2535",minWidth:"160px",flex:"1 1 160px"}}>
              <Bdg label={c.l} bg={lc[c.l]?.bg||"#1e293b"} t={lc[c.l]?.color||"#94a3b8"} style={{fontSize:"0.7rem",marginBottom:"6px",display:"inline-block"}}/>
              <div style={{color:"#f59e0b",fontWeight:700,fontSize:"1.1rem"}}>{fmt(c.saldo)}</div>
              <div style={{color:"#4b5563",fontSize:"0.68rem"}}>{c.pendCount} pendiente{c.pendCount!==1?"s":""} de pago</div>
              {c.abonCount>0&&<div style={{color:"#10b981",fontSize:"0.68rem",marginTop:"2px"}}>✓ {c.abonCount} abonado{c.abonCount!==1?"s":""}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Barra principal de vistas */}
      <div style={{...S.card,padding:"0.65rem 1rem",marginBottom:"0.8rem",display:"flex",gap:"4px",flexWrap:"wrap",alignItems:"center"}}>
        <button onClick={()=>setVista("envios")} style={S.btn(vista==="envios","#6366f1")}>Envíos</button>
        <button onClick={()=>setVista("historial")} style={S.btn(vista==="historial","#10b981")}>Historial pagos</button>
        {vista==="envios"&&<>
          <span style={{color:"#374151",fontSize:"0.6rem"}}>|</span>
          {["TODOS",...logActivas].map(t=>(
            <button key={t} onClick={()=>setFilTrans(t)} style={S.btnSm(filTrans===t,lc[t]?.color||"#6366f1")}>{t}</button>
          ))}
          <span style={{color:"#374151",fontSize:"0.6rem"}}>|</span>
          {[{k:"pendiente",l:"Pendientes"},{k:"abonado",l:"Abonados"},{k:"todos",l:"Todos"}].map(x=>(
            <button key={x.k} onClick={()=>setFilVista(x.k)} style={S.btnSm(filVista===x.k,x.k==="pendiente"?"#f59e0b":x.k==="abonado"?"#10b981":"#6b7280")}>{x.l}</button>
          ))}
          <span style={{color:"#374151",fontSize:"0.6rem"}}>|</span>
          <input type="date" value={filDesde} onChange={ev=>setFilDesde(ev.target.value)} style={{...S.input,padding:"3px 6px",width:"128px",fontSize:"0.72rem"}}/>
          <input type="date" value={filHasta} onChange={ev=>setFilHasta(ev.target.value)} style={{...S.input,padding:"3px 6px",width:"128px",fontSize:"0.72rem"}}/>
          {(filDesde||filHasta)&&<button onClick={()=>{setFilDesde("");setFilHasta("");}} style={{...S.btnSm(false),fontSize:"0.68rem",color:"#6b7280"}}>✕</button>}
        </>}
      </div>

      {/* Historial de pagos */}
      {vista==="historial"&&(
        <div style={{display:"flex",flexDirection:"column",gap:"0.5rem"}}>
          {historial.length===0?(
            <div style={{...S.card,padding:"2rem",textAlign:"center",color:"#4b5563"}}>Sin pagos registrados aún</div>
          ):historial.filter(h=>filTrans==="TODOS"||h.logistica===filTrans).map(h=>(
            <div key={h.id} style={{...S.card,padding:"0.75rem 1rem",display:"flex",gap:"1rem",alignItems:"center",flexWrap:"wrap",border:confirmEliminarPago===h.id?"1px solid #7f1d1d":"1px solid #1e2535"}}>
              <Bdg label={h.logistica} bg={lc[h.logistica]?.bg||"#1e293b"} t={lc[h.logistica]?.color||"#94a3b8"} style={{fontSize:"0.7rem",flexShrink:0}}/>
              <span style={{color:"#6b7280",fontSize:"0.75rem",flexShrink:0}}>{fmtF(h.fecha)}</span>
              <span style={{color:"#6b7280",fontSize:"0.72rem",flexShrink:0}}>{h.cantEnvios} envíos</span>
              {h.montoSistema!==h.montoPagado&&<span style={{color:"#4b5563",fontSize:"0.7rem"}}>Sistema: {fmt(h.montoSistema)}</span>}
              <div style={{flex:1}}/>
              {h.notas&&<span style={{color:"#4b5563",fontSize:"0.7rem",fontStyle:"italic"}}>{h.notas}</span>}
              {h.abonoPor&&<span style={{color:"#374151",fontSize:"0.65rem"}}>por {h.abonoPor.nombre}</span>}
              <span style={{color:"#10b981",fontWeight:700,fontSize:"1rem",flexShrink:0}}>{fmt(h.montoPagado)}</span>
              {confirmEliminarPago===h.id?(
                <div style={{display:"flex",gap:"6px",alignItems:"center",flexShrink:0}}>
                  <span style={{color:"#f87171",fontSize:"0.72rem"}}>¿Eliminar y revertir envíos a pendiente?</span>
                  <button onClick={()=>eliminarPago(h)} style={{...S.btnSm(false),color:"#f87171",borderColor:"#7f1d1d",fontSize:"0.72rem"}}>Sí</button>
                  <button onClick={()=>setConfirmEliminarPago(null)} style={{...S.btnSm(false),fontSize:"0.72rem"}}>No</button>
                </div>
              ):(
                <button onClick={()=>setConfirmEliminarPago(h.id)} style={{...S.btnSm(false),color:"#f87171",borderColor:"#7f1d1d",padding:"2px 8px",fontSize:"0.7rem",flexShrink:0}}>Eliminar</button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Envíos agrupados por logística */}
      {vista==="envios"&&(
        Object.keys(porLog).length===0?(
          <div style={{...S.card,padding:"2rem",textAlign:"center",color:"#4b5563"}}>
            {envRelevantes.length===0?"Sin envíos asignados a logísticas aún.":filVista==="pendiente"?"No hay envíos pendientes de pago en este filtro":"Sin envíos en este filtro"}
          </div>
        ):(
          <div style={{display:"flex",flexDirection:"column",gap:"0.75rem"}}>
              {Object.entries(porLog).map(([log,envLog])=>{
              const totalLog=envLog.reduce((s,e)=>s+(e.importeOverride||getImp(e)||0),0);
              const pendLog=envLog.filter(e=>e.estadoPago!=="abonado");
              const totalPend=pendLog.reduce((s,e)=>s+(e.importeOverride||getImp(e)||0),0);
              return(
                <div key={log} style={{...S.card,padding:"0",overflow:"hidden",border:"1px solid #1e2535"}}>
                  <div style={{padding:"0.65rem 1rem",background:"#12172a",borderBottom:"1px solid #252d40",display:"flex",alignItems:"center",gap:"0.75rem",flexWrap:"wrap"}}>
                    <Bdg label={log} bg={lc[log]?.bg||"#1e293b"} t={lc[log]?.color||"#94a3b8"} style={{fontSize:"0.75rem"}}/>
                    <span style={{color:"#9ca3af",fontSize:"0.78rem"}}>{envLog.length} envío{envLog.length!==1?"s":""}</span>
                    <div style={{flex:1}}/>
                    {pendLog.length>0&&<span style={{color:"#f59e0b",fontWeight:700}}>{fmt(totalPend)} pendiente</span>}
                    <span style={{color:"#10b981",fontWeight:700,fontSize:"0.95rem"}}>{fmt(totalLog)}</span>
                    {pendLog.length>0&&puedeVer(sesion,"accion_abonar")&&(
                      <button onClick={()=>abrirModalPago(log,pendLog)} style={{...S.btn(false,"#10b981"),padding:"0.3rem 0.8rem",fontSize:"0.75rem"}}>💳 Pagar {pendLog.length===envLog.length?"todos":pendLog.length}</button>
                    )}
                  </div>
                  <div>
                    {envLog.map(e=>{
                      const imp=e.importeOverride||getImp(e)||0;
                      const abonado=e.estadoPago==="abonado";
                      return(
                        <div key={e.id} style={{display:"flex",alignItems:"center",gap:"0.6rem",padding:"7px 1rem",borderBottom:"1px solid #1a1f2e"}}>
                          <span style={{color:"#10b981",fontSize:"0.75rem",flexShrink:0,width:"16px"}}>{abonado?"✓":""}</span>
                          <span style={{color:"#6b7280",fontSize:"0.72rem",flexShrink:0,minWidth:"50px"}}>{fmtF(e.fecha||e.fechaVenta)}</span>
                          <span style={{color:"#e5e7eb",fontSize:"0.8rem",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.direccion}{e.partido?` · ${e.partido}`:""}</span>
                          {e.nroOrdenTN&&<span style={{color:"#4b5563",fontSize:"0.7rem",flexShrink:0}}>#{e.nroOrdenTN}</span>}
                          {e.origen==="ML"&&<span style={{color:"#84cc16",fontSize:"0.65rem",flexShrink:0,padding:"1px 5px",border:"1px solid #84cc16",borderRadius:"3px"}}>FLEX</span>}
                          {e.importeOverride&&<span style={{color:"#fbbf24",fontSize:"0.68rem",flexShrink:0}}>*</span>}
                          <span style={{color:abonado?"#4b5563":"#10b981",fontWeight:600,fontSize:"0.82rem",flexShrink:0,textDecoration:abonado?"line-through":"none"}}>{fmt(imp)}</span>
                          {!abonado&&puedeVer(sesion,"accion_abonar")&&<button onClick={()=>abrirModalPago(log,[e])} style={{...S.btnSm(false),padding:"1px 7px",fontSize:"0.68rem",color:"#10b981",borderColor:"#065f46",flexShrink:0}}>Pagar</button>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      {/* Modal pago */}
      {modalPago&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:"1rem"}}>
          <div style={{background:"#12172a",border:"1px solid #1e2535",borderRadius:"14px",padding:"1.5rem",width:"100%",maxWidth:"440px"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"1rem"}}>
              <span style={{color:"#e5e7eb",fontWeight:700,fontSize:"1rem"}}>Registrar pago — {modalPago.logistica}</span>
              <button onClick={()=>setModalPago(null)} style={{background:"none",border:"none",color:"#6b7280",cursor:"pointer",fontSize:"1.2rem"}}>✕</button>
            </div>
            <div style={{color:"#6b7280",fontSize:"0.72rem",marginBottom:"1rem"}}>{modalPago.envios.length} envío{modalPago.envios.length!==1?"s":""} · Sistema: {fmt(modalPago.total)}</div>
            <div style={{marginBottom:"0.75rem"}}>
              <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>Monto a pagar</div>
              <input type="number" autoFocus value={pago.monto} onChange={ev=>setPago(p=>({...p,monto:ev.target.value}))} style={{...S.input,width:"100%",padding:"6px 10px",fontSize:"0.9rem"}}/>
              {pago.monto&&Math.abs(parseFloat(pago.monto)-modalPago.total)>1&&(
                <div style={{marginTop:"4px",fontSize:"0.72rem",color:parseFloat(pago.monto)>modalPago.total?"#f87171":"#34d399",fontWeight:600}}>
                  Diferencia: {parseFloat(pago.monto)>modalPago.total?"+":""}{fmt(parseFloat(pago.monto)-modalPago.total)}
                </div>
              )}
            </div>
            <div style={{marginBottom:"0.75rem"}}>
              <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>Fecha</div>
              <input type="date" value={pago.fecha} onChange={ev=>setPago(p=>({...p,fecha:ev.target.value}))} style={{...S.input,width:"100%",padding:"6px 10px"}}/>
            </div>
            <div style={{marginBottom:"1rem"}}>
              <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>Notas</div>
              <textarea value={pago.notas} onChange={ev=>setPago(p=>({...p,notas:ev.target.value}))} placeholder="Ajustes, descuentos..." style={{...S.input,display:"block",width:"100%",height:"52px",resize:"vertical",fontSize:"0.8rem"}}/>
            </div>
            <div style={{display:"flex",gap:"8px",justifyContent:"flex-end"}}>
              <button onClick={()=>setModalPago(null)} style={S.btnSm(false)}>Cancelar</button>
              <button onClick={registrarPago} disabled={!pago.monto||!pago.fecha||guardandoPago} style={{...S.btn(false,"#10b981"),opacity:(!pago.monto||!pago.fecha||guardandoPago)?0.4:1}}>{guardandoPago?"Guardando...":"💳 Confirmar pago"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// TAB LIQUIDACION — cobranzas y cambios/retiros pendientes
// ════════════════════════════════════════════════════════════════════
function TabLiquidacion({ envios, setEnvios, lc, sesion=null }) {
  const hoy=fechaHoy();
  const [seccion, setSeccion] = useState("cobranzas"); // cobranzas | retiros
  const [filTrans, setFilTrans] = useState("TODOS");
  const [filEstado, setFilEstado] = useState("pendiente"); // pendiente | recibido | todos
  const [filFecha, setFilFecha] = useState("todos"); // todos | hoy | ayer | rango
  const [rangoD, setRangoD] = useState(hoy);
  const [rangoH, setRangoH] = useState(hoy);
  const [notaModal, setNotaModal] = useState(null); // {id, tipo, nota}
  const [confirmModal, setConfirmModal] = useState(null); // {id, tipo:"cobranza"|"retiro", envio}
  const [busqueda, setBusqueda] = useState("");
  const logActivas = Object.entries(lc).filter(([,v]) => v.activa).map(([k]) => k);

  // Envios con cobranza
  const conCobranza = envios.filter(e =>
    e.cobranza !== null && e.cobranza !== undefined && e.cobranza > 0 && getEstado(e) !== "cancelado"
  );
  // Envios con cambio, retiro, o devolución por cancelación tras despacho
  const conRetiro = envios.filter(e =>
    ((e.cambio !== null || e.retiro !== null) && getEstado(e) !== "cancelado") ||
    (e.devolucionPendiente && !e.devolucionCancelacionRecibida)
  );

  const lista = [...(seccion === "cobranzas" ? conCobranza : conRetiro)].filter(e => {
    if (filTrans !== "TODOS" && e.trans !== filTrans) return false;
    const recibido = seccion === "cobranzas" ? !!e.cobranzaRecibida : (e.devolucionPendiente ? !!e.devolucionCancelacionRecibida : !!e.retiroRecibido);
    if (filEstado === "pendiente" && recibido) return false;
    if (filEstado === "recibido" && !recibido) return false;
    const fEnv = e.fecha || e.fechaVenta || "";
    if (filFecha === "hoy" && fEnv !== hoy) return false;
    if (filFecha === "ayer" && fEnv !== fechaAyer()) return false;
    if (filFecha === "rango" && (fEnv < rangoD || fEnv > rangoH)) return false;
    if (busqueda) {
      const srch = norm(busqueda);
      return norm(e.direccion).includes(srch) ||
             (e.nroOrdenTN||"").includes(srch) ||
             (e.id||"").includes(srch) ||
             norm(e.clienteNombre).includes(srch);
    }
    return true;
  }).sort((a, b) => {
    // Ordenar por fecha de entrega ascendente (mas proxima primero)
    const fa = a.fecha || a.fechaVenta || "";
    const fb = b.fecha || b.fechaVenta || "";
    return fa.localeCompare(fb);
  });

  // Totales cobranzas
  const totalEsperado = conCobranza.filter(e => filTrans === "TODOS" || e.trans === filTrans).reduce((s,e) => s + (e.cobranza||0), 0);
  const totalRecibido = conCobranza.filter(e => (filTrans === "TODOS" || e.trans === filTrans) && e.cobranzaRecibida).reduce((s,e) => s + (e.cobranza||0), 0);
  const totalPendiente = totalEsperado - totalRecibido;

  // Por logistica - cobranzas
  const porLogCob = logActivas.map(l => {
    const envL = conCobranza.filter(e => e.trans === l);
    const total = envL.reduce((s,e) => s + (e.cobranza||0), 0);
    const recibido = envL.filter(e => e.cobranzaRecibida).reduce((s,e) => s + (e.cobranza||0), 0);
    return {
      l,
      total,
      recibido,
      pendienteImporte: total - recibido,
      pendienteN: envL.filter(e => !e.cobranzaRecibida).length,
    };
  }).filter(x => x.total > 0);

  // Por logistica - retiros
  const porLogRet = logActivas.map(l => {
    const envL = conRetiro.filter(e => e.trans === l);
    return {
      l,
      total: envL.length,
      pendiente: envL.filter(e => !e.retiroRecibido).length,
    };
  }).filter(x => x.total > 0);

  const marcarCobranza = (id, recibido) => {
    const a=mkAudit(sesion);
    setEnvios(p => p.map(e => e.id === id ? { ...e, cobranzaRecibida: recibido, cobranzaFecha: recibido ? fechaHoy() : null, ...(recibido&&a?{cobranzaRecibidaPor:a}:{}) } : e));
  };

  const marcarRetiro = (id, recibido) => {
    const a=mkAudit(sesion);
    const env=envios.find(e=>e.id===id);
    if(env?.devolucionPendiente){
      // Devolución por cancelación — usa campo propio
      setEnvios(p => p.map(e => e.id === id ? { ...e, devolucionCancelacionRecibida: recibido, devolucionCancelacionFecha: recibido ? fechaHoy() : null } : e));
    } else {
      setEnvios(p => p.map(e => e.id === id ? { ...e, retiroRecibido: recibido, retiroFecha: recibido ? fechaHoy() : null, ...(recibido&&a?{retiroRecibidoPor:a}:{}) } : e));
    }
  };

  const guardarNota = () => {
    if (!notaModal) return;
    const { id, tipo, nota } = notaModal;
    setEnvios(p => p.map(e => e.id === id ? { ...e, [tipo]: nota } : e));
    setNotaModal(null);
  };

  return (
    <div>
      {/* Selector seccion */}
      <div style={{ ...S.card, padding: "0.65rem 1rem", marginBottom: "0.8rem", display: "flex", gap: "4px", flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={() => setSeccion("cobranzas")} style={S.btn(seccion === "cobranzas", "#f59e0b")}>💰 Cobranzas</button>
        <button onClick={() => setSeccion("retiros")} style={S.btn(seccion === "retiros", "#ec4899")}>🔄 Cambios y Retiros</button>
        <span style={{ color: "#374151", fontSize: "0.6rem" }}>|</span>
        <button onClick={() => setFilEstado("pendiente")} style={S.btnSm(filEstado === "pendiente", "#f59e0b")}>Pendientes</button>
        <button onClick={() => setFilEstado("recibido")} style={S.btnSm(filEstado === "recibido", "#10b981")}>Recibidos</button>
        <button onClick={() => setFilEstado("todos")} style={S.btnSm(filEstado === "todos")}>Todos</button>
        <span style={{ color: "#374151", fontSize: "0.6rem" }}>|</span>
        {["TODOS", ...logActivas].map(t => (
          <button key={t} onClick={() => setFilTrans(t)} style={S.btnSm(filTrans === t, lc[t]?.color || "#6366f1")}>{t}</button>
        ))}
        <span style={{ color: "#374151", fontSize: "0.6rem" }}>|</span>
        <span style={{color:"#4b5563",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase"}}>Fecha</span>
        {[{k:"todos",l:"Todos"},{k:"hoy",l:"Hoy"},{k:"ayer",l:"Ayer"},{k:"rango",l:"Rango"}].map(x =><button key={x.k} onClick={()=>setFilFecha(x.k)} style={S.btnSm(filFecha===x.k)}>{x.l}</button>)}
        {filFecha==="rango"&&<><input type="date" value={rangoD} onChange={e=>setRangoD(e.target.value)} style={{...S.input,padding:"3px 7px",width:"128px",fontSize:"0.75rem"}}/><input type="date" value={rangoH} onChange={e=>setRangoH(e.target.value)} style={{...S.input,padding:"3px 7px",width:"128px",fontSize:"0.75rem"}}/></>}
        <span style={{ color: "#374151", fontSize: "0.6rem" }}>|</span>
        <input value={busqueda} onChange={e=>setBusqueda(e.target.value)} placeholder="Buscar nro orden o dirección..." style={{...S.input,width:"200px",padding:"3px 8px",fontSize:"0.75rem"}}/>
        {busqueda&&<button onClick={()=>setBusqueda("")} style={{...S.btnSm(false),color:"#6b7280"}}>x</button>}
        <button onClick={()=>{
          const filas=lista.map((e,i)=>{
            const recibido=seccion==="cobranzas"?!!e.cobranzaRecibida:!!e.retiroRecibido;
            const fechaR=seccion==="cobranzas"?e.cobranzaFecha:e.retiroFecha;
            return{"#":i+1,Logistica:lc[e.trans]?.nombreFormal||e.trans||"",Direccion:e.direccion,Partido:e.partido,
              NroOrden:e.nroOrdenTN?"#"+e.nroOrdenTN:e.id.slice(-8),
              Fecha:e.fecha||"",Turno:e.turno||"",
              Monto:seccion==="cobranzas"?(e.cobranza||""):"",
              Detalle:seccion==="retiros"?((e.cambio||"")+(e.retiro||"")):"",
              Estado:recibido?"Recibido":"Pendiente",FechaRecibido:fechaR||"",
            };
          });
          if(seccion==="cobranzas"){
            const totalMonto=lista.reduce((s,e)=>s+(e.cobranza||0),0);
            const totalPend=lista.filter(e=>!e.cobranzaRecibida).reduce((s,e)=>s+(e.cobranza||0),0);
            filas.push({"#":"","Logistica":"","Direccion":"","Partido":"","NroOrden":"","Fecha":"","Turno":"","Monto":"","Detalle":"","Estado":"","FechaRecibido":""});
            filas.push({"#":"TOTAL","Logistica":lista.length+" registros","Direccion":"","Partido":"","NroOrden":"","Fecha":"","Turno":"","Monto":totalMonto,"Detalle":"","Estado":"Pendiente: $"+totalPend.toLocaleString("es-AR"),"FechaRecibido":""});
          }
          exportarXLSX(filas,"liquidacion_"+seccion+"_"+fechaHoy());
        }} style={{...S.btnSm(false),color:"#10b981",border:"1px solid #10b981",padding:"3px 10px",fontSize:"0.72rem"}}>⬇ Excel</button>
        <button onClick={()=>{
          const ahora=new Date();
          const ts=ahora.toLocaleDateString("es-AR",{weekday:"long",day:"numeric",month:"long",year:"numeric"})+" "+ahora.toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit",hour12:false});
          const rows=lista.map((e,i)=>{
            const campo=seccion==="cobranzas"?"cobranzaRecibida":"retiroRecibido";
            const recibido=!!e[campo];
            const monto=seccion==="cobranzas"?("$"+Number(e.cobranza||0).toLocaleString("es-AR")):"-";
            const detalle=seccion==="retiros"?(e.cambio||e.retiro||"-"):"-";
            return`<tr style="background:${i%2===0?"#fff":"#f9f9f9"}"><td style="padding:3px 6px;border-bottom:0.5px solid #ddd;">${i+1}</td><td style="padding:3px 6px;border-bottom:0.5px solid #ddd;font-weight:500;">${e.direccion}</td><td style="padding:3px 6px;border-bottom:0.5px solid #ddd;font-family:monospace;font-size:9px;">${e.nroOrdenTN?"#"+e.nroOrdenTN:e.id.slice(-8)}</td><td style="padding:3px 6px;border-bottom:0.5px solid #ddd;">${e.trans||"-"}</td><td style="padding:3px 6px;border-bottom:0.5px solid #ddd;">${e.fecha?fmtCorta(e.fecha):"-"}</td><td style="padding:3px 6px;border-bottom:0.5px solid #ddd;font-weight:600;color:${seccion==="cobranzas"?"#b45309":"#555"};">${monto}</td><td style="padding:3px 6px;border-bottom:0.5px solid #ddd;color:${recibido?"#15803d":"#b45309"};font-weight:600;">${recibido?"Recibido":"Pendiente"}</td></tr>`;
          }).join("");
          const totalPDF=seccion==="cobranzas"?lista.reduce((s,e)=>s+(e.cobranza||0),0):0;
          const totalPendPDF=seccion==="cobranzas"?lista.filter(e=>!e.cobranzaRecibida).reduce((s,e)=>s+(e.cobranza||0),0):0;
          const footerExtra=seccion==="cobranzas"?`<span style="margin-left:20px;font-size:11px;font-weight:800;">Total: $${totalPDF.toLocaleString("es-AR")}</span><span style="margin-left:14px;font-size:11px;font-weight:700;color:#b45309;">Pendiente: $${totalPendPDF.toLocaleString("es-AR")}</span>`:"";
          const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Liquidacion</title><style>@page{size:A4;margin:10mm;}body{font-family:Arial,sans-serif;font-size:10px;color:#111;}table{width:100%;border-collapse:collapse;}th{background:#e8e8e8;padding:3px 6px;text-align:left;font-size:8px;text-transform:uppercase;font-weight:700;border-bottom:1.5px solid #333;}@media print{button{display:none!important;}}</style></head><body><div style="display:flex;justify-content:space-between;margin-bottom:4px;"><strong style="font-size:12px;">Liquidacion — ${seccion==="cobranzas"?"Cobranzas":"Cambios y Retiros"}</strong><span style="font-size:8px;color:#888;">Impreso: ${ts}</span></div><table><thead><tr><th style="width:20px;">#</th><th>Direccion</th><th style="width:80px;">Nro orden</th><th style="width:60px;">Logistica</th><th style="width:48px;">Fecha</th><th style="width:70px;">${seccion==="cobranzas"?"Monto":"-"}</th><th style="width:65px;">Estado</th></tr></thead><tbody>${rows}</tbody></table><div style="border-top:1.5px solid #333;margin-top:4px;padding-top:3px;font-size:8px;color:#555;">${lista.length} registros${footerExtra}</div><script>window.onload=function(){window.print();}<\/script></body></html>`;
          const w=window.open("","_blank");if(!w){alert("Permite ventanas emergentes.");return;}w.document.write(html);w.document.close();
        }} style={{...S.btn(true),background:"#0f1420",border:"1px solid #252d40",marginLeft:"auto",padding:"0.3rem 0.8rem",fontSize:"0.72rem"}}>🖨️ Imprimir</button>
      </div>

      {/* Resumen cards */}
      {seccion === "cobranzas" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: "0.55rem", marginBottom: "0.8rem" }}>
          <div onClick={() => setFilEstado(filEstado === "pendiente" ? "todos" : "pendiente")}
               style={{ ...S.card, padding: "0.75rem 1rem", borderLeft: "3px solid #f59e0b", cursor: "pointer",
                        opacity: filEstado === "todos" || filEstado === "pendiente" ? 1 : 0.65,
                        outline: filEstado === "pendiente" ? "2px solid #f59e0b" : "none", outlineOffset: "-2px" }}>
            <div style={{ color: "#f59e0b", fontWeight: 800, fontSize: "1.1rem" }}>{fmt(totalPendiente)}</div>
            <div style={{ color: "#6b7280", fontSize: "0.62rem", marginTop: "2px" }}>Pendiente</div>
          </div>
          {porLogCob.map(({ l, pendienteImporte, pendienteN }) => (
            <div key={l} onClick={() => setFilTrans(filTrans === l ? "TODOS" : l)}
                 style={{ ...S.card, padding: "0.75rem 1rem", borderLeft: "3px solid " + lc[l].color, cursor: "pointer",
                          opacity: filTrans === "TODOS" || filTrans === l ? 1 : 0.65,
                          outline: filTrans === l ? "2px solid " + lc[l].color : "none", outlineOffset: "-2px" }}>
              <div style={{ color: lc[l].color, fontWeight: 800, fontSize: "0.9rem" }}>{l}</div>
              <div style={{ color: "#f59e0b", fontWeight: 700, fontSize: "0.85rem" }}>{fmt(pendienteImporte)}</div>
              {pendienteN > 0 && <div style={{ color: "#6b7280", fontSize: "0.68rem", marginTop: "2px" }}>{pendienteN} pendiente{pendienteN !== 1 ? "s" : ""}</div>}
            </div>
          ))}
        </div>
      )}

      {seccion === "retiros" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: "0.55rem", marginBottom: "0.8rem" }}>
          <div onClick={() => setFilEstado("todos")}
               style={{ ...S.card, padding: "0.75rem 1rem", cursor: "pointer",
                        opacity: filEstado === "todos" ? 1 : 0.65,
                        outline: filEstado === "todos" ? "2px solid #ec4899" : "none", outlineOffset: "-2px" }}>
            <div style={{ color: "#ec4899", fontWeight: 800, fontSize: "1.8rem" }}>{conRetiro.length}</div>
            <div style={{ color: "#6b7280", fontSize: "0.62rem", marginTop: "2px" }}>Total</div>
          </div>
          <div onClick={() => setFilEstado(filEstado === "pendiente" ? "todos" : "pendiente")}
               style={{ ...S.card, padding: "0.75rem 1rem", borderLeft: "3px solid #f59e0b", cursor: "pointer",
                        opacity: filEstado === "todos" || filEstado === "pendiente" ? 1 : 0.65,
                        outline: filEstado === "pendiente" ? "2px solid #f59e0b" : "none", outlineOffset: "-2px" }}>
            <div style={{ color: "#f59e0b", fontWeight: 800, fontSize: "1.8rem" }}>{conRetiro.filter(e => !e.retiroRecibido).length}</div>
            <div style={{ color: "#6b7280", fontSize: "0.62rem", marginTop: "2px" }}>Pendientes</div>
          </div>
          <div onClick={() => setFilEstado(filEstado === "recibido" ? "todos" : "recibido")}
               style={{ ...S.card, padding: "0.75rem 1rem", borderLeft: "3px solid #10b981", cursor: "pointer",
                        opacity: filEstado === "todos" || filEstado === "recibido" ? 1 : 0.65,
                        outline: filEstado === "recibido" ? "2px solid #10b981" : "none", outlineOffset: "-2px" }}>
            <div style={{ color: "#10b981", fontWeight: 800, fontSize: "1.8rem" }}>{conRetiro.filter(e => e.retiroRecibido).length}</div>
            <div style={{ color: "#6b7280", fontSize: "0.62rem", marginTop: "2px" }}>Recibidos</div>
          </div>
          {porLogRet.map(({ l, total, pendiente }) => (
            <div key={l} onClick={() => setFilTrans(filTrans === l ? "TODOS" : l)}
                 style={{ ...S.card, padding: "0.75rem 1rem", borderLeft: "3px solid " + lc[l].color, cursor: "pointer",
                          opacity: filTrans === "TODOS" || filTrans === l ? 1 : 0.65,
                          outline: filTrans === l ? "2px solid " + lc[l].color : "none", outlineOffset: "-2px" }}>
              <div style={{ color: lc[l].color, fontWeight: 800, fontSize: "0.9rem" }}>{l}</div>
              <div style={{ color: "#e5e7eb", fontWeight: 700 }}>{total} items</div>
              {pendiente > 0 && <div style={{ color: "#f59e0b", fontSize: "0.68rem", marginTop: "2px" }}>{pendiente} pendiente{pendiente !== 1 ? "s" : ""}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Lista */}
      {lista.length === 0 ? (
        <div style={{ textAlign: "center", padding: "3rem", color: "#4b5563" }}>
          <div style={{ fontSize: "2rem" }}>{seccion === "cobranzas" ? "💰" : "🔄"}</div>
          <p style={{ marginTop: "0.5rem" }}>No hay {seccion === "cobranzas" ? "cobranzas" : "cambios/retiros"} {filEstado === "pendiente" ? "pendientes" : filEstado === "recibido" ? "recibidos" : ""}</p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "4px" }}>
          {lista.map((e, i) => {
            const recibido = seccion === "cobranzas" ? !!e.cobranzaRecibida : (e.devolucionPendiente ? !!e.devolucionCancelacionRecibida : !!e.retiroRecibido);
            const fecha = seccion === "cobranzas" ? e.cobranzaFecha : (e.devolucionPendiente ? e.devolucionCancelacionFecha : e.retiroFecha);
            const nota = seccion === "cobranzas" ? e.cobranzaNota : e.retiroNota;
            const lci = lc[e.trans];
            return (
              <div key={e.id} style={{ ...S.card, padding: "0.6rem 1rem", display: "flex", alignItems: "flex-start", gap: "0.6rem", flexWrap: "wrap", opacity: recibido ? 0.6 : 1 }}>
                {/* Checkbox recibido */}
                <div style={{ paddingTop: "2px" }}>
                  <Chk checked={recibido} onChange={() => {
                    if(recibido){
                      seccion==="cobranzas"?marcarCobranza(e.id,false):marcarRetiro(e.id,false);
                    } else {
                      setConfirmModal({id:e.id, tipo:seccion==="cobranzas"?"cobranza":"retiro", envio:e});
                    }
                  }} size={18} />
                </div>
                <div style={{ flex: 1, minWidth: "160px" }}>
                  <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", marginBottom: "3px", alignItems: "center" }}>
                    {e.trans && <Bdg label={e.trans} bg={lci?.bg || "#1a1f2e"} t={lci?.color || "#6b7280"} />}
                    {e.turno && <Bdg label={e.turno} bg={TURNO_C[e.turno]?.bg || "#130d2a"} t={TURNO_C[e.turno]?.c || "#a78bfa"} />}
                    {e.fechaVenta && <Bdg label={"V:"+fmtCorta(e.fechaVenta)} bg="#0d1a12" t="#4ade80" />}
                    {e.fecha && <Bdg label={"E:"+fmtCorta(e.fecha)} bg="#0c1628" t="#93c5fd" />}
                    {recibido && <Bdg label={"Recibido" + (fecha ? " " + fmtCorta(fecha) : "") + (seccion==="cobranzas"&&e.cobranzaRecibidaPor ? " · " + e.cobranzaRecibidaPor.nombre : seccion==="retiros"&&e.retiroRecibidoPor ? " · " + e.retiroRecibidoPor.nombre : "")} bg="#041f14" t="#34d399" />}
                  </div>
                  <div style={{ color: "#e5e7eb", fontSize: "0.82rem", lineHeight: 1.35 }}>{e.direccion}</div>
                  <div style={{ display:"flex", gap:"6px", alignItems:"center", marginTop:"3px", flexWrap:"wrap" }}>
                    {e.nroOrdenTN
                      ? <span style={{fontFamily:"monospace",fontWeight:700,fontSize:"0.75rem",color:"#7dd3fc"}}>#{e.nroOrdenTN}</span>
                      : <span style={{fontFamily:"monospace",fontSize:"0.7rem",color:"#64748b"}}>{e.id.slice(-10)}</span>
                    }
                    {e.nroSeguimiento&&<span style={{fontFamily:"monospace",fontSize:"0.7rem",color:"#94a3b8"}}>{e.nroSeguimiento}</span>}
                    {e.partido&&<span style={{fontSize:"0.72rem",color:"#9ca3af"}}>· {e.partido}</span>}
                  </div>
                  {seccion === "cobranzas" && e.cambio !== null && (
                    <div style={{ color: "#ec4899", fontSize: "0.72rem", marginTop: "2px" }}>Cambio: {e.cambio}</div>
                  )}
                  {seccion === "retiros" && e.devolucionPendiente && (
                    <div style={{ color: "#f87171", fontSize: "0.72rem", marginTop: "2px", fontWeight: 600 }}>⚠ Devolución por cancelación (despachado)</div>
                  )}
                  {seccion === "retiros" && !e.devolucionPendiente && (
                    <div style={{ marginTop: "3px" }}>
                      {e.cambio !== null && <div style={{ color: "#ec4899", fontSize: "0.72rem" }}>Cambio: {e.cambio}</div>}
                      {e.retiro !== null && <div style={{ color: "#f97316", fontSize: "0.72rem" }}>Retiro: {e.retiro}</div>}
                    </div>
                  )}
                  {nota && <div style={{ color: "#6b7280", fontSize: "0.7rem", fontStyle: "italic", marginTop: "2px" }}>"{nota}"</div>}
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px", flexShrink: 0 }}>
                  {seccion === "cobranzas" && (
                    <div style={{ color: "#f59e0b", fontWeight: 800, fontSize: "1rem" }}>{fmt(e.cobranza)}</div>
                  )}
                  <button
                    onClick={() => setNotaModal({ id: e.id, tipo: seccion === "cobranzas" ? "cobranzaNota" : "retiroNota", nota: nota || "" })}
                    style={{ ...S.btnSm(false), padding: "2px 8px", fontSize: "0.68rem", color: "#6b7280" }}
                  >
                    {nota ? "ver nota" : "+ nota"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modal nota */}
      {notaModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}>
          <div style={{ ...S.card, padding: "1.25rem", width: "100%", maxWidth: "380px" }}>
            <h3 style={{ margin: "0 0 0.75rem", fontWeight: 800, fontSize: "0.95rem" }}>Nota</h3>
            <textarea
              autoFocus
              value={notaModal.nota}
              onChange={e => setNotaModal(p => ({ ...p, nota: e.target.value }))}
              placeholder="Escribi una nota opcional..."
              style={{ ...S.input, display: "block", width: "100%", height: "80px", resize: "vertical", marginBottom: "0.75rem" }}
            />
            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
              <button onClick={() => setNotaModal(null)} style={S.btn(false)}>Cancelar</button>
              <button onClick={guardarNota} style={{ ...S.btn(true), background: "linear-gradient(135deg,#6366f1,#8b5cf6)" }}>Guardar</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal confirmación cobranza/retiro ── */}
      {confirmModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}>
          <div style={{background:"#12172a",border:"1px solid #252d40",borderRadius:"12px",padding:"1.4rem 1.5rem",width:"100%",maxWidth:"320px",display:"flex",flexDirection:"column",gap:"1rem"}}>
            <div style={{fontSize:"0.7rem",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",color:confirmModal.tipo==="cobranza"?"#f59e0b":"#f97316"}}>
              {confirmModal.tipo==="cobranza"?"Confirmar cobro recibido":"Confirmar retiro recibido"}
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:"6px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                <span style={{fontSize:"0.62rem",color:"#4b5563",fontWeight:700,textTransform:"uppercase"}}>Dirección</span>
                <span style={{fontSize:"0.82rem",color:"#e2e8f0",fontWeight:600,maxWidth:"200px",textAlign:"right"}}>{confirmModal.envio.direccion}</span>
              </div>
              {confirmModal.envio.trans&&(
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                  <span style={{fontSize:"0.62rem",color:"#4b5563",fontWeight:700,textTransform:"uppercase"}}>Logística</span>
                  <span style={{fontSize:"0.82rem",fontWeight:700,color:lc[confirmModal.envio.trans]?.color||"#9ca3af"}}>{confirmModal.envio.trans}</span>
                </div>
              )}
              <div style={{borderTop:"1px solid #1a2640",marginTop:"4px",paddingTop:"8px",display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                <span style={{fontSize:"0.62rem",color:"#4b5563",fontWeight:700,textTransform:"uppercase"}}>{confirmModal.tipo==="cobranza"?"Monto":"Retira"}</span>
                {confirmModal.tipo==="cobranza"
                  ?<span style={{fontSize:"1.3rem",color:"#f59e0b",fontWeight:800}}>${Math.round(confirmModal.envio.cobranza||0).toLocaleString("es-AR")}</span>
                  :<span style={{fontSize:"0.85rem",color:"#f97316",fontWeight:700,maxWidth:"200px",textAlign:"right"}}>{confirmModal.envio.devolucionPendiente?"Devolución por cancelación":(confirmModal.envio.retiro||confirmModal.envio.cambio||"—")}</span>
                }
              </div>
            </div>
            <div style={{display:"flex",gap:"8px"}}>
              <button onClick={()=>setConfirmModal(null)} style={{...S.btn(false),flex:1}}>Cancelar</button>
              <button onClick={()=>{
                confirmModal.tipo==="cobranza"?marcarCobranza(confirmModal.id,true):marcarRetiro(confirmModal.id,true);
                setConfirmModal(null);
              }} style={{flex:2,padding:"0.5rem",borderRadius:"8px",border:"none",fontWeight:700,fontSize:"0.82rem",cursor:"pointer",
                background:confirmModal.tipo==="cobranza"?"#0d2b0d":"#1c0d00",
                color:confirmModal.tipo==="cobranza"?"#4ade80":"#f97316",
                border:confirmModal.tipo==="cobranza"?"1px solid #1a4a1a":"1px solid #3d1f00"
              }}>
                {confirmModal.tipo==="cobranza"?"Confirmar cobro":"Confirmar retiro"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// TAB LOCALIDADES — ver, editar y agregar CP → Partido
// ════════════════════════════════════════════════════════════════════
const CP_P_INIT = {"1601":"La Plata","1607":"San Isidro","1608":"Tigre","1609":"San Isidro","1610":"Tigre","1611":"Tigre","1612":"Malvinas Argentinas","1613":"Malvinas Argentinas","1614":"Malvinas Argentinas","1615":"Malvinas Argentinas","1616":"Malvinas Argentinas","1617":"Tigre","1618":"Tigre","1619":"Escobar","1620":"Escobar","1621":"Tigre","1622":"Escobar","1623":"Escobar","1624":"Tigre","1625":"Escobar","1626":"Escobar","1627":"Escobar","1628":"Escobar","1629":"Pilar","1630":"Pilar","1631":"Pilar","1632":"Pilar","1633":"Pilar","1634":"Pilar","1635":"Pilar","1636":"Vicente Lopez","1637":"Vicente Lopez","1638":"Vicente Lopez","1640":"San Isidro","1641":"San Isidro","1642":"San Isidro","1643":"San Isidro","1644":"San Fernando","1645":"San Fernando","1646":"San Fernando","1647":"Zarate","1648":"Tigre","1649":"San Fernando","1650":"San Martin","1651":"San Martin","1653":"San Martin","1655":"San Martin","1657":"San Martin","1659":"San Miguel","1660":"Jose C Paz","1661":"San Miguel","1662":"San Miguel","1663":"San Miguel","1664":"Pilar","1665":"Jose C Paz","1666":"Jose C Paz","1667":"Pilar","1669":"Pilar","1670":"Tigre","1671":"Tigre","1672":"San Martin","1674":"Tres de Febrero","1675":"Tres de Febrero","1676":"Tres de Febrero","1678":"Tres de Febrero","1682":"Tres de Febrero","1683":"Tres de Febrero","1684":"Moron","1685":"Moron","1686":"Hurlingham","1687":"Tres de Febrero","1688":"Hurlingham","1689":"La Matanza Norte","1692":"Tres de Febrero","1702":"Tres de Febrero","1703":"Tres de Febrero","1704":"La Matanza Norte","1706":"Moron","1707":"Moron","1708":"Moron","1712":"Moron","1713":"Ituzaingo","1714":"Ituzaingo","1715":"Ituzaingo","1716":"Merlo","1718":"Merlo","1721":"Merlo","1722":"Merlo","1723":"Merlo","1724":"Merlo","1727":"Marcos Paz","1736":"Moreno","1738":"Moreno","1740":"Moreno","1742":"Moreno","1743":"Moreno","1744":"Moreno","1745":"Moreno","1746":"Moreno","1748":"Gral. Rodriguez","1749":"Gral. Rodriguez","1751":"La Matanza Norte","1752":"La Matanza Norte","1753":"La Matanza Norte","1754":"La Matanza Norte","1755":"La Matanza Norte","1757":"La Matanza Sur","1758":"La Matanza Sur","1759":"La Matanza Sur","1761":"La Matanza Norte","1763":"La Matanza Sur","1764":"La Matanza Sur","1765":"La Matanza Sur","1766":"La Matanza Norte","1768":"La Matanza Norte","1770":"La Matanza Norte","1771":"La Matanza Norte","1772":"La Matanza Norte","1774":"La Matanza Norte","1778":"La Matanza Norte","1785":"La Matanza Norte","1786":"La Matanza Sur","1801":"Ezeiza","1802":"Ezeiza","1803":"Ezeiza","1804":"Ezeiza","1805":"Esteban Echeverria","1806":"Ezeiza","1807":"Ezeiza","1808":"Canuelas","1812":"Canuelas","1813":"Ezeiza","1814":"Canuelas","1815":"Canuelas","1816":"Canuelas","1821":"Lomas de Zamora","1822":"Lanus","1823":"Lanus","1824":"Lanus","1825":"Lanus","1826":"Lanus","1827":"Lomas de Zamora","1828":"Lomas de Zamora","1829":"Lomas de Zamora","1831":"Lomas de Zamora","1832":"Lomas de Zamora","1833":"Lomas de Zamora","1834":"Lomas de Zamora","1835":"Lomas de Zamora","1836":"Lomas de Zamora","1837":"Berazategui","1838":"Esteban Echeverria","1839":"Esteban Echeverria","1840":"Quilmes","1841":"Esteban Echeverria","1842":"Esteban Echeverria","1843":"Almirante Brown","1844":"Almirante Brown","1845":"Almirante Brown","1846":"Almirante Brown","1847":"Almirante Brown","1848":"Almirante Brown","1849":"Almirante Brown","1851":"Almirante Brown","1852":"Almirante Brown","1853":"Florencio Varela","1854":"Almirante Brown","1855":"Almirante Brown","1856":"Almirante Brown","1858":"Presidente Peron","1859":"Florencio Varela","1860":"Berazategui","1861":"Berazategui","1862":"Presidente Peron","1863":"Florencio Varela","1864":"San Vicente","1865":"San Vicente","1867":"Florencio Varela","1868":"Avellaneda","1869":"Avellaneda","1870":"Avellaneda","1871":"Avellaneda","1872":"Avellaneda","1873":"Avellaneda","1874":"Avellaneda","1875":"Avellaneda","1876":"Quilmes","1877":"Quilmes","1878":"Quilmes","1879":"Quilmes","1880":"Berazategui","1881":"Quilmes","1882":"Quilmes","1883":"Quilmes","1884":"Berazategui","1885":"Berazategui","1886":"Berazategui","1887":"Florencio Varela","1888":"Florencio Varela","1889":"Florencio Varela","1890":"Berazategui","1891":"Florencio Varela","1893":"Berazategui","1894":"La Plata","1895":"La Plata","1896":"La Plata","1897":"La Plata","1900":"La Plata","1901":"La Plata","1902":"La Plata","1903":"La Plata","1904":"La Plata","1905":"La Plata","1906":"La Plata","1907":"La Plata","1908":"La Plata","1909":"La Plata","1910":"La Plata","1912":"La Plata","1914":"La Plata","1923":"Berisso","1924":"Berisso","1925":"Ensenada","1926":"Ensenada","1927":"Ensenada","1929":"Berisso","1931":"Ensenada","1984":"San Vicente","2800":"Zarate","2801":"Zarate","2802":"Zarate","2804":"Campana","2805":"Campana","2806":"Zarate","2808":"Zarate","2812":"Campana","2814":"Ex.de la Cruz","2816":"Campana","6700":"Lujan","6701":"Lujan","6702":"Lujan","6703":"Ex.de la Cruz","6706":"Lujan","6708":"Lujan","6712":"Lujan"};


// Utilidad compartida: clave normalizada de cliente
function mkClienteKey(nombre){
  return (nombre||"").toLowerCase().trim().replace(/\s+/g,"_")||null;
}

// Saldo de un envío = deuda - pagado, tolerando diferencias de centavos (redondeo).
// Si la diferencia es menor a $1 se considera saldado (evita pedidos "pendientes" eternos
// por un desajuste de centavos entre el importe cargado y el pago registrado).
function saldoTolerante(monto,pagado){
  const s=(monto||0)-(pagado||0);
  return s>0.99?s:0;
}

// ════════════════════════════════════════════════════════════════════
// TAB CUENTAS CORRIENTES
// ════════════════════════════════════════════════════════════════════
function TabCtasCtes({envios,lc,sesion=null,pagosInicial=[],facturaClientes={},setFacturaCliente=()=>{}}){
  const pagos=pagosInicial; // real-time desde App(), sin listener duplicado
  const loadingPagos=false;
  const [vistaCliente,setVistaCliente]=useState(null);
  const [filtro,setFiltro]=useState("deuda");
  const [busqueda,setBusqueda]=useState("");
  const [sortCC,setSortCC]=useState({col:"saldo",dir:"desc"});
  const [modalPago,setModalPago]=useState(null);
  const [limites,setLimites]=useState({});
  const [loadingLim,setLoadingLim]=useState(true);
  const [syncPagos,setSyncPagos]=useState(null); // null | "confirm" | "cargando" | {actualizados, pendientes, errores, detalle}
  const [syncDetalleOpen,setSyncDetalleOpen]=useState(false);
  const [borrandoPago,setBorrandoPago]=useState(null);
  const [pagoExpandido,setPagoExpandido]=useState(null); // id del pago con detalle visible
  const [mostrarTodosEnvios,setMostrarTodosEnvios]=useState(false);

  useEffect(()=>{setMostrarTodosEnvios(false);},[vistaCliente]);

  const eliminarPago=async(id)=>{
    if(!window.confirm("¿Eliminar este pago? No se puede deshacer."))return;
    setBorrandoPago(id);
    try{await deleteDoc(doc(db,"pagosCC",id));}catch(e){alert("Error al eliminar el pago.");}
    setBorrandoPago(null);
  };

  const sincronizarPagosTN=async()=>{
    setSyncPagos("confirm");
  };
  const confirmarSync=async()=>{
    setSyncPagos("cargando");
    setSyncDetalleOpen(false);
    try{
      const resp=await fetch("/api/sync-pagos-tn",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({})});
      const d=await resp.json();
      setSyncPagos(d);
    }catch(e){
      setSyncPagos({error:e.message});
    }
  };

  useEffect(()=>{
    const unsub=onSnapshot(doc(db,"config","ctasCtes"),snap=>{
      if(snap.exists())setLimites(snap.data().limites||{});
      setLoadingLim(false);
    });
    return()=>unsub();
  },[]);

  const setLimiteCliente=(key,dias)=>{
    const next={...limites,[key]:parseInt(dias)||15};
    setLimites(next);
    setDoc(doc(db,"config","ctasCtes"),{limites:next},{merge:true}).catch(console.error);
  };

  // Derivar clienteKey normalizado (usa helper de módulo)
  const getClienteKey=(e)=>mkClienteKey(e.clienteNombre)||"sin_nombre_"+e.id;
  const getClienteNombre=(e)=>e.clienteNombre||"Sin nombre ("+e.id.slice(-6)+")";

  // Calcular deuda de cada envio
  const getDeudaEnvio=(e)=>{
    if(e.estado==="cancelado")return null;
    if(e.pagoEstado==="cuenta_corriente"&&e.importeOrden>0&&!e.cobranzaRecibida){const monto=e.cobranza>0?e.cobranza:e.importeOrden;return{monto,tipo:"TN CC",logistica:e.trans||""};}
    if(e.cobranza>0&&e.pagoEstado!=="pagado"&&!e.cobranzaRecibida)return{monto:e.cobranza,tipo:"Efectivo",logistica:e.trans||""};
    if(e.esCC&&e.importeCC>0&&!(e.pagoEstado==="pagado"&&e.importeCC===e.importeOrden))return{monto:e.importeCC,tipo:"Manual CC",logistica:e.trans||""};
    return null;
  };

  // Agrupar envios con deuda por cliente
  const clientesMap={};
  envios.forEach(e=>{
    const deuda=getDeudaEnvio(e);
    if(!deuda)return;
    const key=getClienteKey(e);
    if(!clientesMap[key])clientesMap[key]={key,nombre:getClienteNombre(e),envios:[],deudaTotal:0,logisticas:new Set(),fechaMin:e.fecha||""};
    clientesMap[key].envios.push({...e,_deuda:deuda});
    clientesMap[key].deudaTotal+=deuda.monto;
    if(deuda.logistica)clientesMap[key].logisticas.add(deuda.logistica);
    if(e.fecha&&e.fecha<clientesMap[key].fechaMin)clientesMap[key].fechaMin=e.fecha;
  });

  // Calcular pagos por cliente
  const pagosPorCliente={};
  pagos.forEach(p=>{
    if(!pagosPorCliente[p.clienteKey])pagosPorCliente[p.clienteKey]=0;
    pagosPorCliente[p.clienteKey]+=p.monto||0;
  });

  // Calcular antiguedad en dias
  const diasDeuda=(fechaMin)=>{
    if(!fechaMin)return 0;
    const hoy=new Date();hoy.setHours(0,0,0,0);
    const f=new Date(fechaMin+"T00:00:00");
    return Math.max(0,Math.round((hoy-f)/(1000*60*60*24)));
  };

  // Helper: calcular pago atribuido a un envío específico
  const calcPagEnvio=(envioId)=>pagos.filter(p=>p.envioIds?.includes(envioId)).reduce((s,p)=>{
    if(p.montosPorEnvio)return s+(p.montosPorEnvio[envioId]||0);
    if((p.envioIds?.length||0)===1)return s+(p.monto||0);
    return s;
  },0);

  // Lista de clientes con saldo
  const clientes=Object.values(clientesMap).map(c=>{
    const cobradoTotal=pagosPorCliente[c.key]||0; // total histórico de pagos del cliente
    const dias=diasDeuda(c.fechaMin);
    const limite=limites[c.key]||15;
    // Saldo real = suma de saldos individuales por pedido (no deudaTotal - pagos totales)
    let saldo=0,cobradoConSaldo=0,pendienteCount=0,fechaMinPendiente="";
    c.envios.forEach(e=>{
      const pagEnvio=calcPagEnvio(e.id);
      const saldoE=saldoTolerante(e._deuda?.monto,pagEnvio);
      saldo+=saldoE;
      if(saldoE>0){
        pendienteCount++;
        cobradoConSaldo+=((e._deuda?.monto||0)-saldoE);
        const fe=e.fecha||e.fechaVenta||"";
        if(fe&&(!fechaMinPendiente||fe<fechaMinPendiente))fechaMinPendiente=fe;
      }
    });
    // COBRADO que se muestra = lo que efectivamente redujo deuda en pedidos activos
    const cobrado=c.deudaTotal-saldo;
    const diasReal=diasDeuda(fechaMinPendiente||c.fechaMin);
    return{...c,cobrado,cobradoConSaldo,cobradoTotal,pendienteCount,saldo,dias:diasReal,limite,logisticas:[...c.logisticas]};
  });

  const fmt=(n)=>"$"+Math.round(n).toLocaleString("es-AR");
  const hoy=new Date();hoy.setHours(0,0,0,0);

  // Filtros + sort
  const clientesFiltrados=clientes.filter(c=>{
    if(filtro==="deuda"&&c.saldo===0)return false;
    if(filtro==="vencidos"&&c.dias<c.limite)return false;
    if(filtro==="saldados"&&c.saldo>0)return false;
    if(filtro==="fc_pend"&&!(facturaClientes[c.key]&&c.envios.some(e=>e.trans&&!e.nroFactura&&e.estado!=="cancelado")))return false;
    if(busqueda){const s=norm(busqueda);const ok=norm(c.nombre).includes(s)||c.envios.some(e=>norm(e.direccion).includes(s)||(e.nroOrdenTN||"").includes(s)||(e.nroSeguimiento||"").includes(s));if(!ok)return false;}
    return true;
  }).sort((a,b)=>{
    const {col,dir}=sortCC;
    let va,vb;
    if(col==="nombre"){va=a.nombre.toLowerCase();vb=b.nombre.toLowerCase();}
    else if(col==="deudaTotal"){va=a.deudaTotal;vb=b.deudaTotal;}
    else if(col==="cobrado"){va=a.cobradoConSaldo;vb=b.cobradoConSaldo;}
    else if(col==="saldo"){va=a.saldo;vb=b.saldo;}
    else if(col==="dias"){va=a.dias;vb=b.dias;}
    else{va=a.saldo;vb=b.saldo;}
    if(va<vb)return dir==="asc"?-1:1;
    if(va>vb)return dir==="asc"?1:-1;
    return 0;
  });

  // Metricas globales
  const deudaTotal=clientesFiltrados.reduce((s,c)=>s+c.saldo,0);
  const vencidosTotal=clientesFiltrados.filter(c=>c.dias>=c.limite&&c.saldo>0).reduce((s,c)=>s+c.saldo,0);
  const cobradoMes=(()=>{
    const inicio=new Date();inicio.setDate(1);inicio.setHours(0,0,0,0);
    const keysFil=new Set(clientesFiltrados.map(c=>c.key));
    return pagos.filter(p=>{const f=p.creadoEn?.toDate?.();return f&&f>=inicio&&keysFil.has(p.clienteKey);}).reduce((s,p)=>s+(p.monto||0),0);
  })();
  const clientesActivos=clientesFiltrados.filter(c=>c.saldo>0).length;

  if(loadingPagos||loadingLim)return<div style={{padding:"2rem",color:"#6b7280",textAlign:"center"}}>Cargando cuentas corrientes...</div>;

  // Vista detalle de cliente
  if(vistaCliente){
    const c=clientes.find(cl=>cl.key===vistaCliente);
    if(!c)return null;
    const pagosCli=pagos.filter(p=>p.clienteKey===c.key).sort((a,b)=>b.creadoEn?.toDate?.()-(a.creadoEn?.toDate?.())||0);
    return(
      <div style={{maxWidth:"820px"}}>
        <button onClick={()=>setVistaCliente(null)} style={{...S.btn(false),marginBottom:"1rem",fontSize:"0.78rem"}}>← Volver</button>
        <div style={{...S.card,padding:"1rem 1.25rem",marginBottom:"1rem"}}>
          <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",flexWrap:"wrap",gap:"0.5rem",marginBottom:"0.75rem"}}>
            <div>
              <div style={{fontWeight:800,fontSize:"1rem",color:"#e5e7eb"}}>{c.nombre}</div>
              <div style={{fontSize:"0.72rem",color:"#6b7280",marginTop:"2px"}}>
                {c.logisticas.length>0&&<span>Logisticas: {c.logisticas.join(", ")} · </span>}
                Limite alerta: <input type="number" min="1" max="90" value={c.limite} onChange={ev=>setLimiteCliente(c.key,ev.target.value)} style={{...S.input,width:"48px",padding:"1px 6px",fontSize:"0.72rem",height:"20px",display:"inline-block"}}/> días
              </div>
            </div>
            <div style={{display:"flex",gap:"0.75rem",flexWrap:"wrap",alignItems:"flex-end"}}>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:"0.62rem",color:"#6b7280",textTransform:"uppercase",fontWeight:700}}>Total pedidos</div>
                <div style={{fontSize:"0.85rem",fontWeight:600,color:"#6b7280"}}>{fmt(c.deudaTotal)}</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:"0.62rem",color:"#6b7280",textTransform:"uppercase",fontWeight:700}}>Cobrado</div>
                <div style={{fontSize:"0.85rem",fontWeight:600,color:"#10b981"}}>{fmt(c.cobrado)}</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:"0.62rem",color:"#6b7280",textTransform:"uppercase",fontWeight:700}}>Pendiente</div>
                <div style={{fontSize:"1.25rem",fontWeight:800,color:c.saldo>0?"#ef4444":"#10b981"}}>{fmt(c.saldo)}</div>
              </div>
            </div>
          </div>
          <button onClick={()=>setModalPago({clienteKey:c.key,clienteNombre:c.nombre,saldoPendiente:c.saldo})} disabled={c.saldo===0} style={{...S.btn(true),background:"linear-gradient(135deg,#10b981,#059669)",padding:"0.4rem 1rem",fontSize:"0.8rem",opacity:c.saldo===0?0.4:1}}>Registrar pago</button>
        </div>

        {/* Pedidos con saldo / todos */}
        {(()=>{
          // Calcular saldo por envio para filtrar
          const enviosConSaldo=c.envios.map(e=>{
            const pagEnvio=calcPagEnvio(e.id);
            return{...e,_saldoEnvio:saldoTolerante(e._deuda?.monto,pagEnvio)};
          }).filter(e=>e._saldoEnvio>0);

          // Todos los pedidos del cliente (incluyendo sin deuda)
          const todosEnviosCliente=envios.filter(e=>getClienteKey(e)===c.key).sort((a,b)=>(b.fechaVenta||b.fecha||"").localeCompare(a.fechaVenta||a.fecha||""));

          const listaDeuda=mostrarTodosEnvios?null:enviosConSaldo;
          const listaTodos=mostrarTodosEnvios?todosEnviosCliente:null;

          return(
            <div style={{...S.card,marginBottom:"1rem",overflow:"hidden"}}>
              <div style={{padding:"0.6rem 1rem",background:"#12172a",borderBottom:"1px solid #1e2535",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:"0.5rem"}}>
                <span style={{fontSize:"0.72rem",fontWeight:700,color:"#6b7280",textTransform:"uppercase"}}>
                  {mostrarTodosEnvios?"Historial de pedidos":"Pedidos con saldo"}
                  {!mostrarTodosEnvios&&enviosConSaldo.length===0&&<span style={{color:"#10b981",marginLeft:"8px"}}>✓ todo cobrado</span>}
                </span>
                <div style={{display:"flex",gap:"4px"}}>
                  <button onClick={()=>setMostrarTodosEnvios(false)} style={{...S.btnSm(!mostrarTodosEnvios,"#ef4444"),fontSize:"0.65rem",padding:"2px 8px"}}>Con saldo</button>
                  <button onClick={()=>setMostrarTodosEnvios(true)} style={{...S.btnSm(mostrarTodosEnvios,"#6366f1"),fontSize:"0.65rem",padding:"2px 8px"}}>Todos ({todosEnviosCliente.length})</button>
                </div>
              </div>

              {!mostrarTodosEnvios&&(
                enviosConSaldo.length===0
                  ?<div style={{padding:"1rem",textAlign:"center",color:"#10b981",fontSize:"0.8rem"}}>Sin pedidos con saldo pendiente</div>
                  :enviosConSaldo.map((e,i)=>(
                    <div key={e.id} style={{padding:"0.65rem 1rem",borderBottom:i<enviosConSaldo.length-1?"1px solid #1a1f2e":"none",display:"flex",gap:"0.75rem",alignItems:"center",flexWrap:"wrap"}}>
                      <div style={{flex:1,minWidth:"200px"}}>
                        <div style={{fontSize:"0.82rem",color:"#d1d5db",fontWeight:500}}>{e.direccion?.slice(0,60)}</div>
                        <div style={{fontSize:"0.68rem",color:"#4b5563",marginTop:"2px"}}>
                          {e.nroOrdenTN?<span style={{color:"#7dd3fc",fontWeight:700}}>#{e.nroOrdenTN}</span>:<span>ID {e.id.slice(-8)}</span>}{e.fechaVenta?<span> · Venta: {fmtCorta(e.fechaVenta)}</span>:null}{e.fecha?<span> · Envio: {fmtCorta(e.fecha)}</span>:null}
                          {e.trans&&<span style={{marginLeft:"6px",padding:"1px 6px",background:lc[e.trans]?.color+"22",color:lc[e.trans]?.color,borderRadius:"4px",fontSize:"0.65rem",fontWeight:700}}>{e.trans}</span>}
                          {e.nroFactura&&<span style={{marginLeft:"6px",padding:"1px 7px",background:"#130d2a",color:"#c4b5fd",borderRadius:"4px",fontSize:"0.65rem",fontWeight:600,border:"1px solid #4c1d95",fontFamily:"monospace"}}>FC {e.nroFactura}</span>}
                        </div>
                      </div>
                      <div style={{display:"flex",gap:"0.75rem",alignItems:"center",flexWrap:"wrap"}}>
                        <span style={{fontSize:"0.7rem",padding:"2px 8px",background:e._deuda.tipo==="Efectivo"?"#1c0f00":"#130d2a",color:e._deuda.tipo==="Efectivo"?"#f59e0b":"#a78bfa",borderRadius:"4px",border:"1px solid "+(e._deuda.tipo==="Efectivo"?"#78350f":"#6d28d9")}}>{e._deuda.tipo}</span>
                        <div style={{textAlign:"right"}}>
                          <div style={{fontSize:"0.62rem",color:"#6b7280"}}>Importe</div>
                          <div style={{fontWeight:700,color:"#f59e0b"}}>{fmt(e._deuda.monto)}</div>
                        </div>
                        <div style={{textAlign:"right"}}>
                          <div style={{fontSize:"0.62rem",color:"#6b7280"}}>Saldo</div>
                          <div style={{fontWeight:700,color:e._saldoEnvio>0?"#ef4444":"#10b981"}}>{fmt(e._saldoEnvio)}</div>
                        </div>
                      </div>
                    </div>
                  ))
              )}

              {mostrarTodosEnvios&&(
                todosEnviosCliente.length===0
                  ?<div style={{padding:"1rem",textAlign:"center",color:"#6b7280",fontSize:"0.8rem"}}>Sin pedidos registrados</div>
                  :todosEnviosCliente.map((e,i)=>{
                    const deuda=getDeudaEnvio(e);
                    const pagEnvio=deuda?calcPagEnvio(e.id):0;
                    const saldoE=deuda?saldoTolerante(deuda.monto,pagEnvio):0;
                    const esCancelado=e.estado==="cancelado";
                    return(
                      <div key={e.id} style={{padding:"0.6rem 1rem",borderBottom:i<todosEnviosCliente.length-1?"1px solid #1a1f2e":"none",display:"flex",gap:"0.75rem",alignItems:"center",flexWrap:"wrap",opacity:esCancelado?0.45:1}}>
                        <div style={{flex:1,minWidth:"200px"}}>
                          <div style={{fontSize:"0.8rem",color:"#d1d5db",fontWeight:500,textDecoration:esCancelado?"line-through":"none"}}>{e.direccion?.slice(0,60)}</div>
                          <div style={{fontSize:"0.67rem",color:"#4b5563",marginTop:"2px"}}>
                            {e.nroOrdenTN?<span style={{color:"#7dd3fc",fontWeight:700}}>#{e.nroOrdenTN}</span>:<span>ID {e.id.slice(-8)}</span>}{e.fechaVenta?<span> · Venta: {fmtCorta(e.fechaVenta)}</span>:null}{e.fecha?<span> · Envio: {fmtCorta(e.fecha)}</span>:null}
                            {e.trans&&<span style={{marginLeft:"6px",padding:"1px 6px",background:lc[e.trans]?.color+"22",color:lc[e.trans]?.color,borderRadius:"4px",fontSize:"0.62rem",fontWeight:700}}>{e.trans}</span>}
                          </div>
                        </div>
                        <div style={{display:"flex",gap:"0.5rem",alignItems:"center"}}>
                          {deuda?(
                            <>
                              <span style={{fontSize:"0.68rem",padding:"1px 6px",background:deuda.tipo==="Efectivo"?"#1c0f00":"#130d2a",color:deuda.tipo==="Efectivo"?"#f59e0b":"#a78bfa",borderRadius:"4px",border:"1px solid "+(deuda.tipo==="Efectivo"?"#78350f":"#6d28d9")}}>{deuda.tipo}</span>
                              <div style={{textAlign:"right"}}>
                                <div style={{fontSize:"0.6rem",color:"#6b7280"}}>Importe</div>
                                <div style={{fontSize:"0.78rem",fontWeight:700,color:"#f59e0b"}}>{fmt(deuda.monto)}</div>
                              </div>
                              <div style={{textAlign:"right"}}>
                                <div style={{fontSize:"0.6rem",color:"#6b7280"}}>Saldo</div>
                                <div style={{fontSize:"0.78rem",fontWeight:700,color:saldoE>0?"#ef4444":"#10b981"}}>{fmt(saldoE)}</div>
                              </div>
                            </>
                          ):(
                            <span style={{fontSize:"0.68rem",padding:"1px 8px",background:"#0d1f0d",color:esCancelado?"#6b7280":"#10b981",borderRadius:"4px",border:"1px solid "+(esCancelado?"#374151":"#166534")}}>
                              {esCancelado?"Cancelado":"Sin deuda"}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })
              )}
            </div>
          );
        })()}

        {pagosCli.length>0&&(
          <div style={{...S.card,overflow:"hidden"}}>
            <div style={{padding:"0.6rem 1rem",background:"#12172a",borderBottom:"1px solid #1e2535",fontSize:"0.72rem",fontWeight:700,color:"#6b7280",textTransform:"uppercase"}}>Historial de pagos</div>
            {pagosCli.map((p,i)=>{
              const expandido=pagoExpandido===p._id;
              const enviosDePago=(p.envioIds||[]).map(eid=>{
                const env=envios.find(e=>e.id===eid);
                const monto=p.montosPorEnvio?p.montosPorEnvio[eid]||(p.envioIds.length===1?p.monto:null):(p.envioIds.length===1?p.monto:null);
                return{id:eid,env,monto};
              });
              return(
                <div key={p._id} style={{borderBottom:i<pagosCli.length-1?"1px solid #1a1f2e":"none"}}>
                  {/* Fila principal del pago */}
                  <div style={{padding:"0.55rem 1rem",display:"flex",justifyContent:"space-between",alignItems:"center",gap:"0.5rem",flexWrap:"wrap"}}>
                    <div style={{flex:1}}>
                      <div style={{display:"flex",alignItems:"center",gap:"0.5rem",flexWrap:"wrap"}}>
                        <div style={{fontSize:"0.82rem",color:"#10b981",fontWeight:700}}>{fmt(p.monto)}</div>
                        {p.nota&&<div style={{fontSize:"0.7rem",color:"#6b7280"}}>{p.nota}</div>}
                      </div>
                      <div style={{display:"flex",gap:"0.75rem",alignItems:"center",flexWrap:"wrap",marginTop:"2px"}}>
                        {p.registradoPor&&<div style={{fontSize:"0.62rem",color:"#374151"}}>por {p.registradoPor.nombre}</div>}
                        {enviosDePago.length>0&&(
                          <button onClick={()=>setPagoExpandido(expandido?null:p._id)}
                            style={{background:"none",border:"none",color:"#6366f1",fontSize:"0.65rem",cursor:"pointer",padding:0,fontWeight:600,textDecoration:"underline"}}>
                            {expandido?"▲ Ocultar":"▼ Ver"} {enviosDePago.length} pedido{enviosDePago.length!==1?"s":""}
                          </button>
                        )}
                      </div>
                    </div>
                    <div style={{display:"flex",gap:"0.5rem",alignItems:"center"}}>
                      <div style={{fontSize:"0.72rem",color:"#4b5563"}}>{p.fechaCobro||p.creadoEn?.toDate?.()?.toLocaleDateString("es-AR")||"—"}</div>
                      <button onClick={()=>eliminarPago(p._id)} disabled={borrandoPago===p._id} style={{background:"transparent",border:"1px solid #7f1d1d",borderRadius:"5px",color:"#ef4444",fontSize:"0.7rem",padding:"2px 7px",cursor:"pointer",opacity:borrandoPago===p._id?0.5:1}}>{borrandoPago===p._id?"...":"✕"}</button>
                    </div>
                  </div>
                  {/* Detalle expandido: pedidos cubiertos por este pago */}
                  {expandido&&enviosDePago.length>0&&(
                    <div style={{background:"#0a0e1a",borderTop:"1px solid #1e2535",padding:"0.5rem 1rem 0.6rem"}}>
                      {enviosDePago.map(({id,env,monto})=>(
                        <div key={id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"4px 0",borderBottom:"1px solid #12172a",gap:"0.5rem",flexWrap:"wrap"}}>
                          <div style={{flex:1,minWidth:"160px"}}>
                            <div style={{fontSize:"0.75rem",color:"#d1d5db",fontWeight:500}}>{env?.direccion?.slice(0,55)||<span style={{color:"#4b5563",fontStyle:"italic"}}>ID {id.slice(-8)}</span>}</div>
                            <div style={{fontSize:"0.65rem",color:"#4b5563",marginTop:"1px"}}>
                              {env?.nroOrdenTN?<span style={{color:"#7dd3fc"}}>#{env.nroOrdenTN}</span>:<span>{id.slice(-8)}</span>}
                              {env?.fecha?<span> · {fmtCorta(env.fecha)}</span>:null}
                              {env?.trans?<span style={{marginLeft:"5px",color:lc[env.trans]?.color||"#9ca3af",fontWeight:700}}>{env.trans}</span>:null}
                            </div>
                          </div>
                          {monto!=null&&<div style={{fontSize:"0.78rem",color:"#10b981",fontWeight:700,flexShrink:0}}>{fmt(monto)}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      {modalPago&&<ModalRegistrarPago {...modalPago} onClose={()=>setModalPago(null)} envios={envios.filter(e=>{const deuda=getDeudaEnvio(e);return deuda&&getClienteKey(e)===modalPago.clienteKey;})} pagos={pagos.filter(p=>p.clienteKey===modalPago.clienteKey)} getDeudaEnvio={getDeudaEnvio} sesion={sesion}/>}
      </div>
    );
  }

  return(
    <div>
      {/* Botón sync TN + resultado */}
      <div style={{display:"flex",alignItems:"center",gap:"0.75rem",marginBottom:"0.8rem",flexWrap:"wrap"}}>
        {syncPagos==="confirm"?(
          <>
            <span style={{fontSize:"0.78rem",color:"#fcd34d"}}>¿Actualizar pagos TN→Firestore?</span>
            <button onClick={confirmarSync} style={{...S.btnSm(false,"#22c55e"),padding:"0.3rem 0.7rem",fontSize:"0.75rem"}}>Sí, sincronizar</button>
            <button onClick={()=>setSyncPagos(null)} style={{...S.btnSm(false,"#6b7280"),padding:"0.3rem 0.7rem",fontSize:"0.75rem"}}>Cancelar</button>
          </>
        ):(
          <button onClick={sincronizarPagosTN} disabled={syncPagos==="cargando"}
            style={{...S.btnSm(false,"#38bdf8"),padding:"0.4rem 0.9rem",fontSize:"0.78rem",opacity:syncPagos==="cargando"?0.6:1}}>
            {syncPagos==="cargando"?"⏳ Sincronizando...":"🔄 Sincronizar pagos TN"}
          </button>
        )}
        {syncPagos&&syncPagos!=="cargando"&&syncPagos!=="confirm"&&(
          syncPagos.error
            ? <span style={{fontSize:"0.75rem",color:"#fca5a5"}}>Error: {syncPagos.error}</span>
            : <span style={{fontSize:"0.75rem",color:"#6b7280",display:"flex",alignItems:"center",gap:"8px",flexWrap:"wrap"}}>
                <span style={{color:"#34d399"}}>✓ {syncPagos.actualizados} actualizados</span>
                <span>· {syncPagos.pendientes} pendientes ·</span>
                <span style={{color:syncPagos.errores>0?"#f87171":"#6b7280"}}>{syncPagos.errores} errores</span>
                <span style={{color:"#4b5563"}}>({syncPagos.totalCC??0} CC + {syncPagos.totalEfectivo??0} efectivo + {syncPagos.totalPendientes??0} transf.)</span>
                <button onClick={()=>setSyncDetalleOpen(p=>!p)} style={{...S.btnSm(syncDetalleOpen,"#6366f1"),padding:"1px 8px",fontSize:"0.68rem"}}>
                  {syncDetalleOpen?"Ocultar detalle":"Ver detalle"}
                </button>
              </span>
        )}
      </div>

      {/* Panel detalle sync */}
      {syncPagos&&syncPagos.detalle&&syncDetalleOpen&&(()=>{
        const errores=(syncPagos.detalle||[]).filter(d=>d.error);
        const actualizados=(syncPagos.detalle||[]).filter(d=>d.resultado==="pagado");
        const pendientes=(syncPagos.detalle||[]).filter(d=>d.resultado&&d.resultado!=="pagado");
        return(
          <div style={{...S.card,padding:0,marginBottom:"1rem",overflow:"hidden"}}>
            {/* Header */}
            <div style={{padding:"0.6rem 1rem",background:"#0b1220",borderBottom:"1px solid #1a2640",display:"flex",alignItems:"center",gap:"1rem",flexWrap:"wrap"}}>
              <span style={{fontWeight:700,fontSize:"0.78rem",color:"#e2e8f0"}}>Detalle sincronización</span>
              <span style={{fontSize:"0.72rem",color:"#34d399"}}>✓ {actualizados.length} pagados</span>
              <span style={{fontSize:"0.72rem",color:"#6b7280"}}>⏳ {pendientes.length} pendientes</span>
              {errores.length>0&&<span style={{fontSize:"0.72rem",color:"#f87171"}}>✗ {errores.length} errores</span>}
              {errores.length>0&&<button onClick={()=>{
                const filas=errores.map(d=>({"Nro Orden":d.nro||"","Cliente":d.cliente||"","Error":d.error||"","ID":d.id||""}));
                exportarXLSX(filas,"errores_sync_tn_"+fechaHoy());
              }} style={{...S.btnSm(false),color:"#10b981",borderColor:"#10b981",padding:"2px 8px",fontSize:"0.68rem",marginLeft:"auto"}}>⬇ Exportar errores</button>}
            </div>
            {/* Errores */}
            {errores.length>0&&(
              <div style={{borderBottom:"1px solid #1a2640"}}>
                <div style={{padding:"5px 1rem",background:"#1c0a0a",fontSize:"0.65rem",fontWeight:700,color:"#f87171",textTransform:"uppercase",letterSpacing:"0.05em"}}>Errores ({errores.length})</div>
                {errores.map((d,i)=>(
                  <div key={i} style={{padding:"6px 1rem",borderBottom:"1px solid #0d1117",display:"flex",gap:"1rem",alignItems:"center",flexWrap:"wrap"}}>
                    <span style={{fontSize:"0.72rem",color:"#f87171",fontFamily:"monospace",fontWeight:700}}>#{d.nro||d.idFirestore||d.id||"—"}</span>
                    {d.cliente&&<span style={{fontSize:"0.72rem",color:"#9ca3af"}}>{d.cliente}</span>}
                    {d.idFirestore&&!d.nro&&<span style={{fontSize:"0.65rem",color:"#374151",fontFamily:"monospace"}}>id: {d.idFirestore.slice(-8)}</span>}
                    <span style={{fontSize:"0.72rem",color:"#6b7280",marginLeft:"auto",fontFamily:"monospace"}}>{d.error}</span>
                  </div>
                ))}
              </div>
            )}
            {/* Actualizados */}
            {actualizados.length>0&&(
              <div style={{borderBottom:"1px solid #1a2640"}}>
                <div style={{padding:"5px 1rem",background:"#041f14",fontSize:"0.65rem",fontWeight:700,color:"#34d399",textTransform:"uppercase",letterSpacing:"0.05em"}}>Marcados como pagados ({actualizados.length})</div>
                {actualizados.map((d,i)=>(
                  <div key={i} style={{padding:"6px 1rem",borderBottom:"1px solid #0d1117",display:"flex",gap:"1rem",alignItems:"center"}}>
                    <span style={{fontSize:"0.72rem",color:"#34d399",fontFamily:"monospace",fontWeight:700}}>#{d.nro||"—"}</span>
                    {d.cliente&&<span style={{fontSize:"0.72rem",color:"#9ca3af"}}>{d.cliente}</span>}
                  </div>
                ))}
              </div>
            )}
            {/* Pendientes */}
            {pendientes.length>0&&(
              <div>
                <div style={{padding:"5px 1rem",background:"#0b1220",fontSize:"0.65rem",fontWeight:700,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.05em"}}>Pendientes en TN ({pendientes.length})</div>
                {pendientes.map((d,i)=>(
                  <div key={i} style={{padding:"6px 1rem",borderBottom:"1px solid #0d1117",display:"flex",gap:"1rem",alignItems:"center"}}>
                    <span style={{fontSize:"0.72rem",color:"#6b7280",fontFamily:"monospace",fontWeight:700}}>#{d.nro||"—"}</span>
                    {d.cliente&&<span style={{fontSize:"0.72rem",color:"#4b5563"}}>{d.cliente}</span>}
                    <span style={{fontSize:"0.72rem",color:"#374151",marginLeft:"auto",fontFamily:"monospace"}}>{d.resultado}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* Alerta vencidos */}
      {clientes.filter(c=>c.dias>=c.limite&&c.saldo>0).length>0&&(
        <div style={{...S.card,padding:"0.65rem 1rem",marginBottom:"1rem",background:"#1c0a0a",border:"1px solid #7f1d1d",color:"#fca5a5",display:"flex",alignItems:"center",gap:"0.75rem"}}>
          <span style={{fontSize:"1rem"}}>⚠</span>
          <span style={{fontSize:"0.82rem"}}><strong>{clientes.filter(c=>c.dias>=c.limite&&c.saldo>0).length} clientes</strong> con deuda vencida según su límite configurado</span>
        </div>
      )}

      {/* Metricas */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,minmax(0,1fr))",gap:"10px",marginBottom:"1rem"}}>
        {[
          {l:"Clientes activos",v:clientesActivos,c:"#e5e7eb"},
          {l:"Deuda total",v:fmt(deudaTotal),c:"#f59e0b"},
          {l:"Vencidas",v:fmt(vencidosTotal),c:"#ef4444"},
          {l:"Cobrado este mes",v:fmt(cobradoMes),c:"#10b981"},
        ].map(m=>(
          <div key={m.l} style={{background:"#12172a",borderRadius:"10px",padding:"0.75rem 1rem",border:"1px solid #1e2535"}}>
            <div style={{fontSize:"0.62rem",color:"#6b7280",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>{m.l}</div>
            <div style={{fontSize:"1.25rem",fontWeight:800,color:m.c}}>{m.v}</div>
          </div>
        ))}
      </div>

      {/* Filtros + Exportar */}
      <div style={{display:"flex",gap:"6px",flexWrap:"wrap",alignItems:"center",marginBottom:"0.85rem"}}>
        {[{k:"todos",l:"Todos"},{k:"deuda",l:"Con deuda"},{k:"vencidos",l:"Vencidos"},{k:"saldados",l:"Saldados"},{k:"fc_pend",l:"🧾 FC pend."}].map(f=>(
          <button key={f.k} onClick={()=>setFiltro(f.k)} style={S.btnSm(filtro===f.k,"#6366f1")}>{f.l}</button>
        ))}
        <input value={busqueda} onChange={e=>setBusqueda(e.target.value)} placeholder="Nombre, dirección o nro orden..." style={{...S.input,width:"240px",marginLeft:"auto"}}/>
        <button onClick={()=>{
          // Helper saldo por envio
          const saldoE=e=>{const pE=pagos.filter(p=>p.envioIds?.includes(e.id)).reduce((s,p)=>{if(p.montosPorEnvio)return s+(p.montosPorEnvio[e.id]||0);if((p.envioIds?.length||0)===1)return s+(p.monto||0);return s;},0);return saldoTolerante(e._deuda?.monto,pE);};
          const filas=[];
          clientesFiltrados.forEach((c,ci)=>{
            const vencido=c.saldo>0&&c.dias>=c.limite;
            // Fila resumen cliente
            filas.push({
              Tipo:"CLIENTE","#":ci+1,Cliente:c.nombre,
              Logisticas:c.logisticas.join(", "),
              Direccion:"","Nro Orden":"","Fecha Venta":"","Fecha Envio":"",
              "Tipo CC":"","Importe":"",
              "Cobrado a cta.":c.cobradoConSaldo,
              Saldo:c.saldo,
              "Antiguedad (dias)":c.saldo>0?c.dias:"",
              Estado:c.saldo===0?"Saldado":vencido?"Vencido":"Con deuda",
            });
            // Filas de pedidos pendientes
            c.envios.forEach(e=>{
              const se=saldoE(e);
              if(se<=0)return;
              filas.push({
                Tipo:"  pedido","#":"",Cliente:"",Logisticas:"",
                Direccion:e.direccion,
                "Nro Orden":e.nroOrdenTN?"#"+e.nroOrdenTN:e.id.slice(-8),
                "Fecha Venta":e.fechaVenta?fmtCorta(e.fechaVenta):"",
                "Fecha Envio":e.fecha?fmtCorta(e.fecha):"",
                "Tipo CC":e._deuda?.tipo||"",
                Importe:e._deuda?.monto||0,
                "Cobrado a cta.":e._deuda?.monto-se,
                Saldo:se,
                "Antiguedad (dias)":"",Estado:"",
              });
            });
            // Separador
            filas.push({Tipo:"","":" ","#":"",Cliente:"",Logisticas:"",Direccion:"","Nro Orden":"","Fecha Venta":"","Fecha Envio":"","Tipo CC":"",Importe:"","Cobrado a cta.":"",Saldo:"","Antiguedad (dias)":"",Estado:""});
          });
          exportarXLSX(filas,"ctas_ctes_"+fechaHoy());
        }} style={{...S.btnSm(false),color:"#10b981",border:"1px solid #10b981",padding:"3px 10px",fontSize:"0.72rem"}}>⬇ Excel</button>
        <button onClick={()=>{
          const ahora=new Date();
          const ts=ahora.toLocaleDateString("es-AR",{weekday:"long",day:"numeric",month:"long",year:"numeric"});
          const saldoE=e=>{const pE=pagos.filter(p=>p.envioIds?.includes(e.id)).reduce((s,p)=>{if(p.montosPorEnvio)return s+(p.montosPorEnvio[e.id]||0);if((p.envioIds?.length||0)===1)return s+(p.monto||0);return s;},0);return saldoTolerante(e._deuda?.monto,pE);};
          const rows=clientesFiltrados.map((c,ci)=>{
            const vencido=c.saldo>0&&c.dias>=c.limite;
            const estadoBg=c.saldo===0?"#dcfce7":vencido?"#fee2e2":"#fef3c7";
            const estadoC=c.saldo===0?"#166534":vencido?"#991b1b":"#92400e";
            const pedidosOrdenados=[...c.envios].sort((a,b)=>(a.fechaVenta||a.fecha||"").localeCompare(b.fechaVenta||b.fecha||""));
            const pedidosRows=pedidosOrdenados.map(e=>{
              const se=saldoE(e);
              if(se<=0)return"";
              return`<tr>
                <td style="padding:3px 6px 3px 18px;border-bottom:0.5px solid #eee;font-size:10px;color:#374151;">${e.direccion?.slice(0,55)||"—"}</td>
                <td style="padding:3px 6px;border-bottom:0.5px solid #eee;font-size:9px;font-family:monospace;color:#2563eb;">${e.nroOrdenTN?"#"+e.nroOrdenTN:e.id.slice(-8)}</td>
                <td style="padding:3px 6px;border-bottom:0.5px solid #eee;font-size:9px;color:#6b7280;">${e.fecha?fmtCorta(e.fecha):"—"}</td>
                <td style="padding:3px 6px;border-bottom:0.5px solid #eee;font-size:9px;color:#555;">${e.trans||"—"}</td>
                <td style="padding:3px 6px;border-bottom:0.5px solid #eee;font-size:9px;">${e._deuda?.tipo||""}</td>
                <td style="padding:3px 6px;border-bottom:0.5px solid #eee;text-align:right;font-size:10px;color:#92400e;">$${Math.round(e._deuda?.monto||0).toLocaleString("es-AR")}</td>
                <td style="padding:3px 6px;border-bottom:0.5px solid #eee;text-align:right;font-size:10px;font-weight:700;color:${se>0?"#dc2626":"#059669"};">$${Math.round(se).toLocaleString("es-AR")}</td>
              </tr>`;
            }).join("");
            return`
              <tr style="background:#f0f0f0;border-top:1.5px solid #bbb;">
                <td style="padding:5px 6px;font-weight:700;font-size:11px;">${ci+1}. ${c.nombre}</td>
                <td style="padding:5px 6px;font-size:9px;color:#555;">${c.logisticas.join(", ")}</td>
                <td style="padding:5px 6px;font-size:9px;text-align:center;color:#555;">${c.pendienteCount} pedido${c.pendienteCount!==1?"s":""}</td>
                <td style="padding:5px 6px;font-size:9px;text-align:center;color:#555;">${c.saldo===0?"—":c.dias+" días"}</td>
                <td colspan="2" style="padding:5px 6px;text-align:right;font-weight:800;font-size:11px;color:${c.saldo===0?"#059669":vencido?"#dc2626":"#d97706"};">$${Math.round(c.saldo).toLocaleString("es-AR")}</td>
                <td style="padding:5px 6px;text-align:center;"><span style="font-size:8.5px;padding:2px 6px;border-radius:3px;background:${estadoBg};color:${estadoC};font-weight:700;">${c.saldo===0?"Saldado":vencido?"Vencido":"Con deuda"}</span></td>
              </tr>
              ${pedidosRows}`;
          }).join("");
          const totalSaldo=clientesFiltrados.reduce((s,c)=>s+c.saldo,0);
          const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Ctas. Ctes.</title>
            <style>@page{size:A4;margin:10mm;}body{font-family:Arial,sans-serif;font-size:11px;color:#111;}table{width:100%;border-collapse:collapse;}th{background:#d1d5db;padding:4px 6px;text-align:left;font-size:9px;text-transform:uppercase;font-weight:700;border-bottom:1.5px solid #333;}@media print{button{display:none!important;}}</style>
            </head><body>
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
              <strong style="font-size:13px;">Cuentas Corrientes${busqueda?" — "+busqueda:""}</strong>
              <span style="font-size:8px;color:#888;">${ts}</span>
            </div>
            <table><thead><tr>
              <th>Cliente / Dirección</th>
              <th style="width:70px;">Logística</th>
              <th style="width:55px;text-align:center;">Pedidos</th>
              <th style="width:50px;text-align:center;">Antigüedad</th>
              <th style="width:75px;text-align:right;" colspan="2">Saldo</th>
              <th style="width:55px;text-align:center;">Estado</th>
            </tr></thead><tbody>${rows}</tbody></table>
            <div style="border-top:1.5px solid #333;margin-top:6px;padding-top:4px;display:flex;justify-content:space-between;font-size:9px;color:#555;">
              <span>${clientesFiltrados.length} clientes · ${clientesFiltrados.reduce((s,c)=>s+c.pendienteCount,0)} pedidos pendientes</span>
              <span style="font-weight:700;font-size:11px;">Saldo total: $${Math.round(totalSaldo).toLocaleString("es-AR")}</span>
            </div>
            <script>window.onload=function(){window.print();}<\/script></body></html>`;
          const w=window.open("","_blank");if(!w){alert("Permite ventanas emergentes.");return;}w.document.write(html);w.document.close();
        }} style={{...S.btn(true),background:"#0f1420",border:"1px solid #252d40",padding:"0.3rem 0.8rem",fontSize:"0.72rem"}}>🖨️ Imprimir</button>
      </div>

      {/* Tabla */}
      <div style={{...S.card,overflow:"hidden"}}>
        <table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead>
            <tr style={{background:"#12172a"}}>
              {[
                {label:"Cliente",col:"nombre",align:"left"},
                {label:"Logísticas",col:null,align:"left"},
                {label:"Facturas",col:null,align:"left"},
                {label:"Cobrado a cta.",col:"cobrado",align:"right"},
                {label:"Saldo",col:"saldo",align:"right"},
                {label:"Antigüedad",col:"dias",align:"left"},
                {label:"",col:null,align:"left"},
              ].map(h=>{
                const activo=sortCC.col===h.col&&h.col;
                const flecha=activo?(sortCC.dir==="asc"?"▲":"▼"):"";
                return(
                  <th key={h.label} onClick={h.col?()=>setSortCC(p=>p.col===h.col?{col:h.col,dir:p.dir==="asc"?"desc":"asc"}:{col:h.col,dir:"desc"}):undefined}
                    style={{padding:"8px 10px",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",
                      color:activo?"#a5b4fc":"#6b7280",textAlign:h.align,borderBottom:"1px solid #1e2535",
                      cursor:h.col?"pointer":"default",userSelect:"none",whiteSpace:"nowrap"}}>
                    {h.label}{flecha&&<span style={{marginLeft:"4px",fontSize:"0.6rem"}}>{flecha}</span>}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {clientesFiltrados.length===0&&(
              <tr><td colSpan={7} style={{padding:"2rem",textAlign:"center",color:"#4b5563"}}>Sin resultados</td></tr>
            )}
            {clientesFiltrados.map((c,i)=>{
              const vencido=c.saldo>0&&c.dias>=c.limite;
              const cercano=c.saldo>0&&c.dias>=(c.limite*0.7)&&c.dias<c.limite;
              return(
                <tr key={c.key} style={{background:vencido?"#1c0a0a":i%2===0?"transparent":"#0d1119",borderBottom:"1px solid #1a1f2e"}}>
                  <td style={{padding:"10px 10px"}}>
                    <div style={{fontWeight:600,fontSize:"0.82rem",color:"#e5e7eb"}}>{c.nombre}</div>
                    <div style={{fontSize:"0.68rem",color:"#4b5563",marginTop:"1px"}}>{c.pendienteCount} pedido{c.pendienteCount!==1?"s":""} pendiente{c.pendienteCount!==1?"s":""}</div>
                  </td>
                  <td style={{padding:"10px 10px"}}>
                    <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>
                      {c.logisticas.map(l=><span key={l} style={{fontSize:"0.65rem",padding:"1px 6px",background:lc[l]?.color+"22",color:lc[l]?.color,borderRadius:"4px",fontWeight:700}}>{l}</span>)}
                    </div>
                  </td>
                  <td style={{padding:"10px 10px"}}>
                    {(()=>{
                      const facts=[...new Set(c.envios.filter(e=>e.nroFactura&&calcPagEnvio&&saldoTolerante(e._deuda?.monto,calcPagEnvio(e.id))>0).map(e=>e.nroFactura))];
                      return facts.length>0
                        ?<div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{facts.map(f=><span key={f} style={{fontSize:"0.68rem",padding:"1px 7px",background:"#130d2a",color:"#c4b5fd",borderRadius:"4px",border:"1px solid #4c1d95",fontWeight:600,fontFamily:"monospace"}}>{f}</span>)}</div>
                        :<span style={{color:"#374151",fontSize:"0.72rem"}}>—</span>;
                    })()}
                  </td>
                  <td style={{padding:"10px 10px",textAlign:"right",color:c.cobradoConSaldo>0?"#10b981":"#4b5563"}}>{c.cobradoConSaldo>0?fmt(c.cobradoConSaldo):"—"}</td>
                  <td style={{padding:"10px 10px",textAlign:"right",fontWeight:800,color:c.saldo===0?"#10b981":vencido?"#ef4444":"#f59e0b"}}>{fmt(c.saldo)}</td>
                  <td style={{padding:"10px 10px"}}>
                    <span style={{fontSize:"0.72rem",padding:"2px 8px",borderRadius:"20px",fontWeight:700,
                      background:vencido?"#7f1d1d":cercano?"#78350f":"#1a1f2e",
                      color:vencido?"#fca5a5":cercano?"#fbbf24":"#6b7280"}}>
                      {c.saldo===0?"—":c.dias+" días"}
                    </span>
                  </td>
                  <td style={{padding:"10px 10px"}}>
                    <div style={{display:"flex",gap:"4px"}}>
                      <button onClick={()=>setVistaCliente(c.key)} style={{...S.btnSm(false,"#6366f1"),fontSize:"0.68rem"}}>Ver</button>
                      {c.saldo>0&&<button onClick={()=>setModalPago({clienteKey:c.key,clienteNombre:c.nombre,saldoPendiente:c.saldo})} style={{...S.btnSm(false,"#10b981"),fontSize:"0.68rem"}}>Cobrar</button>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Modal registro de pago */}
      {modalPago&&<ModalRegistrarPago {...modalPago} onClose={()=>setModalPago(null)} envios={envios.filter(e=>{const deuda=getDeudaEnvio(e);return deuda&&getClienteKey(e)===modalPago.clienteKey;})} pagos={pagos.filter(p=>p.clienteKey===modalPago.clienteKey)} getDeudaEnvio={getDeudaEnvio} sesion={sesion}/>}
    </div>
  );
}

function ModalRegistrarPago({clienteKey,clienteNombre,saldoPendiente,onClose,envios,pagos,getDeudaEnvio,sesion=null}){
  const hoy=new Date().toISOString().slice(0,10);
  const [seleccion,setSeleccion]=useState({});
  const [monto,setMonto]=useState("");
  const [montoManual,setMontoManual]=useState(false);
  const [nota,setNota]=useState("");
  const [fechaCobro,setFechaCobro]=useState(hoy);
  const [guardando,setGuardando]=useState(false);
  const fmt=(n)=>"$"+Math.round(n).toLocaleString("es-AR");

  // Calcular saldo pendiente por envio (descontando pagos ya registrados)
  const saldoEnvio=(e)=>{
    const pagEnvio=pagos.filter(p=>p.envioIds?.includes(e.id)).reduce((s,p)=>{
      // Nuevo formato: monto por envio guardado explicitamente
      if(p.montosPorEnvio) return s+(p.montosPorEnvio[e.id]||0);
      // Pago de un solo envio (formato viejo, compatibilidad)
      if((p.envioIds?.length||0)===1) return s+(p.monto||0);
      // Pago generico con multiples envioIds (formato viejo bugueado): ignorar a nivel individual
      return s;
    },0);
    return saldoTolerante(getDeudaEnvio(e)?.monto,pagEnvio);
  };

  const toggleEnvio=(id,importe)=>{
    const next={...seleccion};
    if(next[id])delete next[id];
    else next[id]=importe;
    setSeleccion(next);
    if(!montoManual){
      const total=Object.values(next).reduce((s,v)=>s+v,0);
      setMonto(total>0?String(total):"");
    }
  };

  const montoSeleccionado=Object.values(seleccion).reduce((s,v)=>s+v,0);
  const haySeleccion=Object.keys(seleccion).length>0;

  const guardar=async()=>{
    const m=parseFloat(monto);
    if(!m||m<=0){alert("Ingresa un monto valido.");return;}
    setGuardando(true);
    // Construir montosPorEnvio: distribuir el monto ingresado respetando el saldo de cada envio seleccionado
    let montosPorEnvio=null;
    let enviosIds=[];
    if(haySeleccion){
      enviosIds=Object.keys(seleccion);
      // Distribuir: llenar cada envio en orden hasta agotar el monto
      let restante=m;
      montosPorEnvio={};
      for(const id of enviosIds){
        const cap=seleccion[id];
        const asignado=Math.min(cap,restante);
        montosPorEnvio[id]=asignado;
        restante-=asignado;
        if(restante<=0)break;
      }
    }
    try{
      const auditCC=mkAudit(sesion);
      await addDoc(collection(db,"pagosCC"),{
        clienteKey,clienteNombre,monto:m,nota:nota.trim(),
        envioIds:enviosIds,
        ...(montosPorEnvio?{montosPorEnvio}:{}),
        fechaCobro,
        creadoEn:serverTimestamp(),
        ...(auditCC?{registradoPor:auditCC}:{}),
      });
      onClose();
    }catch(err){console.error(err);alert("Error al guardar el pago.");}
    setGuardando(false);
  };

  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:3000,display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}>
      <div style={{background:"#12172a",border:"1px solid #10b981",borderRadius:"16px",padding:"1.5rem",minWidth:"380px",maxWidth:"520px",width:"100%",maxHeight:"90vh",overflowY:"auto"}}>
        <div style={{fontWeight:800,fontSize:"0.95rem",color:"#e5e7eb",marginBottom:"4px"}}>Registrar pago</div>
        <div style={{fontSize:"0.75rem",color:"#6b7280",marginBottom:"1rem"}}>{clienteNombre} · Saldo pendiente: <strong style={{color:"#f59e0b"}}>{fmt(saldoPendiente)}</strong></div>

        {/* Seleccion de pedidos */}
        <div style={{marginBottom:"1rem"}}>
          <label style={{display:"block",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",color:"#6b7280",marginBottom:"6px"}}>Pedidos a cancelar</label>
          <div style={{display:"flex",flexDirection:"column",gap:"4px"}}>
            {envios.map(e=>{
              const sl=saldoEnvio(e);
              if(sl<=0)return null;
              const sel=!!seleccion[e.id];
              return(
                <div key={e.id} onClick={()=>toggleEnvio(e.id,sl)} style={{display:"flex",alignItems:"center",gap:"8px",padding:"7px 10px",borderRadius:"8px",border:"1px solid "+(sel?"#10b981":"#1e2535"),background:sel?"#041f14":"#0d1119",cursor:"pointer"}}>
                  <div style={{width:"14px",height:"14px",borderRadius:"3px",border:"2px solid "+(sel?"#10b981":"#4b5563"),background:sel?"#10b981":"transparent",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
                    {sel&&<span style={{color:"#fff",fontSize:"9px",fontWeight:900}}>✓</span>}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:"0.78rem",color:"#d1d5db",fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.direccion?.slice(0,45)}</div>
                    <div style={{fontSize:"0.65rem",color:"#4b5563",marginTop:"1px"}}>
                      {e.nroOrdenTN?"#"+e.nroOrdenTN:e.id.slice(-8)}
                      {e.fechaVenta&&" · "+fmtCorta(e.fechaVenta)}
                    </div>
                  </div>
                  <div style={{fontWeight:700,color:sel?"#10b981":"#f59e0b",fontSize:"0.82rem",flexShrink:0}}>{fmt(sl)}</div>
                </div>
              );
            })}
          </div>
          {haySeleccion&&<div style={{fontSize:"0.7rem",color:"#10b981",marginTop:"5px",textAlign:"right"}}>Seleccionado: {fmt(montoSeleccionado)}</div>}
          {!haySeleccion&&<div style={{fontSize:"0.68rem",color:"#f59e0b",marginTop:"4px"}}>⚠ Sin seleccion — el pago se registra solo a nivel cliente, no descuenta deuda de pedidos individuales</div>}
        </div>

        {/* Monto */}
        <div style={{marginBottom:"0.75rem"}}>
          <label style={{display:"block",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",color:"#6b7280",marginBottom:"4px"}}>Monto cobrado</label>
          <div style={{display:"flex",gap:"6px",alignItems:"center"}}>
            <input type="number" value={monto} onChange={e=>{setMonto(e.target.value);setMontoManual(true);}} placeholder="0" style={{...S.input,flex:1}}/>
            <button onClick={()=>{setMonto(String(haySeleccion?montoSeleccionado:saldoPendiente));setMontoManual(false);}} style={{...S.btnSm(false,"#10b981"),whiteSpace:"nowrap",fontSize:"0.7rem"}}>Total</button>
          </div>
        </div>

        {/* Fecha cobro */}
        <div style={{marginBottom:"0.75rem"}}>
          <label style={{display:"block",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",color:"#6b7280",marginBottom:"4px"}}>Fecha del cobro</label>
          <input type="date" value={fechaCobro} onChange={e=>setFechaCobro(e.target.value)} style={{...S.input,width:"100%"}}/>
        </div>

        {/* Nota */}
        <div style={{marginBottom:"1rem"}}>
          <label style={{display:"block",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",color:"#6b7280",marginBottom:"4px"}}>Nota (opcional)</label>
          <input value={nota} onChange={e=>setNota(e.target.value)} placeholder="ej. Transferencia, efectivo..." style={{...S.input,width:"100%"}}/>
        </div>

        <div style={{display:"flex",justifyContent:"flex-end",gap:"0.5rem"}}>
          <button onClick={onClose} style={S.btn(false)}>Cancelar</button>
          <button onClick={guardar} disabled={guardando||!monto} style={{...S.btn(true),background:"linear-gradient(135deg,#10b981,#059669)",opacity:guardando||!monto?0.5:1}}>
            {guardando?"Guardando...":"Guardar pago"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TabLocalidades({cpExtra,setCpExtra}) {
  const tabla={...CP_P_INIT,...cpExtra};
  const [busqueda, setBusqueda] = useState("");
  const [editCP, setEditCP] = useState(null);
  const [editVal, setEditVal] = useState("");
  const [newCP, setNewCP] = useState("");
  const [newPartido, setNewPartido] = useState("");
  const [toast, setToast] = useState("");

  const mostrarToast = msg => { setToast(msg); setTimeout(() => setToast(""), 2000); };
  const partidos = [...new Set(Object.values(tabla))].sort();
  const filas = Object.entries(tabla)
    .filter(([cp, p]) => {
      if (!busqueda) return true;
      const srch = norm(busqueda);
      return cp.includes(srch) || norm(p).includes(srch);
    })
    .sort(([a], [b]) => parseInt(a) - parseInt(b));

  const guardar = (cp, partido) => {
    const nuevaExtra={...cpExtra};
    if(!CP_P_INIT[cp]||CP_P_INIT[cp]!==partido) nuevaExtra[cp]=partido;
    else delete nuevaExtra[cp];
    setDoc(doc(db,"config","cp_extra"),nuevaExtra).catch(console.error);
    setCpExtra(nuevaExtra);
    CP_P[cp]=partido;
    setEditCP(null);
    mostrarToast("Guardado en Firebase ✓");
  };

  const eliminar = (cp) => {
    if (!window.confirm("Eliminar CP " + cp + "?")) return;
    const nuevaExtra={...cpExtra};
    delete nuevaExtra[cp];
    setDoc(doc(db,"config","cp_extra"),nuevaExtra).catch(console.error);
    setCpExtra(nuevaExtra);
    if(CP_P_INIT[cp]) CP_P[cp]=CP_P_INIT[cp]; else delete CP_P[cp];
    mostrarToast("Eliminado");
  };

  const agregar = () => {
    if (!newCP.trim() || !newPartido.trim()) return;
    guardar(newCP.trim(), newPartido.trim());
    setNewCP(""); setNewPartido("");
  };

  return (
    <div style={{ maxWidth: "700px" }}>
      {toast && <div style={{ ...S.card, padding: "0.5rem 1rem", marginBottom: "0.75rem", background: "#041f14", border: "1px solid #10b981", color: "#34d399", fontSize: "0.82rem" }}>{toast}</div>}
      <div style={{ ...S.card, padding: "0.75rem 1rem", marginBottom: "0.9rem" }}>
        <div style={{ color: "#6b7280", fontSize: "0.72rem", marginBottom: "0.5rem" }}>
          La app detecta el partido automaticamente a partir del codigo postal. Si hay un CP que no esta o esta mal asignado, lo podes corregir aca.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "100px 1fr auto", gap: "0.5rem", alignItems: "center" }}>
          <input value={newCP} onChange={e => setNewCP(e.target.value)} style={{ ...S.input, width: "100%" }} placeholder="CP (ej. 1900)" />
          <input value={newPartido} onChange={e => setNewPartido(e.target.value)} style={{ ...S.input, width: "100%" }} placeholder="Partido (ej. La Plata)" list="partidos-list" />
          <datalist id="partidos-list">{partidos.map(p => <option key={p} value={p} />)}</datalist>
          <button onClick={agregar} style={{ ...S.btn(true), background: "linear-gradient(135deg,#6366f1,#8b5cf6)", whiteSpace: "nowrap" }}>+ Agregar</button>
        </div>
      </div>

      <div style={{ ...S.card, padding: "0.65rem 1rem", marginBottom: "0.75rem" }}>
        <input value={busqueda} onChange={e => setBusqueda(e.target.value)} placeholder="Buscar por CP o partido..." style={{ ...S.input, width: "100%" }} />
      </div>

      <div style={{ ...S.card, overflow: "auto" }}>
        <div style={{ padding: "0.5rem 1rem", borderBottom: "1px solid #252d40", display: "flex", gap: "0", color: "#6b7280", fontSize: "0.65rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
          <span style={{ width: "90px" }}>CP</span>
          <span style={{ flex: 1 }}>Partido</span>
          <span style={{ width: "80px" }}>Zona ML</span>
          <span style={{ width: "80px" }}></span>
        </div>
        {filas.map(([cp, partido], i) => {
          const esCustom = CP_P_INIT[cp] !== partido || !CP_P_INIT[cp];
          const zml = getZonaML(partido);
          const isEdit = editCP === cp;
          return (
            <div key={cp} style={{ padding: "0.45rem 1rem", borderBottom: i < filas.length - 1 ? "1px solid #1a1f2e" : "none", display: "flex", alignItems: "center", gap: "0", background: esCustom ? "#0d1119" : "transparent" }}>
              <span style={{ width: "90px", fontFamily: "monospace", color: "#9ca3af", fontSize: "0.82rem" }}>
                {cp}
                {esCustom && <span style={{ marginLeft: "4px", background: "#1c1500", color: "#f59e0b", borderRadius: "4px", padding: "0 4px", fontSize: "0.6rem", fontWeight: 700 }}>CUSTOM</span>}
              </span>
              {isEdit ? (
                <input autoFocus value={editVal} onChange={e => setEditVal(e.target.value)} onKeyDown={e => { if (e.key === "Enter") guardar(cp, editVal); if (e.key === "Escape") setEditCP(null); }} style={{ ...S.input, flex: 1, padding: "3px 8px", fontSize: "0.82rem" }} list="partidos-list" />
              ) : (
                <span style={{ flex: 1, color: "#e5e7eb", fontSize: "0.82rem" }}>{partido}</span>
              )}
              <span style={{ width: "80px" }}>
                {zml && <span style={{ background: ZONA_ML_BG[zml] || "#1a1f2e", color: ZONA_ML_COLOR[zml] || "#6b7280", borderRadius: "5px", padding: "1px 7px", fontSize: "0.68rem", fontWeight: 700 }}>{zml}</span>}
              </span>
              <div style={{ width: "80px", display: "flex", gap: "4px", justifyContent: "flex-end" }}>
                {isEdit ? (
                  <>
                    <button onClick={() => guardar(cp, editVal)} style={{ ...S.btnSm(true, "#6366f1"), padding: "2px 8px" }}>OK</button>
                    <button onClick={() => setEditCP(null)} style={{ ...S.btnSm(false), padding: "2px 6px" }}>x</button>
                  </>
                ) : (
                  <>
                    <button onClick={() => { setEditCP(cp); setEditVal(partido); }} style={{ ...S.btnSm(false), padding: "2px 7px", fontSize: "0.68rem", color: "#6b7280" }}>editar</button>
                    {esCustom && <button onClick={() => eliminar(cp)} style={{ ...S.btnSm(false), padding: "2px 6px", fontSize: "0.68rem", color: "#f87171" }}>x</button>}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ color: "#374151", fontSize: "0.72rem", marginTop: "0.75rem", textAlign: "right" }}>{filas.length} registros · CABA = CPs 1000–1499</div>
    </div>
  );
}


// ════════════════════════════════════════════════════════════════════
// PANTALLA ASIGNACION TN — agrupa por fecha+turno, pre-rellena fecha/turno
// ════════════════════════════════════════════════════════════════════
function PantallaAsignacionTN({borrador,onConfirmar,onCancelar,lc,sesion=null}){
  const logActivas=Object.entries(lc).filter(([,v])=>v.activa).map(([k])=>k);
  // Pre-inicializar asig con fecha y turno del datepicker
  const initAsig=()=>{const a={};borrador.forEach(e=>{a[e.id]={trans:"",fecha:e.fecha||fechaHoy(),turno:e.turno||""};});return a;};
  const [asig,setAsig]=useState(initAsig);
  const getA=id=>asig[id]||{trans:"",fecha:fechaHoy(),turno:""};
  const setA=(id,k,v)=>setAsig(p=>({...p,[id]:{...getA(id),[k]:v}}));
  const setGrupo=(ids,k,v)=>setAsig(p=>{const n={...p};ids.forEach(id=>{n[id]={...getA(id),[k]:v}});return n;});
  const getGrupo=(ids,k)=>{const vals=[...new Set(ids.map(id=>getA(id)[k]||""))];return vals.length===1?vals[0]:"";};

  // Agrupar por fecha + turno
  const grupos={};
  borrador.forEach(e=>{
    const a=getA(e.id);
    const key=(e.fecha||"Sin fecha")+"|"+(e.turno||"Sin turno");
    if(!grupos[key])grupos[key]={fecha:e.fecha||"",turno:e.turno||"",envios:[]};
    grupos[key].envios.push(e);
  });
  const grupoKeys=Object.keys(grupos).sort();
  const totalAsig=borrador.filter(e=>getA(e.id).trans).length;
  // Bloquea confirmar si algún pedido quedó con logística asignada pero sin turno
  const incompletosTN=borrador.filter(e=>{const a=getA(e.id);return a.trans&&!a.turno;});
  const puedeConfirmarTN=incompletosTN.length===0;
  const [confirmando,setConfirmando]=useState(false);
  const auditTN=mkAudit(sesion);
  const confirmar=()=>{if(confirmando||!puedeConfirmarTN)return;setConfirmando(true);onConfirmar(borrador.map(e=>({...e,...getA(e.id),estado:getA(e.id).trans?"asignado":"sin_asignar",...(getA(e.id).trans&&auditTN?{asignadoPor:auditTN}:{})})));};
  const btnConfirmarTN=(padding="")=>(
    <button onClick={confirmar} disabled={confirmando||!puedeConfirmarTN} style={{...S.btn(true),background:confirmando?"#0a1520":"#0d1c2e",border:"1px solid #38bdf8",color:confirmando?"#4b5563":"#38bdf8",...(padding?{padding}:{}),display:"flex",alignItems:"center",gap:"6px",opacity:(confirmando||!puedeConfirmarTN)?0.7:1}}>
      {confirmando&&<span style={{width:"10px",height:"10px",border:"2px solid #38bdf8",borderTopColor:"transparent",borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite"}}/>}
      {confirmando?`Guardando ${borrador.length} envíos...`:`Confirmar (${totalAsig}/${borrador.length})`}
      {!puedeConfirmarTN&&!confirmando&&<span style={{fontSize:"0.68rem",marginLeft:"5px",color:"#f59e0b"}}>⚠ {incompletosTN.length}</span>}
    </button>
  );

  return(
    <div style={{minHeight:"100vh",background:"#0a0e1a",color:"#fff",fontFamily:"sans-serif"}}>
      <style>{`*{box-sizing:border-box;}`}</style>
      <div style={{position:"sticky",top:0,zIndex:100,background:"#0f1420",borderBottom:"1px solid #1a1f2e",padding:"0.75rem 1rem",display:"flex",alignItems:"center",gap:"0.75rem",flexWrap:"wrap"}}>
        <div style={{width:"28px",height:"28px",background:"#0d1c2e",border:"1px solid #38bdf8",borderRadius:"7px",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"0.85rem"}}>TN</div>
        <div><div style={{fontWeight:800,fontSize:"0.95rem"}}>Asignar pedidos Tienda Nube</div><div style={{color:"#4b5563",fontSize:"0.62rem"}}>{borrador.length} pedidos sin asignar · agrupados por fecha y turno</div></div>
        <div style={{marginLeft:"auto",display:"flex",gap:"0.5rem",alignItems:"center"}}>
          <span style={{color:totalAsig===borrador.length?"#10b981":"#f59e0b",fontSize:"0.82rem",fontWeight:700}}>{totalAsig}/{borrador.length}</span>
          <button onClick={onCancelar} style={S.btn(false)}>Cancelar</button>
          {btnConfirmarTN()}
        </div>
      </div>
      <div style={{padding:"1rem",maxWidth:"980px",margin:"0 auto"}}>
        {incompletosTN.length>0&&(
          <div style={{background:"#1c0a00",border:"1px solid #92400e",borderRadius:"8px",padding:"8px 14px",marginBottom:"0.75rem",display:"flex",alignItems:"center",gap:"8px",flexWrap:"wrap"}}>
            <span style={{color:"#fbbf24",fontSize:"0.78rem",fontWeight:700}}>⚠ {incompletosTN.length} envío{incompletosTN.length>1?"s":""} con logística asignada pero sin turno</span>
            <span style={{color:"#78350f",fontSize:"0.72rem"}}>Asigná el turno antes de confirmar — no se puede dejar un pedido asignado sin turno</span>
          </div>
        )}
        {grupoKeys.map(key=>{
          const grupo=grupos[key];
          const ids=grupo.envios.map(e=>e.id);
          const idsPagados=grupo.envios.filter(e=>puedeAsignar(e)).map(e=>e.id);
          const gT=getGrupo(ids,"trans");
          const gTu=getGrupo(ids,"turno");
          const turnoC=TURNO_C[grupo.turno]||{c:"#6b7280",bg:"#1a1f2e"};
          const asigCount=ids.filter(id=>getA(id).trans).length;
          return(
            <div key={key} style={{...S.card,marginBottom:"0.75rem",overflow:"hidden"}}>
              <div style={{padding:"0.6rem 1rem",background:"#12172a",borderBottom:"1px solid #1e2535"}}>
                <div style={{display:"flex",alignItems:"center",gap:"0.5rem",marginBottom:"0.5rem",flexWrap:"wrap"}}>
                  {grupo.fecha&&<span style={{background:"#0c1a2e",color:"#60a5fa",padding:"2px 10px",borderRadius:"5px",fontWeight:700,fontSize:"0.8rem"}}>{fmtCorta(grupo.fecha)}</span>}
                  {grupo.turno&&<span style={{background:turnoC.bg,color:turnoC.c,padding:"2px 10px",borderRadius:"5px",fontWeight:700,fontSize:"0.8rem",border:"1px solid "+turnoC.c}}>{grupo.turno}</span>}
                  <span style={{color:"#4b5563",fontSize:"0.72rem"}}>{grupo.envios.length} pedidos</span>
                  <span style={{color:asigCount===grupo.envios.length?"#10b981":"#4b5563",fontSize:"0.7rem",marginLeft:"auto"}}>{asigCount}/{grupo.envios.length}</span>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:"0.5rem",flexWrap:"wrap",marginBottom:"0.4rem"}}>
                  <span style={{color:"#6b7280",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase"}}>Logistica:</span>
                  {logActivas.map(l =><button key={l} onClick={()=>setGrupo(idsPagados,"trans",gT===l?"":l)} style={S.btnSm(gT===l,lc[l]?.color||"#6366f1")} disabled={idsPagados.length===0}>{l}</button>)}
                  {gT&&<button onClick={()=>setGrupo(idsPagados,"trans","")} style={{...S.btnSm(false),color:"#6b7280"}}>x</button>}
                </div>
                <div style={{display:"flex",alignItems:"center",gap:"0.5rem",flexWrap:"wrap"}}>
                  <span style={{color:"#6b7280",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase"}}>Turno:</span>
                  {TURNOS.map(t =><button key={t} onClick={()=>setGrupo(idsPagados,"turno",gTu===t?"":t)} style={S.btnSm(gTu===t,"#8b5cf6")} disabled={idsPagados.length===0}>{t}</button>)}
                  {gTu&&<button onClick={()=>setGrupo(idsPagados,"turno","")} style={{...S.btnSm(false),color:"#6b7280"}}>x</button>}
                </div>
              </div>
              {grupo.envios.map((e,i)=>{
                const a=getA(e.id);
                const zml=getZonaML(e.partido);
                const incompletoTN=a.trans&&!a.turno;
                return(
                  <div key={e.id} style={{padding:"0.45rem 1rem",borderBottom:i<grupo.envios.length-1?"1px solid #1a1f2e":"none",display:"flex",alignItems:"center",gap:"0.75rem",flexWrap:"wrap",opacity:!puedeAsignar(e)?0.5:1,background:incompletoTN?"#1c0a00":undefined,borderLeft:incompletoTN?"3px solid #f59e0b":"3px solid transparent"}}>
                    <div style={{flex:1,minWidth:"180px"}}>
                      <div style={{display:"flex",gap:"6px",alignItems:"baseline"}}>
                        <span style={{color:"#7dd3fc",fontWeight:700,fontSize:"0.75rem"}}>#{e.nroOrdenTN}</span>
                        {e.clienteNombre&&<span style={{color:"#e5e7eb",fontSize:"0.78rem",fontWeight:600}}>{e.clienteNombre}</span>}
                        {!puedeAsignar(e)&&<span style={{color:"#fb923c",fontSize:"0.65rem",fontWeight:700}}>⚠ Pago pendiente</span>}
                      </div>
                      <div style={{color:"#9ca3af",fontSize:"0.72rem"}}>{e.direccion}</div>
                      <div style={{color:"#4b5563",fontSize:"0.68rem"}}>{e.localidad?e.localidad+" · ":""}{e.partido}{zml?" · "+zml:""}</div>
                    </div>
                    <div style={{display:"flex",gap:"3px",flexWrap:"wrap",alignItems:"center"}}>
                      {logActivas.map(l =><button key={l} onClick={()=>setA(e.id,"trans",a.trans===l?"":l)} style={S.btnSm(a.trans===l,lc[l].color)} disabled={!puedeAsignar(e)}>{l}</button>)}
                      <span style={{color:"#252d40",padding:"0 2px"}}>|</span>
                      {TURNOS.map(t =><button key={t} onClick={()=>setA(e.id,"turno",a.turno===t?"":t)} style={S.btnSm(a.turno===t,"#8b5cf6")} disabled={!puedeAsignar(e)}>{t}</button>)}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
        <div style={{display:"flex",justifyContent:"flex-end",gap:"0.75rem",marginTop:"1rem",paddingBottom:"2rem"}}>
          <button onClick={onCancelar} style={S.btn(false)}>Cancelar</button>
          {btnConfirmarTN("0.55rem 1.4rem")}
        </div>
      </div>
    </div>
  );
}


// ════════════════════════════════════════════════════════════════════
// TAB USUARIOS — solo admin
// ════════════════════════════════════════════════════════════════════
function TabUsuarios({lc,configExpedicion={},setConfigExpedicion=()=>{}}){
  const [usuarios,setUsuarios]=useState([]);
  const [loading,setLoading]=useState(true);
  const [form,setForm]=useState({usuario:"",password:"",rol:"colaborador",logistica:"",armadorId:"",esChofer:false,activo:true});
  const [editId,setEditId]=useState(null);
  const [toast,setToast]=useState("");
  const [permsOpenId,setPermsOpenId]=useState(null);
  const [tooltipKey,setTooltipKey]=useState(null);
  const [nuevoArmador,setNuevoArmador]=useState("");
  const armadoresConfig=configExpedicion.armadores||[];
  const impresionHabilitada=configExpedicion.impresionHabilitada||false;

  const agregarArmador=()=>{
    const nombre=nuevoArmador.trim();
    if(!nombre)return;
    if(armadoresConfig.some(a=>a.nombre.toLowerCase()===nombre.toLowerCase())){mostrarToast("Ya existe un armador con ese nombre");return;}
    const id="arm_"+Date.now();
    const color=ARM_COLORS[armadoresConfig.length%ARM_COLORS.length];
    setConfigExpedicion(p=>({...p,armadores:[...(p.armadores||[]),{id,nombre,color}]}));
    setNuevoArmador("");
  };
  const logActivas=Object.keys(lc).filter(k=>lc[k].activa);

  const mostrarToast=msg=>{setToast(msg);setTimeout(()=>setToast(""),2500);};

  useEffect(()=>{
    const unsub=onSnapshot(collection(db,"usuarios"),snap=>{
      setUsuarios(snap.docs.map(d=>({id:d.id,...d.data()})));
      setLoading(false);
    });
    return()=>unsub();
  },[]);

  const guardar=async()=>{
    if(!form.usuario||!form.password){mostrarToast("Completá usuario y contraseña");return;}
    if(form.rol==="logistica"&&!form.logistica){mostrarToast("Selecciona la logistica para este usuario");return;}
    if(form.rol==="armador"&&!form.armadorId){mostrarToast("Selecciona el armador para este usuario");return;}
    const id=editId||("usr_"+Date.now());
    await setDoc(doc(db,"usuarios",id),{...form,usuario:form.usuario.toLowerCase().trim()});
    setForm({usuario:"",password:"",rol:"colaborador",logistica:"",armadorId:"",esChofer:false,activo:true});
    setEditId(null);
    mostrarToast(editId?"Usuario actualizado":"Usuario creado");
  };

  const toggleActivo=async(u)=>{
    await setDoc(doc(db,"usuarios",u.id),{...u,activo:!u.activo});
  };

  const editar=u=>{setForm({usuario:u.usuario,password:u.password,rol:u.rol,logistica:u.logistica||"",armadorId:u.armadorId||"",esChofer:u.esChofer||false,activo:u.activo});setEditId(u.id);};

  const togglePerm=async(u,featureKey)=>{
    const actual=(u.permisos||{})[featureKey];
    const nuevoVal=actual===false?true:false; // si era false → true; si era undefined/true → false
    const nuevosPermisos={...(u.permisos||{}),[featureKey]:nuevoVal};
    setUsuarios(prev=>prev.map(x=>x.id===u.id?{...x,permisos:nuevosPermisos}:x));
    await setDoc(doc(db,"usuarios",u.id),{permisos:nuevosPermisos},{merge:true});
  };

  // Habilita/deshabilita que un armador puntual pueda pasar a modo Salida (despacho) sin re-loguearse.
  // Default-deny: a diferencia de "permisos" (colaborador), acá lo que falta significa NO habilitado.
  const toggleSalidaArmador=async(u)=>{
    const nuevo=!u.puedeSalida;
    setUsuarios(prev=>prev.map(x=>x.id===u.id?{...x,puedeSalida:nuevo}:x));
    await setDoc(doc(db,"usuarios",u.id),{puedeSalida:nuevo},{merge:true});
  };

  const ROL_C={admin:{label:"Admin",color:"#6366f1"},colaborador:{label:"Colaborador",color:"#10b981"},logistica:{label:"Logistica",color:"#8b5cf6"},expedicion:{label:"Expedicion",color:"#f59e0b"},armador:{label:"Armador",color:"#06b6d4"}};

  // Componente inline para el panel de permisos de un colaborador
  const PanelPermisos=({u})=>{
    const perms=u.permisos||{};
    const grupos=[
      {id:"tabs",   label:"Vistas (Tabs)",  color:"#6366f1"},
      {id:"acciones",label:"Acciones",       color:"#10b981"},
    ];
    return(
      <div style={{background:"#0d1221",borderTop:"1px solid #252d40",padding:"1rem"}}>
        <div style={{fontSize:"0.72rem",fontWeight:700,color:"#9ca3af",marginBottom:"0.75rem",textTransform:"uppercase",letterSpacing:"0.06em"}}>
          Permisos de <span style={{color:"#e5e7eb"}}>{u.usuario}</span>
          <span style={{color:"#4b5563",fontWeight:400,marginLeft:"8px"}}>— por defecto todos habilitados; desactivá los que no apliquen</span>
        </div>
        {grupos.map(g=>{
          const feats=FEATURES.filter(f=>f.grupo===g.id);
          return(
            <div key={g.id} style={{marginBottom:"0.85rem"}}>
              <div style={{color:g.color,fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:"6px",paddingBottom:"4px",borderBottom:"1px solid #1a1f2e"}}>{g.label}</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:"4px"}}>
                {feats.map(f=>{
                  const habilitado=perms[f.key]!==false;
                  const ttId=u.id+"_"+f.key;
                  return(
                    <div key={f.key} style={{display:"flex",alignItems:"center",gap:"8px",padding:"5px 8px",borderRadius:"6px",background:habilitado?"#0f1a10":"#1c0a0a",border:"1px solid "+(habilitado?"#1a3a1a":"#3a1a1a"),cursor:"pointer",userSelect:"none"}}
                      onClick={()=>togglePerm(u,f.key)}>
                      {/* Toggle visual */}
                      <div style={{width:"32px",height:"18px",borderRadius:"9px",background:habilitado?"#10b981":"#374151",position:"relative",flexShrink:0,transition:"background 0.2s"}}>
                        <div style={{position:"absolute",top:"2px",left:habilitado?"14px":"2px",width:"14px",height:"14px",borderRadius:"50%",background:"#fff",transition:"left 0.2s"}}/>
                      </div>
                      <span style={{color:habilitado?"#d1fae5":"#6b7280",fontSize:"0.78rem",fontWeight:habilitado?600:400,flex:1}}>{f.label}</span>
                      {/* Tooltip button */}
                      <div style={{position:"relative",flexShrink:0}}
                        onMouseEnter={e=>{e.stopPropagation();setTooltipKey(ttId);}}
                        onMouseLeave={()=>setTooltipKey(null)}
                        onClick={e=>e.stopPropagation()}>
                        <span style={{color:"#4b5563",fontSize:"0.72rem",cursor:"default",padding:"0 3px"}}>ℹ</span>
                        {tooltipKey===ttId&&(
                          <div style={{position:"absolute",bottom:"calc(100% + 6px)",right:0,background:"#1a1f2e",border:"1px solid #374151",borderRadius:"8px",padding:"7px 10px",width:"230px",fontSize:"0.72rem",color:"#d1d5db",lineHeight:1.4,zIndex:200,pointerEvents:"none",boxShadow:"0 4px 16px rgba(0,0,0,0.6)"}}>
                            {f.desc}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        <div style={{display:"flex",gap:"8px",marginTop:"4px"}}>
          <button onClick={async()=>{
            const todo={};FEATURES.forEach(f=>{todo[f.key]=true;});
            setUsuarios(prev=>prev.map(x=>x.id===u.id?{...x,permisos:todo}:x));
            await setDoc(doc(db,"usuarios",u.id),{permisos:todo},{merge:true});
          }} style={{...S.btnSm(false),color:"#10b981",borderColor:"#065f46",fontSize:"0.7rem"}}>Habilitar todo</button>
          <button onClick={async()=>{
            const nada={};FEATURES.forEach(f=>{nada[f.key]=false;});
            setUsuarios(prev=>prev.map(x=>x.id===u.id?{...x,permisos:nada}:x));
            await setDoc(doc(db,"usuarios",u.id),{permisos:nada},{merge:true});
          }} style={{...S.btnSm(false),color:"#f87171",borderColor:"#7f1d1d",fontSize:"0.7rem"}}>Deshabilitar todo</button>
        </div>
      </div>
    );
  };

  if(loading)return<div style={{textAlign:"center",padding:"2rem",color:"#4b5563"}}>Cargando...</div>;

  return(
    <div>
      {toast&&<div style={{position:"fixed",top:"16px",right:"16px",zIndex:999,background:"#041f14",border:"1px solid #10b981",borderRadius:"10px",padding:"0.6rem 1.1rem",color:"#34d399",fontWeight:700,fontSize:"0.82rem"}}>{toast}</div>}

      {/* Formulario nuevo/editar */}
      <div style={{...S.card,padding:"1.1rem",marginBottom:"1rem"}}>
        <div style={{fontWeight:700,fontSize:"0.9rem",marginBottom:"0.85rem",color:"#e5e7eb"}}>{editId?"Editar usuario":"Nuevo usuario"}</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:"0.65rem",marginBottom:"0.75rem"}}>
          <div>
            <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>Usuario</div>
            <input value={form.usuario} onChange={e=>setForm(p=>({...p,usuario:e.target.value}))} placeholder="nombre.usuario" style={{...S.input,width:"100%"}}/>
          </div>
          <div>
            <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>Contraseña</div>
            <input value={form.password} onChange={e=>setForm(p=>({...p,password:e.target.value}))} placeholder="contraseña" style={{...S.input,width:"100%"}}/>
          </div>
          <div>
            <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>Rol</div>
            <select value={form.rol} onChange={e=>setForm(p=>({...p,rol:e.target.value,logistica:"",armadorId:""}))} style={{...S.input,width:"100%"}}>
              <option value="admin">Administrador</option>
              <option value="colaborador">Colaborador</option>
              <option value="logistica">Logistica</option>
              <option value="expedicion">Expedicion</option>
              <option value="armador">Armador</option>
            </select>
          </div>
          {form.rol==="logistica"&&<div>
            <div style={{display:"flex",alignItems:"center",gap:"8px",marginBottom:"6px"}}>
              <input type="checkbox" id="esChofer" checked={form.esChofer||false} onChange={ev=>setForm(p=>({...p,esChofer:ev.target.checked}))} style={{width:"16px",height:"16px",cursor:"pointer"}}/>
              <label htmlFor="esChofer" style={{color:"#9ca3af",fontSize:"0.78rem",cursor:"pointer"}}>Vista Chofer (app móvil simplificada para el repartidor)</label>
            </div>
            <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>Logistica asignada</div>
            <select value={form.logistica} onChange={e=>setForm(p=>({...p,logistica:e.target.value}))} style={{...S.input,width:"100%"}}>
              <option value="">Elegir...</option>
              {logActivas.map(l=><option key={l} value={l}>{l}</option>)}
            </select>
          </div>}
          {form.rol==="armador"&&<div>
            <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>Armador vinculado</div>
            <select value={form.armadorId} onChange={e=>setForm(p=>({...p,armadorId:e.target.value}))} style={{...S.input,width:"100%"}}>
              <option value="">Elegir...</option>
              {armadoresConfig.map(a=><option key={a.id} value={a.id}>{a.nombre}</option>)}
            </select>
            {armadoresConfig.length===0&&<div style={{color:"#f59e0b",fontSize:"0.7rem",marginTop:"4px"}}>No hay armadores configurados todavía — agregá uno en la sección Expedición más abajo.</div>}
          </div>}
        </div>
        <div style={{display:"flex",gap:"0.5rem"}}>
          <button onClick={guardar} style={{...S.btn(true),background:"linear-gradient(135deg,#6366f1,#8b5cf6)"}}>{editId?"Guardar cambios":"Crear usuario"}</button>
          {editId&&<button onClick={()=>{setEditId(null);setForm({usuario:"",password:"",rol:"colaborador",logistica:"",armadorId:"",esChofer:false,activo:true});}} style={S.btn(false)}>Cancelar</button>}
        </div>
      </div>

      {/* Lista usuarios */}
      <div style={{...S.card,padding:0,overflow:"hidden"}}>
        <div style={{padding:"0.75rem 1rem",background:"#12172a",borderBottom:"1px solid #252d40",fontSize:"0.72rem",fontWeight:700,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.06em"}}>Usuarios del sistema</div>
        {usuarios.length===0&&<div style={{padding:"2rem",textAlign:"center",color:"#4b5563"}}>No hay usuarios creados</div>}
        {usuarios.map(u=>{
          const rc=ROL_C[u.rol]||ROL_C.colaborador;
          const permsOpen=permsOpenId===u.id;
          return(
            <div key={u.id} style={{borderBottom:"1px solid #1a1f2e",opacity:u.activo?1:0.55}}>
              {/* Fila principal del usuario */}
              <div style={{padding:"0.75rem 1rem",display:"flex",alignItems:"center",gap:"0.75rem",flexWrap:"wrap"}}>
                <div style={{flex:1,minWidth:"120px"}}>
                  <div style={{display:"flex",alignItems:"center",gap:"8px",flexWrap:"wrap"}}>
                    <span style={{color:"#e5e7eb",fontWeight:600,fontSize:"0.88rem"}}>{u.usuario}</span>
                    <span style={{padding:"1px 8px",background:rc.color+"22",color:rc.color,borderRadius:"5px",fontSize:"0.65rem",fontWeight:700}}>{rc.label}</span>
                    {u.rol==="logistica"&&u.logistica&&<span style={{padding:"1px 8px",background:lc[u.logistica]?.bg||"#1a1f2e",color:lc[u.logistica]?.color||"#6b7280",borderRadius:"5px",fontSize:"0.65rem",fontWeight:700}}>{u.logistica}</span>}
                    {u.rol==="armador"&&<span style={{padding:"1px 8px",background:"#0c2a30",color:armadoresConfig.find(a=>a.id===u.armadorId)?.color||"#06b6d4",borderRadius:"5px",fontSize:"0.65rem",fontWeight:700}}>{armadoresConfig.find(a=>a.id===u.armadorId)?.nombre||"⚠ armador no encontrado"}</span>}
                    {u.rol==="armador"&&u.puedeSalida&&<span style={{padding:"1px 8px",background:"#1a0f2e",color:"#a78bfa",borderRadius:"5px",fontSize:"0.65rem",fontWeight:700}}>🚚 + Salida</span>}
                    {u.esChofer&&<span style={{padding:"1px 8px",background:"#1c1500",color:"#f59e0b",borderRadius:"5px",fontSize:"0.65rem",fontWeight:700}}>🛵 Chofer</span>}
                    {!u.activo&&<span style={{padding:"1px 8px",background:"#1c0a0a",color:"#f87171",borderRadius:"5px",fontSize:"0.65rem",fontWeight:700}}>Inactivo</span>}
                    {u.rol==="colaborador"&&u.permisos&&Object.values(u.permisos).some(v=>v===false)&&(
                      <span style={{padding:"1px 8px",background:"#1c1500",color:"#f59e0b",borderRadius:"5px",fontSize:"0.65rem",fontWeight:700}}>Permisos personalizados</span>
                    )}
                  </div>
                </div>
                <div style={{display:"flex",gap:"0.4rem",flexWrap:"wrap"}}>
                  {u.rol==="colaborador"&&(
                    <button onClick={()=>setPermsOpenId(permsOpen?null:u.id)} style={{...S.btnSm(permsOpen,"#8b5cf6"),fontSize:"0.72rem"}}>
                      {permsOpen?"▲ Permisos":"▼ Permisos"}
                    </button>
                  )}
                  {u.rol==="armador"&&(
                    <button onClick={()=>toggleSalidaArmador(u)} style={{...S.btnSm(!!u.puedeSalida,"#a78bfa"),fontSize:"0.72rem"}}>
                      {u.puedeSalida?"🚚 Salida: ON":"🚚 Salida: OFF"}
                    </button>
                  )}
                  <button onClick={()=>editar(u)} style={{...S.btnSm(false),color:"#6366f1"}}>Editar</button>
                  <button onClick={()=>toggleActivo(u)} style={S.btnSm(u.activo,u.activo?"#ef4444":"#10b981")}>{u.activo?"Desactivar":"Activar"}</button>
                </div>
              </div>
              {/* Panel de permisos — solo colaboradores */}
              {permsOpen&&u.rol==="colaborador"&&<PanelPermisos u={u}/>}
            </div>
          );
        })}
      </div>

      {/* ═══ Configuración Expedición ═══ */}
      <div style={{...S.card,padding:0,overflow:"hidden",marginTop:"1.5rem"}}>
        <div style={{padding:"0.75rem 1rem",background:"#12172a",borderBottom:"1px solid #252d40",display:"flex",alignItems:"center",gap:"8px"}}>
          <span style={{fontSize:"0.72rem",fontWeight:700,color:"#f59e0b",textTransform:"uppercase",letterSpacing:"0.06em"}}>⚙ Expedición</span>
          <span style={{fontSize:"0.65rem",color:"#4b5563"}}>Configuración del tab de armado y expedición</span>
        </div>
        <div style={{padding:"1rem"}}>
          {/* Toggle impresión */}
          <div style={{display:"flex",alignItems:"center",gap:"12px",marginBottom:"1.25rem",padding:"0.85rem 1rem",background:"#12172a",borderRadius:"10px",border:"1px solid #252d40",cursor:"pointer"}}
            onClick={()=>setConfigExpedicion(p=>({...p,impresionHabilitada:!p.impresionHabilitada}))}>
            <div style={{width:"42px",height:"24px",borderRadius:"12px",background:impresionHabilitada?"#10b981":"#374151",position:"relative",flexShrink:0,transition:"background 0.2s"}}>
              <div style={{position:"absolute",top:"3px",left:impresionHabilitada?"21px":"3px",width:"18px",height:"18px",borderRadius:"50%",background:"#fff",transition:"left 0.2s"}}/>
            </div>
            <div>
              <div style={{fontSize:"0.88rem",fontWeight:600,color:"#e5e7eb"}}>Impresión automática de etiquetas</div>
              <div style={{fontSize:"0.72rem",color:"#6b7280",marginTop:"2px"}}>
                {impresionHabilitada?"Habilitada — al confirmar un pedido NO FLEX con más de 1 bulto se imprimen las etiquetas de bultos adicionales automáticamente":"Deshabilitada — las etiquetas no se imprimirán automáticamente al escanear"}
              </div>
            </div>
          </div>
          {/* Lista armadores */}
          <div style={{fontSize:"0.65rem",color:"#6b7280",fontWeight:700,textTransform:"uppercase",marginBottom:"8px"}}>Armadores ({armadoresConfig.length})</div>
          {armadoresConfig.length===0&&<div style={{padding:"0.75rem",background:"#12172a",borderRadius:"8px",color:"#4b5563",fontSize:"0.8rem",marginBottom:"8px"}}>Sin armadores. Agregá los nombres del equipo de preparación.</div>}
          <div style={{display:"grid",gap:"6px",marginBottom:"0.75rem"}}>
            {armadoresConfig.map((arm,i)=>(
              <div key={arm.id} style={{display:"flex",alignItems:"center",gap:"8px",padding:"8px 12px",background:"#12172a",borderRadius:"8px",border:"1px solid #252d40"}}>
                <span style={{fontSize:"0.8rem",fontWeight:800,color:"#374151",minWidth:"18px"}}>{i+1}</span>
                <span style={{flex:1,fontSize:"0.9rem",fontWeight:600,color:arm.color||"#e5e7eb"}}>{arm.nombre}</span>
                {/* Toggle controlador */}
                <button onClick={()=>setConfigExpedicion(p=>({...p,armadores:p.armadores.map(a=>a.id===arm.id?{...a,puedeControlar:!a.puedeControlar}:a)}))}
                  style={{padding:"3px 8px",borderRadius:"5px",fontSize:"0.65rem",fontWeight:700,cursor:"pointer",flexShrink:0,
                    background:arm.puedeControlar?"#0a2a1c":"#12172a",
                    border:"1px solid "+(arm.puedeControlar?"#10b981":"#374151"),
                    color:arm.puedeControlar?"#34d399":"#4b5563"}}>
                  🔍 {arm.puedeControlar?"Control: ON":"Control: OFF"}
                </button>
                <div style={{display:"flex",gap:"4px",flexWrap:"wrap"}}>
                  {ARM_COLORS.map(c=>(
                    <button key={c} onClick={()=>setConfigExpedicion(p=>({...p,armadores:p.armadores.map(a=>a.id===arm.id?{...a,color:c}:a)}))}
                      style={{width:"16px",height:"16px",borderRadius:"50%",background:c,border:arm.color===c?"2px solid #fff":"2px solid transparent",cursor:"pointer",padding:0,flexShrink:0}}/>
                  ))}
                </div>
                <button onClick={()=>setConfigExpedicion(p=>({...p,armadores:p.armadores.filter(a=>a.id!==arm.id)}))}
                  style={{background:"none",border:"none",color:"#f87171",cursor:"pointer",fontSize:"1.1rem",padding:"0 4px",lineHeight:1,flexShrink:0}}>✕</button>
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:"8px"}}>
            <input value={nuevoArmador} onChange={e=>setNuevoArmador(e.target.value)}
              onKeyDown={e=>{if(e.key==="Enter")agregarArmador();}}
              placeholder="Nombre del armador..." style={{...S.input,flex:1}}/>
            <button onClick={agregarArmador} style={{...S.btn(true),background:"linear-gradient(135deg,#6366f1,#8b5cf6)",whiteSpace:"nowrap"}}>+ Agregar</button>
          </div>

        </div>
      </div>

    </div>
  );
}


// ════════════════════════════════════════════════════════════════════
// VISTA LOGISTICA — solo lectura, filtrada por su empresa
// ════════════════════════════════════════════════════════════════════
function VistaLogistica({envios,sesion,lc}){
  const hoy=fechaHoy();
  const [modFecha,setModFecha]=useState("proximos");
  const [rangoD,setRangoD]=useState(hoy);
  const [rangoH,setRangoH]=useState(hoy);
  const [filTurno,setFilTurno]=useState("TODOS");
  const [filTipo,setFilTipo]=useState("TODOS");
  const [busqueda,setBusqueda]=useState("");
  const [expandId,setExpandId]=useState(null);
  const logNombre=sesion.logistica;
  const mostrarImporte=lc[logNombre]?.mostrarImporteLg===true;

  // proximos = hoy + 7 dias futuros
  const d7=new Date(hoy+"T00:00:00");d7.setDate(d7.getDate()+7);
  const hasta7=d7.toISOString().split("T")[0];

  const filtrados=[...envios].filter(e=>{
    if(e.trans!==logNombre)return false;
    if(getEstado(e)==="cancelado")return false;
    const fEnv=e.fecha||e.fechaVenta||"";
    if(modFecha==="hoy"&&fEnv!==hoy)return false;
    if(modFecha==="proximos"&&(fEnv<hoy||fEnv>hasta7))return false;
    if(modFecha==="rango"&&(fEnv<rangoD||fEnv>rangoH))return false;
    if(filTurno==="SIN_TURNO"){if(e.turno)return false;}else if(filTurno!=="TODOS"&&e.turno!==filTurno)return false;
    if(filTipo==="FLEX"&&e.origen!=="ML")return false;
    if(filTipo==="NOFLEX"&&e.origen==="ML")return false;
    if(busqueda){const srch=norm(busqueda);return norm(e.direccion).includes(srch)||norm(e.partido).includes(srch)||norm(e.clienteNombre).includes(srch)||(e.nroOrdenTN||"").includes(srch);}
    return true;
  }).sort((a,b)=>{
    const la=a.loteImportacion||"9";const lb=b.loteImportacion||"9";
    if(la!==lb)return la.localeCompare(lb);
    const fa=a.fecha||a.fechaVenta||"";const fb=b.fecha||b.fechaVenta||"";
    if(fa!==fb)return fa.localeCompare(fb);
    const ta=TURNOS.indexOf(a.turno);const tb=TURNOS.indexOf(b.turno);
    return ta-tb;
  });

  const lcD=lc[logNombre]||{color:"#6366f1",bg:"#0c1a2e"};
  const cobPendiente=filtrados.filter(e=>e.cobranza!==null&&!e.cobranzaRecibida).reduce((s,e)=>s+(e.cobranza||0),0);

  return(
    <div style={{minHeight:"100vh",background:"#0a0e1a",color:"#fff",fontFamily:"sans-serif"}}>
      <style>{`*{box-sizing:border-box;}::-webkit-scrollbar{width:4px;}::-webkit-scrollbar-thumb{background:#252d40;border-radius:3px;}`}</style>
      <div style={{position:"sticky",top:0,zIndex:100,background:"#0f1420",borderBottom:"1px solid #1a1f2e",padding:"0.7rem 1rem",display:"flex",alignItems:"center",gap:"0.75rem",flexWrap:"wrap"}}>
        <div style={{width:"26px",height:"26px",background:"linear-gradient(135deg,#6366f1,#8b5cf6)",borderRadius:"7px",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>🛵</div>
        <div>
          <div style={{fontWeight:800,fontSize:"0.92rem"}}>EnviosHub <span style={{color:"#374151",fontSize:"0.6rem",fontWeight:400}}>v{VERSION}</span></div>
          <div style={{color:lcD.color,fontSize:"0.65rem",fontWeight:700}}>{logNombre}</div>
        </div>
        <div style={{display:"flex",gap:"3px",flexWrap:"wrap",marginLeft:"8px"}}>
          {[{k:"hoy",l:"Hoy"},{k:"proximos",l:"Proximos 7 dias"},{k:"todos",l:"Todos"},{k:"rango",l:"Rango"}].map(x =><button key={x.k} onClick={()=>setModFecha(x.k)} style={{...S.btn(modFecha===x.k),padding:"0.28rem 0.6rem",fontSize:"0.72rem"}}>{x.l}</button>)}
          {modFecha==="rango"&&<><input type="date" value={rangoD} onChange={e=>setRangoD(e.target.value)} style={{...S.input,padding:"3px 8px",width:"130px",fontSize:"0.72rem"}}/><input type="date" value={rangoH} onChange={e=>setRangoH(e.target.value)} style={{...S.input,padding:"3px 8px",width:"130px",fontSize:"0.72rem"}}/></>}
          <span style={{color:"#374151",fontSize:"0.6rem",alignSelf:"center"}}>|</span>
          {["TODOS",...TURNOS].map(t =><button key={t} onClick={()=>setFilTurno(t)} style={{...S.btnSm(filTurno===t,"#8b5cf6"),padding:"0.28rem 0.6rem",fontSize:"0.72rem"}}>{t}</button>)}<button onClick={()=>setFilTurno("SIN_TURNO")} style={{...S.btnSm(filTurno==="SIN_TURNO","#6b7280"),padding:"0.28rem 0.6rem",fontSize:"0.72rem"}}>Sin turno</button>
          <span style={{color:"#374151",fontSize:"0.6rem",alignSelf:"center"}}>|</span>
          <button onClick={()=>setFilTipo("TODOS")} style={{...S.btnSm(filTipo==="TODOS"),padding:"0.28rem 0.6rem",fontSize:"0.72rem"}}>Todos</button>
          <button onClick={()=>setFilTipo("FLEX")} style={{padding:"0.28rem 0.6rem",fontSize:"0.72rem",borderRadius:"6px",fontWeight:700,cursor:"pointer",background:filTipo==="FLEX"?"#0d1c04":"#0f1420",color:filTipo==="FLEX"?"#84cc16":"#4b7a10",border:"1px solid "+(filTipo==="FLEX"?"#84cc16":"#1a3008")}}>FLEX</button>
          <button onClick={()=>setFilTipo("NOFLEX")} style={{...S.btnSm(filTipo==="NOFLEX","#6366f1"),padding:"0.28rem 0.6rem",fontSize:"0.72rem"}}>NO FLEX</button>
        </div>
        <input value={busqueda} onChange={e=>setBusqueda(e.target.value)} placeholder="Buscar..." style={{...S.input,width:"160px",padding:"0.3rem 0.65rem",fontSize:"0.78rem"}}/>
        <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:"0.5rem",flexWrap:"wrap"}}>
          <button onClick={()=>{
            const filas=filtrados.sort((a,b)=>(a.loteImportacion||"9").localeCompare(b.loteImportacion||"9")).map((e,i)=>{
              const esFlex=e.origen==="ML";
              const lote=e.loteImportacion?new Date(e.loteImportacion).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit",hour12:false}):"";
              const nroRef=esFlex?(e.nroSeguimiento||""):("#"+(e.nroOrdenTN||""));
              const zona=getZonaML(e.partido)||"";
              return{"#":i+1,
                Lote:lote,
                Tipo:e.tipoEntrega==="COMERCIAL"?"COM":e.tipoEntrega==="RESIDENCIAL"?"RES":"",
                Direccion:[e.direccion,e.localidad,e.partido,e.cp].filter(Boolean).join(" · "),
                Referencia:(e.referencia&&!e.direccion.toLowerCase().includes(e.referencia.toLowerCase().slice(0,20)))?e.referencia:"",
                NroEnvio:esFlex?nroRef:"",
                NroOrden:esFlex?"":nroRef,
                Zona:zona,
                Turno:e.turno||"",
                Fecha:e.fecha||"",
                Bultos:e.bultos||1,
                Cobrar:e.cobranza||""};
            });
            exportarXLSX(filas,"envios_"+logNombre+"_"+fechaHoy());
          }} style={{...S.btnSm(false),border:"1px solid #10b981",color:"#10b981",padding:"4px 10px",fontSize:"0.72rem"}}>⬇ Excel</button>
          <button onClick={()=>{
            const ahora=new Date();
            const ts=ahora.toLocaleDateString("es-AR",{weekday:"long",day:"numeric",month:"long",year:"numeric"})+" "+ahora.toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit",hour12:false});
            const hayCobro=filtrados.some(e=>e.cobranza!==null&&e.cobranza>0);
            const rows=filtrados.map((e,i)=>{
              const esFlex=e.origen==="ML";
              const dir=[e.direccion,e.localidad,e.partido,e.cp].filter(Boolean).join(" · ");
              const nroRef=esFlex?(e.nroSeguimiento||e.id.slice(-10)):("#"+(e.nroOrdenTN||e.id.slice(-8)));
              const lote=esFlex&&e.loteImportacion?new Date(e.loteImportacion).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit",hour12:false}):"—";
              const tipo=e.tipoEntrega==="COMERCIAL"?"COM":e.tipoEntrega==="RESIDENCIAL"?"RES":"—";
              const cobrar=e.cobranza?"$"+Number(e.cobranza).toLocaleString("es-AR"):"—";
              return`<tr style="background:${i%2===0?"#fff":"#f9f9f9"}"><td style="text-align:center;padding:3px 4px;color:#888;border-bottom:0.5px solid #ddd;">${i+1}</td><td style="padding:3px 4px;border-bottom:0.5px solid #ddd;color:#16a34a;font-size:9px;font-weight:700;">${lote}</td><td style="padding:3px 4px;border-bottom:0.5px solid #ddd;text-align:center;font-size:9px;font-weight:700;background:${e.tipoEntrega==="COMERCIAL"?"#dbeafe":e.tipoEntrega?"#dcfce7":"transparent"};color:${e.tipoEntrega==="COMERCIAL"?"#1d4ed8":e.tipoEntrega?"#15803d":"#aaa"};">${tipo}</td><td style="padding:3px 4px;border-bottom:0.5px solid #ddd;font-weight:500;">${dir}${(e.referencia&&!e.direccion.toLowerCase().includes(e.referencia.toLowerCase().slice(0,20)))?" — "+e.referencia:""}</td><td style="padding:3px 4px;border-bottom:0.5px solid #ddd;font-family:monospace;font-size:9px;color:#444;">${nroRef}</td><td style="padding:3px 4px;border-bottom:0.5px solid #ddd;text-align:center;">${e.turno||"—"}</td><td style="padding:3px 4px;border-bottom:0.5px solid #ddd;text-align:center;">${e.fecha?fmtCorta(e.fecha):"—"}</td><td style="padding:3px 4px;border-bottom:0.5px solid #ddd;text-align:center;font-weight:${(e.bultos||1)>1?700:400};">${e.bultos||1}</td>${hayCobro?`<td style="padding:3px 4px;border-bottom:0.5px solid #ddd;text-align:right;font-weight:${e.cobranza?"600":"400"};color:${e.cobranza?"#b45309":"#aaa"};">${cobrar}</td>`:""}<td style="padding:3px 4px;border-bottom:0.5px solid #ddd;text-align:center;"><div style="width:11px;height:11px;border:1px solid #aaa;border-radius:1px;display:inline-block;"></div></td></tr>`;
            }).join("");
            const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Envios ${logNombre}</title><style>@page{size:A4 landscape;margin:8mm 10mm;}body{font-family:Arial,sans-serif;font-size:11px;margin:0;color:#111;}table{width:100%;border-collapse:collapse;}th{background:#e8e8e8;padding:3px 4px;text-align:left;font-size:9px;font-weight:700;text-transform:uppercase;color:#555;border-bottom:1.5px solid #333;}@media print{button{display:none!important;}}</style></head><body><div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px;"><span style="font-weight:700;font-size:13px;">Envios — ${logNombre} · ${ts}</span><span style="font-size:10px;color:#888;">${filtrados.length} envios</span></div><table><thead><tr><th style="width:20px;">#</th><th style="width:55px;">Lote</th><th style="width:38px;text-align:center;">Tipo</th><th>Direccion · Localidad · Partido · CP · Referencia</th><th style="width:100px;">Nro envio</th><th style="width:32px;text-align:center;">Turno</th><th style="width:42px;text-align:center;">Fecha</th><th style="width:28px;text-align:center;">Blts</th>${hayCobro?"<th style='width:72px;text-align:right;'>Cobrar</th>":""}<th style="width:18px;text-align:center;">Chk</th></tr></thead><tbody>${rows}</tbody></table><div style="border-top:1.5px solid #333;margin-top:4px;padding-top:3px;font-size:9px;color:#555;">${filtrados.length} envios</div><script>window.onload=function(){window.print();}<\/script></body></html>`;
            const w=window.open("","_blank");if(!w){alert("Permite ventanas emergentes.");return;}w.document.write(html);w.document.close();
          }} style={{...S.btnSm(true),background:"linear-gradient(135deg,#6366f1,#8b5cf6)",padding:"4px 10px",fontSize:"0.72rem",border:"none"}}>Imprimir</button>
          <span style={{color:"#4b5563",fontSize:"0.72rem"}}>{sesion.usuario}</span>
          <button onClick={()=>{clearSession();window.location.reload();}} style={{...S.btnSm(false),color:"#f87171"}}>Salir</button>
        </div>
      </div>
      <div style={{padding:"0.85rem 1rem",maxWidth:"900px",margin:"0 auto"}}>
        <div style={{display:"flex",gap:"8px",marginBottom:"0.75rem",flexWrap:"wrap"}}>
          <div style={{...S.card,padding:"0.75rem 1rem",flex:1}}>
            <div style={{color:lcD.color,fontWeight:800,fontSize:"1.6rem",lineHeight:1}}>{filtrados.length}</div>
            <div style={{color:"#6b7280",fontSize:"0.62rem",marginTop:"2px"}}>Envios</div>
          </div>
          <div style={{...S.card,padding:"0.75rem 1rem",flex:1}}>
            <div style={{color:"#f59e0b",fontWeight:800,fontSize:"1.1rem"}}>{filtrados.filter(e=>getEstado(e)==="sin_asignar").length}</div>
            <div style={{color:"#6b7280",fontSize:"0.62rem",marginTop:"2px"}}>Sin asignar</div>
          </div>
          {cobPendiente>0&&<div style={{...S.card,padding:"0.75rem 1rem",flex:1,borderLeft:"3px solid #fbbf24"}}>
            <div style={{color:"#fbbf24",fontWeight:800,fontSize:"0.95rem"}}>{fmt(cobPendiente)}</div>
            <div style={{color:"#6b7280",fontSize:"0.62rem",marginTop:"2px"}}>A cobrar</div>
          </div>}
          {mostrarImporte&&<div style={{...S.card,padding:"0.75rem 1rem",flex:1}}>
            <div style={{color:"#10b981",fontWeight:800,fontSize:"0.95rem"}}>{fmt(filtrados.reduce((s,e)=>s+(e.importe||0),0))}</div>
            <div style={{color:"#6b7280",fontSize:"0.62rem",marginTop:"2px"}}>Total</div>
          </div>}
        </div>
        <div style={{display:"grid",gap:"4px"}}>
          {filtrados.length===0&&<div style={{textAlign:"center",padding:"3rem",color:"#4b5563"}}><div style={{fontSize:"2rem"}}>📭</div><p>Sin envios en este periodo</p></div>}
          {filtrados.map(e=>{
            const zml=getZonaML(e.partido);
            const estKey=getEstado(e);
            const estC=ESTADO_C[estKey]||ESTADO_C.sin_asignar;
            const esTN=e.origen==="Tienda Nube";
            const isExp=expandId===e.id;
            return(
              <div key={e.id} style={{...S.card,padding:"0.6rem 0.75rem",opacity:estKey==="cancelado"?0.4:1,cursor:"pointer"}} onClick={()=>setExpandId(isExp?null:e.id)}>
                <div style={{display:"flex",gap:"3px",flexWrap:"wrap",alignItems:"center",marginBottom:"3px"}}>
                  <Bdg label={estC.label} bg={estC.bg} t={estC.t}/>
                  {e.origen==="ML"&&e.loteImportacion&&<Bdg label={new Date(e.loteImportacion).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit",hour12:false})} bg="#0d1c04" t="#84cc16"/>}
                  {e.tipoEntrega&&<span style={{padding:"1px 6px",background:e.tipoEntrega==="COMERCIAL"?"#0c1a40":"#0a1a0a",color:e.tipoEntrega==="COMERCIAL"?"#38bdf8":"#86efac",borderRadius:"4px",fontSize:"0.65rem",fontWeight:700}}>{e.tipoEntrega==="COMERCIAL"?"COM":"RES"}</span>}
                  {zml&&<Bdg label={zml} bg={ZONA_ML_BG[zml]||"#1a1f2e"} t={ZONA_ML_COLOR[zml]||"#6b7280"}/>}
                  {e.turno&&<Bdg label={e.turno} bg={TURNO_C[e.turno]?.bg||"#130d2a"} t={TURNO_C[e.turno]?.c||"#a78bfa"}/>}
                  {e.fecha&&<Bdg label={fmtCorta(e.fecha)} bg="#12172a" t="#9ca3af"/>}
                  {(e.bultos||1)>1&&<Bdg label={e.bultos+" bultos"} bg="#0c1a2e" t="#60a5fa"/>}
                  {e.cobranza!==null&&<Bdg label={"Cobrar $"+Number(e.cobranza).toLocaleString("es-AR")} bg="#1c1500" t="#fbbf24"/>}
                  {e.cambio!==null&&<Bdg label="Cambio" bg="#1c0514" t="#ec4899"/>}
                  {e.retiro!==null&&<Bdg label="Retiro" bg="#1c1000" t="#f97316"/>}
                </div>
                {esTN&&<div style={{display:"flex",gap:"8px",alignItems:"baseline",marginBottom:"1px"}}>
                  <span style={{color:"#7dd3fc",fontWeight:700,fontSize:"0.82rem"}}>#{e.nroOrdenTN}</span>
                  {e.clienteNombre&&<span style={{color:"#e5e7eb",fontWeight:600,fontSize:"0.82rem"}}>{e.clienteNombre}</span>}
                </div>}
                <div style={{color:esTN&&e.clienteNombre?"#9ca3af":"#e5e7eb",fontSize:"0.82rem",fontWeight:500}}>{e.direccion}{e.referencia&&!e.direccion.toLowerCase().includes(e.referencia.toLowerCase().slice(0,20))?<span style={{color:"#6b7280",fontWeight:400}}> — {e.referencia}</span>:null}</div>
                <div style={{color:"#6b7280",fontSize:"0.72rem",marginTop:"1px"}}>{e.localidad?e.localidad+" · ":""}{e.partido}{e.cp?" · CP "+e.cp:""}</div>
                {e.telefono&&<div style={{color:"#6b7280",fontSize:"0.72rem"}}>📞 {e.telefono}</div>}
                {/* Info expandida */}
                {isExp&&<div style={{marginTop:"8px",borderTop:"1px solid #252d40",paddingTop:"8px",display:"grid",gap:"6px"}}>
                  {e.notasCliente&&<div style={{background:"#0d1119",borderRadius:"7px",padding:"6px 10px"}}>
                    <div style={{color:"#6b7280",fontSize:"0.6rem",fontWeight:700,textTransform:"uppercase",marginBottom:"2px"}}>Notas del cliente</div>
                    <div style={{color:"#e5e7eb",fontSize:"0.78rem",fontStyle:"italic"}}>"{e.notasCliente}"</div>
                  </div>}
                  {e.notasOrden&&<div style={{background:"#0d1119",borderRadius:"7px",padding:"6px 10px"}}>
                    <div style={{color:"#6b7280",fontSize:"0.6rem",fontWeight:700,textTransform:"uppercase",marginBottom:"2px"}}>Notas de la orden</div>
                    <div style={{color:"#9ca3af",fontSize:"0.75rem"}}>{e.notasOrden}</div>
                  </div>}
                  {e.observaciones&&<div style={{background:"#0d1119",borderRadius:"7px",padding:"6px 10px"}}>
                    <div style={{color:"#6b7280",fontSize:"0.6rem",fontWeight:700,textTransform:"uppercase",marginBottom:"2px"}}>Observaciones</div>
                    <div style={{color:"#9ca3af",fontSize:"0.75rem"}}>{e.observaciones}</div>
                  </div>}
                  {e.cambio&&<div style={{background:"#1c0514",borderRadius:"7px",padding:"6px 10px"}}>
                    <div style={{color:"#ec4899",fontSize:"0.6rem",fontWeight:700,textTransform:"uppercase",marginBottom:"2px"}}>Cambio</div>
                    <div style={{color:"#f9a8d4",fontSize:"0.78rem"}}>{e.cambio}</div>
                  </div>}
                  {e.retiro&&<div style={{background:"#1c1000",borderRadius:"7px",padding:"6px 10px"}}>
                    <div style={{color:"#f97316",fontSize:"0.6rem",fontWeight:700,textTransform:"uppercase",marginBottom:"2px"}}>Retiro</div>
                    <div style={{color:"#fdba74",fontSize:"0.78rem"}}>{e.retiro}</div>
                  </div>}
                  {e.cobranza!==null&&<div style={{background:"#1c1500",borderRadius:"7px",padding:"6px 10px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <div style={{color:"#6b7280",fontSize:"0.6rem",fontWeight:700,textTransform:"uppercase",marginBottom:"2px"}}>Cobranza</div>
                      <div style={{color:"#fbbf24",fontWeight:800,fontSize:"1rem"}}>{fmt(e.cobranza)}</div>
                    </div>
                    <div style={{color:e.formaPago==="Efectivo"?"#fbbf24":"#9ca3af",fontSize:"0.75rem"}}>{e.formaPago||"Efectivo"}</div>
                  </div>}
                  {mostrarImporte&&e.importe>0&&<div style={{color:"#10b981",fontWeight:700,fontSize:"0.82rem",paddingTop:"2px"}}>Tarifa: {fmt(e.importe)}</div>}
                </div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}



// Motivos de entrega fallida
const MOTIVOS_FALLO=[
  {k:"cerrado_no_atendio",l:"Cerrado / No atendió",icon:"🔒"},
  {k:"sin_efectivo",l:"Cliente sin efectivo",icon:"💸"},
  {k:"rechazo",l:"Rechazo del pedido",icon:"📦"},
  {k:"otro",l:"Otro motivo",icon:"✏️"},
];

// ════════════════════════════════════════════════════════════════════
// VISTA ARMADOR — escaneo simple para celular propio, sesión personal
// ════════════════════════════════════════════════════════════════════
function VistaArmador({envios,setEnvios,colectas=[],setColectas,sesion,lc,armador,armadores=[],gapUmbralMin=5}){
  // "armado" = escaneo simple al armar; "salida" = TabSalida (despacho a logística) — mismo usuario, sin re-loguear.
  const [modo,setModo]=useState("armado");
  const [qrInput,setQrInput]=useState("");
  const [resultado,setResultado]=useState(null);
  const [overlayRes,setOverlayRes]=useState(null); // fullscreen feedback (ok|false|"ya")
  const [sesionContador,setSesionContador]=useState(0);
  const [controladorSel,setControladorSel]=useState(null); // sticky por sesión
  const [sesionActiva,setSesionActiva]=useState(false);
  const [sesionInicioTs,setSesionInicioTs]=useState(null);
  const [camara,setCamara]=useState(false);
  const soportaCamera=typeof window!=="undefined"&&"mediaDevices" in navigator&&!!navigator.mediaDevices?.getUserMedia;
  const inputRef=useRef(null);
  const videoRef=useRef(null);
  const canvasRef=useRef(null);
  const sesionGapRef=useRef(null); // timer de inactividad de sesión
  const GAP_MS=gapUmbralMin*60*1000; // minutos sin escanear → cierra sesión (configurable)

  const resetGapTimer=useCallback(()=>{
    if(sesionGapRef.current)clearTimeout(sesionGapRef.current);
    sesionGapRef.current=setTimeout(()=>{
      setSesionActiva(false);setSesionInicioTs(null);
      setResultado({ok:false,msg:"Sesión cerrada por inactividad ("+gapUmbralMin+" min)."});
      setTimeout(()=>setResultado(null),6000);
    },GAP_MS);
  },[]);

  const iniciarSesion=useCallback(()=>{
    setSesionActiva(true);setSesionInicioTs(Date.now());setSesionContador(0);
    resetGapTimer();
    if(inputRef.current)inputRef.current.focus();
  },[resetGapTimer]);

  const cerrarSesion=useCallback(()=>{
    if(sesionGapRef.current)clearTimeout(sesionGapRef.current);
    setSesionActiva(false);setSesionInicioTs(null);
  },[]);

  useEffect(()=>{if(inputRef.current)inputRef.current.focus();},[]);

  const ejecutarArmado=useCallback((envio,bultos)=>{
    const ts=new Date().toISOString();
    const ctrl=controladorSel||null;
    setEnvios(pv=>pv.map(e=>e.id===envio.id?{...e,preparado:true,bultos,armadorId:armador.id,armadorNombre:armador.nombre,armadoTs:ts}:e));
    const msg="✓ "+armador.nombre+(bultos>1?" · "+bultos+" bultos":"")+(ctrl?" — ctrl: "+ctrl.nombre:"");
    setResultado({ok:true,envio,bultos,msg});
    setOverlayRes({ok:true,msg});
    setTimeout(()=>setOverlayRes(null),1800);
    setTimeout(()=>setResultado(null),4000);
    if(inputRef.current)inputRef.current.focus();
    addDoc(collection(db,"armados"),{
      envioId:envio.id,
      nroSeguimiento:envio.nroSeguimiento||"",
      nroOrdenTN:String(envio.nroOrdenTN||""),
      armadorId:armador.id,armadorNombre:armador.nombre,
      controladorId:ctrl?.id||"",controladorNombre:ctrl?.nombre||"",
      ts,fecha:envio.fecha||envio.fechaVenta||"",
      bultos,logistica:envio.trans||"",
      direccion:envio.direccion||"",
      partido:envio.partido||"",
      esFlex:envio.origen==="ML",
      esEdicion:false,
    }).catch(err=>console.error("Error guardando armado:",err));
  },[setEnvios,armador,controladorSel]);

  // Armado de colectas ML (circuito separado de envíos) — sin panel, directo con el armador fijo de la vista.
  const ejecutarArmadoColecta=useCallback((colecta)=>{
    const ts=new Date().toISOString();
    const ctrl=controladorSel||null;
    if(setColectas)setColectas(pv=>pv.filter(c=>c.id!==colecta.id));
    const msg="📋 Colecta · "+armador.nombre+(ctrl?" — ctrl: "+ctrl.nombre:"");
    setResultado({ok:true,envio:colecta,bultos:1,msg});
    setOverlayRes({ok:true,msg});
    setTimeout(()=>setOverlayRes(null),1800);
    setTimeout(()=>setResultado(null),4000);
    if(inputRef.current)inputRef.current.focus();
    updateDoc(doc(db,"colectas",colecta.id),{
      estado:"armada",armadorId:armador.id,armadorNombre:armador.nombre,
      controladorId:ctrl?.id||"",controladorNombre:ctrl?.nombre||"",
      fechaArmado:fechaHoy(),horaArmado:ts,
    }).catch(err=>console.error("Error actualizando colecta:",err));
    addDoc(collection(db,"armados"),{
      envioId:colecta.id,
      nroSeguimiento:colecta.nroSeguimiento||"",
      nroOrdenTN:"",
      nroVenta:colecta.nroVenta||"",
      nroPackId:colecta.nroPackId||"",
      destinatario:colecta.destinatario||"",
      usuario:colecta.usuario||"",
      armadorId:armador.id,armadorNombre:armador.nombre,
      controladorId:ctrl?.id||"",controladorNombre:ctrl?.nombre||"",
      ts,fecha:colecta.fecha||fechaHoy(),
      bultos:1,logistica:"Colecta",
      direccion:colecta.direccion||"",
      partido:colecta.partido||"",
      esFlex:false,esColecta:true,esEdicion:false,
    }).catch(err=>console.error("Error guardando armado:",err));
  },[setColectas,armador,controladorSel]);

  const procesarScan=useCallback((nro)=>{
    const srch=nro.trim().replace(/^#/,"");if(!srch)return;
    setResultado(null);
    const nums=srch.replace(/\D/g,"");
    const candidatos=envios
      .map(e=>({e,score:scoreBusqueda(e,srch,nums)}))
      .filter(x=>x.score>0)
      .sort((a,b)=>b.score-a.score);
    if(candidatos.length===0){
      // Fallback: no matcheó en envíos → probar contra colectas pendientes (sin filtro de fecha)
      const candColecta=colectas
        .map(c=>({c,score:scoreBusqueda(c,srch,nums)}))
        .filter(x=>x.score>0)
        .sort((a,b)=>b.score-a.score);
      if(candColecta.length===0){
        const msg="No encontrado: "+srch.slice(0,20);
        setResultado({ok:false,msg});
        setOverlayRes({ok:false,msg});
        setTimeout(()=>setOverlayRes(null),1800);
        setTimeout(()=>setResultado(null),5000);return;
      }
      ejecutarArmadoColecta(candColecta[0].c);
      setSesionContador(p=>p+1);
      if(sesionActiva)resetGapTimer();
      beepOK();
      return;
    }
    const found=candidatos[0].e;
    if(found.preparado&&found.armadorNombre){
      const msg="Ya preparado por "+found.armadorNombre;
      setResultado({ok:"ya",envio:found,msg});
      setOverlayRes({ok:"ya",msg});
      setTimeout(()=>setOverlayRes(null),1800);
      setTimeout(()=>setResultado(null),4000);return;
    }
    ejecutarArmado(found,found.bultos||1);
    setSesionContador(p=>p+1);
    if(sesionActiva)resetGapTimer();
    beepOK();
  },[envios,colectas,ejecutarArmado,ejecutarArmadoColecta,sesionActiva,resetGapTimer]);

  // Escaneo QR via cámara — usa BarcodeDetector nativo si está disponible (Chrome/Android);
  // si no existe (Safari/iPhone) decodifica con jsQR leyendo los frames del video por canvas.
  useEffect(()=>{
    if(!camara)return;
    let stream=null;let rafId=null;let activo=true;
    const startCam=async()=>{
      try{
        stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment",width:{ideal:1280},height:{ideal:720}}});
        if(!videoRef.current||!activo)return;
        videoRef.current.srcObject=stream;
        await videoRef.current.play();
        const nativo=typeof window.BarcodeDetector!=="undefined";
        const detector=nativo?new window.BarcodeDetector({formats:["qr_code","code_128","code_39","ean_13"]}):null;
        if(!canvasRef.current)canvasRef.current=document.createElement("canvas");
        const canvas=canvasRef.current;
        const ctx=canvas.getContext("2d",{willReadFrequently:true});
        const scan=async()=>{
          if(!activo||!videoRef.current||videoRef.current.readyState<2){rafId=requestAnimationFrame(scan);return;}
          try{
            let val=null;
            if(nativo){
              const barcodes=await detector.detect(videoRef.current);
              if(barcodes.length>0)val=barcodes[0].rawValue;
            }else{
              const w=videoRef.current.videoWidth,h=videoRef.current.videoHeight;
              if(w&&h){
                canvas.width=w;canvas.height=h;
                ctx.drawImage(videoRef.current,0,0,w,h);
                const imgData=ctx.getImageData(0,0,w,h);
                const code=jsQR(imgData.data,w,h);
                if(code)val=code.data;
              }
            }
            if(val){
              setResultado({ok:"scanning",msg:"Escaneando..."});
              await new Promise(r=>setTimeout(r,800));
              if(!activo)return;
              procesarScan(val);
              setCamara(false);return;
            }
          }catch(e){}
          if(activo)rafId=requestAnimationFrame(scan);
        };
        rafId=requestAnimationFrame(scan);
      }catch(err){
        setResultado({ok:false,msg:"No se pudo acceder a la cámara. Verificá los permisos."});
        setCamara(false);
      }
    };
    startCam();
    return()=>{
      activo=false;
      if(rafId)cancelAnimationFrame(rafId);
      if(stream)stream.getTracks().forEach(t=>t.stop());
    };
  },[camara,procesarScan]);

  // Tu usuario no está (o ya no está) vinculado a un armador válido
  if(!armador){
    return(
      <div style={{minHeight:"100vh",background:"#0a0e1a",color:"#fff",fontFamily:"sans-serif",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"2rem",textAlign:"center"}}>
        <div style={{fontSize:"2rem",marginBottom:"0.75rem"}}>⚠️</div>
        <div style={{fontWeight:700,fontSize:"1rem",marginBottom:"0.5rem"}}>Usuario sin armador vinculado</div>
        <div style={{color:"#9ca3af",fontSize:"0.85rem",marginBottom:"1.5rem",maxWidth:"320px"}}>Tu cuenta no está vinculada a ningún armador activo. Pedile al administrador que lo revise en Usuarios.</div>
        <button onClick={()=>{clearSession();window.location.reload();}} style={{...S.btnSm(false),color:"#f87171"}}>Salir</button>
      </div>
    );
  }

  return(
    <div style={{minHeight:"100vh",background:"#0a0e1a",color:"#fff",fontFamily:"sans-serif",maxWidth:modo==="salida"?"720px":"500px",margin:"0 auto"}}>
      <style>{`*{box-sizing:border-box;}`}</style>

      {/* ── Overlay fullscreen resultado ───────────────────────────── */}
      {overlayRes&&(
        <div onClick={()=>setOverlayRes(null)} style={{position:"fixed",inset:0,zIndex:9999,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
          background:overlayRes.ok===true?"rgba(4,31,20,0.96)":overlayRes.ok==="ya"?"rgba(10,14,26,0.96)":"rgba(28,4,4,0.96)",
          cursor:"pointer"}}>
          <div style={{fontSize:"5rem",lineHeight:1,marginBottom:"0.5rem"}}>
            {overlayRes.ok===true?"✓":overlayRes.ok==="ya"?"⏸":"✗"}
          </div>
          <div style={{fontSize:"1.1rem",fontWeight:700,color:overlayRes.ok===true?"#34d399":overlayRes.ok==="ya"?"#9ca3af":"#f87171",textAlign:"center",padding:"0 2rem",maxWidth:"340px"}}>
            {overlayRes.msg}
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{position:"sticky",top:0,zIndex:100,background:"#0f1420",borderBottom:"1px solid #1a1f2e"}}>
        <div style={{padding:"0.7rem 1rem",display:"flex",alignItems:"center",gap:"0.75rem",flexWrap:"wrap"}}>
          <div style={{width:"26px",height:"26px",background:"linear-gradient(135deg,#6366f1,#8b5cf6)",borderRadius:"7px",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:"14px"}}>📦</div>
          <div>
            <div style={{fontWeight:800,fontSize:"0.92rem"}}>EnviosHub <span style={{color:"#374151",fontSize:"0.6rem",fontWeight:400}}>v{VERSION}</span></div>
            <div style={{color:armador.color||"#06b6d4",fontSize:"0.7rem",fontWeight:700}}>{armador.nombre}</div>
          </div>
          {sesion.puedeSalida&&(
            <button onClick={()=>setModo(p=>p==="armado"?"salida":"armado")}
              style={{padding:"0.35rem 0.7rem",borderRadius:"8px",fontWeight:700,fontSize:"0.72rem",cursor:"pointer",
                background:modo==="salida"?"#1a0f2e":"#0d1c04",color:modo==="salida"?"#a78bfa":"#84cc16",border:"1px solid "+(modo==="salida"?"#a78bfa":"#84cc16")}}>
              {modo==="salida"?"📦 Volver a Armado":"🚚 Modo Salida"}
            </button>
          )}
          <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:"0.75rem"}}>
            <span style={{color:"#4b5563",fontSize:"0.7rem"}}>{sesion.usuario}</span>
            <button onClick={()=>{clearSession();window.location.reload();}} style={{...S.btnSm(false),color:"#f87171"}}>Salir</button>
          </div>
        </div>
      </div>

      {modo==="salida"?(
        <div style={{padding:"14px"}}>
          <TabSalida envios={envios} setEnvios={setEnvios} lc={lc} sesion={sesion}/>
        </div>
      ):(
      <div style={{padding:"14px"}}>
        {/* Sesión + contador */}
        {!sesionActiva?(
          <div style={{...S.card,padding:"1.1rem 1rem",marginBottom:"0.85rem",textAlign:"center",borderLeft:"3px solid "+(armador.color||"#06b6d4")}}>
            <div style={{color:"#4b5563",fontSize:"0.65rem",textTransform:"uppercase",marginBottom:"0.5rem"}}>Sesión no iniciada</div>
            <button onClick={iniciarSesion}
              style={{padding:"0.7rem 2rem",borderRadius:"12px",fontWeight:800,fontSize:"1rem",cursor:"pointer",
                background:"linear-gradient(135deg,#6366f1,#8b5cf6)",border:"none",color:"#fff",letterSpacing:".02em"}}>
              ▶ Iniciar sesión
            </button>
          </div>
        ):(
          <div style={{...S.card,padding:"0.7rem 1rem",marginBottom:"0.85rem",display:"flex",alignItems:"center",gap:"12px",borderLeft:"3px solid "+(armador.color||"#06b6d4")}}>
            <div style={{flex:1}}>
              <div style={{display:"flex",alignItems:"baseline",gap:"8px"}}>
                <span style={{fontWeight:900,fontSize:"2rem",color:armador.color||"#06b6d4",lineHeight:1}}>{sesionContador}</span>
                <span style={{color:"#6b7280",fontSize:"0.65rem",textTransform:"uppercase"}}>armado{sesionContador!==1?"s":""}</span>
              </div>
              {sesionInicioTs&&<div style={{color:"#4b5563",fontSize:"0.62rem",marginTop:"1px"}}>
                desde {new Date(sesionInicioTs).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"})} · cierra en {Math.round(GAP_MS/60000)} min sin escanear
              </div>}
            </div>
            <button onClick={cerrarSesion} style={{padding:"4px 10px",borderRadius:"7px",background:"none",border:"1px solid #374151",color:"#6b7280",cursor:"pointer",fontSize:"0.7rem",fontWeight:700}}>⏹ Cerrar</button>
          </div>
        )}

        {/* Selector de controlador (solo si hay armadores configurados) */}
        {(()=>{const ctrls=(armadores.some(a=>a.puedeControlar)?armadores.filter(a=>a.puedeControlar):armadores).filter(a=>a.id!==armador?.id);
        return sesionActiva&&ctrls.length>0&&(
          <div style={{...S.card,padding:"0.6rem 0.8rem",marginBottom:"0.75rem",display:"flex",alignItems:"center",gap:"8px",flexWrap:"wrap"}}>
            <span style={{fontSize:"0.58rem",color:"#6b7280",fontWeight:700,textTransform:"uppercase",whiteSpace:"nowrap"}}>🔍 Ctrl:</span>
            {ctrls.map(a=>(
              <button key={a.id} onClick={()=>setControladorSel(c=>c?.id===a.id?null:a)}
                style={{padding:"3px 9px",borderRadius:"6px",fontWeight:700,fontSize:"0.72rem",cursor:"pointer",
                  background:controladorSel?.id===a.id?"#13102a":"#12172a",
                  border:"1px solid "+(controladorSel?.id===a.id?"#6366f1":"#252d40"),
                  color:controladorSel?.id===a.id?(a.color||"#a78bfa"):"#6b7280"}}>
                {a.nombre}
              </button>
            ))}
            {controladorSel&&<span style={{color:"#10b981",fontSize:"0.65rem",fontWeight:700}}>✓ {controladorSel.nombre}</span>}
          </div>
        );})()}

        {/* Input escaneo */}
        <div style={{...S.card,padding:"0.85rem 1rem",marginBottom:"0.75rem",border:"1px solid #6366f133"}}>
          <div style={{color:"#a78bfa",fontWeight:700,fontSize:"0.7rem",textTransform:"uppercase",letterSpacing:".06em",marginBottom:"8px"}}>Escanear pedido</div>
          <div style={{display:"flex",gap:"8px",marginBottom:(camara||resultado)?"8px":"0"}}>
            <input ref={inputRef} value={qrInput} onChange={e=>setQrInput(e.target.value)}
              onKeyDown={e=>{if(e.key==="Enter"){procesarScan(qrInput);setQrInput("");}}}
              placeholder="Escaneá el código de barras o ingresá el nro..."
              style={{...S.input,flex:1,fontSize:"0.88rem",padding:"10px 12px"}} autoComplete="off"/>
            <button onClick={()=>{procesarScan(qrInput);setQrInput("");}}
              style={{...S.btn(true),background:"#12172a",border:"1px solid #6366f1",color:"#a78bfa",padding:"8px 14px",fontWeight:700,fontSize:"0.8rem"}}>OK</button>
            {soportaCamera&&(
              <button onClick={()=>setCamara(p=>!p)}
                title="Escanear con cámara"
                style={{...S.btn(camara),background:camara?"#0d1c04":"#0f1420",border:"1px solid "+(camara?"#84cc16":"#252d40"),color:camara?"#84cc16":"#6b7280",padding:"8px 12px",fontSize:"1.1rem"}}>📷</button>
            )}
          </div>
          {camara&&(
            <div style={{marginBottom:"8px",borderRadius:"10px",overflow:"hidden",background:"#000",position:"relative"}}>
              <video ref={videoRef} style={{width:"100%",maxHeight:"220px",objectFit:"cover",display:"block"}} playsInline muted/>
              <div style={{position:"absolute",inset:0,border:"2px solid #84cc16",borderRadius:"10px",pointerEvents:"none"}}/>
              <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",width:"150px",height:"150px",border:"2px solid #84cc16",borderRadius:"8px",boxShadow:"0 0 0 9999px rgba(0,0,0,0.45)"}}/>
              <button onClick={()=>setCamara(false)} style={{position:"absolute",top:"8px",right:"8px",background:"rgba(0,0,0,0.75)",border:"1px solid #84cc16",color:"#84cc16",borderRadius:"6px",padding:"4px 10px",fontSize:"0.75rem",cursor:"pointer"}}>Cerrar</button>
            </div>
          )}
          {resultado&&(
            <div onClick={()=>resultado.ok!==true&&setResultado(null)} style={{padding:"8px 12px",borderRadius:"8px",cursor:resultado.ok===true?"default":"pointer",
              background:resultado.ok===true?"#041f14":resultado.ok==="ya"?"#12172a":"#1c0404",
              border:"1px solid "+(resultado.ok===true?"#065f46":resultado.ok==="ya"?"#252d40":"#7f1d1d"),
              color:resultado.ok===true?"#34d399":resultado.ok==="ya"?"#6b7280":"#f87171",
              fontSize:"0.82rem",fontWeight:700,display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:"8px"}}>
              <div>{resultado.msg}{resultado.envio&&<div style={{fontWeight:400,color:"#9ca3af",marginTop:"2px",fontSize:"0.75rem"}}>{resultado.envio.direccion}{resultado.envio.trans&&<span style={{color:lc[resultado.envio.trans]?.color||"#6b7280",fontWeight:700}}> · {resultado.envio.trans}</span>}{resultado.bultos>1&&<span style={{color:"#f59e0b",fontWeight:700}}> · {resultado.bultos} bultos</span>}</div>}</div>
              {resultado.ok!==true&&<span style={{opacity:0.5,fontSize:"0.75rem",flexShrink:0}}>✕</span>}
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

function VistaChofer({envios,setEnvios,sesion,lc}){
  const hoy=fechaHoy();
  const [tab,setTab]=useState("pendientes");
  const [expandFallo,setExpandFallo]=useState(null); // id del envio con panel fallo abierto
  const [motivoSel,setMotivoSel]=useState({});  // {id: motivo}
  const [notaFallo,setNotaFallo]=useState({});  // {id: texto}
  const [notaModal,setNotaModal]=useState(null); // {id, nota}
  const [notaTemp,setNotaTemp]=useState("");
  const logNombre=sesion.logistica;
  const lcD=lc[logNombre]||{color:"#6366f1"};

  const misEnvios=[...envios].filter(e=>{
    if(e.trans!==logNombre)return false;
    if(getEstado(e)==="cancelado")return false;
    const f=e.fecha||e.fechaVenta||"";
    return f===hoy;
  }).sort((a,b)=>{
    const ta=TURNOS.indexOf(a.turno),tb=TURNOS.indexOf(b.turno);
    return ta-tb;
  });

  const pendientes=misEnvios.filter(e=>!e.entregado&&getEstado(e)!=="fallido");
  const entregados=misEnvios.filter(e=>e.entregado);
  const fallidos=misEnvios.filter(e=>e.estadoEntrega==="fallido"&&!e.entregado);
  const total=misEnvios.length;
  const pct=total>0?Math.round(entregados.length/total*100):0;

  const marcarEntregado=useCallback((envio)=>{
    setEnvios(pv=>pv.map(e=>e.id===envio.id?{...e,entregado:true,estadoEntrega:"entregado",fechaEntrega:hoy,cobranzaRecibida:envio.cobranza!==null?true:e.cobranzaRecibida}:e));
    setExpandFallo(null);
  },[setEnvios,hoy]);

  const confirmarFallo=useCallback((envio)=>{
    const motivo=motivoSel[envio.id]||"";
    if(!motivo)return;
    const nota=notaFallo[envio.id]||"";
    const motivoLabel=MOTIVOS_FALLO.find(m=>m.k===motivo)?.l||motivo;
    const obs=motivoLabel+(nota?" — "+nota:"");
    setEnvios(pv=>pv.map(e=>e.id===envio.id?{...e,estadoEntrega:"fallido",motivoFallo:motivo,observacionFallo:obs}:e));
    setExpandFallo(null);
  },[motivoSel,notaFallo,setEnvios]);

  const guardarNota=useCallback(()=>{
    if(!notaModal)return;
    setEnvios(pv=>pv.map(e=>e.id===notaModal.id?{...e,observaciones:notaTemp}:e));
    setNotaModal(null);
  },[notaModal,notaTemp,setEnvios]);

  const lista=tab==="pendientes"?[...pendientes,...fallidos]:entregados;

  return(
    <div style={{minHeight:"100vh",background:"#0a0e1a",color:"#fff",fontFamily:"sans-serif",maxWidth:"500px",margin:"0 auto"}}>
      <style>{`*{box-sizing:border-box;}`}</style>

      {/* Header */}
      <div style={{position:"sticky",top:0,zIndex:100,background:"#0f1420",borderBottom:"1px solid #1a1f2e"}}>
        <div style={{padding:"0.7rem 1rem",display:"flex",alignItems:"center",gap:"0.75rem"}}>
          <div style={{width:"26px",height:"26px",background:"linear-gradient(135deg,#6366f1,#8b5cf6)",borderRadius:"7px",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:"14px"}}>🛵</div>
          <div>
            <div style={{fontWeight:800,fontSize:"0.92rem"}}>EnviosHub <span style={{color:"#374151",fontSize:"0.6rem",fontWeight:400}}>v{VERSION}</span></div>
            <div style={{color:lcD.color,fontSize:"0.65rem",fontWeight:700}}>{logNombre}</div>
          </div>
          <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:"0.75rem"}}>
            <span style={{color:"#4b5563",fontSize:"0.7rem"}}>{sesion.usuario}</span>
            <button onClick={()=>{clearSession();window.location.reload();}} style={{...S.btnSm(false),color:"#f87171"}}>Salir</button>
          </div>
        </div>
        {/* Tabs */}
        <div style={{display:"flex",borderTop:"1px solid #1a1f2e"}}>
          {[{k:"pendientes",l:`Pendientes (${pendientes.length+fallidos.length})`},{k:"entregados",l:`Entregados (${entregados.length})`}].map(t=>(
            <button key={t.k} onClick={()=>setTab(t.k)} style={{flex:1,padding:"10px",fontSize:"0.72rem",fontWeight:700,background:"none",border:"none",borderBottom:"2px solid "+(tab===t.k?"#6366f1":"transparent"),color:tab===t.k?"#fff":"#4b5563",cursor:"pointer"}}>{t.l}</button>
          ))}
        </div>
      </div>

      <div style={{padding:"12px"}}>
        {/* Resumen */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:"6px",marginBottom:"10px"}}>
          {[
            {n:total,l:"Total",c:"#6366f1"},
            {n:entregados.length,l:"Entregados",c:"#10b981"},
            {n:fallidos.length,l:"Fallidos",c:"#f87171"},
            {n:pendientes.length,l:"Pendientes",c:"#f59e0b"},
          ].map((x,i)=>(
            <div key={i} style={{background:"#1a1f2e",borderRadius:"10px",padding:"8px",textAlign:"center"}}>
              <div style={{fontWeight:800,fontSize:"1.3rem",color:x.c,lineHeight:1}}>{x.n}</div>
              <div style={{color:"#6b7280",fontSize:"0.58rem",textTransform:"uppercase",marginTop:"2px"}}>{x.l}</div>
            </div>
          ))}
        </div>
        <div style={{background:"#1a1f2e",borderRadius:"6px",overflow:"hidden",marginBottom:"14px"}}>
          <div style={{height:"6px",background:"#0f1420"}}>
            <div style={{width:pct+"%",height:"100%",background:pct>=80?"#10b981":pct>=50?"#f59e0b":"#6366f1",transition:"width 0.3s"}}/>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",padding:"3px 10px",fontSize:"10px",color:"#4b5563"}}>
            <span>Progreso del día</span>
            <span style={{color:pct>=80?"#10b981":pct>=50?"#f59e0b":"#6366f1",fontWeight:700}}>{pct}%</span>
          </div>
        </div>

        {/* Lista */}
        {lista.length===0&&<div style={{textAlign:"center",padding:"3rem",color:"#4b5563"}}>
          <div style={{fontSize:"2rem"}}>{tab==="entregados"?"✅":"📦"}</div>
          <p style={{marginTop:"8px"}}>{tab==="entregados"?"Sin entregas aún":"Sin pendientes"}</p>
        </div>}

        {lista.map(envio=>{
          const esFallido=envio.estadoEntrega==="fallido";
          const esTN=envio.origen==="Tienda Nube";
          const falloAbierto=expandFallo===envio.id;
          return(
            <div key={envio.id} style={{background:"#1a1f2e",border:"1px solid "+(esFallido?"#7f1d1d":envio.entregado?"#065f46":"#252d40"),borderRadius:"12px",overflow:"hidden",marginBottom:"8px",opacity:envio.entregado?0.6:1}}>
              {/* Info */}
              <div style={{padding:"12px 14px"}}>
                <div style={{display:"flex",gap:"4px",flexWrap:"wrap",marginBottom:"5px"}}>
                  {esFallido&&<span style={{background:"#1c0404",color:"#f87171",border:"1px solid #f87171",padding:"1px 7px",borderRadius:"4px",fontSize:"9px",fontWeight:700}}>❌ Entrega fallida</span>}
                  {envio.entregado&&<span style={{background:"#041f14",color:"#10b981",border:"1px solid #10b981",padding:"1px 7px",borderRadius:"4px",fontSize:"9px",fontWeight:700}}>✓ Entregado</span>}
                  {!esFallido&&!envio.entregado&&<span style={{background:"#1a1f2e",color:"#9ca3af",border:"1px solid #374151",padding:"1px 7px",borderRadius:"4px",fontSize:"9px",fontWeight:700}}>Sin entregar</span>}
                  {envio.turno&&<Bdg label={envio.turno} bg={TURNO_C[envio.turno]?.bg||"#130d2a"} t={TURNO_C[envio.turno]?.c||"#a78bfa"}/>}
                  {esTN&&<span style={{background:"#0d1c2e",color:"#38bdf8",border:"1px solid #38bdf8",padding:"1px 7px",borderRadius:"4px",fontSize:"9px",fontWeight:700}}>#{envio.nroOrdenTN}</span>}
                  {envio.bultos>0&&<span style={{background:"#12172a",color:"#60a5fa",padding:"1px 7px",borderRadius:"4px",fontSize:"9px",fontWeight:700}}>{envio.bultos} bulto{envio.bultos>1?"s":""}</span>}
                </div>
                <div style={{color:"#e5e7eb",fontSize:"0.88rem",fontWeight:600,marginBottom:"2px"}}>{envio.direccion}</div>
                <div style={{color:"#6b7280",fontSize:"0.72rem"}}>{envio.localidad?envio.localidad+" · ":""}{envio.partido}{envio.cp?" · CP "+envio.cp:""}</div>
                {esFallido&&envio.observacionFallo&&<div style={{marginTop:"5px",color:"#f87171",fontSize:"0.72rem"}}>⚠ {envio.observacionFallo}</div>}
                {envio.observaciones&&!esFallido&&<div style={{marginTop:"5px",color:"#9ca3af",fontSize:"0.72rem",fontStyle:"italic"}}>"{envio.observaciones}"</div>}
                {envio.notasCliente&&<div style={{marginTop:"5px",background:"#0d1119",borderRadius:"6px",padding:"5px 8px",color:"#9ca3af",fontSize:"0.72rem"}}>📋 {envio.notasCliente}</div>}
              </div>

              {/* Cobranza */}
              {envio.cobranza!==null&&!envio.entregado&&<div style={{background:"#1c1500",padding:"8px 14px",borderTop:"1px solid #252d40",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase"}}>💰 Cobrar en efectivo</div>
                  <div style={{color:"#fbbf24",fontWeight:800,fontSize:"1rem"}}>{fmt(envio.cobranza)}</div>
                </div>
                <div style={{color:"#6b7280",fontSize:"0.68rem",textAlign:"right"}}>{envio.formaPago||"Efectivo"}</div>
              </div>}
              {envio.entregado&&envio.cobranza!==null&&<div style={{background:"#041f14",padding:"6px 14px",borderTop:"1px solid #065f46",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{color:"#10b981",fontSize:"0.72rem",fontWeight:700}}>✓ Cobrado</div>
                <div style={{color:"#10b981",fontWeight:700}}>{fmt(envio.cobranza)}</div>
              </div>}

              {/* Acciones — solo si no está entregado */}
              {!envio.entregado&&!falloAbierto&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px",padding:"10px 14px",background:"#12172a",borderTop:"1px solid #1a1f2e"}}>
                <button onClick={()=>marcarEntregado(envio)} style={{padding:"9px",borderRadius:"8px",fontWeight:700,fontSize:"0.78rem",background:"#041f14",color:"#10b981",border:"1px solid #10b981",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:"2px"}}>
                  <span style={{fontSize:"16px"}}>✅</span><small style={{fontSize:"0.62rem"}}>Entregar</small>
                </button>
                <button onClick={()=>setExpandFallo(envio.id)} style={{padding:"9px",borderRadius:"8px",fontWeight:700,fontSize:"0.78rem",background:"#1c0404",color:"#f87171",border:"1px solid #f87171",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:"2px"}}>
                  <span style={{fontSize:"16px"}}>❌</span><small style={{fontSize:"0.62rem"}}>Fallo</small>
                </button>
                <button onClick={()=>{setNotaTemp(envio.observaciones||"");setNotaModal({id:envio.id});}} style={{padding:"9px",borderRadius:"8px",fontWeight:700,fontSize:"0.78rem",background:"#0f1420",color:"#9ca3af",border:"1px solid #252d40",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:"6px",gridColumn:"1/-1"}}>
                  <span style={{fontSize:"14px"}}>📝</span><small style={{fontSize:"0.72rem"}}>{envio.observaciones?"Editar nota":"Agregar nota"}</small>
                </button>
              </div>}

              {/* Panel fallo */}
              {falloAbierto&&<div style={{padding:"12px 14px",background:"#1c0404",borderTop:"1px solid #7f1d1d"}}>
                <div style={{color:"#f87171",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",marginBottom:"8px"}}>¿Por qué no se entregó?</div>
                <div style={{display:"flex",flexDirection:"column",gap:"5px",marginBottom:"8px"}}>
                  {MOTIVOS_FALLO.map(m=>(
                    <button key={m.k} onClick={()=>setMotivoSel(pv=>({...pv,[envio.id]:m.k}))} style={{padding:"9px 12px",borderRadius:"8px",background:motivoSel[envio.id]===m.k?"#1c0404":"#12172a",border:"1px solid "+(motivoSel[envio.id]===m.k?"#f87171":"#374151"),color:motivoSel[envio.id]===m.k?"#f87171":"#e5e7eb",fontSize:"0.78rem",textAlign:"left",cursor:"pointer",display:"flex",alignItems:"center",gap:"8px"}}>
                      <span style={{fontSize:"15px"}}>{m.icon}</span>{m.l}
                    </button>
                  ))}
                </div>
                <textarea value={notaFallo[envio.id]||""} onChange={ev=>setNotaFallo(pv=>({...pv,[envio.id]:ev.target.value}))} placeholder="Nota adicional (opcional)..." style={{...S.input,width:"100%",height:"56px",resize:"none",fontSize:"0.8rem",marginBottom:"8px"}}/>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px"}}>
                  <button onClick={()=>setExpandFallo(null)} style={{padding:"10px",borderRadius:"8px",background:"#12172a",border:"1px solid #374151",color:"#9ca3af",fontWeight:700,cursor:"pointer"}}>Cancelar</button>
                  <button onClick={()=>confirmarFallo(envio)} disabled={!motivoSel[envio.id]} style={{padding:"10px",borderRadius:"8px",background:motivoSel[envio.id]?"#f87171":"#374151",color:"#fff",fontWeight:700,cursor:"pointer",opacity:motivoSel[envio.id]?1:0.5}}>Confirmar</button>
                </div>
              </div>}
            </div>
          );
        })}
      </div>

      {/* Modal nota */}
      {notaModal&&<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}>
        <div style={{...S.card,padding:"1.2rem",width:"100%",maxWidth:"360px"}}>
          <div style={{fontWeight:700,fontSize:"0.9rem",marginBottom:"10px"}}>Nota del envío</div>
          <textarea value={notaTemp} onChange={ev=>setNotaTemp(ev.target.value)} placeholder="Escribí una nota..." style={{...S.input,width:"100%",height:"80px",resize:"none",marginBottom:"10px"}}/>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px"}}>
            <button onClick={()=>setNotaModal(null)} style={{...S.btn(false),padding:"0.5rem"}}>Cancelar</button>
            <button onClick={guardarNota} style={{...S.btn(true),padding:"0.5rem"}}>Guardar</button>
          </div>
        </div>
      </div>}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// TAB CLIENTES
// ════════════════════════════════════════════════════════════════════
function TabClientes({envios,lc,pagosCC=[],facturaClientes={},setFacturaCliente=()=>{},sesion=null}){
  const fmt=(n)=>"$"+Math.round(n).toLocaleString("es-AR");
  const [busqueda,setBusqueda]=useState("");
  const [vistaCliente,setVistaCliente]=useState(null);
  const [clientesMeta,setClientesMeta]=useState({}); // {key:{telefono,notas}}
  const [editando,setEditando]=useState({}); // {key:{telefono,notas}}
  const [guardando,setGuardando]=useState({});

  // Cargar metadata editable de clientes desde Firestore
  useEffect(()=>{
    const unsub=onSnapshot(collection(db,"clientes"),snap=>{
      const m={};
      snap.docs.forEach(d=>{ m[d.id]={...d.data(),_id:d.id}; });
      setClientesMeta(m);
    });
    return()=>unsub();
  },[]);

  const guardarMeta=async(key,data)=>{
    setGuardando(p=>({...p,[key]:true}));
    try{ await setDoc(doc(db,"clientes",key),data,{merge:true}); }
    catch(e){ console.error(e); }
    finally{ setGuardando(p=>({...p,[key]:false})); }
  };

  // Solo Manual + TN (sin ML)
  const enviosFiltrados=useMemo(()=>envios.filter(e=>e.origen!=="ML"),[envios]);

  // Agrupar por clienteKey
  const clientes=useMemo(()=>{
    const map={};
    enviosFiltrados.forEach(e=>{
      const key=mkClienteKey(e.clienteNombre)||"sin_nombre_"+e.id;
      if(!map[key])map[key]={key,nombre:e.clienteNombre||"Sin nombre",envios:[],origenes:new Set(),fechaUltimo:"",telefono:e.telefono||""};
      map[key].envios.push(e);
      if(e.origen)map[key].origenes.add(e.origen);
      if(e.telefono&&!map[key].telefono)map[key].telefono=e.telefono;
      const f=e.fechaVenta||e.fecha||"";
      if(f>map[key].fechaUltimo)map[key].fechaUltimo=f;
    });
    return Object.values(map).sort((a,b)=>b.fechaUltimo.localeCompare(a.fechaUltimo));
  },[enviosFiltrados]);

  // Calcular saldo CC por cliente
  const saldoCC=useMemo(()=>{
    const res={};
    clientes.forEach(c=>{
      let deuda=0;
      c.envios.forEach(e=>{
        if(e.estado==="cancelado")return;
        if(e.pagoEstado==="cuenta_corriente"&&e.importeOrden>0)deuda+=(e.cobranza>0?e.cobranza:e.importeOrden);
        else if(e.esCC&&e.importeCC>0&&!(e.pagoEstado==="pagado"&&e.importeCC===e.importeOrden))deuda+=e.importeCC;
      });
      if(deuda===0){res[c.key]=0;return;}
      const cobrado=pagosCC.filter(p=>p.clienteKey===c.key).reduce((s,p)=>s+(p.monto||0),0);
      res[c.key]=Math.max(0,deuda-cobrado);
    });
    return res;
  },[clientes,pagosCC]);

  const norm=s=>(s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"");
  const clientesFiltrados=useMemo(()=>{
    if(!busqueda)return clientes;
    const s=norm(busqueda);
    return clientes.filter(c=>norm(c.nombre).includes(s)||(c.telefono||"").includes(s));
  },[clientes,busqueda]);

  // ── Vista detalle de un cliente ──
  if(vistaCliente){
    const c=clientes.find(cl=>cl.key===vistaCliente);
    if(!c)return null;
    const meta=clientesMeta[c.key]||{};
    const edit=editando[c.key]||{telefono:meta.telefono||c.telefono||"",notas:meta.notas||""};
    const setEdit=(k,v)=>setEditando(p=>({...p,[c.key]:{...edit,[k]:v}}));
    const saveEdit=()=>guardarMeta(c.key,{telefono:edit.telefono,notas:edit.notas});
    const enviosOrdenados=[...c.envios].sort((a,b)=>(b.fechaVenta||b.fecha||"").localeCompare(a.fechaVenta||a.fecha||""));
    const saldo=saldoCC[c.key]||0;

    return(
      <div style={{maxWidth:"820px"}}>
        <button onClick={()=>setVistaCliente(null)} style={{...S.btn(false),marginBottom:"1rem",fontSize:"0.78rem"}}>← Volver</button>

        {/* Header cliente */}
        <div style={{...S.card,padding:"1rem 1.25rem",marginBottom:"1rem"}}>
          <div style={{display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:"0.75rem",marginBottom:"0.75rem"}}>
            <div>
              <div style={{fontWeight:800,fontSize:"1rem",color:"#e5e7eb"}}>{c.nombre}</div>
              <div style={{display:"flex",gap:"4px",marginTop:"4px",flexWrap:"wrap"}}>
                {[...c.origenes].map(o=><span key={o} style={{fontSize:"0.65rem",padding:"1px 7px",background:"#12172a",color:"#94a3b8",borderRadius:"4px",border:"1px solid #1e2535"}}>{o}</span>)}
                {facturaClientes[c.key]&&<span style={{fontSize:"0.65rem",padding:"1px 7px",background:"#1c0d00",color:"#fb923c",borderRadius:"4px",border:"1px solid #c2410c"}}>🧾 Factura impresa</span>}
              </div>
            </div>
            <div style={{display:"flex",gap:"1rem",flexWrap:"wrap",alignItems:"flex-end"}}>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:"0.6rem",color:"#6b7280",textTransform:"uppercase",fontWeight:700}}>Pedidos</div>
                <div style={{fontSize:"1.1rem",fontWeight:800,color:"#e5e7eb"}}>{c.envios.length}</div>
              </div>
              {saldo>0&&<div style={{textAlign:"right"}}>
                <div style={{fontSize:"0.6rem",color:"#6b7280",textTransform:"uppercase",fontWeight:700}}>Saldo CC</div>
                <div style={{fontSize:"1.1rem",fontWeight:800,color:"#ef4444"}}>{fmt(saldo)}</div>
              </div>}
            </div>
          </div>

          {/* Edición teléfono + notas */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.6rem",marginBottom:"0.6rem"}}>
            <div>
              <div style={{fontSize:"0.62rem",color:"#6b7280",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Teléfono</div>
              <input value={edit.telefono} onChange={ev=>setEdit("telefono",ev.target.value)} style={{...S.input,width:"100%",fontSize:"0.82rem"}} placeholder="Ej. 1165432100"/>
            </div>
            <div>
              <div style={{fontSize:"0.62rem",color:"#6b7280",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Notas</div>
              <input value={edit.notas} onChange={ev=>setEdit("notas",ev.target.value)} style={{...S.input,width:"100%",fontSize:"0.82rem"}} placeholder="Observaciones del cliente..."/>
            </div>
          </div>
          <div style={{display:"flex",gap:"0.5rem",alignItems:"center"}}>
            <button onClick={saveEdit} disabled={guardando[c.key]} style={{...S.btn(true),background:"linear-gradient(135deg,#6366f1,#8b5cf6)",padding:"0.3rem 0.9rem",fontSize:"0.78rem"}}>
              {guardando[c.key]?"Guardando...":"Guardar"}
            </button>
            <button onClick={()=>setFacturaCliente(c.key,!facturaClientes[c.key])} style={{...S.btnSm(!!facturaClientes[c.key],"#f97316"),fontSize:"0.72rem",border:"1px solid "+(facturaClientes[c.key]?"#f97316":"#374151")}}>
              🧾 Factura impresa {facturaClientes[c.key]?"✓":"—"}
            </button>
          </div>
        </div>

        {/* Historial de pedidos */}
        <div style={{...S.card,overflow:"hidden"}}>
          <div style={{padding:"0.6rem 1rem",background:"#12172a",borderBottom:"1px solid #1e2535",fontSize:"0.72rem",fontWeight:700,color:"#6b7280",textTransform:"uppercase"}}>
            Historial de pedidos ({enviosOrdenados.length})
          </div>
          {enviosOrdenados.map((e,i)=>{
            const est=getEstado(e);
            const estC=ESTADO_C[est]||ESTADO_C.sin_asignar;
            return(
              <div key={e.id} style={{padding:"0.6rem 1rem",borderBottom:i<enviosOrdenados.length-1?"1px solid #1a1f2e":"none",display:"flex",gap:"0.75rem",alignItems:"center",flexWrap:"wrap",opacity:est==="cancelado"?0.45:1}}>
                <div style={{flex:1,minWidth:"200px"}}>
                  <div style={{fontSize:"0.82rem",color:"#d1d5db",fontWeight:500,textDecoration:est==="cancelado"?"line-through":"none"}}>{e.direccion?.slice(0,55)}</div>
                  <div style={{display:"flex",gap:"5px",marginTop:"3px",flexWrap:"wrap",alignItems:"center"}}>
                    <span style={{fontSize:"0.68rem",padding:"1px 5px",background:estC.bg,color:estC.t,borderRadius:"4px",fontWeight:700}}>{estC.label}</span>
                    {e.trans&&<span style={{fontSize:"0.65rem",padding:"1px 5px",background:lc[e.trans]?.color+"22",color:lc[e.trans]?.color,borderRadius:"4px",fontWeight:700}}>{e.trans}</span>}
                    {e.nroOrdenTN&&<span style={{fontFamily:"monospace",fontSize:"0.68rem",color:"#7dd3fc",fontWeight:700}}>#{e.nroOrdenTN}</span>}
                    {e.nroFactura&&<span style={{fontFamily:"monospace",fontSize:"0.65rem",padding:"1px 6px",background:"#130d2a",color:"#c4b5fd",borderRadius:"4px",border:"1px solid #4c1d95"}}>FC {e.nroFactura}</span>}
                    {facturaClientes[c.key]&&e.trans&&!e.nroFactura&&est!=="cancelado"&&<span style={{fontSize:"0.65rem",padding:"1px 6px",background:"#1c0d00",color:"#fb923c",borderRadius:"4px",border:"1px solid #c2410c",fontWeight:700}}>FC ⚠</span>}
                  </div>
                </div>
                <div style={{textAlign:"right",flexShrink:0}}>
                  {e.fechaVenta&&<div style={{fontSize:"0.68rem",color:"#6b7280"}}>Venta {fmtCorta(e.fechaVenta)}</div>}
                  {e.fecha&&<div style={{fontSize:"0.68rem",color:"#94a3b8"}}>Envío {fmtCorta(e.fecha)}</div>}
                  {(e.cobranza>0||(e.importeCC>0&&e.esCC)||(e.importeOrden>0&&e.pagoEstado==="cuenta_corriente"))&&
                    <div style={{fontSize:"0.78rem",fontWeight:700,color:"#f59e0b",marginTop:"2px"}}>{fmt(e.cobranza||e.importeCC||e.importeOrden||0)}</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Lista de clientes ──
  return(
    <div>
      <div style={{display:"flex",gap:"0.5rem",alignItems:"center",marginBottom:"1rem",flexWrap:"wrap"}}>
        <h2 style={{margin:0,fontWeight:800,fontSize:"1rem",color:"#e5e7eb"}}>Clientes</h2>
        <span style={{fontSize:"0.72rem",color:"#4b5563",background:"#12172a",padding:"2px 8px",borderRadius:"10px"}}>{clientesFiltrados.length} clientes · Manual + TN</span>
        <input value={busqueda} onChange={e=>setBusqueda(e.target.value)} placeholder="Buscar por nombre o teléfono..." style={{...S.input,width:"260px",marginLeft:"auto",padding:"0.3rem 0.7rem",fontSize:"0.78rem"}}/>
      </div>

      <div style={{...S.card,overflow:"hidden"}}>
        <table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead>
            <tr style={{background:"#12172a"}}>
              {["Cliente","Teléfono","Origen","Pedidos","Último pedido","Saldo CC",""].map((h,i)=>(
                <th key={i} style={{padding:"8px 10px",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",color:"#6b7280",textAlign:i>1?"center":"left",borderBottom:"1px solid #1e2535",whiteSpace:"nowrap"}}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {clientesFiltrados.length===0&&(
              <tr><td colSpan={7} style={{padding:"2rem",textAlign:"center",color:"#4b5563"}}>Sin resultados</td></tr>
            )}
            {clientesFiltrados.map((c,i)=>{
              const meta=clientesMeta[c.key]||{};
              const tel=meta.telefono||c.telefono||"";
              const saldo=saldoCC[c.key]||0;
              const factPendientes=facturaClientes[c.key]?c.envios.filter(e=>e.trans&&!e.nroFactura&&getEstado(e)!=="cancelado").length:0;
              return(
                <tr key={c.key} style={{background:i%2===0?"transparent":"#0d1119",borderBottom:"1px solid #1a1f2e",cursor:"pointer"}} onClick={()=>setVistaCliente(c.key)}>
                  <td style={{padding:"10px 10px"}}>
                    <div style={{fontWeight:600,fontSize:"0.82rem",color:"#e5e7eb",display:"flex",gap:"6px",alignItems:"center"}}>
                      {c.nombre}
                      {factPendientes>0&&<span style={{fontSize:"0.62rem",padding:"1px 6px",background:"#1c0d00",color:"#fb923c",borderRadius:"10px",border:"1px solid #c2410c",fontWeight:800}}>FC ⚠ {factPendientes}</span>}
                    </div>
                    {meta.notas&&<div style={{fontSize:"0.65rem",color:"#4b5563",marginTop:"1px"}}>{meta.notas.slice(0,50)}</div>}
                  </td>
                  <td style={{padding:"10px 10px",fontSize:"0.78rem",color:"#94a3b8",fontFamily:"monospace"}}>{tel||"—"}</td>
                  <td style={{padding:"10px 10px",textAlign:"center"}}>
                    <div style={{display:"flex",gap:"3px",justifyContent:"center",flexWrap:"wrap"}}>
                      {[...c.origenes].map(o=><span key={o} style={{fontSize:"0.62rem",padding:"1px 5px",background:"#12172a",color:"#6b7280",borderRadius:"4px"}}>{o}</span>)}
                    </div>
                  </td>
                  <td style={{padding:"10px 10px",textAlign:"center",color:"#e5e7eb",fontWeight:600}}>{c.envios.length}</td>
                  <td style={{padding:"10px 10px",textAlign:"center",color:"#6b7280",fontSize:"0.78rem"}}>{c.fechaUltimo?fmtCorta(c.fechaUltimo):"—"}</td>
                  <td style={{padding:"10px 10px",textAlign:"center",fontWeight:700,color:saldo>0?"#ef4444":"#4b5563"}}>{saldo>0?fmt(saldo):"—"}</td>
                  <td style={{padding:"10px 10px"}}>
                    <button onClick={ev=>{ev.stopPropagation();setVistaCliente(c.key);}} style={{...S.btnSm(false,"#6366f1"),fontSize:"0.68rem"}}>Ver</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TabTablero({envios,lc,zc,pagosCC=[]}){
  const hoy=fechaHoy();
  const [ccOpen,setCcOpen]=useState(false);
  const [cobOpen,setCobOpen]=useState(false);
  const tmap=buildTarifaMap(zc);
  const getImp=e=>calcImp(e,tmap,lc,zc);

  // Envios de hoy
  const deHoy=envios.filter(e=>{
    const f=e.fecha||e.fechaVenta||"";
    return f===hoy&&e.estado!=="cancelado";
  });
  const flex=deHoy.filter(e=>e.origen==="ML");
  const noflex=deHoy.filter(e=>e.origen!=="ML");
  const total=deHoy.length;
  const sinAsignar=deHoy.filter(e=>getEstado(e)==="sin_asignar");
  const asignados=deHoy.filter(e=>getEstado(e)==="asignado");
  const preparados=deHoy.filter(e=>e.preparado);
  const pct=total>0?Math.round(preparados.length/total*100):0;

  const flexSinAsig=flex.filter(e=>getEstado(e)==="sin_asignar");
  const noflexSinAsig=noflex.filter(e=>getEstado(e)==="sin_asignar");
  const flexPrep=flex.filter(e=>e.preparado);
  const noflexPrep=noflex.filter(e=>e.preparado);
  const flexPct=flex.length>0?Math.round(flexPrep.length/flex.length*100):0;
  const noflexPct=noflex.length>0?Math.round(noflexPrep.length/noflex.length*100):0;

  const logActivas=Object.entries(lc).filter(([,v])=>v.activa).map(([k])=>k);

  // Alertas
  const sinDir=envios.filter(e=>e.alertaDireccion&&getEstado(e)!=="cancelado");
  const pagoPend=envios.filter(e=>e.pagoEstado==="pendiente"&&getEstado(e)!=="cancelado");
  const sinAsigHoy=sinAsignar.length;

  // Cobranzas acumuladas
  const cobPorLog=logActivas.map(l =>{
    const envsLog=envios.filter(e=>e.trans===l&&e.cobranza!==null&&e.cobranza>0&&getEstado(e)!=="cancelado");
    const deudaAnterior=envsLog.filter(e=>{const f=e.fecha||"";return f<hoy&&!e.cobranzaRecibida;}).reduce((s,e)=>s+(e.cobranza||0),0);
    const diasDeuda=envsLog.filter(e=>{const f=e.fecha||"";return f<hoy&&!e.cobranzaRecibida;}).reduce((max,e)=>{
      const dias=Math.floor((new Date(hoy)-new Date(e.fecha||hoy))/86400000);
      return Math.max(max,dias);
    },0);
    const saleHoy=envsLog.filter(e=>(e.fecha||"")==hoy&&!e.cobranzaRecibida).reduce((s,e)=>s+(e.cobranza||0),0);
    return{l,deudaAnterior,saleHoy,total:deudaAnterior+saleHoy,diasDeuda};
  }).filter(x =>x.total>0||x.saleHoy>0);

  // CC pendiente por cliente — con matching de pagos por pedido para calcular fechaMin correcta
  const ccPorCliente=(()=>{
    const map={};
    envios.forEach(e=>{
      if(getEstado(e)==="cancelado")return;
      const esTNCC=e.pagoEstado==="cuenta_corriente"&&e.importeOrden>0;
      const esManualCC=e.esCC&&e.importeCC>0&&!(e.pagoEstado==="pagado"&&e.importeCC===e.importeOrden);
      if(!esTNCC&&!esManualCC)return;
      const montoOrig=esTNCC?(e.cobranza>0?e.cobranza:e.importeOrden):e.importeCC;
      // Calcular saldo real de este pedido descontando pagos específicos
      const pagadoEnvio=pagosCC.filter(p=>p.envioIds?.includes(e.id)).reduce((s,p)=>{
        if(p.montosPorEnvio)return s+(p.montosPorEnvio[e.id]||0);
        if((p.envioIds?.length||0)===1)return s+(p.monto||0);
        return s;
      },0);
      const saldoE=saldoTolerante(montoOrig,pagadoEnvio);
      if(saldoE<=0)return; // ya pago, no cuenta para fechaMin
      const nombre=e.clienteNombre||"Sin nombre";
      const fecha=e.fecha||e.fechaVenta||"";
      if(!map[nombre])map[nombre]={nombre,deuda:0,fechaMin:fecha};
      map[nombre].deuda+=saldoE;
      if(fecha&&(!map[nombre].fechaMin||fecha<map[nombre].fechaMin))map[nombre].fechaMin=fecha;
    });
    return Object.values(map).filter(c=>c.deuda>0).map(c=>{
      const dias=c.fechaMin?Math.max(0,Math.floor((new Date(hoy)-new Date(c.fechaMin+"T00:00:00"))/86400000)):0;
      return{...c,dias};
    }).sort((a,b)=>b.dias-a.dias);
  })();
  const totalCC=ccPorCliente.reduce((s,c)=>s+c.deuda,0);

  const cardSt={background:"#1a1f2e",border:"1px solid #252d40",borderRadius:"12px",padding:"14px 16px"};
  const pillFlex={background:"#0d1c04",color:"#84cc16",border:"1px solid #84cc16",padding:"2px 8px",borderRadius:"5px",fontSize:"10px",fontWeight:700};
  const pillNoflex={background:"#12172a",color:"#6366f1",border:"1px solid #6366f1",padding:"2px 8px",borderRadius:"5px",fontSize:"10px",fontWeight:700};
  const pb=(pct2,color)=>(
    <div style={{marginTop:"8px"}}>
      <div style={{height:"6px",background:"#0f1420",borderRadius:"3px",overflow:"hidden"}}>
        <div style={{width:pct2+"%",height:"100%",background:color,borderRadius:"3px"}}/>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:"9px",color:"#4b5563",marginTop:"2px"}}>
        <span>Preparados</span><span style={{color}}>{pct2}%</span>
      </div>
    </div>
  );

  return(
    <div style={{display:"flex",flexDirection:"column",gap:"16px",paddingBottom:"40px"}}>
      {/* Fecha */}
      <div style={{color:"#4b5563",fontSize:"0.72rem"}}>{new Date().toLocaleDateString("es-AR",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}</div>

      {/* 1. RESUMEN */}
      <div>
        <div style={{color:"#4b5563",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",letterSpacing:".08em",marginBottom:"8px"}}>Resumen del día</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:"8px"}}>
          {[
            {num:total,label:"Total envíos",color:"#6366f1",fl:flex.length,nfl:noflex.length},
            {num:sinAsignar.length,label:"Sin asignar",color:"#f59e0b",fl:flexSinAsig.length,nfl:noflexSinAsig.length},
            {num:asignados.length,label:"Asignados",color:"#38bdf8",fl:flex.filter(e=>getEstado(e)==="asignado").length,nfl:noflex.filter(e=>getEstado(e)==="asignado").length},
            {num:preparados.length,label:"Preparados",color:"#10b981",fl:flexPrep.length,nfl:noflexPrep.length,showPb:true,pct},
          ].map((x,i)=>(
            <div key={i} style={{...cardSt,borderLeft:"3px solid "+x.color}}>
              <div style={{fontWeight:800,fontSize:"2rem",color:x.color,lineHeight:1}}>{x.num}</div>
              <div style={{color:"#6b7280",fontSize:"0.62rem",textTransform:"uppercase",marginBottom:"6px"}}>{x.label}</div>
              <div style={{display:"flex",gap:"5px"}}>
                <span style={pillFlex}>FLEX {x.fl}</span>
                <span style={pillNoflex}>NO FLEX {x.nfl}</span>
              </div>
              {x.showPb&&pb(x.pct,"#10b981")}
            </div>
          ))}
        </div>
      </div>

      {/* 2. DETALLE POR TIPO */}
      <div>
        <div style={{color:"#4b5563",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",letterSpacing:".08em",marginBottom:"8px"}}>Detalle por tipo</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"10px"}}>
          {[
            {label:"FLEX — Mercado Libre",via:"QR scan",items:flex,prep:flexPrep,sinAsig2:flexSinAsig,pct2:flexPct,color:"#84cc16",border:"#84cc1644"},
            {label:"NO FLEX — TN + Manual",via:"carga bultos",items:noflex,prep:noflexPrep,sinAsig2:noflexSinAsig,pct2:noflexPct,color:"#6366f1",border:"#6366f144"},
          ].map((t,i)=>(
            <div key={i} style={{background:"#12172a",borderRadius:"10px",padding:"12px",border:"1px solid "+t.border}}>
              <div style={{display:"flex",alignItems:"center",gap:"8px",marginBottom:"10px"}}>
                <span style={{...i===0?pillFlex:pillNoflex,fontSize:"11px",padding:"3px 10px"}}>{t.label}</span>
                <span style={{color:"#4b5563",fontSize:"0.65rem",marginLeft:"auto"}}>vía {t.via}</span>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:"6px"}}>
                {[
                  {n:t.items.length,l:"Total",c:"#6366f1"},
                  {n:t.sinAsig2.length,l:"Sin asignar",c:"#f59e0b"},
                  {n:t.prep.length,l:"Preparados",c:"#10b981"},
                  {n:t.items.filter(e=>getEstado(e)==="asignado").length,l:"Asignados",c:"#38bdf8"},
                  {n:t.items.filter(e=>e.preparado===undefined||!e.preparado).length,l:"Sin preparar",c:"#9ca3af"},
                  {n:t.pct2+"%",l:"% listo",c:t.color},
                ].map((m,j)=>(
                  <div key={j} style={{background:"#0f1420",borderRadius:"8px",padding:"8px 10px"}}>
                    <div style={{fontWeight:800,fontSize:"1.3rem",color:m.c,lineHeight:1}}>{m.n}</div>
                    <div style={{color:"#6b7280",fontSize:"0.58rem",textTransform:"uppercase",marginTop:"2px"}}>{m.l}</div>
                  </div>
                ))}
              </div>
              {pb(t.pct2,t.color)}
            </div>
          ))}
        </div>
      </div>

      {/* 3. POR LOGISTICA */}
      {logActivas.length>0&&<div>
        <div style={{color:"#4b5563",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",letterSpacing:".08em",marginBottom:"8px"}}>Por logística</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:"10px"}}>
          {logActivas.map(l =>{
            const lcD=lc[l];
            const envL=deHoy.filter(e=>e.trans===l);
            if(!envL.length)return null;
            const prepL=envL.filter(e=>e.preparado);
            const pctL=envL.length>0?Math.round(prepL.length/envL.length*100):0;
            const flexL=envL.filter(e=>e.origen==="ML");
            const noflexL=envL.filter(e=>e.origen!=="ML");
            const flexPrepL=flexL.filter(e=>e.preparado);
            const noflexPrepL=noflexL.filter(e=>e.preparado);
            const pctColor=pctL>=80?"#10b981":pctL>=50?"#f59e0b":"#f87171";
            const circ=138; // 2*pi*22
            const dash=Math.round(circ*pctL/100);
            const amTurno=envL.filter(e=>e.turno==="AM").length;
            const pmTurno=envL.filter(e=>e.turno==="PM").length;
            return(
              <div key={l} style={{background:"#1a1f2e",border:"1px solid #252d40",borderRadius:"12px",overflow:"hidden",borderTop:"3px solid "+lcD.color}}>
                <div style={{padding:"10px 14px",display:"flex",alignItems:"center",gap:"8px",borderBottom:"1px solid #252d40"}}>
                  <span style={{color:lcD.color,fontWeight:800,fontSize:"0.92rem"}}>{l}</span>
                  <div style={{marginLeft:"auto",display:"flex",gap:"3px"}}>
                    {amTurno>0&&<span style={{background:"#0c1a2e",color:"#60a5fa",padding:"1px 6px",borderRadius:"4px",fontSize:"9px",fontWeight:700}}>AM {amTurno}</span>}
                    {pmTurno>0&&<span style={{background:"#130d2a",color:"#a78bfa",padding:"1px 6px",borderRadius:"4px",fontSize:"9px",fontWeight:700}}>PM {pmTurno}</span>}
                  </div>
                </div>
                <div style={{padding:"12px 14px"}}>
                  <div style={{display:"flex",alignItems:"center",gap:"12px",marginBottom:"12px"}}>
                    <div style={{position:"relative",width:"60px",height:"60px",flexShrink:0}}>
                      <svg width="60" height="60" viewBox="0 0 60 60" style={{transform:"rotate(-90deg)"}}>
                        <circle cx="30" cy="30" r="22" fill="none" stroke="#252d40" strokeWidth="9"/>
                        <circle cx="30" cy="30" r="22" fill="none" stroke={pctColor} strokeWidth="9" strokeDasharray={dash+" "+(circ-dash)} strokeLinecap="round"/>
                      </svg>
                      <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
                        <span style={{fontSize:"13px",fontWeight:800,color:pctColor}}>{pctL}%</span>
                      </div>
                    </div>
                    <div style={{flex:1,fontSize:"11px",display:"grid",gap:"2px"}}>
                      <div style={{display:"flex",justifyContent:"space-between"}}><span style={{color:"#6b7280"}}>Total</span><span style={{fontWeight:700}}>{envL.length}</span></div>
                      <div style={{display:"flex",justifyContent:"space-between"}}><span style={{color:"#10b981"}}>Preparados</span><span style={{fontWeight:700,color:"#10b981"}}>{prepL.length}</span></div>
                      <div style={{display:"flex",justifyContent:"space-between"}}><span style={{color:"#38bdf8"}}>Pendientes</span><span style={{fontWeight:700,color:"#38bdf8"}}>{envL.length-prepL.length}</span></div>
                    </div>
                  </div>
                  {flexL.length>0&&<div style={{marginBottom:"5px"}}>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:"9px",marginBottom:"2px"}}>
                      <span style={{color:flexPrepL.length===0&&flexL.length>0?"#f87171":"#84cc16",fontWeight:700}}>FLEX{flexPrepL.length===0&&flexL.length>0?" ⚠":""}</span>
                      <span style={{color:flexPrepL.length===0&&flexL.length>0?"#f87171":"#84cc16"}}>{flexPrepL.length}/{flexL.length}</span>
                    </div>
                    <div style={{height:"6px",background:"#0f1420",borderRadius:"3px",overflow:"hidden"}}>
                      <div style={{width:(flexL.length>0?Math.round(flexPrepL.length/flexL.length*100):0)+"%",height:"100%",background:flexPrepL.length===0&&flexL.length>0?"#f87171":"#84cc16",borderRadius:"3px"}}/>
                    </div>
                  </div>}
                  {noflexL.length>0&&<div>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:"9px",marginBottom:"2px"}}>
                      <span style={{color:"#6366f1",fontWeight:700}}>NO FLEX</span>
                      <span style={{color:"#6366f1"}}>{noflexPrepL.length}/{noflexL.length}</span>
                    </div>
                    <div style={{height:"6px",background:"#0f1420",borderRadius:"3px",overflow:"hidden"}}>
                      <div style={{width:(noflexL.length>0?Math.round(noflexPrepL.length/noflexL.length*100):0)+"%",height:"100%",background:"#6366f1",borderRadius:"3px"}}/>
                    </div>
                  </div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>}

      {/* 4. ALERTAS + COBRANZAS */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"12px"}}>
        <div>
          <div style={{color:"#4b5563",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",letterSpacing:".08em",marginBottom:"8px"}}>Alertas</div>
          {sinAsigHoy>0&&<div style={{display:"flex",gap:"10px",padding:"10px 14px",borderRadius:"10px",marginBottom:"6px",background:"#1c0404",border:"1px solid #7f1d1d",color:"#f87171",fontSize:"0.75rem"}}><span>🔴</span><div><div style={{fontWeight:700,marginBottom:"2px"}}>{sinAsigHoy} pedidos sin asignar hoy</div><div style={{fontSize:"0.68rem",opacity:.7}}>FLEX: {flexSinAsig.length} · NO FLEX: {noflexSinAsig.length}</div></div></div>}
          {pagoPend.length>0&&<div style={{display:"flex",gap:"10px",padding:"10px 14px",borderRadius:"10px",marginBottom:"6px",background:"#1c1400",border:"1px solid #78350f",color:"#f59e0b",fontSize:"0.75rem"}}><span>🟡</span><div><div style={{fontWeight:700,marginBottom:"2px"}}>{pagoPend.length} pedidos con pago pendiente</div><div style={{fontSize:"0.68rem",opacity:.7}}>Revisar autorización Cta. Corriente</div></div></div>}
          {sinDir.length>0&&<div style={{display:"flex",gap:"10px",padding:"10px 14px",borderRadius:"10px",marginBottom:"6px",background:"#1c1400",border:"1px solid #78350f",color:"#f59e0b",fontSize:"0.75rem"}}><span>🟡</span><div><div style={{fontWeight:700,marginBottom:"2px"}}>{sinDir.length} pedidos sin dirección completa</div><div style={{fontSize:"0.68rem",opacity:.7}}>Contactar al cliente antes de despachar</div></div></div>}
          {preparados.length>0&&<div style={{display:"flex",gap:"10px",padding:"10px 14px",borderRadius:"10px",marginBottom:"6px",background:"#041f14",border:"1px solid #065f46",color:"#34d399",fontSize:"0.75rem"}}><span>🟢</span><div><div style={{fontWeight:700,marginBottom:"2px"}}>{preparados.length} pedidos preparados y listos</div><div style={{fontSize:"0.68rem",opacity:.7}}>FLEX: {flexPrep.length} · NO FLEX: {noflexPrep.length}</div></div></div>}
          {sinAsigHoy===0&&pagoPend.length===0&&sinDir.length===0&&<div style={{display:"flex",gap:"10px",padding:"10px 14px",borderRadius:"10px",background:"#041f14",border:"1px solid #065f46",color:"#34d399",fontSize:"0.75rem"}}><span>✅</span><div style={{fontWeight:700}}>Sin alertas pendientes</div></div>}
        </div>

        <div>
          <div style={{color:"#4b5563",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",letterSpacing:".08em",marginBottom:"8px"}}>Cobranzas logística + CC clientes</div>
          <div style={{...cardSt,padding:0,overflow:"hidden"}}>
            {/* Header colapsable logística */}
            <div onClick={()=>setCobOpen(p=>!p)} style={{background:"#12172a",padding:"8px 14px",borderBottom:cobOpen?"1px solid #252d40":"none",display:"flex",alignItems:"center",gap:"10px",cursor:"pointer",userSelect:"none"}}>
              <span style={{color:"#f87171",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",flex:1}}>
                {cobPorLog.length} logística{cobPorLog.length!==1?"s":""} · <span style={{color:"#f87171",fontWeight:800}}>{fmt(cobPorLog.reduce((s,x)=>s+x.total,0))}</span>
                {cobPorLog.some(x=>x.diasDeuda>=2)&&<span style={{marginLeft:"8px",background:"#450a0a",color:"#f87171",border:"1px solid #7f1d1d",padding:"1px 6px",borderRadius:"4px",fontSize:"9px",fontWeight:700}}>⚠ Atrasadas</span>}
              </span>
              <span style={{color:"#4b5563",fontSize:"0.7rem"}}>{cobOpen?"▲":"▼"}</span>
            </div>
            {cobOpen&&(
              <>
                <div style={{background:"#12172a",padding:"5px 14px",borderBottom:"1px solid #1a1f2e",display:"grid",gridTemplateColumns:"80px 1fr 1fr 1fr",gap:"8px"}}>
                  {["Logística","Deuda anterior","Sale hoy","Total"].map((h,i)=>(
                    <div key={i} style={{color:i===1?"#f87171":i===2?"#f59e0b":"#6b7280",fontSize:"0.58rem",fontWeight:700,textTransform:"uppercase",textAlign:i>0?"right":"left"}}>{h}</div>
                  ))}
                </div>
                {cobPorLog.length===0&&<div style={{padding:"1rem",color:"#4b5563",fontSize:"0.75rem",textAlign:"center"}}>Sin cobranzas pendientes</div>}
                {cobPorLog.map(({l,deudaAnterior,saleHoy,total:tot,diasDeuda})=>{
                  const lcD2=lc[l];
                  const atrasado=diasDeuda>=2;
                  const revisar=diasDeuda===1;
                  return(
                    <div key={l} style={{display:"grid",gridTemplateColumns:"80px 1fr 1fr 1fr",gap:"8px",padding:"8px 14px",borderBottom:"1px solid #1a1f2e",alignItems:"center",background:atrasado?"#1c0404":revisar?"#1c1000":"transparent"}}>
                      <div>
                        <div style={{color:lcD2.color,fontWeight:700,fontSize:"0.82rem"}}>{l}</div>
                        {atrasado&&<div style={{background:"#450a0a",color:"#f87171",border:"1px solid #7f1d1d",padding:"1px 6px",borderRadius:"4px",fontSize:"9px",fontWeight:700,marginTop:"2px",display:"inline-block"}}>⚠ Atrasado</div>}
                        {revisar&&<div style={{background:"#1c1000",color:"#f59e0b",border:"1px solid #78350f",padding:"1px 6px",borderRadius:"4px",fontSize:"9px",fontWeight:700,marginTop:"2px",display:"inline-block"}}>⚠ Revisar</div>}
                      </div>
                      <div style={{textAlign:"right"}}>
                        {deudaAnterior>0?<><div style={{color:"#f87171",fontWeight:700,fontSize:"0.78rem"}}>{fmt(deudaAnterior)}</div><div style={{color:"#6b7280",fontSize:"9px"}}>{diasDeuda} día{diasDeuda>1?"s":""} pend.</div></>:<span style={{color:"#4b5563"}}>—</span>}
                      </div>
                      <div style={{textAlign:"right"}}>
                        {saleHoy>0?<span style={{color:"#f59e0b",fontWeight:700,fontSize:"0.78rem"}}>{fmt(saleHoy)}</span>:<span style={{color:"#4b5563"}}>—</span>}
                      </div>
                      <div style={{textAlign:"right"}}>
                        <span style={{color:atrasado?"#f87171":"#e5e7eb",fontWeight:700,fontSize:"0.82rem"}}>{fmt(tot)}</span>
                      </div>
                    </div>
                  );
                })}
                {cobPorLog.length>0&&(()=>{
                  const totDeu=cobPorLog.reduce((s,x)=>s+x.deudaAnterior,0);
                  const totHoy=cobPorLog.reduce((s,x)=>s+x.saleHoy,0);
                  const totTot=cobPorLog.reduce((s,x)=>s+x.total,0);
                  return<div style={{display:"grid",gridTemplateColumns:"80px 1fr 1fr 1fr",gap:"8px",padding:"8px 14px",background:"#12172a",borderTop:"2px solid #252d40"}}>
                    <span style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase"}}>Total</span>
                    <div style={{textAlign:"right",color:"#f87171",fontWeight:800,fontSize:"0.82rem"}}>{totDeu>0?fmt(totDeu):"—"}</div>
                    <div style={{textAlign:"right",color:"#f59e0b",fontWeight:800,fontSize:"0.82rem"}}>{totHoy>0?fmt(totHoy):"—"}</div>
                    <div style={{textAlign:"right",color:"#e5e7eb",fontWeight:800,fontSize:"0.88rem"}}>{fmt(totTot)}</div>
                  </div>;
                })()}
              </>
            )}
          </div>

          {/* Sección CC clientes */}
          {ccPorCliente.length>0&&(
            <div style={{marginTop:"1rem"}}>
              <div style={{color:"#4b5563",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",letterSpacing:".08em",marginBottom:"8px"}}>Cuentas corrientes pendientes (clientes)</div>
              <div style={{...cardSt,padding:0,overflow:"hidden"}}>
                {/* Header colapsable */}
                <div onClick={()=>setCcOpen(p=>!p)} style={{background:"#12172a",padding:"8px 14px",borderBottom:ccOpen?"1px solid #252d40":"none",display:"flex",alignItems:"center",gap:"10px",cursor:"pointer",userSelect:"none"}}>
                  <span style={{color:"#a78bfa",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",flex:1}}>
                    {ccPorCliente.length} cliente{ccPorCliente.length!==1?"s":""} · <span style={{color:"#a78bfa",fontWeight:800}}>{fmt(totalCC)}</span>
                  </span>
                  <span style={{color:"#4b5563",fontSize:"0.7rem"}}>{ccOpen?"▲":"▼"}</span>
                </div>
                {ccOpen&&(
                  <>
                    <div style={{background:"#12172a",padding:"5px 14px",borderBottom:"1px solid #1a1f2e",display:"grid",gridTemplateColumns:"1fr 60px auto",gap:"8px"}}>
                      <div style={{color:"#6b7280",fontSize:"0.58rem",fontWeight:700,textTransform:"uppercase"}}>Cliente</div>
                      <div style={{color:"#6b7280",fontSize:"0.58rem",fontWeight:700,textTransform:"uppercase",textAlign:"center"}}>Días</div>
                      <div style={{color:"#6b7280",fontSize:"0.58rem",fontWeight:700,textTransform:"uppercase",textAlign:"right"}}>Saldo</div>
                    </div>
                    {ccPorCliente.map((c,i)=>{
                      const vencido=c.dias>=30;
                      const revisar=c.dias>=15&&c.dias<30;
                      return(
                        <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 60px auto",gap:"8px",padding:"7px 14px",borderBottom:"1px solid #1a1f2e",alignItems:"center",background:vencido?"#1c0a1c":revisar?"#130d2a":"transparent"}}>
                          <div style={{color:"#e2e8f0",fontSize:"0.78rem",fontWeight:600}}>{c.nombre}</div>
                          <div style={{textAlign:"center"}}>
                            {c.dias>0
                              ?<span style={{background:vencido?"#3b0764":revisar?"#1e1b4b":"#1a1f2e",color:vencido?"#e879f9":revisar?"#a78bfa":"#6b7280",border:`1px solid ${vencido?"#7e22ce":revisar?"#4c1d95":"#252d40"}`,padding:"1px 6px",borderRadius:"4px",fontSize:"9px",fontWeight:700}}>{c.dias}d</span>
                              :<span style={{color:"#374151",fontSize:"9px"}}>—</span>
                            }
                          </div>
                          <div style={{color:vencido?"#e879f9":"#a78bfa",fontWeight:700,fontSize:"0.78rem",textAlign:"right"}}>{fmt(c.deuda)}</div>
                        </div>
                      );
                    })}
                    <div style={{display:"grid",gridTemplateColumns:"1fr 60px auto",gap:"8px",padding:"8px 14px",background:"#12172a",borderTop:"2px solid #252d40"}}>
                      <span style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase"}}>Total</span>
                      <div/>
                      <div style={{textAlign:"right",color:"#a78bfa",fontWeight:800,fontSize:"0.88rem"}}>{fmt(totalCC)}</div>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


function VistaExpedicion({envios,setEnvios,colectas=[],setColectas,sesion,lc,configExpedicion={},esAdmin=false}){
  const {impresionHabilitada=false,armadores=[]}=configExpedicion;
  // Lista efectiva de controladores: armadores con puedeControlar=true; fallback a todos si ninguno lo tiene
  const listaControladores=armadores.some(a=>a.puedeControlar)?armadores.filter(a=>a.puedeControlar):armadores;
  const hoy=fechaHoy();
  const [subTab,setSubTab]=useState("escaneo");
  const [fecha,setFecha]=useState(hoy);
  const [qrInput,setQrInput]=useState("");
  const [scanPendiente,setScanPendiente]=useState(null);
  const [bultosSel,setBultosSel]=useState(1);
  const [resultado,setResultado]=useState(null);
  const [ultimoArmador,setUltimoArmador]=useState(null);
  const [matchesPendientes,setMatchesPendientes]=useState([]); // candidatos para disambiguation
  const [modoEdicion,setModoEdicion]=useState(false);          // true cuando se edita un pedido ya preparado
  const [armadorActivo,setArmadorActivo]=useState(null);       // armador "bloqueado" para escaneo rápido
  const [sesionContador,setSesionContador]=useState(0);        // pedidos confirmados en la sesión activa
  const [filLog,setFilLog]=useState("TODOS");
  const [soloPendientes,setSoloPendientes]=useState(true);
  const [filTipo,setFilTipo]=useState("TODOS");
  const [filTurno,setFilTurno]=useState("TODOS");
  const [busqueda,setBusqueda]=useState("");
  const [colectasArmadasHoy,setColectasArmadasHoy]=useState([]);
  const [controladorSel,setControladorSel]=useState(null); // sticky por sesión

  const [camara,setCamara]=useState(false);
  // BarcodeDetector solo existe en Chrome Android — ocultar botón si no hay soporte
  const soportaCamera=typeof window!=="undefined"&&"BarcodeDetector" in window&&"mediaDevices" in navigator;

  const inputRef=useRef(null);
  const videoRef=useRef(null);
  const timeoutRef=useRef(null);
  const armadorTimerRef=useRef(null); // timer de inactividad del armador activo
  const logActivas=Object.entries(lc).filter(([,v])=>v.activa).map(([k])=>k);

  // Reinicia el timer de inactividad del armador (10s sin escanear → desactiva)
  const resetArmadorTimer=useCallback(()=>{
    if(armadorTimerRef.current)clearTimeout(armadorTimerRef.current);
    armadorTimerRef.current=setTimeout(()=>{
      setArmadorActivo(null);setSesionContador(0);
      setResultado({ok:false,msg:"Armador desactivado por inactividad."});
      setTimeout(()=>setResultado(null),4000);
      if(inputRef.current)inputRef.current.focus();
    },10000);
  },[]);

  const ayer=()=>{const d=new Date(hoy+"T00:00:00");d.setDate(d.getDate()-1);return d.toISOString().split("T")[0];};
  const manana=()=>{const d=new Date(hoy+"T00:00:00");d.setDate(d.getDate()+1);return d.toISOString().split("T")[0];};

  const deFecha=useMemo(()=>envios.filter(e=>{const f=e.fecha||e.fechaVenta||"";return f===fecha&&getEstado(e)==="asignado"&&e.origen!=="ML";}),[envios,fecha]);
  const flexFecha=useMemo(()=>envios.filter(e=>{const f=e.fecha||e.fechaVenta||"";return e.origen==="ML"&&f===fecha&&getEstado(e)==="asignado";}),[envios,fecha]);
  const todosLista=useMemo(()=>[...deFecha,...flexFecha],[deFecha,flexFecha]);

  const filtrados=useMemo(()=>todosLista.filter(e=>{
    if(filLog==="__COLECTAS__")return false;
    if(filLog!=="TODOS"&&e.trans!==filLog)return false;
    if(filTipo==="FLEX"&&e.origen!=="ML")return false;
    if(filTipo==="NOFLEX"&&e.origen==="ML")return false;
    if(filTurno!=="TODOS"){if(filTurno==="SIN_TURNO"){if(e.turno)return false;}else if(e.turno!==filTurno)return false;}
    if(soloPendientes&&e.preparado)return false;
    if(busqueda){const s=norm(busqueda);return norm(e.direccion).includes(s)||(e.nroOrdenTN||"").includes(s)||(e.nroSeguimiento||"").includes(s)||norm(e.partido).includes(s);}
    return true;
  }).sort((a,b)=>{
    if(a.trans!==b.trans)return(a.trans||"").localeCompare(b.trans||"");
    if(a.origen!==b.origen)return a.origen==="ML"?1:-1;
    return TURNOS.indexOf(a.turno)-TURNOS.indexOf(b.turno);
  }),[todosLista,filLog,filTipo,filTurno,soloPendientes,busqueda]);

  const preparados=todosLista.filter(e=>e.preparado).length;
  const total=todosLista.length;
  const prepNoflex=deFecha.filter(e=>e.preparado).length;
  const prepFlex=flexFecha.filter(e=>e.preparado).length;

  // Colectas pendientes de armar, ordenadas por fecha (más antiguas primero) para monitorear demoras
  const colectasOrdenadas=useMemo(()=>[...colectas].sort((a,b)=>(a.fecha||"").localeCompare(b.fecha||"")),[colectas]);

  // Auto-expirar colectas sin registro: si pasaron 48hs desde loteImportacion y siguen pendientes → marcar sin_registro en Firestore
  const LIMITE_COLECTA_MS=48*60*60*1000;
  useEffect(()=>{
    const ahora=Date.now();
    colectas.forEach(c=>{
      if(!c.loteImportacion)return;
      if((ahora-new Date(c.loteImportacion).getTime())>LIMITE_COLECTA_MS){
        updateDoc(doc(db,"colectas",c.id),{estado:"sin_registro"}).catch(()=>{});
      }
    });
  },[colectas]);

  // Colectas armadas en la fecha seleccionada (listener local, para mostrar en el listado)
  useEffect(()=>{
    if(!fecha)return;
    const q=query(collection(db,"colectas"),where("estado","==","armada"),where("fechaArmado","==",fecha));
    const unsub=onSnapshot(q,snap=>setColectasArmadasHoy(snap.docs.map(d=>({id:d.id,...d.data(),_isColecta:true}))),err=>console.error("colectasArmadas:",err));
    return()=>unsub();
  },[fecha]);

  // Cómputos por logística para las cards de resumen
  const statsPorLog=useMemo(()=>{
    const m={};
    todosLista.forEach(e=>{
      const k=e.trans||"Sin asignar";
      if(!m[k])m[k]={flex:{total:0,arm:0},noflex:{total:0,arm:0}};
      const esFlex=e.origen==="ML";
      if(esFlex){m[k].flex.total++;if(e.preparado)m[k].flex.arm++;}
      else{m[k].noflex.total++;if(e.preparado)m[k].noflex.arm++;}
    });
    return m;
  },[todosLista]);

  const pct=total>0?Math.round(preparados/total*100):0;

  // ── Abre el panel de armadores para un envío específico ───────────
  const abrirPanelArmador=useCallback((found,edicion=false)=>{
    setMatchesPendientes([]);
    setModoEdicion(edicion);
    setScanPendiente(found);
    setBultosSel(found.bultos||1);
    if(!edicion)beepOK();
    if(timeoutRef.current)clearTimeout(timeoutRef.current);
    timeoutRef.current=setTimeout(()=>{
      setScanPendiente(null);setModoEdicion(false);
      setResultado({ok:false,msg:"Tiempo agotado. Escaneá de nuevo."});
      setTimeout(()=>setResultado(null),5000);
      if(inputRef.current)inputRef.current.focus();
    },30000);
  },[]);

  // ── Cancela cualquier panel abierto ──────────────────────────────
  const cancelarPanel=useCallback(()=>{
    if(timeoutRef.current)clearTimeout(timeoutRef.current);
    setMatchesPendientes([]);setScanPendiente(null);setModoEdicion(false);
    if(inputRef.current)inputRef.current.focus();
  },[]);

  // ── Lógica base de confirmación (debe ir ANTES de procesarScan) ───
  const ejecutarArmado=useCallback((envio,armador,bultos,controlador,esEdit=false)=>{
    const ts=new Date().toISOString();
    setEnvios(pv=>pv.map(e=>e.id===envio.id?{...e,preparado:true,bultos,armadorId:armador.id,armadorNombre:armador.nombre,armadoTs:ts}:e));
    setUltimoArmador(armador);
    setResultado({ok:true,envio,bultos,msg:(esEdit?"✏️ Editado: ":"✓ ")+armador.nombre+(bultos>1?" · "+bultos+" bultos":"")+(controlador?" — ctrl: "+controlador.nombre:"")});
    setTimeout(()=>setResultado(null),5000);
    if(inputRef.current)inputRef.current.focus();
    addDoc(collection(db,"armados"),{
      envioId:envio.id,
      nroSeguimiento:envio.nroSeguimiento||"",
      nroOrdenTN:String(envio.nroOrdenTN||""),
      armadorId:armador.id,armadorNombre:armador.nombre,
      controladorId:controlador?.id||"",controladorNombre:controlador?.nombre||"",
      ts,fecha:envio.fecha||envio.fechaVenta||"",
      bultos,logistica:envio.trans||"",
      direccion:envio.direccion||"",
      partido:envio.partido||"",
      esFlex:envio.origen==="ML",
      esEdicion:esEdit,
    }).catch(err=>console.error("Error guardando armado:",err));
    if(bultos>1&&impresionHabilitada&&envio.origen!=="ML")imprimirEtiquetasExtra({...envio,bultos},lc);
  },[setEnvios,lc,impresionHabilitada]);

  // ── Lógica de confirmación para colectas ML (circuito separado de envios) ──
  const ejecutarArmadoColecta=useCallback((colecta,armador,controlador)=>{
    const ts=new Date().toISOString();
    if(setColectas)setColectas(pv=>pv.filter(c=>c.id!==colecta.id));
    setUltimoArmador(armador);
    setResultado({ok:true,envio:colecta,bultos:1,msg:"📋 Colecta · "+armador.nombre+(controlador?" — ctrl: "+controlador.nombre:"")});
    setTimeout(()=>setResultado(null),5000);
    if(inputRef.current)inputRef.current.focus();
    updateDoc(doc(db,"colectas",colecta.id),{
      estado:"armada",armadorId:armador.id,armadorNombre:armador.nombre,
      controladorId:controlador?.id||"",controladorNombre:controlador?.nombre||"",
      fechaArmado:fechaHoy(),horaArmado:ts,
    }).catch(err=>console.error("Error actualizando colecta:",err));
    addDoc(collection(db,"armados"),{
      envioId:colecta.id,
      nroSeguimiento:colecta.nroSeguimiento||"",
      nroOrdenTN:"",
      nroVenta:colecta.nroVenta||"",
      nroPackId:colecta.nroPackId||"",
      destinatario:colecta.destinatario||"",
      usuario:colecta.usuario||"",
      armadorId:armador.id,armadorNombre:armador.nombre,
      controladorId:controlador?.id||"",controladorNombre:controlador?.nombre||"",
      ts,fecha:colecta.fecha||fechaHoy(),
      bultos:1,logistica:"Colecta",
      direccion:colecta.direccion||"",
      partido:colecta.partido||"",
      esFlex:false,esColecta:true,esEdicion:false,
    }).catch(err=>console.error("Error guardando armado:",err));
  },[setColectas]);

  // ── Scan handler con scoring ──────────────────────────────────────
  const procesarScan=useCallback((nro)=>{
    const srch=nro.trim().replace(/^#/,"");if(!srch)return;
    setResultado(null);
    const nums=srch.replace(/\D/g,"");
    // Helper: busca contra colectas pendientes (ML, circuito separado) — SIN filtro de fecha,
    // porque Maxi puede cargar colectas para el día siguiente con anticipación.
    const buscarColecta=()=>colectas
      .map(c=>({c,score:scoreBusqueda(c,srch,nums)}))
      .filter(x=>x.score>0)
      .sort((a,b)=>b.score-a.score);
    // Modo armador activo: buscar y confirmar automáticamente sin panel
    if(armadorActivo){
      const candidatos=envios
        .map(e=>({e,score:scoreBusqueda(e,srch,nums)}))
        .filter(x=>x.score>0)
        .sort((a,b)=>b.score-a.score);
      if(candidatos.length===0){
        const candColecta=buscarColecta();
        if(candColecta.length>0){
          ejecutarArmadoColecta(candColecta[0].c,armadorActivo,controladorSel||null);
          setSesionContador(p=>p+1);
          resetArmadorTimer();
          beepOK();
          return;
        }
        setResultado({ok:false,msg:"No encontrado: "+srch.slice(0,20)});
        setTimeout(()=>setResultado(null),5000);return;
      }
      const found=candidatos[0].e;
      if(found.preparado&&found.armadorNombre){
        setResultado({ok:"ya",envio:found,msg:"Ya preparado por "+found.armadorNombre});
        setTimeout(()=>setResultado(null),4000);return;
      }
      ejecutarArmado(found,armadorActivo,found.bultos||1,controladorSel||null);
      setSesionContador(p=>p+1);
      resetArmadorTimer(); // reinicia el contador de inactividad
      beepOK();
      return;
    }
    // Puntuar todos los envíos y ordenar por relevancia
    const candidatos=envios
      .map(e=>({e,score:scoreBusqueda(e,srch,nums)}))
      .filter(x=>x.score>0)
      .sort((a,b)=>b.score-a.score);
    if(candidatos.length===0){
      // Fallback: no matcheó en envíos → probar contra colectas pendientes
      const candColecta=buscarColecta();
      if(candColecta.length===0){
        setResultado({ok:false,msg:"No encontrado: "+srch.slice(0,20)});
        setTimeout(()=>setResultado(null),8000);return;
      }
      if(candColecta.length===1){
        abrirPanelArmador({...candColecta[0].c,_isColecta:true});return;
      }
      // Múltiples colectas candidatas → mismo panel de disambiguation, tageado
      setMatchesPendientes(candColecta.map(x=>({...x.c,_isColecta:true,_score:x.score})));
      if(timeoutRef.current)clearTimeout(timeoutRef.current);
      timeoutRef.current=setTimeout(()=>{
        setMatchesPendientes([]);
        setResultado({ok:false,msg:"Tiempo agotado. Escaneá de nuevo."});
        setTimeout(()=>setResultado(null),5000);
        if(inputRef.current)inputRef.current.focus();
      },30000);
      return;
    }
    // Un único resultado → siempre directo, sin importar el score
    if(candidatos.length===1){
      const found=candidatos[0].e;
      if(found.preparado&&found.armadorNombre){
        setResultado({ok:"ya",envio:found,msg:"Ya preparado por "+found.armadorNombre+" · "+(found.bultos||1)+" bulto"+(found.bultos>1?"s":"")});
        setTimeout(()=>setResultado(null),8000);return;
      }
      abrirPanelArmador(found);return;
    }
    // Múltiples candidatos: exacto único → directo; resto → panel de selección
    const topScore=candidatos[0].score;
    const topCands=candidatos.filter(x=>x.score===topScore);
    if(topCands.length===1&&topScore===3){
      const found=topCands[0].e;
      if(found.preparado&&found.armadorNombre){
        setResultado({ok:"ya",envio:found,msg:"Ya preparado por "+found.armadorNombre+" · "+(found.bultos||1)+" bulto"+(found.bultos>1?"s":"")});
        setTimeout(()=>setResultado(null),8000);return;
      }
      abrirPanelArmador(found);return;
    }
    // Genuina ambigüedad → panel de selección
    setMatchesPendientes(candidatos.map(x=>({...x.e,_score:x.score})));
    if(timeoutRef.current)clearTimeout(timeoutRef.current);
    timeoutRef.current=setTimeout(()=>{
      setMatchesPendientes([]);
      setResultado({ok:false,msg:"Tiempo agotado. Escaneá de nuevo."});
      setTimeout(()=>setResultado(null),5000);
      if(inputRef.current)inputRef.current.focus();
    },30000);
  },[envios,colectas,armadorActivo,ejecutarArmado,ejecutarArmadoColecta,abrirPanelArmador,resetArmadorTimer]);

  // ── Confirmar armado desde el panel flotante ──────────────────────
  const confirmarArmado=useCallback((armador)=>{
    if(!scanPendiente)return;
    if(timeoutRef.current)clearTimeout(timeoutRef.current);
    const item=scanPendiente;
    const bultos=bultosSel;
    const esEdit=modoEdicion;
    const ctrl=controladorSel||null;
    setScanPendiente(null);setModoEdicion(false);
    if(item._isColecta){
      ejecutarArmadoColecta(item,armador,ctrl);
    } else {
      ejecutarArmado(item,armador,bultos,ctrl,esEdit);
    }
  },[scanPendiente,bultosSel,modoEdicion,controladorSel,ejecutarArmado,ejecutarArmadoColecta]);

  useEffect(()=>{if(inputRef.current)inputRef.current.focus();},[]);

  // Escaneo QR/barcode via cámara — BarcodeDetector API (Chrome Android nativo)
  useEffect(()=>{
    if(!camara)return;
    let stream=null;let rafId=null;let activo=true;
    const startCam=async()=>{
      try{
        stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment",width:{ideal:1280},height:{ideal:720}}});
        if(!videoRef.current||!activo)return;
        videoRef.current.srcObject=stream;
        await videoRef.current.play();
        if(!("BarcodeDetector" in window)){
          setResultado({ok:false,msg:"Tu navegador no soporta escaneo. Usá el campo de texto."});
          setCamara(false);return;
        }
        const detector=new window.BarcodeDetector({formats:["qr_code","code_128","code_39","ean_13"]});
        const scan=async()=>{
          if(!activo||!videoRef.current||videoRef.current.readyState<2){rafId=requestAnimationFrame(scan);return;}
          try{
            const barcodes=await detector.detect(videoRef.current);
            if(barcodes.length>0){
              const val=barcodes[0].rawValue;
              setResultado({ok:"scanning",msg:"Escaneando..."});
              await new Promise(r=>setTimeout(r,800));
              if(!activo)return;
              procesarScan(val);
              setCamara(false);return;
            }
          }catch(e){}
          if(activo)rafId=requestAnimationFrame(scan);
        };
        rafId=requestAnimationFrame(scan);
      }catch(err){
        setResultado({ok:false,msg:"No se pudo acceder a la cámara. Verificá los permisos."});
        setCamara(false);
      }
    };
    startCam();
    return()=>{
      activo=false;
      if(rafId)cancelAnimationFrame(rafId);
      if(stream)stream.getTracks().forEach(t=>t.stop());
    };
  },[camara,procesarScan]);

  // Teclado numérico — funciona en modo disambiguation y modo armador
  useEffect(()=>{
    const panelAbierto=matchesPendientes.length>0||scanPendiente;
    if(!panelAbierto)return;
    const h=ev=>{
      if(ev.key==="Escape"){cancelarPanel();return;}
      const n=parseInt(ev.key);
      if(isNaN(n)||n<1)return;
      if(matchesPendientes.length>0&&!scanPendiente){
        // Modo disambiguation: seleccionar candidato
        const cand=matchesPendientes[n-1];
        if(cand)abrirPanelArmador(cand,!!cand.preparado);
      }else if(scanPendiente&&n<=armadores.length){
        // Modo armador: seleccionar armador
        confirmarArmado(armadores[n-1]);
      }
    };
    window.addEventListener("keydown",h);
    return()=>window.removeEventListener("keydown",h);
  },[matchesPendientes,scanPendiente,armadores,confirmarArmado,abrirPanelArmador,cancelarPanel]);

  // Grupos para el listado
  const grupos={};
  filtrados.forEach(e=>{const k=e.trans||"Sin asignar";if(!grupos[k])grupos[k]=[];grupos[k].push(e);});

  return(
    <div style={{minHeight:"100vh",background:"#0a0e1a",color:"#fff",fontFamily:"sans-serif"}}>
      <style>{`*{box-sizing:border-box;}`}</style>

      {/* ── Panel flotante (disambiguation + armador) ──────────────── */}
      {(matchesPendientes.length>0||scanPendiente)&&(
        <div style={{position:"fixed",inset:0,zIndex:500,background:"rgba(0,0,0,0.82)",display:"flex",alignItems:"flex-end",justifyContent:"center"}} onClick={e=>{if(e.target===e.currentTarget)cancelarPanel();}}>
          <div style={{background:"#0f1420",border:"1px solid #252d40",borderRadius:"16px 16px 0 0",width:"100%",maxWidth:"560px",padding:"1.25rem 1.25rem 2.5rem",maxHeight:"90vh",overflowY:"auto"}}>

            {/* ─ MODO 1: Disambiguation ─ */}
            {matchesPendientes.length>0&&!scanPendiente&&(<>
              <div style={{marginBottom:"1rem"}}>
                <div style={{fontSize:"0.62rem",color:"#f59e0b",textTransform:"uppercase",fontWeight:700,marginBottom:"4px"}}>
                  {matchesPendientes.length} pedidos encontrados — elegí el correcto
                  <span style={{color:"#374151",fontWeight:400,textTransform:"none",marginLeft:"6px"}}>o presioná el número</span>
                </div>
              </div>
              <div style={{display:"grid",gap:"8px",marginBottom:"1rem"}}>
                {matchesPendientes.map((e,i)=>{
                  const scoreLabel=e._score===2?"≈ número similar":e._score===1?"≈ dirección":"";
                  return(
                    <button key={e.id} onClick={()=>abrirPanelArmador(e,!!e.preparado)}
                      style={{display:"flex",alignItems:"center",gap:"10px",padding:"12px 14px",borderRadius:"10px",
                        border:"2px solid "+(e.preparado?"#065f46":"#252d40"),
                        background:e.preparado?"#041f14":"#12172a",cursor:"pointer",textAlign:"left",width:"100%"}}>
                      <div style={{width:"28px",height:"28px",borderRadius:"8px",background:"#0f1420",border:"1px solid #374151",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:"0.95rem",fontWeight:900,color:"#6b7280"}}>{i+1}</div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",gap:"6px",alignItems:"center",flexWrap:"wrap",marginBottom:"2px"}}>
                          {e._isColecta&&<span style={{background:"#1a0d2e",color:"#a78bfa",border:"1px solid #a78bfa",padding:"1px 6px",borderRadius:"4px",fontSize:"0.65rem",fontWeight:700}}>📋 Colecta</span>}
                          {e.nroOrdenTN&&<span style={{color:"#7dd3fc",fontWeight:700,fontSize:"0.82rem"}}>#{e.nroOrdenTN}</span>}
                          {e.nroSeguimiento&&!e.nroOrdenTN&&<span style={{color:"#7dd3fc",fontWeight:700,fontSize:"0.82rem"}}>{e.nroSeguimiento}</span>}
                          {e.trans&&<span style={{color:lc[e.trans]?.color||"#9ca3af",fontWeight:700,fontSize:"0.75rem"}}>{e.trans}</span>}
                          {e.preparado&&<span style={{background:"#041f14",color:"#10b981",border:"1px solid #065f46",padding:"1px 6px",borderRadius:"4px",fontSize:"0.65rem",fontWeight:700}}>✓ preparado{e.armadorNombre?" · "+e.armadorNombre:""}</span>}
                          {scoreLabel&&<span style={{color:"#4b5563",fontSize:"0.6rem"}}>{scoreLabel}</span>}
                        </div>
                        <div style={{color:"#e5e7eb",fontSize:"0.84rem",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.direccion}</div>
                        <div style={{color:"#6b7280",fontSize:"0.7rem"}}>{e.partido}{e.cobranza&&<span style={{color:"#fbbf24",fontWeight:700,marginLeft:"6px"}}>${Number(e.cobranza).toLocaleString("es-AR")}</span>}</div>
                      </div>
                      <div style={{color:"#374151",fontSize:"1rem",flexShrink:0}}>›</div>
                    </button>
                  );
                })}
              </div>
            </>)}

            {/* ─ MODO 2: Selección de armador ─ */}
            {scanPendiente&&(<>
              {/* Banner edición */}
              {modoEdicion&&(
                <div style={{marginBottom:"0.75rem",padding:"6px 12px",background:"#1c1500",border:"1px solid #92400e",borderRadius:"8px",color:"#f59e0b",fontSize:"0.73rem",fontWeight:700}}>
                  ✏️ Editando armado existente — el nuevo armador reemplazará al anterior
                </div>
              )}
              {/* Info del pedido */}
              <div style={{marginBottom:"1rem",padding:"0.75rem 1rem",background:"#12172a",borderRadius:"10px",border:"1px solid #1a1f2e"}}>
                <div style={{fontSize:"0.6rem",color:"#4b5563",textTransform:"uppercase",fontWeight:700,marginBottom:"3px"}}>
                  {modoEdicion?"Pedido a editar":"Pedido escaneado"}
                </div>
                <div style={{fontWeight:700,fontSize:"0.95rem",color:"#e5e7eb",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{scanPendiente.direccion}</div>
                <div style={{fontSize:"0.75rem",color:"#6b7280",marginTop:"3px",display:"flex",gap:"8px",flexWrap:"wrap"}}>
                  {scanPendiente._isColecta&&<span style={{background:"#1a0d2e",color:"#a78bfa",border:"1px solid #a78bfa",padding:"1px 6px",borderRadius:"4px",fontWeight:700}}>📋 Colecta</span>}
                  {scanPendiente._isColecta&&scanPendiente.nroSeguimiento&&<span style={{color:"#7dd3fc",fontWeight:700}}>{scanPendiente.nroSeguimiento}</span>}
                  {scanPendiente.nroOrdenTN&&<span style={{color:"#7dd3fc",fontWeight:700}}>#{scanPendiente.nroOrdenTN}</span>}
                  {scanPendiente.trans&&<span style={{color:lc[scanPendiente.trans]?.color||"#9ca3af",fontWeight:700}}>{scanPendiente.trans}</span>}
                  {scanPendiente.partido&&<span>{scanPendiente.partido}</span>}
                  {scanPendiente.cobranza&&<span style={{color:"#fbbf24",fontWeight:700}}>${Number(scanPendiente.cobranza).toLocaleString("es-AR")}</span>}
                </div>
              </div>
              {/* Selector de bultos — no aplica a colectas (siempre 1 bulto por etiqueta) */}
              {!scanPendiente._isColecta&&<div style={{display:"flex",alignItems:"center",gap:"12px",marginBottom:"1.1rem"}}>
                <span style={{fontSize:"0.7rem",color:"#6b7280",fontWeight:700,textTransform:"uppercase",minWidth:"50px"}}>Bultos</span>
                <button onClick={()=>setBultosSel(b=>Math.max(1,b-1))} style={{width:"38px",height:"38px",borderRadius:"8px",background:"#1a1f2e",border:"1px solid #374151",color:"#e5e7eb",fontSize:"1.3rem",cursor:"pointer"}}>−</button>
                <span style={{fontSize:"1.8rem",fontWeight:900,color:"#e5e7eb",minWidth:"32px",textAlign:"center"}}>{bultosSel}</span>
                <button onClick={()=>setBultosSel(b=>b+1)} style={{width:"38px",height:"38px",borderRadius:"8px",background:"#1a1f2e",border:"1px solid #374151",color:"#e5e7eb",fontSize:"1.3rem",cursor:"pointer"}}>+</button>
                {bultosSel>1&&<span style={{fontSize:"0.68rem",color:impresionHabilitada?"#f59e0b":"#374151",marginLeft:"4px"}}>{impresionHabilitada?"🖨 "+(bultosSel-1)+" etiqueta"+(bultosSel>2?"s":"")+" a imprimir":"impresión deshabilitada"}</span>}
              </div>}
              {/* Selector de controlador — permite cambiar el ya seleccionado en fila 1 */}
              {listaControladores.length>0&&(
                <div style={{marginBottom:"0.9rem"}}>
                  <div style={{fontSize:"0.6rem",color:"#6b7280",textTransform:"uppercase",fontWeight:700,marginBottom:"6px"}}>
                    🔍 Controlador <span style={{color:"#374151",fontWeight:400,textTransform:"none"}}>— queda fijo hasta que lo cambiés</span>
                    {controladorSel&&<button onClick={()=>setControladorSel(null)} style={{marginLeft:"8px",background:"none",border:"none",color:"#6366f1",cursor:"pointer",fontSize:"0.68rem",fontWeight:700}}>✕ quitar</button>}
                  </div>
                  <div style={{display:"flex",gap:"6px",flexWrap:"wrap"}}>
                    {listaControladores.map(ctrl=>(
                      <button key={ctrl.id} onClick={()=>setControladorSel(c=>c?.id===ctrl.id?null:ctrl)}
                        style={{padding:"5px 10px",borderRadius:"7px",fontWeight:700,fontSize:"0.75rem",cursor:"pointer",
                          background:controladorSel?.id===ctrl.id?"#064e3b":"#12172a",
                          border:"1px solid "+(controladorSel?.id===ctrl.id?"#10b981":"#252d40"),
                          color:controladorSel?.id===ctrl.id?(ctrl.color||"#34d399"):"#6b7280"}}>
                        {ctrl.nombre}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {/* Botonera armadores */}
              <div style={{marginBottom:"0.85rem"}}>
                <div style={{fontSize:"0.62rem",color:"#6b7280",textTransform:"uppercase",fontWeight:700,marginBottom:"8px"}}>¿Quién armó este pedido? <span style={{color:"#374151",fontWeight:400,textTransform:"none"}}>— o presioná el número</span></div>
                {armadores.length===0
                  ?<div style={{padding:"1rem",background:"#12172a",borderRadius:"8px",color:"#4b5563",fontSize:"0.8rem",textAlign:"center"}}>Sin armadores configurados. Configurá en Usuarios (admin).</div>
                  :<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(120px,1fr))",gap:"8px"}}>
                    {armadores.map((arm,i)=>{
                      const esUlt=ultimoArmador?.id===arm.id;
                      const esActual=modoEdicion&&scanPendiente.armadorId===arm.id;
                      return(
                        <button key={arm.id} onClick={()=>confirmarArmado(arm)}
                          style={{padding:"12px 8px",borderRadius:"10px",border:"2px solid "+(esActual?"#f59e0b":esUlt?"#6366f1":"#252d40"),background:esActual?"#1c1500":esUlt?"#13102a":"#12172a",cursor:"pointer",textAlign:"left",position:"relative"}}>
                          <div style={{fontSize:"1rem",fontWeight:900,color:"#374151",lineHeight:1,marginBottom:"4px"}}>{i+1}</div>
                          <div style={{fontSize:"0.92rem",fontWeight:700,color:arm.color||"#e5e7eb"}}>{arm.nombre}</div>
                          {esActual&&<div style={{position:"absolute",top:"5px",right:"7px",fontSize:"0.55rem",color:"#f59e0b",fontWeight:700}}>actual</div>}
                          {!esActual&&esUlt&&<div style={{position:"absolute",top:"5px",right:"7px",fontSize:"0.55rem",color:"#6366f1",fontWeight:700}}>último</div>}
                        </button>
                      );
                    })}
                  </div>
                }
              </div>
            </>)}

            <button onClick={cancelarPanel}
              style={{width:"100%",padding:"10px",background:"transparent",border:"1px solid #252d40",borderRadius:"8px",color:"#4b5563",cursor:"pointer",fontSize:"0.8rem"}}>
              Cancelar (Esc)
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{position:"sticky",top:0,zIndex:100,background:"#0f1420",borderBottom:"1px solid #1a1f2e",padding:"0.7rem 1rem",display:"flex",alignItems:"center",gap:"0.75rem",flexWrap:"wrap"}}>
        <div style={{width:"26px",height:"26px",background:"linear-gradient(135deg,#6366f1,#8b5cf6)",borderRadius:"7px",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>🛵</div>
        <div>
          <div style={{fontWeight:800,fontSize:"0.92rem"}}>EnviosHub <span style={{color:"#374151",fontSize:"0.6rem",fontWeight:400}}>v{VERSION}</span></div>
          <div style={{color:"#f59e0b",fontSize:"0.65rem",fontWeight:700}}>Expedición</div>
        </div>
        <div style={{display:"flex",gap:"4px",marginLeft:"0.75rem"}}>
          <button onClick={()=>setSubTab("escaneo")} style={{...S.btnSm(subTab==="escaneo"),padding:"4px 12px",fontSize:"0.73rem"}}>📦 Escaneo</button>
        </div>
        <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:"0.5rem"}}>
          <span style={{color:"#4b5563",fontSize:"0.72rem"}}>{sesion.usuario}</span>
          <button onClick={()=>{clearSession();window.location.reload();}} style={{...S.btnSm(false),color:"#f87171"}}>Salir</button>
        </div>
      </div>

      <div style={{padding:"0.85rem 1rem"}}>

        {/* ═══════════════ SUB-TAB ESCANEO ═══════════════ */}
        {subTab==="escaneo"&&(<>
          {/* Selector de fecha */}
          <div style={{...S.card,padding:"0.6rem 1rem",marginBottom:"0.75rem",display:"flex",gap:"6px",alignItems:"center",flexWrap:"wrap"}}>
            <span style={{color:"#4b5563",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase"}}>Fecha</span>
            {[{l:"Ayer",v:ayer()},{l:"Hoy",v:hoy},{l:"Mañana",v:manana()}].map(x=>(
              <button key={x.v} onClick={()=>setFecha(x.v)} style={S.btnSm(fecha===x.v)}>{x.l}</button>
            ))}
            <input type="date" value={fecha} onChange={e=>setFecha(e.target.value)} style={{...S.input,padding:"3px 8px",width:"138px",fontSize:"0.78rem"}}/>
            <span style={{color:"#4b5563",fontSize:"0.72rem",marginLeft:"4px"}}>{total} · {preparados} prep.</span>
          </div>

          {/* ── Barra de resumen (Opción B) ─────────────────────────────── */}
          {(()=>{
            const colTotal=colectas.length+colectasArmadasHoy.length;
            const colArm=colectasArmadasHoy.length;
            const colPend=colectas.length;
            const flexPend=flexFecha.filter(e=>!e.preparado).length;
            const noflexPend=deFecha.filter(e=>!e.preparado).length;
            const pctFlex=flexFecha.length>0?Math.round(prepFlex/flexFecha.length*100):0;
            const pctNoFlex=deFecha.length>0?Math.round(prepNoflex/deFecha.length*100):0;
            const pctCol=colTotal>0?Math.round(colArm/colTotal*100):0;
            const cols=[
              {label:"Total",pend:total-preparados,arm:preparados,tot:total,pct,color:"#6366f1",bar:"#6366f1",onClick:()=>{setFilLog("TODOS");setFilTipo("TODOS");}},
              {label:"FLEX",pend:flexPend,arm:prepFlex,tot:flexFecha.length,pct:pctFlex,color:"#84cc16",bar:"#84cc16",onClick:()=>{setFilLog("TODOS");setFilTipo("FLEX");}},
              {label:"NO FLEX",pend:noflexPend,arm:prepNoflex,tot:deFecha.length,pct:pctNoFlex,color:"#38bdf8",bar:"#38bdf8",onClick:()=>{setFilLog("TODOS");setFilTipo("NOFLEX");}},
              {label:"📋 Colectas",pend:colPend,arm:colArm,tot:colTotal,pct:pctCol,color:"#a78bfa",bar:"#a78bfa",onClick:()=>{setFilLog("__COLECTAS__");setFilTipo("TODOS");}},
            ];
            const activeBar=(filLog==="__COLECTAS__")?3:(filTipo==="FLEX")?1:(filTipo==="NOFLEX")?2:-1;
            return(
              <div style={{...S.card,padding:"0",marginBottom:"0.75rem",overflow:"hidden"}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)"}}>
                  {cols.map((c,i)=>(
                    <div key={c.label} onClick={c.onClick} style={{padding:"0.65rem 0.7rem",borderRight:i<3?"1px solid #1a1f2e":"none",position:"relative",cursor:"pointer",background:activeBar===i?"#12172a":"transparent",transition:"background .15s"}}>
                      <div style={{fontSize:"0.55rem",color:activeBar===i?c.color:"#6b7280",textTransform:"uppercase",fontWeight:700,letterSpacing:".05em",marginBottom:"2px"}}>{c.label}{activeBar===i&&" ▾"}</div>
                      <div style={{display:"flex",alignItems:"baseline",gap:"4px"}}>
                        <span style={{fontSize:"1.4rem",fontWeight:800,color:c.color,lineHeight:1}}>{c.pend}</span>
                        <span style={{fontSize:"0.58rem",color:"#4b5563"}}>pend</span>
                      </div>
                      <div style={{fontSize:"0.62rem",color:"#6b7280",marginTop:"1px"}}>{c.arm}/{c.tot} arm.</div>
                      <div style={{marginTop:"5px",height:"3px",background:"#1a1f2e",borderRadius:"2px",overflow:"hidden"}}>
                        <div style={{width:c.pct+"%",height:"100%",background:c.bar,borderRadius:"2px",transition:"width .3s"}}/>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* ── Cards por logística ──────────────────────────────────────── */}
          {Object.keys(statsPorLog).length>0&&(
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))",gap:"8px",marginBottom:"0.75rem"}}>
              {Object.entries(statsPorLog).sort(([a],[b])=>a.localeCompare(b)).map(([log,st])=>{
                const lcD=lc[log]||{color:"#6b7280",bg:"#1a1f2e"};
                const flexPendL=st.flex.total-st.flex.arm;
                const noflexPendL=st.noflex.total-st.noflex.arm;
                const totPendL=flexPendL+noflexPendL;
                const esFiltroActivo=filLog===log;
                return(
                  <div key={log} onClick={()=>setFilLog(esFiltroActivo?"TODOS":log)}
                    style={{...S.card,padding:"0",overflow:"hidden",borderLeft:"3px solid "+(lcD.color||"#6b7280"),cursor:"pointer",background:esFiltroActivo?(lcD.bg||"#12172a"):"#0f1420",transition:"background .15s"}}>
                    <div style={{padding:"0.5rem 0.7rem",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid #1a1f2e"}}>
                      <span style={{fontWeight:700,fontSize:"0.75rem",color:lcD.color||"#e5e7eb"}}>{log}{esFiltroActivo&&" ▾"}</span>
                      <span style={{fontSize:"0.68rem",color:"#f59e0b",fontWeight:700}}>{totPendL} pend</span>
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",borderTop:"none"}}>
                      {st.flex.total>0&&(
                        <div style={{padding:"0.4rem 0.6rem",borderRight:"1px solid #1a1f2e"}}>
                          <div style={{fontSize:"0.52rem",color:"#84cc16",fontWeight:700,textTransform:"uppercase",marginBottom:"1px"}}>FLEX</div>
                          <div style={{fontSize:"0.88rem",fontWeight:800,color:"#84cc16"}}>{flexPendL}</div>
                          <div style={{fontSize:"0.58rem",color:"#4b5563"}}>{st.flex.arm}/{st.flex.total} arm</div>
                        </div>
                      )}
                      {st.noflex.total>0&&(
                        <div style={{padding:"0.4rem 0.6rem",gridColumn:st.flex.total===0?"1/3":"auto"}}>
                          <div style={{fontSize:"0.52rem",color:"#38bdf8",fontWeight:700,textTransform:"uppercase",marginBottom:"1px"}}>NO FX</div>
                          <div style={{fontSize:"0.88rem",fontWeight:800,color:"#38bdf8"}}>{noflexPendL}</div>
                          <div style={{fontSize:"0.58rem",color:"#4b5563"}}>{st.noflex.arm}/{st.noflex.total} arm</div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── BOX UNIFICADO: Registrar Armado ── */}
          <div style={{...S.card,padding:"0",marginBottom:"0.75rem",border:"2px solid #6366f133",overflow:"hidden"}}>

            {/* Header */}
            <div style={{padding:"0.55rem 1rem",background:"#12172a",borderBottom:"1px solid #1a1f2e",display:"flex",alignItems:"center",gap:"10px",flexWrap:"wrap"}}>
              <span style={{fontWeight:800,fontSize:"0.72rem",color:"#a78bfa",textTransform:"uppercase",letterSpacing:".08em"}}>📦 Registrar Armado</span>
              {armadorActivo&&(<>
                <span style={{color:"#4b5563",fontSize:"0.65rem"}}>·</span>
                <span style={{fontWeight:800,fontSize:"0.9rem",color:armadorActivo.color||"#10b981"}}>{armadorActivo.nombre}</span>
                {sesionContador>0&&<span style={{background:"#041f14",color:"#10b981",border:"1px solid #065f46",padding:"1px 8px",borderRadius:"20px",fontSize:"0.7rem",fontWeight:700}}>{sesionContador} arm.</span>}
                <button onClick={()=>{if(armadorTimerRef.current)clearTimeout(armadorTimerRef.current);setArmadorActivo(null);setSesionContador(0);if(inputRef.current)inputRef.current.focus();}}
                  style={{marginLeft:"auto",padding:"3px 10px",borderRadius:"6px",background:"#1c0404",border:"1px solid #7f1d1d",color:"#f87171",cursor:"pointer",fontWeight:700,fontSize:"0.7rem"}}>
                  Liberar
                </button>
              </>)}
            </div>

            {/* Sección armadores */}
            {armadores.length>0&&(
              <div style={{padding:"0.6rem 1rem",borderBottom:"1px solid #1a1f2e"}}>
                {armadorActivo?(
                  <div>
                    <div style={{fontSize:"0.58rem",color:"#4b5563",textTransform:"uppercase",fontWeight:700,marginBottom:"5px"}}>Cambiar armador:</div>
                    <div style={{display:"flex",gap:"6px",flexWrap:"wrap"}}>
                      {armadores.filter(a=>a.id!==armadorActivo.id).map(arm=>(
                        <button key={arm.id} onClick={()=>{setArmadorActivo(arm);setSesionContador(0);resetArmadorTimer();if(inputRef.current)inputRef.current.focus();}}
                          style={{padding:"5px 12px",borderRadius:"8px",background:"#12172a",border:"1px solid #252d40",color:arm.color||"#9ca3af",cursor:"pointer",fontSize:"0.78rem",fontWeight:600}}>
                          {arm.nombre}
                        </button>
                      ))}
                    </div>
                  </div>
                ):(
                  <div>
                    <div style={{fontSize:"0.58rem",color:"#6b7280",textTransform:"uppercase",fontWeight:700,marginBottom:"6px"}}>¿Quién va a escanear? — tocá tu nombre</div>
                    <div style={{display:"flex",gap:"6px",flexWrap:"wrap"}}>
                      {armadores.map((arm,i)=>(
                        <button key={arm.id}
                          onClick={()=>{setArmadorActivo(arm);setSesionContador(0);resetArmadorTimer();if(inputRef.current)inputRef.current.focus();}}
                          style={{padding:"8px 14px",borderRadius:"8px",background:"#12172a",border:"2px solid "+(ultimoArmador?.id===arm.id?"#6366f1":"#252d40"),
                            color:arm.color||"#e5e7eb",cursor:"pointer",fontWeight:700,fontSize:"0.85rem",position:"relative"}}>
                          <span style={{fontSize:"0.6rem",color:"#374151",marginRight:"5px"}}>{i+1}</span>
                          {arm.nombre}
                          {ultimoArmador?.id===arm.id&&<span style={{position:"absolute",top:"-6px",right:"6px",fontSize:"0.5rem",color:"#6366f1",fontWeight:700,background:"#0f1420",padding:"0 3px"}}>último</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Sección controlador */}
            {listaControladores.length>0&&(
              <div style={{padding:"0.5rem 1rem",borderBottom:"1px solid #1a1f2e",display:"flex",alignItems:"center",gap:"6px",flexWrap:"wrap"}}>
                <span style={{fontSize:"0.6rem",fontWeight:700,textTransform:"uppercase",letterSpacing:".04em",color:controladorSel?"#10b981":"#f59e0b",whiteSpace:"nowrap"}}>
                  🔍 Ctrl:
                </span>
                {!controladorSel&&<span style={{background:"#7c2d12",color:"#fed7aa",fontSize:"0.55rem",fontWeight:700,padding:"1px 5px",borderRadius:"3px"}}>requerido</span>}
                {listaControladores.map(ctrl=>(
                  <button key={ctrl.id} onClick={()=>setControladorSel(c=>c?.id===ctrl.id?null:ctrl)}
                    style={{padding:"4px 10px",borderRadius:"6px",fontWeight:700,fontSize:"0.75rem",cursor:"pointer",
                      background:controladorSel?.id===ctrl.id?"#064e3b":"#12172a",
                      border:"1px solid "+(controladorSel?.id===ctrl.id?"#10b981":"#252d40"),
                      color:controladorSel?.id===ctrl.id?(ctrl.color||"#34d399"):"#9ca3af"}}>
                    {ctrl.nombre}
                  </button>
                ))}
                {controladorSel&&<>
                  <span style={{color:"#10b981",fontSize:"0.65rem",fontWeight:700}}>✓ {controladorSel.nombre}</span>
                  <button onClick={()=>setControladorSel(null)} style={{background:"none",border:"none",color:"#6b7280",cursor:"pointer",fontSize:"0.68rem",fontWeight:700,padding:"0 2px",lineHeight:1}}>✕</button>
                </>}
              </div>
            )}

            {/* Scan input */}
            <div style={{padding:"0.75rem 1rem"}}>
              <div style={{display:"flex",gap:"8px",marginBottom:(camara||resultado||!controladorSel)?"8px":"0"}}>
                <input ref={inputRef} value={qrInput} onChange={e=>setQrInput(e.target.value)}
                  onKeyDown={e=>{if(e.key==="Enter"&&controladorSel){procesarScan(qrInput);setQrInput("");}}}
                  placeholder={armadorActivo?"Escaneá el código de barras...":"Escaneá el código de barras o ingresá el nro..."}
                  style={{...S.input,flex:1,fontSize:"0.88rem",padding:"10px 12px"}} autoComplete="off"/>
                <button onClick={()=>{if(controladorSel){procesarScan(qrInput);setQrInput("");}}}
                  disabled={!controladorSel}
                  style={{...S.btn(true),background:controladorSel?"#12172a":"#0a0e1a",border:"1px solid "+(controladorSel?"#6366f1":"#252d40"),color:controladorSel?"#a78bfa":"#374151",padding:"8px 14px",fontWeight:700,fontSize:"0.8rem",cursor:controladorSel?"pointer":"not-allowed"}}>OK</button>
                {soportaCamera&&(
                  <button onClick={()=>controladorSel&&setCamara(p=>!p)}
                    title="Escanear con cámara"
                    style={{...S.btn(camara),background:camara?"#0d1c04":"#0f1420",border:"1px solid "+(camara?"#84cc16":"#252d40"),color:camara?"#84cc16":(controladorSel?"#6b7280":"#374151"),padding:"8px 12px",fontSize:"1.1rem",cursor:controladorSel?"pointer":"not-allowed"}}>📷</button>
                )}
              </div>
              {!controladorSel&&(
                <div style={{fontSize:"0.72rem",color:"#f97316",marginBottom:"4px",display:"flex",alignItems:"center",gap:"4px"}}>
                  ⚠ Seleccioná un controlador para habilitar el escaneo
                </div>
              )}
              {camara&&(
                <div style={{marginBottom:"8px",borderRadius:"10px",overflow:"hidden",background:"#000",position:"relative"}}>
                  <video ref={videoRef} style={{width:"100%",maxHeight:"220px",objectFit:"cover",display:"block"}} playsInline muted/>
                  <div style={{position:"absolute",inset:0,border:"2px solid #84cc16",borderRadius:"10px",pointerEvents:"none"}}/>
                  <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",width:"150px",height:"150px",border:"2px solid #84cc16",borderRadius:"8px",boxShadow:"0 0 0 9999px rgba(0,0,0,0.45)"}}/>
                  <button onClick={()=>setCamara(false)} style={{position:"absolute",top:"8px",right:"8px",background:"rgba(0,0,0,0.75)",border:"1px solid #84cc16",color:"#84cc16",borderRadius:"6px",padding:"4px 10px",fontSize:"0.75rem",cursor:"pointer"}}>Cerrar</button>
                </div>
              )}
              {resultado&&(
                <div onClick={()=>resultado.ok!==true&&setResultado(null)} style={{padding:"8px 12px",borderRadius:"8px",cursor:resultado.ok===true?"default":"pointer",
                  background:resultado.ok===true?"#041f14":resultado.ok==="ya"?"#12172a":"#1c0404",
                  border:"1px solid "+(resultado.ok===true?"#065f46":resultado.ok==="ya"?"#252d40":"#7f1d1d"),
                  color:resultado.ok===true?"#34d399":resultado.ok==="ya"?"#6b7280":"#f87171",
                  fontSize:"0.82rem",fontWeight:700,display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:"8px"}}>
                  <div>{resultado.msg}{resultado.envio&&<div style={{fontWeight:400,color:"#9ca3af",marginTop:"2px",fontSize:"0.75rem"}}>{resultado.envio.direccion}{resultado.envio.trans&&<span style={{color:lc[resultado.envio.trans]?.color||"#6b7280",fontWeight:700}}> · {resultado.envio.trans}</span>}{resultado.bultos>1&&<span style={{color:"#f59e0b",fontWeight:700}}> · {resultado.bultos} bultos</span>}</div>}</div>
                  {resultado.ok!==true&&<span style={{opacity:0.5,fontSize:"0.75rem",flexShrink:0}}>✕</span>}
                </div>
              )}
            </div>
          </div>

          {/* Filtros */}
          <div style={{display:"flex",gap:"6px",flexWrap:"wrap",marginBottom:"0.5rem",alignItems:"center"}}>
            <button onClick={()=>{setFilLog("TODOS");setFilTipo("TODOS");}} style={S.btnSm(filLog==="TODOS"&&filTipo==="TODOS")}>Todos</button>
            {logActivas.map(l=><button key={l} onClick={()=>{setFilLog(filLog===l?"TODOS":l);}} style={S.btnSm(filLog===l,lc[l]?.color)}>{l}</button>)}
            <button onClick={()=>{setFilLog("__COLECTAS__");setFilTipo("TODOS");}} style={{...S.btnSm(filLog==="__COLECTAS__","#a78bfa")}}>📋 Colectas</button>
            <button onClick={()=>setSoloPendientes(!soloPendientes)} style={{...S.btnSm(soloPendientes,"#f59e0b"),marginLeft:"auto"}}>Solo pendientes</button>
          </div>
          <div style={{display:"flex",gap:"6px",marginBottom:"0.6rem",alignItems:"center"}}>
            <button onClick={()=>setFilTipo("TODOS")} style={S.btnSm(filTipo==="TODOS")} disabled={filLog==="__COLECTAS__"}>Todos</button>
            <button onClick={()=>{setFilTipo("FLEX");if(filLog==="__COLECTAS__")setFilLog("TODOS");}} style={{...S.btnSm(filTipo==="FLEX"),background:filTipo==="FLEX"?"#0d1c04":"#0f1420",color:filTipo==="FLEX"?"#84cc16":"#4b7a10",border:"1px solid "+(filTipo==="FLEX"?"#84cc16":"#1a3008")}}>FLEX</button>
            <button onClick={()=>{setFilTipo("NOFLEX");if(filLog==="__COLECTAS__")setFilLog("TODOS");}} style={S.btnSm(filTipo==="NOFLEX","#6366f1")}>NO FLEX</button>
            <span style={{color:"#4b5563",fontSize:"0.68rem",marginLeft:"4px"}}>
              {filLog==="__COLECTAS__"
                ?(colectas.length+colectasArmadasHoy.length)+" colectas"
                :filtrados.length+" pedidos"}
            </span>
          </div>
          <div style={{display:"flex",gap:"6px",marginBottom:"0.6rem",alignItems:"center",flexWrap:"wrap"}}>
            <span style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase"}}>Turno:</span>
            <button onClick={()=>setFilTurno("TODOS")} style={S.btnSm(filTurno==="TODOS")}>Todos</button>
            {TURNOS.map(t=><button key={t} onClick={()=>setFilTurno(t)} style={S.btnSm(filTurno===t,TURNO_C[t]?.c||"#8b5cf6")}>{t}</button>)}
            <button onClick={()=>setFilTurno("SIN_TURNO")} style={{...S.btnSm(filTurno==="SIN_TURNO"),color:filTurno==="SIN_TURNO"?"#f59e0b":"#6b7280"}}>Sin turno</button>
            <input value={busqueda} onChange={e=>setBusqueda(e.target.value)} placeholder="🔍 Buscar..." style={{...S.input,marginLeft:"auto",width:"160px",fontSize:"0.78rem",padding:"4px 10px"}}/>
          </div>

          {/* Lista */}
          {filtrados.length===0&&<div style={{textAlign:"center",padding:"3rem",color:"#4b5563"}}><div style={{fontSize:"2rem"}}>📦</div><p style={{marginTop:"8px"}}>Sin pedidos para esta fecha</p></div>}
          {Object.entries(grupos).map(([log,items])=>{
            const lcD=lc[log]||{color:"#6b7280",bg:"#1a1f2e"};
            const prepG=items.filter(e=>e.preparado).length;
            return(
              <div key={log} style={{marginBottom:"16px"}}>
                <div style={{display:"flex",alignItems:"center",gap:"8px",marginBottom:"6px"}}>
                  <div style={{flex:1,height:"1px",background:"#1a1f2e"}}/>
                  <div style={{background:lcD.bg||"#12172a",color:lcD.color,padding:"2px 12px",borderRadius:"10px",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase"}}>{log} · {prepG}/{items.length}</div>
                  <div style={{flex:1,height:"1px",background:"#1a1f2e"}}/>
                </div>
                <div style={{display:"grid",gap:"6px"}}>
                  {items.map(e=>{
                    const esTN=e.origen==="Tienda Nube";
                    const esFlex=e.origen==="ML";
                    const esManual=!esTN&&!esFlex;
                    return(
                      <div key={e.id} style={{...S.card,overflow:"hidden",opacity:e.preparado?0.6:1,borderColor:e.preparado?"#065f46":"#252d40"}}>
                        <div style={{padding:"10px 14px",display:"flex",alignItems:"flex-start",gap:"10px"}}>
                          <div style={{width:"26px",height:"26px",borderRadius:"7px",background:e.preparado?"#041f14":"#0f1420",border:"2px solid "+(e.preparado?"#10b981":"#374151"),display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:"2px"}}>
                            {e.preparado&&<span style={{color:"#10b981",fontSize:"15px",lineHeight:1}}>✓</span>}
                          </div>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{display:"flex",gap:"4px",flexWrap:"wrap",marginBottom:"3px",alignItems:"center"}}>
                              {/* Badge de tipo + referencia completa */}
                              {esFlex&&<>
                                <span style={{background:"#0d1c04",color:"#84cc16",border:"1px solid #2d5a0e",padding:"1px 5px",borderRadius:"4px",fontSize:"0.6rem",fontWeight:700,flexShrink:0}}>FLEX</span>
                                {(e.nroPackId||e.nroVenta)&&<span style={{color:"#84cc16",fontFamily:"monospace",fontSize:"0.7rem",fontWeight:600}}>{e.nroPackId||e.nroVenta}</span>}
                                {(e.nroPackId||e.nroVenta)&&e.nroSeguimiento&&<span style={{color:"#374151",fontSize:"0.65rem"}}>·</span>}
                                {e.nroSeguimiento&&<span style={{color:"#84cc16",fontFamily:"monospace",fontSize:"0.7rem"}}>{e.nroSeguimiento}</span>}
                              </>}
                              {esTN&&<>
                                <span style={{background:"#0d1c2e",color:"#38bdf8",border:"1px solid #1e4060",padding:"1px 5px",borderRadius:"4px",fontSize:"0.6rem",fontWeight:700,flexShrink:0}}>TN</span>
                                {e.nroOrdenTN&&<span style={{color:"#7dd3fc",fontWeight:700,fontSize:"0.8rem"}}>#{e.nroOrdenTN}</span>}
                                {e.clienteNombre&&<span style={{color:"#9ca3af",fontSize:"0.72rem",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:"110px"}}>{e.clienteNombre}</span>}
                              </>}
                              {esManual&&<>
                                <span style={{background:"#1a0e2e",color:"#a78bfa",border:"1px solid #4b1d8e",padding:"1px 5px",borderRadius:"4px",fontSize:"0.6rem",fontWeight:700,flexShrink:0}}>MANUAL</span>
                                <span style={{color:"#6b7280",fontFamily:"monospace",fontSize:"0.68rem"}}>...{e.id.slice(-6)}</span>
                              </>}
                              {e.turno&&<Bdg label={e.turno} bg={TURNO_C[e.turno]?.bg||"#130d2a"} t={TURNO_C[e.turno]?.c||"#a78bfa"}/>}
                              {e.preparado&&<Bdg label={"✓ "+(e.bultos||1)+"b"+(e.armadorNombre?" · "+e.armadorNombre:"")} bg="#041f14" t="#10b981"/>}
                              {e.cobranza&&<Bdg label={"$"+Number(e.cobranza).toLocaleString("es-AR")} bg="#1c1500" t="#fbbf24"/>}
                              {e.reprogramado&&<Bdg label="⟳ Reprog." bg="#1c1500" t="#fbbf24" style={{border:"1px solid #78350f"}}/>}
                            </div>
                            <div style={{color:"#e5e7eb",fontSize:"0.85rem",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.direccion}</div>
                            <div style={{color:"#6b7280",fontSize:"0.72rem",marginTop:"1px"}}>{e.localidad?e.localidad+" · ":""}{e.partido}{e.cp?" · CP "+e.cp:""}</div>
                          </div>
                          {/* Botón asignar / editar */}
                          <button
                            onClick={()=>abrirPanelArmador(e,e.preparado)}
                            title={e.preparado?"Editar armado":"Asignar armador"}
                            style={{flexShrink:0,width:"34px",height:"34px",borderRadius:"8px",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:"0.95rem",
                              background:e.preparado?"#1c1500":"#0f1420",
                              border:"1px solid "+(e.preparado?"#92400e":"#374151"),
                              color:e.preparado?"#f59e0b":"#6b7280",
                              transition:"all .15s"}}>
                            {e.preparado?"✏️":"📦"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* ── Grupo Colectas en el listado ─────────────────────────────── */}
          {(()=>{
            // Visible cuando filLog es TODOS o __COLECTAS__, y no es filtro FLEX
            if((filLog!=="TODOS"&&filLog!=="__COLECTAS__")||filTipo==="FLEX")return null;
            const ahora=Date.now();
            const pendientes=colectasOrdenadas.filter(c=>{
              if(c.loteImportacion&&(ahora-new Date(c.loteImportacion).getTime())>LIMITE_COLECTA_MS)return false;
              if(busqueda){const s=norm(busqueda);return norm(c.destinatario||"").includes(s)||(c.nroSeguimiento||"").includes(s);}
              return true;
            });
            const armadasHoy=colectasArmadasHoy.filter(c=>{
              if(soloPendientes)return false; // si filtra solo pendientes, no mostrar armadas
              if(busqueda){const s=norm(busqueda);return norm(c.destinatario||"").includes(s)||(c.nroSeguimiento||"").includes(s);}
              return true;
            });
            if(pendientes.length===0&&armadasHoy.length===0)return null;
            const items=[...pendientes,...armadasHoy];
            return(
              <div style={{marginBottom:"16px"}}>
                <div style={{display:"flex",alignItems:"center",gap:"8px",marginBottom:"6px"}}>
                  <div style={{flex:1,height:"1px",background:"#1a1f2e"}}/>
                  <div style={{background:"#1e1433",color:"#a78bfa",padding:"2px 12px",borderRadius:"10px",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase"}}>
                    📋 Colectas · {armadasHoy.length}/{items.length}
                  </div>
                  <div style={{flex:1,height:"1px",background:"#1a1f2e"}}/>
                </div>
                <div style={{display:"grid",gap:"6px"}}>
                  {items.map(c=>{
                    const esArmada=c.estado==="armada";
                    return(
                      <div key={c.id||c.nroSeguimiento} style={{...S.card,overflow:"hidden",opacity:esArmada?0.6:1,borderColor:esArmada?"#4c1d95":"#3b1d6e",borderLeft:"3px solid #a78bfa"}}>
                        <div style={{padding:"10px 14px",display:"flex",alignItems:"flex-start",gap:"10px"}}>
                          <div style={{width:"26px",height:"26px",borderRadius:"7px",background:esArmada?"#1e1433":"#0f1420",border:"2px solid "+(esArmada?"#7c3aed":"#4c1d95"),display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:"2px"}}>
                            <span style={{color:"#a78bfa",fontSize:"13px",lineHeight:1}}>{esArmada?"✓":"📋"}</span>
                          </div>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{display:"flex",gap:"4px",flexWrap:"wrap",marginBottom:"3px"}}>
                              {c.fecha&&c.fecha!==fecha&&<Bdg label={fmtCorta(c.fecha)} bg="#1a1f2e" t="#f59e0b"/>}
                              {esArmada&&<Bdg label={"✓ armada"+(c.armadorNombre?" · "+c.armadorNombre:"")} bg="#1e1433" t="#a78bfa"/>}
                            </div>
                            <div style={{color:"#e5e7eb",fontSize:"0.85rem",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.destinatario||c.direccion||"—"}</div>
                            <div style={{color:"#6b7280",fontSize:"0.72rem",marginTop:"1px",display:"flex",gap:"8px",flexWrap:"wrap"}}>
                              <span style={{fontFamily:"monospace"}}>{c.nroSeguimiento}</span>
                              {c.usuario&&<span style={{color:"#a78bfa",fontFamily:"sans-serif"}}>@{c.usuario}</span>}
                            </div>
                          </div>
                          <button
                            onClick={()=>!esArmada&&abrirPanelArmador({...c,_isColecta:true})}
                            disabled={esArmada}
                            title={esArmada?"Ya armada":"Asignar armador"}
                            style={{flexShrink:0,width:"34px",height:"34px",borderRadius:"8px",display:"flex",alignItems:"center",justifyContent:"center",cursor:esArmada?"default":"pointer",fontSize:"0.95rem",
                              background:esArmada?"#1e1433":"#0f1420",
                              border:"1px solid "+(esArmada?"#4c1d95":"#3b1d6e"),
                              color:esArmada?"#7c3aed":"#a78bfa",
                              transition:"all .15s",opacity:esArmada?0.5:1}}>
                            {esArmada?"✓":"📦"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </>)}

      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// TAB CONSULTA ARMADO — búsqueda histórica de pedidos armados
// ════════════════════════════════════════════════════════════════════
function TabConsultaArmado({esAdmin=false}){
  const hoy=fechaHoy();
  const d3=new Date(hoy+"T00:00:00");d3.setDate(d3.getDate()-2);
  const defDesde=d3.toISOString().split("T")[0];
  const [desde,setDesde]=useState(defDesde);
  const [hasta,setHasta]=useState(hoy);
  const [armados,setArmados]=useState([]);
  const [loading,setLoading]=useState(false);
  const [busqueda,setBusqueda]=useState("");
  const [expandId,setExpandId]=useState(null);

  const cargar=useCallback(async()=>{
    if(!desde||!hasta)return;
    setLoading(true);
    try{
      const q=query(collection(db,"armados"),where("fecha",">=",desde),where("fecha","<=",hasta));
      const snap=await getDocs(q);
      const data=snap.docs.map(d=>({id:d.id,...d.data()}));
      data.sort((a,b)=>(b.ts||"").localeCompare(a.ts||""));
      setArmados(data);
    }catch(err){console.error("Error cargando armados:",err);}
    finally{setLoading(false);}
  },[desde,hasta]);

  useEffect(()=>{cargar();},[cargar]);

  const eliminarColecta=async(a)=>{
    if(!window.confirm("¿Eliminar esta colecta del registro? Borrará tanto el armado como la colecta de Firestore."))return;
    try{
      await Promise.all([
        deleteDoc(doc(db,"armados",a.id)),
        a.envioId?deleteDoc(doc(db,"colectas",a.envioId)):Promise.resolve(),
      ]);
      setArmados(prev=>prev.filter(x=>x.id!==a.id));
    }catch(err){alert("Error al eliminar: "+err.message);}
  };

  const presets=[
    {l:"Hoy",fn:()=>{setDesde(hoy);setHasta(hoy);}},
    {l:"Ayer",fn:()=>{const d=new Date(hoy+"T00:00:00");d.setDate(d.getDate()-1);const v=d.toISOString().split("T")[0];setDesde(v);setHasta(v);}},
    {l:"3 días",fn:()=>{const d=new Date(hoy+"T00:00:00");d.setDate(d.getDate()-2);setDesde(d.toISOString().split("T")[0]);setHasta(hoy);}},
    {l:"7 días",fn:()=>{const d=new Date(hoy+"T00:00:00");d.setDate(d.getDate()-6);setDesde(d.toISOString().split("T")[0]);setHasta(hoy);}},
  ];

  const filtrados=useMemo(()=>{
    const s=norm(busqueda.trim());
    if(!s)return armados;
    return armados.filter(a=>(
      (a.nroSeguimiento||"").includes(busqueda.trim())||
      (String(a.nroOrdenTN||"")).includes(busqueda.trim())||
      (a.nroVenta||"").includes(busqueda.trim())||
      (a.nroPackId||"").includes(busqueda.trim())||
      norm(a.direccion||"").includes(s)||
      norm(a.destinatario||"").includes(s)||
      norm(a.usuario||"").includes(s)||
      norm(a.armadorNombre||"").includes(s)||
      norm(a.controladorNombre||"").includes(s)||
      norm(a.partido||"").includes(s)
    ));
  },[armados,busqueda]);

  return(
    <div>
      {/* Controles */}
      <div style={{...S.card,padding:"0.75rem 1rem",marginBottom:"0.75rem"}}>
        <div style={{display:"flex",gap:"6px",alignItems:"center",flexWrap:"wrap",marginBottom:"0.55rem"}}>
          {presets.map(p=><button key={p.l} onClick={p.fn} style={S.btnSm(false)}>{p.l}</button>)}
          <span style={{color:"#374151",fontSize:"0.6rem"}}>·</span>
          <input type="date" value={desde} onChange={e=>setDesde(e.target.value)} style={{...S.input,padding:"3px 8px",width:"138px",fontSize:"0.78rem"}}/>
          <span style={{color:"#6b7280",fontSize:"0.65rem"}}>→</span>
          <input type="date" value={hasta} onChange={e=>setHasta(e.target.value)} style={{...S.input,padding:"3px 8px",width:"138px",fontSize:"0.78rem"}}/>
          <button onClick={cargar} style={{...S.btn(true),background:"#12172a",border:"1px solid #6366f1",color:"#a78bfa",padding:"5px 14px",fontSize:"0.8rem"}}>
            {loading?"Cargando...":"🔄"}
          </button>
          <span style={{color:"#4b5563",fontSize:"0.68rem",marginLeft:"4px"}}>{armados.length} registros · {filtrados.length} en vista</span>
        </div>
        <input value={busqueda} onChange={e=>setBusqueda(e.target.value)}
          placeholder="🔍  Buscar por nro envío · nro TN · nro venta · pack id · dirección · usuario · destinatario · armador..."
          style={{...S.input,width:"100%"}}/>
      </div>

      {/* Lista */}
      <div style={{...S.card,padding:0,overflow:"hidden"}}>
        {/* Header */}
        <div style={{display:"grid",gridTemplateColumns:"110px 1fr 90px 100px 80px",gap:"6px",padding:"0.45rem 0.9rem",background:"#12172a",borderBottom:"1px solid #252d40",fontSize:"0.58rem",color:"#6b7280",fontWeight:700,textTransform:"uppercase",letterSpacing:".04em"}}>
          <span>Fecha · Hora</span><span>Pedido</span><span>Logística</span><span>Armador</span><span>Ctrl.</span>
        </div>
        {loading&&<div style={{padding:"2.5rem",textAlign:"center",color:"#4b5563"}}>Cargando...</div>}
        {!loading&&filtrados.length===0&&<div style={{padding:"2.5rem",textAlign:"center",color:"#4b5563"}}>Sin resultados para este rango / búsqueda</div>}
        {filtrados.map(a=>{
          const fechaDDMM=(()=>{const f=a.fecha||"";const p=f.split("-");return p.length===3?p[2]+"/"+p[1]:(a.ts?new Date(a.ts).toLocaleDateString("es-AR",{day:"2-digit",month:"2-digit"}):"—");})();
          const horaHHMM=fmtHora(a.ts)||"—";
          const expandido=expandId===a.id;
          return(
            <div key={a.id} style={{borderBottom:"1px solid #1a1f2e"}}>
              <div onClick={()=>setExpandId(expandido?null:a.id)}
                style={{display:"grid",gridTemplateColumns:"110px 1fr 90px 100px 80px",gap:"6px",padding:"0.5rem 0.9rem",alignItems:"start",cursor:"pointer",background:expandido?"#12172a":"transparent",transition:"background .1s"}}>
                {/* Fecha + Hora */}
                <div>
                  <div style={{color:"#6b7280",fontSize:"0.7rem",marginBottom:"1px"}}>{fechaDDMM}</div>
                  <div style={{color:"#e5e7eb",fontSize:"1rem",fontWeight:800,letterSpacing:"0.03em",lineHeight:1}}>{horaHHMM}</div>
                  {a.esEdicion&&<div style={{color:"#f59e0b",fontSize:"0.58rem",fontWeight:700,marginTop:"3px"}}>✏️ edit</div>}
                </div>
                {/* Pedido */}
                <div>
                  <div style={{display:"flex",gap:"3px",flexWrap:"wrap",marginBottom:"2px"}}>
                    {a.esColecta&&<span style={{background:"#1a0d2e",color:"#a78bfa",border:"1px solid #a78bfa44",padding:"1px 5px",borderRadius:"3px",fontSize:"0.58rem",fontWeight:700}}>📋 Colecta</span>}
                    {a.esFlex&&!a.esColecta&&<span style={{background:"#0d1c04",color:"#84cc16",border:"1px solid #84cc1644",padding:"1px 5px",borderRadius:"3px",fontSize:"0.58rem",fontWeight:700}}>FLEX</span>}
                    {!a.esFlex&&!a.esColecta&&<span style={{background:"#12172a",color:"#6366f1",border:"1px solid #6366f144",padding:"1px 5px",borderRadius:"3px",fontSize:"0.58rem",fontWeight:700}}>NO FX</span>}
                    {a.nroOrdenTN&&<span style={{color:"#7dd3fc",fontWeight:700,fontSize:"0.7rem"}}>#{a.nroOrdenTN}</span>}
                    {(a.bultos||1)>1&&<span style={{color:"#f59e0b",fontSize:"0.62rem",fontWeight:700}}>{a.bultos}b</span>}
                  </div>
                  <div style={{color:"#e5e7eb",fontWeight:600,fontSize:"0.8rem",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{a.esColecta?(a.destinatario||a.direccion||"—"):a.direccion||"—"}</div>
                  <div style={{color:"#6b7280",fontSize:"0.62rem"}}>{a.partido}</div>
                </div>
                {/* Logística */}
                <div style={{color:"#9ca3af",fontSize:"0.72rem",paddingTop:"2px"}}>{a.logistica||"—"}</div>
                {/* Armador */}
                <div style={{color:"#e5e7eb",fontSize:"0.75rem",fontWeight:600,paddingTop:"2px"}}>{a.armadorNombre||"—"}</div>
                {/* Controlador */}
                <div style={{color:"#6366f1",fontSize:"0.7rem",paddingTop:"2px"}}>{a.controladorNombre||<span style={{color:"#374151"}}>—</span>}</div>
              </div>
              {/* Detalle expandido */}
              {expandido&&(
                <div style={{padding:"0.5rem 0.9rem 0.7rem",background:"#080c17",borderTop:"1px solid #1a1f2e"}}>
                  <div style={{display:"flex",gap:"1.5rem",flexWrap:"wrap",fontSize:"0.68rem",color:"#6b7280"}}>
                    {a.nroSeguimiento&&<div><div style={{color:"#374151",textTransform:"uppercase",fontSize:"0.56rem",fontWeight:700,marginBottom:"1px"}}>Nro seguimiento</div><div style={{color:"#a78bfa",fontFamily:"monospace"}}>{a.nroSeguimiento}</div></div>}
                    {a.nroOrdenTN&&<div><div style={{color:"#374151",textTransform:"uppercase",fontSize:"0.56rem",fontWeight:700,marginBottom:"1px"}}>Nro TN</div><div style={{color:"#7dd3fc"}}>#{a.nroOrdenTN}</div></div>}
                    {a.nroVenta&&<div><div style={{color:"#374151",textTransform:"uppercase",fontSize:"0.56rem",fontWeight:700,marginBottom:"1px"}}>Nro venta</div><div style={{color:"#e5e7eb"}}>{a.nroVenta}</div></div>}
                    {a.nroPackId&&<div><div style={{color:"#374151",textTransform:"uppercase",fontSize:"0.56rem",fontWeight:700,marginBottom:"1px"}}>Pack ID</div><div style={{color:"#e5e7eb"}}>{a.nroPackId}</div></div>}
                    {a.usuario&&<div><div style={{color:"#374151",textTransform:"uppercase",fontSize:"0.56rem",fontWeight:700,marginBottom:"1px"}}>Usuario ML</div><div style={{color:"#e5e7eb"}}>{a.usuario}</div></div>}
                    {a.destinatario&&<div><div style={{color:"#374151",textTransform:"uppercase",fontSize:"0.56rem",fontWeight:700,marginBottom:"1px"}}>Destinatario</div><div style={{color:"#e5e7eb"}}>{a.destinatario}</div></div>}
                    {a.direccion&&<div><div style={{color:"#374151",textTransform:"uppercase",fontSize:"0.56rem",fontWeight:700,marginBottom:"1px"}}>Dirección</div><div style={{color:"#e5e7eb"}}>{a.direccion}</div></div>}
                    <div><div style={{color:"#374151",textTransform:"uppercase",fontSize:"0.56rem",fontWeight:700,marginBottom:"1px"}}>Armador</div><div style={{color:"#e5e7eb"}}>{a.armadorNombre||"—"}</div></div>
                    {a.controladorNombre&&<div><div style={{color:"#374151",textTransform:"uppercase",fontSize:"0.56rem",fontWeight:700,marginBottom:"1px"}}>Controlador</div><div style={{color:"#6366f1"}}>{a.controladorNombre}</div></div>}
                    <div><div style={{color:"#374151",textTransform:"uppercase",fontSize:"0.56rem",fontWeight:700,marginBottom:"1px"}}>TS completo</div><div style={{color:"#374151",fontFamily:"monospace"}}>{a.ts||"—"}</div></div>
                  </div>
                  {esAdmin&&a.esColecta&&(
                    <div style={{marginTop:"8px",borderTop:"1px solid #1a1f2e",paddingTop:"8px"}}>
                      <button onClick={()=>eliminarColecta(a)}
                        style={{padding:"4px 12px",borderRadius:"6px",background:"#1c0404",border:"1px solid #7f1d1d",color:"#f87171",cursor:"pointer",fontSize:"0.72rem",fontWeight:600}}>
                        🗑 Eliminar colecta
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TabStatsArmado({configExpedicion={},setConfigExpedicion=()=>{},esAdmin=false}){
  const hoy=fechaHoy();
  const gapUmbralMin=configExpedicion.gapUmbralMin||5;
  const [gapEditVal,setGapEditVal]=useState(String(gapUmbralMin));
  useEffect(()=>{setGapEditVal(String(gapUmbralMin));},[gapUmbralMin]);
  const [statsDesde,setStatsDesde]=useState(hoy);
  const [statsHasta,setStatsHasta]=useState(hoy);
  const [statsArmadosRaw,setStatsArmadosRaw]=useState([]);
  const [loadingStats,setLoadingStats]=useState(false);
  const [statsFilArm,setStatsFilArm]=useState("TODOS"); // filtro log por armador
  const [statsFilTipo,setStatsFilTipo]=useState("TODOS"); // TODOS | ENVIOS | COLECTAS

  // Cargar stats al cambiar el rango de fechas (vacío en ambos = todas las fechas)
  useEffect(()=>{
    setLoadingStats(true);
    let q;
    if(!statsDesde&&!statsHasta){
      q=query(collection(db,"armados"),limit(3000));
    }else if(statsDesde&&statsHasta&&statsDesde===statsHasta){
      q=query(collection(db,"armados"),where("fecha","==",statsDesde));
    }else{
      q=query(collection(db,"armados"),where("fecha",">=",statsDesde||"0000-00-00"),where("fecha","<=",statsHasta||"9999-99-99"));
    }
    getDocs(q)
      .then(snap=>{setStatsArmadosRaw(snap.docs.map(d=>({id:d.id,...d.data()})));setLoadingStats(false);})
      .catch(()=>setLoadingStats(false));
  },[statsDesde,statsHasta]);

  const statsArmados=useMemo(()=>{
    return statsArmadosRaw.filter(a=>statsFilTipo==="TODOS"||(statsFilTipo==="COLECTAS"?a.esColecta:!a.esColecta));
  },[statsArmadosRaw,statsFilTipo]);

  // Estadísticas por armador
  const statsPerArmador=useMemo(()=>{
    if(!statsArmados.length)return[];
    const map={};
    statsArmados.forEach(a=>{
      const k=a.armadorId||a.armadorNombre||"?";
      if(!map[k])map[k]={id:a.armadorId,nombre:a.armadorNombre||"?",count:0,bultos:0,times:[]};
      map[k].count++;map[k].bultos+=(a.bultos||1);
      if(a.ts)map[k].times.push(new Date(a.ts).getTime());
    });
    return Object.values(map).map(arm=>{
      arm.times.sort((a,b)=>a-b);
      const n=arm.times.length;
      if(n>1){
        const spanMs=arm.times[n-1]-arm.times[0];
        const spanMin=spanMs/60000;
        arm.spanMin=Math.round(spanMin);
        arm.pedXhora=spanMin>0?Math.round(arm.count/(spanMin/60)*10)/10:null;
        // avg gap entre scans consecutivos
        const diffs=[];for(let i=1;i<n;i++)diffs.push((arm.times[i]-arm.times[i-1])/60000);
        arm.avgGapMin=Math.round(diffs.reduce((s,d)=>s+d,0)/diffs.length*10)/10;
      }else{arm.spanMin=0;arm.pedXhora=null;arm.avgGapMin=null;}
      arm.inicioTs=n>0?arm.times[0]:null;
      arm.finTs=n>0?arm.times[n-1]:null;
      return arm;
    }).sort((a,b)=>(b.count||0)-(a.count||0)); // ranking principal: cantidad de pedidos armados
  },[statsArmados]);

  // Ranking secundario: por velocidad (ped/h) — solo armadores con velocidad calculable
  const statsPerArmadorVelocidad=useMemo(()=>{
    return statsPerArmador.filter(a=>a.pedXhora).slice().sort((a,b)=>(b.pedXhora||0)-(a.pedXhora||0));
  },[statsPerArmador]);

  // Controladores: tiempo activo estimado (mismo umbral 15 min)
  const statsControladores=useMemo(()=>{
    const map={};
    statsArmados.forEach(a=>{
      if(!a.controladorId&&!a.controladorNombre)return;
      const k=a.controladorId||a.controladorNombre;
      if(!map[k])map[k]={id:a.controladorId,nombre:a.controladorNombre||"?",count:0,times:[]};
      map[k].count++;
      if(a.ts)map[k].times.push(new Date(a.ts).getTime());
    });
    return Object.values(map).map(ctrl=>{
      ctrl.times.sort((a,b)=>a-b);
      ctrl.tiempoActivoMin=calcTiempoActivo(ctrl.times);
      return ctrl;
    }).sort((a,b)=>b.count-a.count);
  },[statsArmados]);

  // Sesiones por armador: bloques separados por gaps > gapUmbralMin
  const statsConSesiones=useMemo(()=>{
    const umbralMs=gapUmbralMin*60000;
    return statsPerArmador.map(arm=>{
      const times=arm.times||[];
      if(times.length===0)return{...arm,sesiones:[]};
      const sesiones=[];let grupo=[times[0]];
      for(let i=1;i<times.length;i++){
        if(times[i]-times[i-1]>umbralMs){sesiones.push(grupo);grupo=[times[i]];}
        else grupo.push(times[i]);
      }
      sesiones.push(grupo);
      const tiempoActivoMin=calcTiempoActivo(times);
      return{...arm,tiempoActivoMin,sesiones:sesiones.map(ts=>{
        const n=ts.length,spanMs=n>1?ts[n-1]-ts[0]:0,spanMin=spanMs/60000;
        const diffs=[];for(let i=1;i<n;i++)diffs.push((ts[i]-ts[i-1])/60000);
        const avgGapMin=diffs.length>0?Math.round(diffs.reduce((s,d)=>s+d,0)/diffs.length*10)/10:null;
        const pedXhora=spanMin>0?Math.round(n/(spanMin/60)*10)/10:null;
        return{inicioTs:ts[0],finTs:ts[n-1],count:n,spanMin:Math.round(spanMin),pedXhora,avgGapMin};
      })};
    });
  },[statsPerArmador,gapUmbralMin]);

  const actPorHora=useMemo(()=>{
    const hrs=Array.from({length:24},(_,i)=>({h:i,count:0}));
    statsArmados.forEach(a=>{if(a.ts)hrs[new Date(a.ts).getHours()].count++;});
    return hrs.filter(h=>h.count>0);
  },[statsArmados]);

  return(
    <div>
      <div style={{...S.card,padding:"0.6rem 1rem",marginBottom:"0.75rem",display:"flex",gap:"6px",alignItems:"center",flexWrap:"wrap"}}>
        <span style={{color:"#4b5563",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase"}}>Fecha</span>
        <button onClick={()=>{setStatsDesde(fechaAyer());setStatsHasta(fechaAyer());}} style={S.btnSm(statsDesde===fechaAyer()&&statsHasta===fechaAyer())}>Ayer</button>
        <button onClick={()=>{setStatsDesde(hoy);setStatsHasta(hoy);}} style={S.btnSm(statsDesde===hoy&&statsHasta===hoy)}>Hoy</button>
        <button onClick={()=>{const d=new Date();d.setDate(d.getDate()-6);const d7=new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().split("T")[0];setStatsDesde(d7);setStatsHasta(hoy);}} style={S.btnSm(statsDesde!==hoy&&statsDesde!==""&&statsHasta===hoy)}>Últimos 7 días</button>
        <button onClick={()=>{setStatsDesde("");setStatsHasta("");}} style={S.btnSm(!statsDesde&&!statsHasta)}>Todas</button>
        <span style={{color:"#4b5563",fontSize:"0.65rem"}}>Desde</span>
        <input type="date" value={statsDesde} onChange={e=>setStatsDesde(e.target.value)} style={{...S.input,padding:"3px 8px",width:"138px",fontSize:"0.78rem"}}/>
        <span style={{color:"#4b5563",fontSize:"0.65rem"}}>Hasta</span>
        <input type="date" value={statsHasta} onChange={e=>setStatsHasta(e.target.value)} style={{...S.input,padding:"3px 8px",width:"138px",fontSize:"0.78rem"}}/>
        <span style={{color:"#4b5563",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",marginLeft:"10px"}}>Tipo</span>
        {[{l:"Todos",v:"TODOS"},{l:"📦 Envíos",v:"ENVIOS"},{l:"📋 Colectas",v:"COLECTAS"}].map(x=>(
          <button key={x.v} onClick={()=>setStatsFilTipo(x.v)} style={S.btnSm(statsFilTipo===x.v)}>{x.l}</button>
        ))}
        <span style={{color:"#4b5563",fontSize:"0.72rem",marginLeft:"4px"}}>{statsArmados.length} armados</span>
        {esAdmin&&(
          <div style={{display:"flex",alignItems:"center",gap:"5px",marginLeft:"auto"}}>
            <span style={{color:"#4b5563",fontSize:"0.62rem",fontWeight:700}}>⚙ umbral sesión</span>
            <input type="number" min="1" max="120" value={gapEditVal} onChange={e=>setGapEditVal(e.target.value)}
              style={{...S.input,width:"50px",padding:"2px 6px",fontSize:"0.78rem",textAlign:"center"}}/>
            <span style={{color:"#4b5563",fontSize:"0.62rem"}}>min</span>
            <button onClick={()=>{const v=parseInt(gapEditVal);if(v>0)setConfigExpedicion(p=>({...p,gapUmbralMin:v}));}}
              style={{...S.btnSm(false),padding:"2px 10px",fontSize:"0.72rem",background:"#1a1f2e",border:"1px solid #6366f1",color:"#a78bfa"}}>✓</button>
          </div>
        )}
      </div>

      {loadingStats&&<div style={{textAlign:"center",padding:"2rem",color:"#4b5563",fontSize:"0.82rem"}}>Cargando...</div>}

      {!loadingStats&&statsArmados.length===0&&(
        <div style={{textAlign:"center",padding:"3rem",color:"#4b5563"}}><div style={{fontSize:"2rem"}}>📊</div><p style={{marginTop:"8px"}}>Sin registros para este rango/filtro</p></div>
      )}

      {!loadingStats&&statsArmados.length>0&&(()=>{
        const totalPed=statsArmados.length;
        const totalBultos=statsArmados.reduce((s,a)=>s+(a.bultos||1),0);
        const maxVel=statsPerArmadorVelocidad[0]?.pedXhora||0;
        const topCount=statsPerArmador[0]?.count||0;
        const logDetalle=statsArmados
          .filter(a=>statsFilArm==="TODOS"||a.armadorNombre===statsFilArm)
          .slice().sort((a,b)=>new Date(a.ts)-new Date(b.ts));
        return(<>
        {/* ── Tarjetas resumen ── */}
        <div style={{display:"flex",gap:"8px",marginBottom:"0.75rem",flexWrap:"wrap"}}>
          <div style={{...S.card,padding:"0.8rem",flex:1,textAlign:"center",minWidth:"70px"}}>
            <div style={{fontSize:"1.8rem",fontWeight:800,color:"#6366f1"}}>{totalPed}</div>
            <div style={{fontSize:"0.6rem",color:"#6b7280",textTransform:"uppercase",marginTop:"2px"}}>Pedidos</div>
          </div>
          <div style={{...S.card,padding:"0.8rem",flex:1,textAlign:"center",minWidth:"70px"}}>
            <div style={{fontSize:"1.8rem",fontWeight:800,color:"#10b981"}}>{totalBultos}</div>
            <div style={{fontSize:"0.6rem",color:"#6b7280",textTransform:"uppercase",marginTop:"2px"}}>Bultos</div>
          </div>
          <div style={{...S.card,padding:"0.8rem",flex:1,textAlign:"center",minWidth:"70px"}}>
            <div style={{fontSize:"1.8rem",fontWeight:800,color:"#f59e0b"}}>{statsPerArmador.length}</div>
            <div style={{fontSize:"0.6rem",color:"#6b7280",textTransform:"uppercase",marginTop:"2px"}}>Armadores</div>
          </div>
          {maxVel>0&&<div style={{...S.card,padding:"0.8rem",flex:1,textAlign:"center",minWidth:"80px"}}>
            <div style={{fontSize:"1.8rem",fontWeight:800,color:"#f87171"}}>{maxVel}</div>
            <div style={{fontSize:"0.6rem",color:"#6b7280",textTransform:"uppercase",marginTop:"2px"}}>Mejor ped/h</div>
          </div>}
        </div>

        {/* ── Ranking principal: cantidad de pedidos armados ── */}
        <div style={{...S.card,padding:"1rem",marginBottom:"0.75rem"}}>
          <div style={{color:"#f59e0b",fontSize:"0.7rem",fontWeight:700,textTransform:"uppercase",letterSpacing:".06em",marginBottom:"12px"}}>🏆 Ranking — cantidad armada</div>
          {statsConSesiones.map((arm,i)=>{
            const pctBar=topCount>0?Math.round(arm.count/topCount*100):0;
            const barColor=i===0?"#f59e0b":i===1?"#9ca3af":i===2?"#b45309":"#374151";
            const multiSesion=arm.sesiones.length>1;
            return(
              <div key={arm.id||arm.nombre} style={{marginBottom:"14px"}}>
                <div style={{display:"flex",alignItems:"flex-start",gap:"8px",marginBottom:"4px"}}>
                  <span style={{fontSize:"0.9rem",fontWeight:800,color:barColor,minWidth:"20px",marginTop:"1px"}}>{i+1}</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:700,fontSize:"0.9rem",color:"#e5e7eb"}}>{arm.nombre}</div>
                    {arm.sesiones.map((ses,si)=>{
                      const spanH=ses.spanMin?Math.floor(ses.spanMin/60)+"h "+String(ses.spanMin%60).padStart(2,"0")+"m":null;
                      const gapAlto=ses.avgGapMin!==null&&ses.avgGapMin>gapUmbralMin;
                      return(
                        <div key={si} style={{display:"flex",gap:"8px",flexWrap:"wrap",marginTop:"3px",alignItems:"center"}}>
                          {multiSesion&&<span style={{fontSize:"0.58rem",color:"#6b7280",background:"#1a1f2e",padding:"0 4px",borderRadius:"3px",fontWeight:700}}>sesión {si+1}</span>}
                          <span style={{fontSize:"0.67rem",color:"#4b5563"}}>{fmtHora(ses.inicioTs)} → {fmtHora(ses.finTs)}{spanH?" ("+spanH+")":""} · {ses.count}p</span>
                          {ses.avgGapMin!==null&&<span style={{fontSize:"0.67rem",color:gapAlto?"#f87171":"#4b5563",fontWeight:gapAlto?700:400}}>⌀ {ses.avgGapMin}m{gapAlto?" ⚠":""}</span>}
                          {ses.pedXhora&&<span style={{fontSize:"0.67rem",color:"#6366f1"}}>{ses.pedXhora}p/h</span>}
                        </div>
                      );
                    })}
                  </div>
                  <div style={{textAlign:"right",flexShrink:0}}>
                    <div style={{fontWeight:800,fontSize:"1rem",color:"#6366f1"}}>{arm.count} ped <span style={{fontSize:"0.72rem",color:"#4b5563",fontWeight:400}}>· {arm.bultos}b</span></div>
                    {arm.tiempoActivoMin>0&&<div style={{fontSize:"0.72rem",fontWeight:700,color:"#10b981"}}>⏱ {fmtMin(arm.tiempoActivoMin)} activo</div>}
                    {arm.pedXhora&&<div style={{fontSize:"0.72rem",fontWeight:700,color:"#f87171"}}>{arm.pedXhora} ped/h</div>}
                  </div>
                </div>
                <div style={{height:"6px",background:"#1a1f2e",borderRadius:"3px",overflow:"hidden"}}>
                  <div style={{width:pctBar+"%",height:"100%",background:barColor,borderRadius:"3px",transition:"width 0.4s"}}/>
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Ranking secundario: velocidad (ped/h) ── */}
        {statsPerArmadorVelocidad.length>0&&(
          <div style={{...S.card,padding:"1rem",marginBottom:"0.75rem"}}>
            <div style={{color:"#f87171",fontSize:"0.7rem",fontWeight:700,textTransform:"uppercase",letterSpacing:".06em",marginBottom:"12px"}}>⚡ Ranking secundario — velocidad (ped/h)</div>
            {statsPerArmadorVelocidad.map((arm,i)=>{
              const pctBar=maxVel>0?Math.round(arm.pedXhora/maxVel*100):0;
              const barColor=i===0?"#f87171":i===1?"#9ca3af":i===2?"#b45309":"#374151";
              return(
                <div key={arm.id||arm.nombre} style={{marginBottom:"10px"}}>
                  <div style={{display:"flex",alignItems:"center",gap:"8px",marginBottom:"3px"}}>
                    <span style={{fontSize:"0.8rem",fontWeight:800,color:barColor,minWidth:"18px"}}>{i+1}</span>
                    <div style={{flex:1,fontWeight:600,fontSize:"0.82rem",color:"#e5e7eb"}}>{arm.nombre}</div>
                    <div style={{fontSize:"0.78rem",fontWeight:700,color:"#f87171"}}>{arm.pedXhora} ped/h</div>
                  </div>
                  <div style={{height:"4px",background:"#1a1f2e",borderRadius:"2px",overflow:"hidden"}}>
                    <div style={{width:pctBar+"%",height:"100%",background:barColor,borderRadius:"2px",transition:"width 0.4s"}}/>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Controladores ── */}
        {statsControladores.length>0&&(
          <div style={{...S.card,padding:"1rem",marginBottom:"0.75rem"}}>
            <div style={{color:"#06b6d4",fontSize:"0.7rem",fontWeight:700,textTransform:"uppercase",letterSpacing:".06em",marginBottom:"12px"}}>🔍 Controladores — tiempo activo</div>
            {statsControladores.map((ctrl,i)=>(
              <div key={ctrl.id||ctrl.nombre} style={{display:"flex",alignItems:"center",gap:"8px",marginBottom:"10px"}}>
                <span style={{fontSize:"0.8rem",fontWeight:800,color:"#4b5563",minWidth:"18px"}}>{i+1}</span>
                <div style={{flex:1,fontWeight:600,fontSize:"0.85rem",color:"#e5e7eb"}}>{ctrl.nombre}</div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:"0.78rem",color:"#06b6d4",fontWeight:700}}>{ctrl.count} pedidos</div>
                  {ctrl.tiempoActivoMin>0&&<div style={{fontSize:"0.68rem",color:"#10b981",fontWeight:700}}>⏱ {fmtMin(ctrl.tiempoActivoMin)} activo</div>}
                </div>
              </div>
            ))}
            <div style={{fontSize:"0.58rem",color:"#374151",marginTop:"6px",borderTop:"1px solid #1a1f2e",paddingTop:"6px"}}>* Tiempo estimado: activo mientras había escaneos bajo control. Pausas ≥ {UMBRAL_ACTIVO_MIN} min excluidas.</div>
          </div>
        )}

        {/* ── Actividad por hora ── */}
        {actPorHora.length>0&&(
          <div style={{...S.card,padding:"1rem",marginBottom:"0.75rem"}}>
            <div style={{color:"#38bdf8",fontSize:"0.7rem",fontWeight:700,textTransform:"uppercase",letterSpacing:".06em",marginBottom:"10px"}}>⏱ Actividad por hora</div>
            <div style={{display:"flex",alignItems:"flex-end",gap:"3px",height:"64px"}}>
              {actPorHora.map(h=>{
                const maxH=Math.max(...actPorHora.map(x=>x.count));
                const pctH=maxH>0?Math.round(h.count/maxH*100):0;
                return(
                  <div key={h.h} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:"2px"}}>
                    <div style={{width:"100%",height:Math.max(3,pctH*0.58)+"px",background:"#38bdf8",borderRadius:"2px 2px 0 0"}}/>
                    <div style={{fontSize:"8px",color:"#4b5563"}}>{h.h}h</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Log detallado — para cámaras ── */}
        <div style={{...S.card,padding:"1rem"}}>
          <div style={{display:"flex",alignItems:"center",gap:"8px",marginBottom:"10px",flexWrap:"wrap"}}>
            <div style={{color:"#a78bfa",fontSize:"0.7rem",fontWeight:700,textTransform:"uppercase",letterSpacing:".06em",flex:1}}>🎥 Log de armados</div>
            <div style={{display:"flex",gap:"4px",flexWrap:"wrap"}}>
              <button onClick={()=>setStatsFilArm("TODOS")} style={{...S.btnSm(statsFilArm==="TODOS"),padding:"2px 8px",fontSize:"0.68rem"}}>Todos</button>
              {statsPerArmador.map(a=><button key={a.nombre} onClick={()=>setStatsFilArm(a.nombre)} style={{...S.btnSm(statsFilArm===a.nombre),padding:"2px 8px",fontSize:"0.68rem"}}>{a.nombre}</button>)}
            </div>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:"4px",maxHeight:"400px",overflowY:"auto"}}>
            {logDetalle.map((a,i)=>(
              <div key={a.id||i} style={{display:"flex",gap:"8px",alignItems:"flex-start",padding:"5px 6px",borderRadius:"6px",background:i%2===0?"#0d1020":"transparent"}}>
                <div style={{flexShrink:0,minWidth:"42px"}}>
                  <div style={{fontFamily:"monospace",fontSize:"0.78rem",color:"#6366f1",fontWeight:700}}>{fmtHora(a.ts)}</div>
                  {statsDesde!==statsHasta&&<div style={{fontSize:"0.6rem",color:"#4b5563"}}>{a.fecha}</div>}
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:"0.78rem",color:"#e5e7eb",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{a.direccion||a.nroOrdenTN||a.envioId}</div>
                  <div style={{display:"flex",gap:"8px",marginTop:"1px",flexWrap:"wrap"}}>
                    {a.esColecta&&<span style={{fontSize:"0.65rem",color:"#a78bfa",fontWeight:700}}>📋 Colecta</span>}
                    {a.nroOrdenTN&&<span style={{fontSize:"0.65rem",color:"#7dd3fc"}}>#{a.nroOrdenTN}</span>}
                    {a.logistica&&<span style={{fontSize:"0.65rem",color:"#4b5563"}}>{a.logistica}</span>}
                    {a.bultos>1&&<span style={{fontSize:"0.65rem",color:"#f59e0b"}}>{a.bultos}b</span>}
                    {a.esEdicion&&<span style={{fontSize:"0.65rem",color:"#f59e0b",fontWeight:700}}>✏ edit</span>}
                  </div>
                </div>
                <div style={{fontSize:"0.72rem",color:"#a78bfa",fontWeight:600,flexShrink:0}}>{a.armadorNombre}</div>
              </div>
            ))}
            {logDetalle.length===0&&<div style={{color:"#4b5563",fontSize:"0.78rem",textAlign:"center",padding:"1rem"}}>Sin registros para este filtro</div>}
          </div>
        </div>
      </>);
      })()}
    </div>
  );
}

function imprimirEtiquetas(envio,lc){
  const bultos=envio.bultos||1;
  const lcD=lc[envio.trans]||{};
  const etqs=Array.from({length:bultos},(_,i)=>`
    <div style="width:9cm;min-height:6cm;border:2px solid #333;border-radius:8px;padding:14px;margin:0 auto 16px;font-family:Arial,sans-serif;page-break-inside:avoid;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">
        <div>
          <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.04em;">EnviosHub · UMP Papel Distribuidora</div>
          <div style="font-size:13px;font-weight:700;color:#333;margin-top:2px;">${envio.trans||"Sin asignar"}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:28px;font-weight:900;color:#333;line-height:1;">${i+1}/${bultos}</div>
          <div style="font-size:10px;color:#666;">bulto${bultos>1?"s":""}</div>
        </div>
      </div>
      <div style="border-top:1px solid #ddd;padding-top:10px;margin-bottom:8px;">
        <div style="font-size:15px;font-weight:700;color:#111;margin-bottom:4px;">${envio.direccion}</div>
        <div style="font-size:12px;color:#444;">${[envio.localidad,envio.partido].filter(Boolean).join(" · ")}${envio.cp?" · CP "+envio.cp:""}</div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:8px;">
        <div>
          ${envio.turno?'<div style="display:inline-block;background:#f0f0f0;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;color:#333;">'+envio.turno+'</div>':""}
          ${envio.fecha?'<div style="font-size:10px;color:#666;margin-top:3px;">'+envio.fecha+'</div>':""}
        </div>
        <div style="text-align:right;">
          ${envio.origen==="ML"&&envio.nroSeguimiento?'<div style="font-family:monospace;font-size:10px;color:#666;">'+envio.nroSeguimiento+'</div>':""}
          ${envio.nroOrdenTN?'<div style="font-size:11px;font-weight:700;color:#333;">#'+envio.nroOrdenTN+'</div>':""}
          ${envio.cobranza?'<div style="font-size:13px;font-weight:700;color:#b45309;">Cobrar $'+Number(envio.cobranza).toLocaleString("es-AR")+'</div>':""}
        </div>
      </div>
    </div>`).join("");

  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Etiquetas</title>
  <style>@page{size:A4;margin:10mm;}body{margin:0;padding:8px;}@media print{button{display:none!important;}}</style>
  </head><body>
  <div style="text-align:center;margin-bottom:12px;font-family:Arial;font-size:11px;color:#888;">
    ${envio.direccion} · ${bultos} etiqueta${bultos>1?"s":""}
  </div>
  ${etqs}
  <script>window.onload=function(){window.print();}<\/script>
  </body></html>`;
  const w=window.open("","_blank");
  if(!w){alert("Permite ventanas emergentes.");return;}
  w.document.write(html);w.document.close();
}

// Imprime sólo las etiquetas de los bultos adicionales (2..N) — se llama automáticamente en expedición
function imprimirEtiquetasExtra(envio,lc){
  const bultos=envio.bultos||1;
  if(bultos<=1)return;
  const etqs=Array.from({length:bultos-1},(_,i)=>{
    const nb=i+2;
    return`<div style="width:9cm;min-height:6cm;border:2px solid #333;border-radius:8px;padding:14px;margin:0 auto 16px;font-family:Arial,sans-serif;page-break-inside:avoid;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">
        <div>
          <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.04em;">EnviosHub · UMP Papel Distribuidora</div>
          <div style="font-size:13px;font-weight:700;color:#333;margin-top:2px;">${envio.trans||"Sin asignar"}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:28px;font-weight:900;color:#333;line-height:1;">${nb}/${bultos}</div>
          <div style="font-size:10px;color:#666;">bulto${bultos>1?"s":""}</div>
        </div>
      </div>
      <div style="border-top:1px solid #ddd;padding-top:10px;margin-bottom:8px;">
        <div style="font-size:15px;font-weight:700;color:#111;margin-bottom:4px;">${envio.direccion}</div>
        <div style="font-size:12px;color:#444;">${[envio.localidad,envio.partido].filter(Boolean).join(" · ")}${envio.cp?" · CP "+envio.cp:""}</div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:8px;">
        <div>
          ${envio.turno?'<div style="display:inline-block;background:#f0f0f0;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;color:#333;">'+envio.turno+'</div>':""}
          ${envio.fecha?'<div style="font-size:10px;color:#666;margin-top:3px;">'+envio.fecha+'</div>':""}
        </div>
        <div style="text-align:right;">
          ${envio.nroOrdenTN?'<div style="font-size:11px;font-weight:700;color:#333;">#'+envio.nroOrdenTN+'</div>':""}
          ${envio.cobranza?'<div style="font-size:13px;font-weight:700;color:#b45309;">Cobrar $'+Number(envio.cobranza).toLocaleString("es-AR")+'</div>':""}
        </div>
      </div>
    </div>`;
  }).join("");
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Etiquetas adicionales</title><style>@page{size:A4;margin:10mm;}body{margin:0;padding:8px;}@media print{button{display:none!important;}}</style></head><body><div style="text-align:center;margin-bottom:12px;font-family:Arial;font-size:11px;color:#888;">${envio.direccion} · bultos adicionales (${nb} de ${bultos})</div>${etqs}<script>window.onload=function(){window.print();};<\/script></body></html>`;
  const w=window.open("","_blank");
  if(!w){alert("Permití ventanas emergentes para imprimir.");return;}
  w.document.write(html);w.document.close();
}

function ScrollTop(){
  const [vis,setVis]=useState(false);
  useEffect(()=>{
    const h=()=>setVis(window.scrollY>350);
    window.addEventListener("scroll",h,{passive:true});
    return()=>window.removeEventListener("scroll",h);
  },[]);
  if(!vis)return null;
  return(
    <button
      onClick={()=>window.scrollTo({top:0,behavior:"smooth"})}
      title="Volver arriba"
      style={{position:"fixed",bottom:"28px",right:"20px",zIndex:200,width:"40px",height:"40px",borderRadius:"50%",background:"#6366f1",border:"none",color:"white",fontSize:"18px",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 4px 16px rgba(99,102,241,0.5)",opacity:0.9}}
    >↑</button>
  );
}



// ════════════════════════════════════════════════════════════════════
// DESPACHO PAGE — página pública que abre el PDF de despacho
// ════════════════════════════════════════════════════════════════════
function DespachoPage({token}){
  const [estado,setEstado]=useState("cargando"); // cargando | generando | listo | error | expirado
  const [err,setErr]=useState("");
  const [despachoData,setDespachoData]=useState(null);

  // Carga datos de Firestore
  useEffect(()=>{
    if(!token){setErr("Token inválido.");setEstado("error");return;}
    getDoc(doc(db,"despachos",token)).then(snap=>{
      if(!snap.exists()){setErr("Despacho no encontrado.");setEstado("error");return;}
      const data=snap.data();
      // Verificar expiración (48 hs)
      if(data.expiresAt&&new Date().toISOString()>data.expiresAt){
        setEstado("expirado");return;
      }
      setDespachoData(data);
      setEstado("generando");
    }).catch(e=>{setErr("Error al cargar: "+e.message);setEstado("error");});
  },[token]);

  // Genera y descarga el PDF usando jsPDF + autotable (sin html2canvas)
  useEffect(()=>{
    if(estado!=="generando"||!despachoData)return;
    const generar=async()=>{
      const orient=despachoData?.pdfOrient||"landscape";
      const nombre=despachoData?.logisticaNombre||despachoData?.logistica||"despacho";
      const fecha=despachoData?.fecha||"hoy";
      const filename=`${nombre}_${fecha}.pdf`;
      const lista=despachoData.envios||[];

      // Cargar jsPDF
      if(!window.jspdf){
        await new Promise((res,rej)=>{const s=document.createElement("script");s.src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";s.onload=res;s.onerror=rej;document.head.appendChild(s);});
      }
      // Cargar autotable (extiende jsPDF.prototype)
      if(!window.jspdf?.jsPDF?.prototype?.autoTable){
        await new Promise((res,rej)=>{const s=document.createElement("script");s.src="https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.7.0/jspdf.plugin.autotable.min.js";s.onload=res;s.onerror=rej;document.head.appendChild(s);});
      }

      const {jsPDF}=window.jspdf;
      const doc=new jsPDF({orientation:orient,unit:"mm",format:"a4"});
      const hayCobro=lista.some(e=>e.cobranza>0);
      const totalImp=lista.reduce((s,e)=>s+(e.importe||0),0);
      const cobTotal=lista.filter(e=>e.cobranza>0).reduce((s,e)=>s+(e.cobranza||0),0);
      const ahora=new Date();
      const ts=ahora.toLocaleDateString("es-AR",{weekday:"long",day:"numeric",month:"long",year:"numeric"})+" "+ahora.toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit",hour12:false});
      const pageW=doc.internal.pageSize.getWidth();

      // Encabezado
      doc.setFontSize(11);doc.setFont("helvetica","bold");
      doc.text(`${nombre} · ${ts}`,10,9);
      doc.setFontSize(8);doc.setFont("helvetica","normal");
      const resumen=`${lista.length} envíos · $${Math.round(totalImp).toLocaleString("es-AR")}${cobTotal?" · A cobrar: $"+cobTotal.toLocaleString("es-AR"):""}`;
      doc.text(resumen,pageW-10,9,{align:"right"});

      // Filas de datos
      const body=lista.map((e,i)=>{
        const esFlex=e.origen==="ML";
        const dir=[e.direccion,e.localidad,e.partido,e.cp].filter(Boolean).join(" · ");
        const refExtra=(e.referencia&&!(e.direccion||"").toLowerCase().includes((e.referencia||"").toLowerCase().slice(0,20)))?" — "+e.referencia:"";
        const nroRef=esFlex?(e.nroSeguimiento||""):("#"+(e.nroOrdenTN||""));
        const zml=esFlex?(getZonaML(e.partido)||""):(e.partido||"");
        const loteCell=e.loteImportacion?new Date(e.loteImportacion).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit",hour12:false}):"—";
        const row=[i+1,loteCell,nroRef,e.tipoEntrega==="COMERCIAL"?"COM":e.tipoEntrega==="RESIDENCIAL"?"RES":"—",e.bultos||1,"□",dir+(refExtra||""),zml,e.turno||"—",e.fecha?fmtCorta(e.fecha):"—"];
        if(hayCobro)row.push(e.cobranza?"$"+Number(e.cobranza).toLocaleString("es-AR"):"—");
        return row;
      });

      const head=[["#","Lote","Nro envío","Tipo","Blts","Chk","Dirección · Localidad · Partido · CP","Zona","Turno","Fecha",...(hayCobro?["Cobrar"]:[])]];

      doc.autoTable({
        startY:13,
        head,
        body,
        styles:{fontSize:8,cellPadding:1.5,overflow:"linebreak"},
        headStyles:{fillColor:[232,232,232],textColor:[85,85,85],fontStyle:"bold",fontSize:7},
        alternateRowStyles:{fillColor:[249,249,249]},
        columnStyles:{
          0:{cellWidth:7,halign:"center",textColor:[150,150,150]},
          1:{cellWidth:15,halign:"center",textColor:[22,163,74],fontStyle:"bold"},
          2:{cellWidth:32,halign:"left"},
          3:{cellWidth:10,halign:"center"},
          4:{cellWidth:9,halign:"center"},
          5:{cellWidth:7,halign:"center"},
          6:{cellWidth:"auto"},
          7:{cellWidth:16},
          8:{cellWidth:11,halign:"center"},
          9:{cellWidth:13,halign:"center"},
          ...(hayCobro?{10:{cellWidth:18,halign:"right"}}:{}),
        },
        didParseCell:(data)=>{
          if(data.section==="body"){
            // Dirección en negrita
            if(data.column.index===6)data.cell.styles.fontStyle="bold";
            // Nro envío en courier
            if(data.column.index===2)data.cell.styles.font="courier";
            // Bultos múltiples en negrita
            if(data.column.index===4&&Number(data.cell.raw)>1)data.cell.styles.fontStyle="bold";
            // Color tipo COM/RES
            if(data.column.index===3){
              if(data.cell.raw==="COM"){data.cell.styles.textColor=[29,78,216];data.cell.styles.fillColor=[219,234,254];}
              else if(data.cell.raw==="RES"){data.cell.styles.textColor=[21,128,61];data.cell.styles.fillColor=[220,252,231];}
            }
          }
        },
        margin:{top:8,right:10,bottom:8,left:10},
        didDrawPage:(data)=>{
          doc.setFontSize(6);doc.setFont("helvetica","normal");doc.setTextColor(150,150,150);
          doc.text(`${lista.length} envíos`,data.settings.margin.left,doc.internal.pageSize.getHeight()-4);
          doc.text(`Pág. ${doc.internal.getCurrentPageInfo().pageNumber}`,pageW-data.settings.margin.right,doc.internal.pageSize.getHeight()-4,{align:"right"});
          doc.setTextColor(0,0,0);
        },
      });

      doc.save(filename);
      setEstado("listo");
      setTimeout(()=>window.close(),4000);
    };
    generar().catch(e=>{setErr("Error al generar PDF: "+e.message);setEstado("error");});
  },[estado,despachoData]);

  const bg="#0a0e1a",tx="#e5e7eb",muted="#6b7280",red="#f87171",yellow="#fbbf24";

  if(estado==="expirado")return(
    <div style={{minHeight:"100vh",background:bg,display:"flex",alignItems:"center",justifyContent:"center",color:tx,fontFamily:"sans-serif",padding:"1rem"}}>
      <div style={{textAlign:"center",maxWidth:"320px"}}><div style={{fontSize:"2rem",marginBottom:"0.5rem"}}>⏰</div><div style={{color:yellow,fontWeight:700,marginBottom:"0.5rem"}}>Link expirado</div><div style={{color:muted,fontSize:"0.85rem"}}>Este link era válido por 48 hs. Pedí uno nuevo.</div></div>
    </div>
  );
  if(estado==="error")return(
    <div style={{minHeight:"100vh",background:bg,display:"flex",alignItems:"center",justifyContent:"center",color:tx,fontFamily:"sans-serif",padding:"1rem"}}>
      <div style={{textAlign:"center",maxWidth:"320px"}}><div style={{fontSize:"2rem",marginBottom:"0.5rem"}}>❌</div><div style={{color:red,fontWeight:700,marginBottom:"0.5rem"}}>No se pudo cargar</div><div style={{color:muted,fontSize:"0.85rem"}}>{err}</div></div>
    </div>
  );

  return(
    <div style={{minHeight:"100vh",background:bg,color:tx,fontFamily:"sans-serif"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh",flexDirection:"column",gap:"0.75rem"}}>
        <div style={{fontSize:"2.5rem"}}>{estado==="listo"?"✅":"📄"}</div>
        <div style={{fontWeight:700,fontSize:"1rem"}}>{estado==="listo"?"PDF descargado":"Generando PDF..."}</div>
        {estado==="listo"&&<div style={{color:muted,fontSize:"0.82rem",textAlign:"center"}}>Revisá tu carpeta de descargas.<br/>Esta pestaña se cierra en unos segundos.</div>}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// CONFIRM PAGE — página pública para que logísticas confirmen cierre
// ════════════════════════════════════════════════════════════════════
function ConfirmPage({token}){
  const [cierre,setCierre]=useState(null);
  const [cargando,setCargando]=useState(true);
  const [err,setErr]=useState("");
  const [modo,setModo]=useState(null); // null | "ok" | "incidentes"
  const [incidents,setIncidents]=useState({});
  const [guardando,setGuardando]=useState(false);
  const [done,setDone]=useState(false);

  useEffect(()=>{
    if(!token){setErr("Token inválido.");setCargando(false);return;}
    getDoc(doc(db,"cierres",token)).then(snap=>{
      if(!snap.exists()){setErr("Cierre no encontrado. El link puede ser incorrecto o ya fue eliminado.");setCargando(false);return;}
      const d=snap.data();
      setCierre(d);
      if(d.confirmado)setDone(true);
      setCargando(false);
    }).catch(e=>{setErr("Error al cargar: "+e.message);setCargando(false);});
  },[token]);

  const fmtP=n=>n!=null?"$"+Number(n).toLocaleString("es-AR"):"";
  const fechaLabel=cierre?.fecha?new Date(cierre.fecha+"T00:00:00").toLocaleDateString("es-AR",{weekday:"long",day:"numeric",month:"long",year:"numeric"}):"";
  const bg="#0a0e1a",card="#12172a",brd="#1e2640",green="#10b981",yellow="#fbbf24",red="#f87171",tx="#e5e7eb",muted="#6b7280";
  const cs={background:card,border:`1px solid ${brd}`,borderRadius:"12px",padding:"1rem",marginBottom:"0.75rem"};

  const handleConfirmar=async()=>{
    setGuardando(true);
    const incs=Object.entries(incidents).filter(([,v])=>v.sel).map(([envioId,v])=>({envioId,motivo:v.motivo||"",nuevaFecha:v.nuevaFecha||""}));
    try{
      await updateDoc(doc(db,"cierres",token),{confirmado:true,confirmadoAt:new Date().toISOString(),incidentes:incs});
      setDone(true);
    }catch(e){alert("Error al confirmar: "+e.message);}
    setGuardando(false);
  };

  if(cargando)return(
    <div style={{minHeight:"100vh",background:bg,display:"flex",alignItems:"center",justifyContent:"center",color:tx,fontFamily:"sans-serif"}}>
      <div style={{textAlign:"center"}}><div style={{fontSize:"2rem",marginBottom:"0.5rem"}}>⏳</div><div style={{color:muted}}>Cargando...</div></div>
    </div>
  );
  if(err)return(
    <div style={{minHeight:"100vh",background:bg,display:"flex",alignItems:"center",justifyContent:"center",color:tx,fontFamily:"sans-serif",padding:"1rem"}}>
      <div style={{textAlign:"center",maxWidth:"320px"}}><div style={{fontSize:"2rem",marginBottom:"0.5rem"}}>❌</div><div style={{color:red,fontWeight:700,marginBottom:"0.5rem"}}>No se pudo cargar</div><div style={{color:muted,fontSize:"0.85rem"}}>{err}</div></div>
    </div>
  );
  if(done)return(
    <div style={{minHeight:"100vh",background:bg,color:tx,fontFamily:"sans-serif",padding:"1rem",maxWidth:"480px",margin:"0 auto"}}>
      <style>{`*{box-sizing:border-box;}`}</style>
      <div style={{textAlign:"center",padding:"2rem 0 1rem"}}>
        <div style={{fontSize:"3rem",marginBottom:"0.5rem"}}>✅</div>
        <div style={{fontWeight:800,fontSize:"1.2rem",marginBottom:"0.3rem"}}>Cierre confirmado</div>
        <div style={{color:muted,fontSize:"0.85rem"}}>{fechaLabel}</div>
      </div>
      <div style={cs}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:"0.5rem"}}><span style={{color:muted,fontSize:"0.8rem"}}>Logística</span><span style={{fontWeight:700}}>{cierre.logisticaNombre}</span></div>
        <div style={{display:"flex",justifyContent:"space-between"}}><span style={{color:muted,fontSize:"0.8rem"}}>Envíos asignados</span><span style={{fontWeight:700}}>{cierre.envios?.length||0}</span></div>
        {cierre.incidentes?.length>0&&(
          <div style={{marginTop:"0.75rem",borderTop:`1px solid ${brd}`,paddingTop:"0.75rem"}}>
            <div style={{color:yellow,fontWeight:700,fontSize:"0.85rem",marginBottom:"0.5rem"}}>⚠️ Incidentes reportados ({cierre.incidentes.length})</div>
            {cierre.incidentes.map((inc,i)=>{
              const e=cierre.envios?.find(x=>x.id===inc.envioId);
              return(<div key={i} style={{background:"#1c1a0a",border:"1px solid #3d3200",borderRadius:"8px",padding:"0.5rem 0.75rem",marginBottom:"0.4rem",fontSize:"0.8rem"}}>
                <div style={{color:tx,fontWeight:600}}>{e?.direccion||inc.envioId}</div>
                {inc.motivo&&<div style={{color:muted,marginTop:"2px"}}>Motivo: {inc.motivo}</div>}
                {inc.nuevaFecha&&<div style={{color:muted,marginTop:"2px"}}>Reprogramado: {inc.nuevaFecha}</div>}
              </div>);
            })}
          </div>
        )}
      </div>
      <div style={{textAlign:"center",color:muted,fontSize:"0.75rem",marginTop:"1rem"}}>EnviosHub · Solo lectura</div>
    </div>
  );

  return(
    <div style={{minHeight:"100vh",background:bg,color:tx,fontFamily:"sans-serif",padding:"1rem",maxWidth:"480px",margin:"0 auto"}}>
      <style>{`*{box-sizing:border-box;}`}</style>
      <div style={{textAlign:"center",padding:"1.5rem 0 1rem"}}>
        <div style={{width:"40px",height:"40px",background:"linear-gradient(135deg,#6366f1,#8b5cf6)",borderRadius:"10px",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"1.3rem",margin:"0 auto 0.75rem"}}>🛵</div>
        <div style={{fontWeight:800,fontSize:"1.1rem",marginBottom:"0.2rem"}}>Cierre del día</div>
        <div style={{color:muted,fontSize:"0.85rem"}}>{fechaLabel}</div>
      </div>
      <div style={cs}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:"0.4rem"}}><span style={{color:muted,fontSize:"0.8rem"}}>Logística</span><span style={{fontWeight:700}}>{cierre.logisticaNombre}</span></div>
        <div style={{display:"flex",justifyContent:"space-between"}}><span style={{color:muted,fontSize:"0.8rem"}}>Envíos asignados</span><span style={{fontWeight:700}}>{cierre.envios?.length||0}</span></div>
      </div>
      <div style={cs}>
        <div style={{fontWeight:700,fontSize:"0.8rem",marginBottom:"0.6rem",color:muted,textTransform:"uppercase",letterSpacing:"0.05em"}}>Detalle</div>
        {cierre.envios?.map((e,i)=>(
          <div key={e.id} style={{padding:"0.5rem 0",borderBottom:i<cierre.envios.length-1?`1px solid ${brd}`:"none",display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:"8px"}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:"0.82rem",fontWeight:600,color:tx,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{e.direccion||"(sin dirección)"}</div>
              <div style={{fontSize:"0.72rem",color:muted,marginTop:"1px"}}>{[e.localidad,e.partido].filter(Boolean).join(" · ")}{e.bultos>1?" · "+e.bultos+" bultos":""}</div>
            </div>
            <div style={{textAlign:"right",flexShrink:0}}>
              <div style={{fontSize:"0.82rem",fontWeight:700,color:green}}>{fmtP(e.importe)}</div>
              {e.cobranza>0&&<div style={{fontSize:"0.7rem",color:yellow}}>COB {fmtP(e.cobranza)}</div>}
            </div>
          </div>
        ))}
      </div>
      {modo===null&&(
        <div style={{display:"flex",flexDirection:"column",gap:"0.6rem",marginTop:"0.25rem"}}>
          <div style={{textAlign:"center",color:muted,fontSize:"0.85rem",marginBottom:"0.1rem"}}>¿Todos los envíos fueron entregados?</div>
          <button onClick={()=>setModo("ok")} style={{width:"100%",padding:"0.9rem",borderRadius:"12px",background:"#0d1c14",border:"2px solid #10b981",color:"#10b981",fontWeight:800,fontSize:"1rem",cursor:"pointer"}}>✅ Sí, todo OK</button>
          <button onClick={()=>setModo("incidentes")} style={{width:"100%",padding:"0.9rem",borderRadius:"12px",background:"#1c1200",border:"2px solid #f59e0b",color:"#f59e0b",fontWeight:800,fontSize:"1rem",cursor:"pointer"}}>⚠️ Hubo incidentes</button>
        </div>
      )}
      {modo==="ok"&&(
        <div style={{marginTop:"0.25rem"}}>
          <div style={{...cs,background:"#0d1c14",border:"1px solid #10b981",textAlign:"center",padding:"1rem"}}>
            <div style={{fontSize:"1.5rem",marginBottom:"0.3rem"}}>✅</div>
            <div style={{fontWeight:700,color:green}}>Todo entregado correctamente</div>
          </div>
          <div style={{display:"flex",gap:"0.5rem"}}>
            <button onClick={()=>setModo(null)} style={{flex:1,padding:"0.8rem",borderRadius:"10px",background:"transparent",border:`1px solid ${brd}`,color:muted,cursor:"pointer",fontWeight:600}}>Volver</button>
            <button onClick={handleConfirmar} disabled={guardando} style={{flex:2,padding:"0.8rem",borderRadius:"10px",background:guardando?"#1a1a2e":"linear-gradient(135deg,#10b981,#059669)",border:"none",color:"#fff",fontWeight:800,cursor:guardando?"not-allowed":"pointer",fontSize:"0.95rem"}}>
              {guardando?"Guardando...":"Confirmar y enviar"}
            </button>
          </div>
        </div>
      )}
      {modo==="incidentes"&&(
        <div>
          <div style={{color:yellow,fontWeight:700,fontSize:"0.85rem",marginBottom:"0.5rem"}}>Marcá los envíos con incidentes:</div>
          <div style={cs}>
            {cierre.envios?.map((e,i)=>{
              const inc=incidents[e.id]||{};
              return(
                <div key={e.id} style={{padding:"0.6rem 0",borderBottom:i<cierre.envios.length-1?`1px solid ${brd}`:"none"}}>
                  <div style={{display:"flex",alignItems:"center",gap:"10px",cursor:"pointer"}} onClick={()=>setIncidents(p=>({...p,[e.id]:{...p[e.id],sel:!inc.sel}}))}>
                    <div style={{width:"22px",height:"22px",borderRadius:"5px",border:`2px solid ${inc.sel?"#f59e0b":brd}`,background:inc.sel?"#2a1a00":"transparent",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:"0.85rem"}}>
                      {inc.sel?"⚠️":""}
                    </div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:"0.82rem",fontWeight:600,color:tx,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{e.direccion||"(sin dirección)"}</div>
                      <div style={{fontSize:"0.7rem",color:muted}}>{[e.localidad,e.partido].filter(Boolean).join(" · ")}</div>
                    </div>
                  </div>
                  {inc.sel&&(
                    <div style={{marginTop:"0.5rem",paddingLeft:"32px",display:"flex",flexDirection:"column",gap:"6px"}}>
                      <input placeholder="Motivo (ej: no había nadie, dirección incorrecta...)" value={inc.motivo||""} onChange={ev=>setIncidents(p=>({...p,[e.id]:{...p[e.id],motivo:ev.target.value}}))} style={{width:"100%",background:"#1a1f2e",border:`1px solid ${brd}`,borderRadius:"7px",padding:"6px 10px",color:tx,fontSize:"0.78rem",outline:"none"}}/>
                      <input type="date" value={inc.nuevaFecha||""} onChange={ev=>setIncidents(p=>({...p,[e.id]:{...p[e.id],nuevaFecha:ev.target.value}}))} style={{width:"100%",background:"#1a1f2e",border:`1px solid ${brd}`,borderRadius:"7px",padding:"6px 10px",color:tx,fontSize:"0.78rem",outline:"none"}}/>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{display:"flex",gap:"0.5rem"}}>
            <button onClick={()=>setModo(null)} style={{flex:1,padding:"0.8rem",borderRadius:"10px",background:"transparent",border:`1px solid ${brd}`,color:muted,cursor:"pointer",fontWeight:600}}>Volver</button>
            <button onClick={handleConfirmar} disabled={guardando} style={{flex:2,padding:"0.8rem",borderRadius:"10px",background:guardando?"#1a1a2e":"linear-gradient(135deg,#f59e0b,#d97706)",border:"none",color:"#fff",fontWeight:800,cursor:guardando?"not-allowed":"pointer",fontSize:"0.95rem"}}>
              {guardando?"Guardando...":"Confirmar y enviar"}
            </button>
          </div>
        </div>
      )}
      <div style={{textAlign:"center",color:muted,fontSize:"0.72rem",marginTop:"1.5rem",paddingBottom:"1rem"}}>EnviosHub · Link de solo confirmación</div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// TAB SALIDA — Despacho con escaneo por logística
// ════════════════════════════════════════════════════════════════════
function TabSalida({envios,setEnvios,lc,sesion}){
  const hoy=fechaHoy();
  const logActivas=Object.entries(lc).filter(([,v])=>v.activa).map(([k])=>k);

  // ── Estado ────────────────────────────────────────────────────────
  const [fecha,setFecha]=useState(hoy);
  const [logSel,setLogSel]=useState(null);          // logística "bloqueada" para la sesión
  const [turnoSel,setTurnoSel]=useState([]);          // turnos "bloqueados" para la sesión (array, multi-turno)
  const [qrInput,setQrInput]=useState("");
  const [resultado,setResultado]=useState(null);    // {ok,msg,envio}
  const [overlayError,setOverlayError]=useState(null); // {msg} → overlay rojo de pantalla completa
  const [confirmBultos,setConfirmBultos]=useState(null); // envio con >1 bulto pendiente de confirmación
  const [sesionIds,setSesionIds]=useState([]);       // IDs despachados en esta sesión (en orden)
  const [camara,setCamara]=useState(false);
  const soportaCamera=typeof window!=="undefined"&&"mediaDevices" in navigator&&!!navigator.mediaDevices?.getUserMedia;
  const inputRef=useRef(null);
  const videoRef=useRef(null);
  const canvasRef=useRef(null);

  // Backup de sesión activa en Firestore (debounced 3s) para resiliencia ante crash de localStorage
  useEffect(()=>{
    if(!logSel||!turnoSel.length||!sesionIds.length)return;
    const t=setTimeout(()=>{
      const docId="activa_"+(sesion?.id||"anon");
      setDoc(doc(db,"sesionesSalidaActiva",docId),{
        logSel,turnoSel,fecha,sesionIds,updatedAt:new Date().toISOString(),operador:sesion?.nombre||sesion?.email||""
      }).catch(()=>{});
    },3000);
    return()=>clearTimeout(t);
  },[sesionIds,logSel,turnoSel,fecha,sesion]);

  // Cargar firmante y sesión guardada desde localStorage; si no hay, intentar Firestore como fallback
  useEffect(()=>{
    const f=localStorage.getItem("salida_firmante_ultimo");
    if(f)setFirmante(f);
    const s=localStorage.getItem("salida_sesion_activa");
    if(s){
      try{setSesionGuardadaOffer(JSON.parse(s));}catch(e){}
    } else {
      // Fallback: buscar sesión activa en Firestore
      const docId="activa_"+(sesion?.id||"anon");
      getDoc(doc(db,"sesionesSalidaActiva",docId)).then(snap=>{
        if(snap.exists()){
          const d=snap.data();
          // Solo ofrecer recuperar si tiene datos recientes (menos de 24hs)
          const age=Date.now()-new Date(d.updatedAt||0).getTime();
          if(age<86400000&&d.sesionIds?.length>0){
            setSesionGuardadaOffer(d);
          }
        }
      }).catch(()=>{});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  // Persistir sesión activa en localStorage cada vez que cambian los IDs escaneados
  useEffect(()=>{
    if(logSel&&turnoSel.length>0&&sesionIds.length>0){
      localStorage.setItem("salida_sesion_activa",JSON.stringify({logSel,turnoSel,fecha,sesionIds}));
    }
  },[logSel,turnoSel,fecha,sesionIds]);

  // Back button trap: evita que el botón "atrás" salga de la app mientras hay sesión activa
  useEffect(()=>{
    if(!logSel)return;
    window.history.pushState({salida:true},"","");
    const handler=()=>{
      window.history.pushState({salida:true},"","");
      if(sesionIds.length>0){
        setResultado({ok:false,msg:"⚠ Sesión activa — usá Liberar para salir"});
        setTimeout(()=>setResultado(null),3500);
      }
    };
    window.addEventListener("popstate",handler);
    return()=>window.removeEventListener("popstate",handler);
  },[logSel,sesionIds.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const esAdmin=sesion?.rol==="admin";
  const [selSalida,setSelSalida]=useState(new Set());
  const [subTab,setSubTab]=useState("despacho"); // "despacho" | "historial"
  const [histFecha,setHistFecha]=useState(hoy);
  const [histFilLog,setHistFilLog]=useState("TODOS");
  const [logPreSel,setLogPreSel]=useState(null);       // logística elegida antes del turno
  const [modalCierre,setModalCierre]=useState(false);  // modal de cierre de sesión
  const [firmaData,setFirmaData]=useState(null);        // dataURL de la firma digital
  const [guardandoCierre,setGuardandoCierre]=useState(false);
  const firmaRef=useRef(null);                           // canvas de firma
  const [sesiones,setSesiones]=useState([]);             // historial de cierres
  const [sesionesLoading,setSesionesLoading]=useState(false);
  const [sesionExpandida,setSesionExpandida]=useState(null); // id expandido en historial
  const [firmante,setFirmante]=useState("");                 // nombre/apellido del firmante
  const [notasPendientes,setNotasPendientes]=useState({});  // {[envioId]: nota} para los no despachados
  const [sesionGuardadaOffer,setSesionGuardadaOffer]=useState(null); // sesión persistida en localStorage

  // La sesión solo se cierra manualmente (sin timer de inactividad)
  const liberarLogistica=useCallback(()=>{
    localStorage.removeItem("salida_sesion_activa");
    setLogSel(null);setTurnoSel([]);setLogPreSel(null);setSesionIds([]);setResultado(null);setQrInput("");setSelSalida(new Set());setModalCierre(false);setFirmaData(null);setNotasPendientes({});
  },[]);

  // Despachar envíos seleccionados manualmente (sin escanear) — solo admin
  const despacharSeleccionados=useCallback(()=>{
    if(!selSalida.size)return;
    const ts=new Date().toISOString();
    const despachoPor=sesion?.nombre||sesion?.email||"";
    setEnvios(pv=>pv.map(e=>selSalida.has(e.id)?{...e,despachado:true,despachoTs:ts,despachoLogistica:logSel,despachoPor}:e));
    setSesionIds(prev=>[...[...selSalida].filter(id=>!prev.includes(id)),...prev]);
    setSelSalida(new Set());
    beepOK();
  },[selSalida,logSel,sesion,setEnvios]);

  // ── Pedidos del día para la logística + turno seleccionados ───────
  // Los envíos sin turno asignado (legacy) no se excluyen para no trabar pedidos viejos.
  const pedidosLog=useMemo(()=>{
    if(!logSel||!turnoSel.length)return[];
    return envios.filter(e=>{
      const f=e.fecha||e.fechaVenta||"";
      return f===fecha&&e.trans===logSel&&getEstado(e)==="asignado"&&e.estado!=="cancelado"&&(!e.turno||turnoSel.includes(e.turno));
    });
  },[envios,logSel,turnoSel,fecha]);

  const totalLog=pedidosLog.length;
  // enviosMap debe estar aquí (antes de despachados) — usarlo antes de la definición
  // causa ReferenceError cuando sesionIds no está vacío (temporal dead zone de const).
  const enviosMap=new Map(envios.map(e=>[e.id,e]));
  // Usar sesionIds como fuente autoritativa — no depende del flag e.despachado
  // que puede perderse si el browser cierra antes de que React persista el estado.
  const sesionSet=new Set(sesionIds);
  const despachados=sesionIds.map(id=>enviosMap.get(id)).filter(Boolean);
  const lotePend=pedidosLog.filter(e=>!sesionSet.has(e.id));
  const pct=totalLog>0?Math.round(despachados.length/totalLog*100):0;

  // ── Procesar scan ─────────────────────────────────────────────────
  const procesarScan=useCallback((raw)=>{
    const srch=raw.trim();
    if(!srch)return;
    setQrInput("");
    if(!logSel||!turnoSel.length){beepError();return;}

    const nums=srch.replace(/\D/g,"");
    // Buscar en TODOS los envíos del día no cancelados (incluye sin_asignar) para dar errores específicos
    const candidatos=envios.filter(e=>{
      const f=e.fecha||e.fechaVenta||"";
      return f===fecha&&e.estado!=="cancelado"&&getEstado(e)!=="cancelado";
    });

    let best=null,bestScore=0;
    candidatos.forEach(e=>{
      const sc=scoreBusqueda(e,srch,nums);
      if(sc>bestScore){bestScore=sc;best=e;}
    });

    if(!best||bestScore===0){
      beepError();
      setResultado({ok:false,msg:"Pedido no encontrado: "+srch});
      setTimeout(()=>setResultado(null),4000);
      if(inputRef.current)inputRef.current.focus();
      return;
    }

    // Sin asignar → overlay rojo bloqueante específico
    if(!best.trans){
      beepError();
      setOverlayError({
        titulo:"SIN ASIGNAR",
        detalle:"Este pedido no tiene logística asignada. Asignalo primero en el panel de despacho.",
        envio:best,
        trans:"",
        color:"#f59e0b",
      });
      if(inputRef.current)inputRef.current.focus();
      return;
    }

    // Logística incorrecta → overlay rojo bloqueante
    if(best.trans!==logSel){
      beepError();
      const lcData=lc[best.trans]||{};
      setOverlayError({
        titulo:"LOGÍSTICA INCORRECTA",
        detalle:`Este pedido pertenece a ${best.trans||"otra logística"}, no a ${logSel}.`,
        envio:best,
        trans:best.trans,
        color:lcData.color||"#ef4444",
      });
      if(inputRef.current)inputRef.current.focus();
      return;
    }

    // Turno incorrecto (logística correcta, pero otro turno) → overlay rojo bloqueante.
    // Los pedidos sin turno asignado (legacy) no se bloquean.
    if(best.turno&&!turnoSel.includes(best.turno)){
      beepError();
      const turnoC=TURNO_C[best.turno]||{};
      setOverlayError({
        titulo:"TURNO INCORRECTO",
        detalle:`Este pedido es de turno ${best.turno}, no de ${turnoSel.join("/")}.`,
        envio:best,
        trans:best.trans,
        turno:best.turno,
        color:turnoC.c||"#ef4444",
      });
      if(inputRef.current)inputRef.current.focus();
      return;
    }

    // Pedido no preparado → bloqueo
    if(!best.preparado){
      beepError();
      setResultado({ok:false,msg:"⚠ Sin preparar: "+( best.nroOrdenTN?"#"+best.nroOrdenTN:best.direccion)});
      setTimeout(()=>setResultado(null),5000);
      if(inputRef.current)inputRef.current.focus();
      return;
    }

    // Ya despachado en esta sesión
    if(sesionIds.includes(best.id)){
      beepError();
      setResultado({ok:false,msg:"Ya despachado en esta sesión: "+(best.nroOrdenTN?"#"+best.nroOrdenTN:best.direccion)});
      setTimeout(()=>setResultado(null),4000);
      if(inputRef.current)inputRef.current.focus();
      return;
    }

    // Multi-bulto: pedir confirmación antes de despachar
    if((best.bultos||1)>1){
      beepOK();
      setConfirmBultos(best);
      setQrInput("");
      return;
    }

    // ✅ Despachar (1 bulto)
    const ts=new Date().toISOString();
    const despachoPor=sesion?.nombre||sesion?.email||"";
    setEnvios(pv=>pv.map(e=>e.id===best.id?{...e,despachado:true,despachoTs:ts,despachoLogistica:logSel,despachoPor}:e));
    setSesionIds(prev=>[best.id,...prev]);
    beepOK();
    setQrInput("");
    setResultado({ok:true,envio:best,msg:"✓ Despachado: "+(best.nroOrdenTN?"#"+best.nroOrdenTN+" — ":"")+best.direccion});
    setTimeout(()=>setResultado(null),5000);
  },[envios,logSel,turnoSel,fecha,sesionIds,sesion,lc,setEnvios]);

  // Escaneo QR via cámara — modo continuo: la cámara queda abierta entre scans.
  // Cooldown de 2s para evitar re-procesar el mismo código seguido.
  // Usa BarcodeDetector nativo si está disponible (Chrome/Android);
  // si no existe (Safari/iPhone) decodifica con jsQR leyendo los frames del video por canvas.
  useEffect(()=>{
    if(!camara)return;
    let stream=null;let rafId=null;let activo=true;
    const startCam=async()=>{
      try{
        stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment",width:{ideal:1280},height:{ideal:720}}});
        if(!videoRef.current||!activo)return;
        videoRef.current.srcObject=stream;
        await videoRef.current.play();
        const nativo=typeof window.BarcodeDetector!=="undefined";
        const detector=nativo?new window.BarcodeDetector({formats:["qr_code","code_128","code_39","ean_13"]}):null;
        if(!canvasRef.current)canvasRef.current=document.createElement("canvas");
        const canvas=canvasRef.current;
        const ctx=canvas.getContext("2d",{willReadFrequently:true});
        let lastVal=null;let lastValTs=0;
        const scan=async()=>{
          if(!activo||!videoRef.current||videoRef.current.readyState<2){rafId=requestAnimationFrame(scan);return;}
          try{
            let val=null;
            if(nativo){
              const barcodes=await detector.detect(videoRef.current);
              if(barcodes.length>0)val=barcodes[0].rawValue;
            }else{
              const w=videoRef.current.videoWidth,h=videoRef.current.videoHeight;
              if(w&&h){
                canvas.width=w;canvas.height=h;
                ctx.drawImage(videoRef.current,0,0,w,h);
                const imgData=ctx.getImageData(0,0,w,h);
                const code=jsQR(imgData.data,w,h);
                if(code)val=code.data;
              }
            }
            if(val){
              const now=Date.now();
              if(lastVal===val&&(now-lastValTs)<2000){rafId=requestAnimationFrame(scan);return;}
              lastVal=val;lastValTs=now;
              setResultado({ok:"scanning",msg:"Escaneando..."});
              await new Promise(r=>setTimeout(r,800));
              if(!activo)return;
              procesarScan(val);
              // Cámara continua — pausa breve antes del próximo scan
              await new Promise(r=>setTimeout(r,1500));
              if(activo)rafId=requestAnimationFrame(scan);
              return;
            }
          }catch(e){}
          if(activo)rafId=requestAnimationFrame(scan);
        };
        rafId=requestAnimationFrame(scan);
      }catch(err){
        setResultado({ok:false,msg:"No se pudo acceder a la cámara. Verificá los permisos."});
        setCamara(false);
      }
    };
    startCam();
    return()=>{
      activo=false;
      if(rafId)cancelAnimationFrame(rafId);
      if(stream)stream.getTracks().forEach(t=>t.stop());
    };
  },[camara,procesarScan]);

  // Canvas de firma digital — registra eventos cuando el modal de cierre está abierto
  useEffect(()=>{
    if(!modalCierre||!firmaRef.current)return;
    const canvas=firmaRef.current;
    const ctx=canvas.getContext("2d");
    ctx.fillStyle="#0f1420";
    ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.strokeStyle="#ffffff";
    ctx.lineWidth=2.5;
    ctx.lineCap="round";
    ctx.lineJoin="round";
    let drawing=false;
    const getPos=(e)=>{
      const rect=canvas.getBoundingClientRect();
      const sx=canvas.width/rect.width,sy=canvas.height/rect.height;
      const cx=e.touches?e.touches[0].clientX:e.clientX;
      const cy=e.touches?e.touches[0].clientY:e.clientY;
      return[(cx-rect.left)*sx,(cy-rect.top)*sy];
    };
    const start=(e)=>{e.preventDefault();drawing=true;const[x,y]=getPos(e);ctx.beginPath();ctx.moveTo(x,y);};
    const move=(e)=>{
      if(!drawing)return;e.preventDefault();
      const[x,y]=getPos(e);ctx.lineTo(x,y);ctx.stroke();ctx.beginPath();ctx.moveTo(x,y);
      setFirmaData(canvas.toDataURL("image/png"));
    };
    const end=()=>{drawing=false;};
    canvas.addEventListener("mousedown",start);canvas.addEventListener("mousemove",move);
    canvas.addEventListener("mouseup",end);canvas.addEventListener("mouseleave",end);
    canvas.addEventListener("touchstart",start,{passive:false});canvas.addEventListener("touchmove",move,{passive:false});
    canvas.addEventListener("touchend",end);
    return()=>{
      canvas.removeEventListener("mousedown",start);canvas.removeEventListener("mousemove",move);
      canvas.removeEventListener("mouseup",end);canvas.removeEventListener("mouseleave",end);
      canvas.removeEventListener("touchstart",start);canvas.removeEventListener("touchmove",move);
      canvas.removeEventListener("touchend",end);
    };
  },[modalCierre]);

  const handleKey=e=>{if(e.key==="Enter"){procesarScan(qrInput);}};

  // ── Des-despachar (undo) ──────────────────────────────────────────
  const desDespachar=useCallback((envioId)=>{
    setEnvios(pv=>pv.map(e=>e.id===envioId?{...e,despachado:false,despachoTs:null,despachoLogistica:null,despachoPor:null}:e));
    setSesionIds(prev=>prev.filter(id=>id!==envioId));
  },[setEnvios]);

  // ── Colores UI ────────────────────────────────────────────────────
  const bg="#0a0e1a",card="#0f1420",brd="#1a1f2e",muted="#6b7280",ok="#10b981",err="#ef4444";

  // Cargar historial de cierres de sesión desde Firestore
  // IMPORTANTE: este useEffect debe estar ANTES de cualquier return condicional
  // para respetar el orden de hooks (Rules of Hooks).
  useEffect(()=>{
    if(subTab!=="sesiones")return;
    setSesionesLoading(true);
    getDocs(query(collection(db,"sesionesSalida"),orderBy("creadoEn","desc"),limit(60)))
      .then(snap=>setSesiones(snap.docs.map(d=>({id:d.id,...d.data()}))))
      .catch(err=>console.error("Error cargando sesiones:",err))
      .finally(()=>setSesionesLoading(false));
  },[subTab]);

  // ── Overlay de error logística ────────────────────────────────────
  if(overlayError){
    const lci=lc[overlayError.trans]||{};
    return(
      <div onClick={()=>setOverlayError(null)}
        style={{position:"fixed",inset:0,zIndex:9999,background:"#200000",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",cursor:"pointer",padding:"2rem"}}>
        <div style={{fontSize:"5rem",marginBottom:"1rem"}}>⛔</div>
        <div style={{fontSize:"2rem",fontWeight:900,color:"#ff4444",textAlign:"center",marginBottom:"0.5rem",letterSpacing:"0.05em"}}>{overlayError.titulo||"ERROR"}</div>
        <div style={{fontSize:"1.1rem",color:"#fca5a5",textAlign:"center",marginBottom:"2rem",maxWidth:"500px"}}>{overlayError.detalle}</div>
        <div style={{background:"#1c0000",border:"2px solid #7f1d1d",borderRadius:"14px",padding:"1.2rem 2rem",textAlign:"center",marginBottom:"2rem",minWidth:"300px"}}>
          <div style={{color:"#9ca3af",fontSize:"0.75rem",marginBottom:"0.3rem"}}>Pedido escaneado</div>
          <div style={{fontWeight:800,fontSize:"1.1rem",color:"#fff",marginBottom:"0.3rem"}}>{overlayError.envio?.nroOrdenTN?"#"+overlayError.envio.nroOrdenTN:overlayError.envio?.direccion}</div>
          {overlayError.envio?.direccion&&overlayError.envio?.nroOrdenTN&&<div style={{color:"#9ca3af",fontSize:"0.8rem"}}>{overlayError.envio.direccion}</div>}
          <div style={{marginTop:"0.6rem",display:"flex",gap:"8px",justifyContent:"center",alignItems:"center"}}>
            <span style={{background:lci.bg||"#1a1f2e",color:lci.color||"#9ca3af",padding:"4px 12px",borderRadius:"6px",fontWeight:700,fontSize:"0.85rem"}}>{overlayError.trans||"Desconocida"}</span>
            {overlayError.turno&&<span style={{background:TURNO_C[overlayError.turno]?.bg||"#1a1f2e",color:TURNO_C[overlayError.turno]?.c||"#9ca3af",padding:"4px 12px",borderRadius:"6px",fontWeight:700,fontSize:"0.85rem",border:"1px solid "+(TURNO_C[overlayError.turno]?.c||"#9ca3af")}}>{overlayError.turno}</span>}
          </div>
        </div>
        <div style={{color:"#9ca3af",fontSize:"0.85rem"}}>Tocá en cualquier lugar para cerrar</div>
        {/* Input oculto para lectores de código de barras físicos */}
        <input ref={inputRef} value={qrInput} onChange={e=>setQrInput(e.target.value)} onKeyDown={handleKey}
          style={{position:"absolute",opacity:0,pointerEvents:"none",width:1,height:1}}
          readOnly={false}/>
      </div>
    );
  }

  // ── Historial de despacho ─────────────────────────────────────────
  const puedeHistorial=puedeVer(sesion,"accion_verhistorialdespacho");

  if(puedeHistorial&&subTab==="historial"){
    const despachados=envios.filter(e=>e.despachado&&(histFecha==="todos"||(e.despachoTs||"").startsWith(histFecha)));
    const filtrados=histFilLog==="TODOS"?despachados:despachados.filter(e=>e.despachoLogistica===histFilLog);
    const ordenados=[...filtrados].sort((a,b)=>(b.despachoTs||"").localeCompare(a.despachoTs||""));
    // Agrupar por logística+turno
    const grupos={};
    ordenados.forEach(e=>{
      const k=(e.despachoLogistica||"Sin logística")+"|"+(e.turno||"Sin turno");
      if(!grupos[k])grupos[k]={log:e.despachoLogistica||"Sin logística",turno:e.turno||"",envios:[]};
      grupos[k].envios.push(e);
    });
    const gruposArr=Object.values(grupos);
    return(
      <div style={{maxWidth:"600px",margin:"0 auto",padding:"1rem 0"}}>
        {/* Tab bar */}
        <div style={{display:"flex",gap:"6px",marginBottom:"1rem"}}>
          <button onClick={()=>setSubTab("despacho")} style={{...S.btnSm(false),padding:"6px 16px",fontSize:"0.82rem"}}>← Despacho</button>
        </div>
        {/* Filtros */}
        <div style={{background:"#0f1420",border:"1px solid #1a1f2e",borderRadius:"12px",padding:"0.75rem 1rem",marginBottom:"0.75rem",display:"flex",gap:"8px",flexWrap:"wrap",alignItems:"center"}}>
          <input type="date" value={histFecha} onChange={e=>setHistFecha(e.target.value)}
            style={{background:"#12172a",border:"1px solid #1a1f2e",borderRadius:"7px",color:"#fff",padding:"4px 8px",fontSize:"0.8rem"}}/>
          <button onClick={()=>setHistFecha(hoy)} style={S.btnSm(histFecha===hoy)}>Hoy</button>
          <button onClick={()=>setHistFecha("todos")} style={S.btnSm(histFecha==="todos")}>Todos</button>
          <span style={{color:"#252d40",fontSize:"0.7rem"}}>|</span>
          {["TODOS",...logActivas].map(l=><button key={l} onClick={()=>setHistFilLog(l)} style={S.btnSm(histFilLog===l,l==="TODOS"?undefined:lc[l]?.color)}>{l}</button>)}
          <span style={{color:"#6b7280",fontSize:"0.75rem",marginLeft:"auto"}}>{filtrados.length} envíos</span>
        </div>
        {/* Grupos */}
        {gruposArr.length===0&&<div style={{color:"#4b5563",fontSize:"0.85rem",textAlign:"center",padding:"2rem"}}>Sin despachos para este filtro</div>}
        {gruposArr.map((g,gi)=>{
          const lci=lc[g.log]||{};
          const totalBultos=g.envios.reduce((s,e)=>s+(e.bultos||1),0);
          return(
            <div key={gi} style={{background:"#0f1420",border:"1px solid #1a1f2e",borderRadius:"12px",marginBottom:"0.6rem",overflow:"hidden"}}>
              {/* Header grupo */}
              <div style={{padding:"0.5rem 0.9rem",background:"#080c14",borderBottom:"1px solid #1a1f2e",display:"flex",alignItems:"center",gap:"8px"}}>
                <span style={{background:lci.bg||"#1a1f2e",color:lci.color||"#9ca3af",padding:"2px 8px",borderRadius:"5px",fontWeight:700,fontSize:"0.75rem"}}>{g.log}</span>
                {g.turno&&<span style={{background:TURNO_C[g.turno]?.bg||"#130d2a",color:TURNO_C[g.turno]?.c||"#a78bfa",padding:"2px 8px",borderRadius:"5px",fontWeight:700,fontSize:"0.75rem",border:"1px solid "+(TURNO_C[g.turno]?.c||"#a78bfa")}}>{g.turno}</span>}
                <span style={{color:"#6b7280",fontSize:"0.72rem",marginLeft:"auto"}}>{g.envios.length} env · {totalBultos} bulto{totalBultos===1?"":"s"}</span>
              </div>
              {/* Filas */}
              {g.envios.map((e,ei)=>(
                <div key={e.id} style={{padding:"0.55rem 0.9rem",borderBottom:ei<g.envios.length-1?"1px solid #12172a":"none",display:"flex",alignItems:"flex-start",gap:"8px"}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",gap:"5px",alignItems:"center",marginBottom:"2px",flexWrap:"wrap"}}>
                      {e.nroOrdenTN&&<span style={{color:"#7dd3fc",fontWeight:700,fontSize:"0.75rem"}}>#{e.nroOrdenTN}</span>}
                      {e.nroSeguimiento&&<span style={{color:"#84cc16",fontFamily:"monospace",fontSize:"0.68rem"}}>{e.nroSeguimiento.slice(-8)}</span>}
                      {e.reprogramado&&<span style={{background:"#1c1500",color:"#fbbf24",border:"1px solid #78350f",padding:"0 5px",borderRadius:"4px",fontSize:"0.6rem",fontWeight:700}}>⟳ Reprog.</span>}
                    </div>
                    <div style={{color:"#e5e7eb",fontSize:"0.8rem",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.direccion}</div>
                    <div style={{color:"#6b7280",fontSize:"0.7rem",marginTop:"2px",display:"flex",gap:"6px",flexWrap:"wrap"}}>
                      {(e.localidad||e.partido)&&<span>{e.localidad||e.partido}</span>}
                      <span>{e.bultos||1} bulto{(e.bultos||1)===1?"":"s"}</span>
                      {e.armadorNombre&&<span>📦 {e.armadorNombre}</span>}
                    </div>
                  </div>
                  <div style={{textAlign:"right",flexShrink:0}}>
                    {e.despachoTs&&<div style={{color:"#10b981",fontSize:"0.72rem",fontWeight:700}}>{fmtHora(e.despachoTs)}</div>}
                    {e.despachoPor&&<div style={{color:"#4b5563",fontSize:"0.65rem"}}>{e.despachoPor}</div>}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    );
  }

  // ── Vista historial de cierres ───────────────────────────────────
  const generarPDFSesion=(s,lciS)=>{
    const doc=new jsPDF();
    const W=doc.internal.pageSize.getWidth();
    const logNombre=lciS.nombreFormal?`${lciS.nombreFormal} (${s.logistica})`:s.logistica;
    // Título
    doc.setFillColor(15,20,32);doc.rect(0,0,W,24,"F");
    doc.setTextColor(255,255,255);doc.setFontSize(16);doc.setFont("helvetica","bold");
    doc.text("CONSTANCIA DE SALIDA",W/2,15,{align:"center"});
    doc.setTextColor(0,0,0);
    // Info
    let y=32;
    doc.setFontSize(10);doc.setFont("helvetica","normal");
    doc.text(`Logística: ${logNombre}`,20,y);doc.text(`Fecha: ${s.fecha||""}`,110,y);y+=6;
    doc.text(`Turno: ${Array.isArray(s.turno)?s.turno.join(" + "):(s.turno||"")}`,20,y);doc.text(`Operador: ${s.operador||""}`,110,y);y+=6;
    const fechaGen=s.creadoEn?new Date(s.creadoEn).toLocaleString("es-AR"):"";
    doc.text(`Generado: ${fechaGen}`,20,y);y+=8;
    // Resumen
    doc.setFillColor(240,244,255);doc.roundedRect(18,y,W-36,18,3,3,"F");
    doc.setFont("helvetica","bold");doc.setFontSize(9);
    const resItems=[
      {label:"Total pedidos",val:s.totalPedidos||0},
      {label:"FLEX",val:s.totalFlex||0},
      {label:"NO FLEX",val:s.totalNoFlex||0},
      {label:"Total bultos",val:s.totalBultos||0},
    ];
    const colW=(W-36)/4;
    resItems.forEach((item,i)=>{
      const cx=20+i*colW+colW/2;
      doc.setFontSize(16);doc.setTextColor(30,80,200);doc.text(String(item.val),cx,y+10,{align:"center"});
      doc.setFontSize(7);doc.setTextColor(100,100,100);doc.text(item.label,cx,y+15.5,{align:"center"});
    });
    y+=24;doc.setTextColor(0,0,0);
    // Tabla envíos
    const det=s.enviosDetalle||[];
    if(det.length>0){
      doc.setFont("helvetica","bold");doc.setFontSize(9.5);doc.text("DETALLE DE ENVÍOS",20,y);y+=5;
      doc.setFillColor(30,40,70);doc.rect(20,y,W-40,6.5,"F");
      doc.setTextColor(255,255,255);doc.setFontSize(7);
      doc.text("#",22,y+4.5);doc.text("Dirección / Ciudad",30,y+4.5);
      doc.text("N° Envío/Orden",128,y+4.5);doc.text("Blt",168,y+4.5);doc.text("Tipo",178,y+4.5);y+=6.5;
      doc.setTextColor(0,0,0);doc.setFont("helvetica","normal");
      det.forEach((e,i)=>{
        if(y>272){doc.addPage();y=20;}
        if(i%2===0){doc.setFillColor(248,249,252);doc.rect(20,y,W-40,5.5,"F");}
        doc.setFontSize(7);
        doc.text(String(i+1),22,y+3.8);
        const dc=(e.direccion||"").split(/\s*\/\s*/)[0].trim();
        const ciudad=e.ciudad||"";
        const dp=ciudad?dc+" · "+ciudad:dc;
        doc.text(dp.length>44?dp.slice(0,41)+"…":dp,30,y+3.8);
        const nroPDF=e.nroSeguimiento||(e.nroOrdenTN?"#"+e.nroOrdenTN:"");
        const nroPDFTxt=nroPDF.length>20?nroPDF.slice(-20):nroPDF;
        doc.text(nroPDFTxt||"-",128,y+3.8);
        doc.text(String(e.bultos||1),170,y+3.8);
        const tipo=(e.origen||"")==="ML"?"FLEX":"NO FL.";
        doc.text(tipo,178,y+3.8);
        y+=5.5;
      });
    }
    // Firma — intentar que quede en la misma hoja
    y+=4;if(y>252){doc.addPage();y=20;}
    doc.setFont("helvetica","bold");doc.setFontSize(10);doc.text("FIRMA DEL TRANSPORTISTA",20,y);y+=8;
    if(s.firmaDataUrl){
      doc.addImage(s.firmaDataUrl,"PNG",20,y,80,36);y+=40;
    }else{
      doc.setDrawColor(180,180,180);doc.rect(20,y,80,36);y+=40;
    }
    doc.setDrawColor(0,0,0);doc.line(20,y+4,100,y+4);
    doc.setFont("helvetica","normal");doc.setFontSize(8);doc.setTextColor(100,100,100);
    doc.text(s.firmante||"Firma y aclaración",60,y+9,{align:"center"});
    doc.save(`salida_${s.logistica}_${s.turno||""}_${s.fecha||""}.pdf`);
  };

  if(subTab==="sesiones"){
    return(
      <div style={{maxWidth:"600px",margin:"0 auto",padding:"1rem 0"}}>
        <div style={{display:"flex",gap:"6px",marginBottom:"1rem",alignItems:"center"}}>
          <button onClick={()=>setSubTab("despacho")} style={{...S.btnSm(false),padding:"6px 16px",fontSize:"0.82rem"}}>← Salida</button>
          <div style={{flex:1,fontWeight:700,fontSize:"0.95rem"}}>Cierres de sesión</div>
          <button onClick={()=>{setSesionesLoading(true);getDocs(query(collection(db,"sesionesSalida"),orderBy("creadoEn","desc"),limit(60))).then(snap=>setSesiones(snap.docs.map(d=>({id:d.id,...d.data()})))).finally(()=>setSesionesLoading(false));}}
            style={{...S.btnSm(false),padding:"4px 10px",fontSize:"0.75rem"}}>↺ Actualizar</button>
        </div>
        {sesionesLoading&&<div style={{color:"#6b7280",textAlign:"center",padding:"2rem",fontSize:"0.85rem"}}>Cargando…</div>}
        {!sesionesLoading&&sesiones.length===0&&<div style={{color:"#4b5563",textAlign:"center",padding:"2rem",fontSize:"0.85rem"}}>No hay cierres registrados</div>}
        <div style={{display:"flex",flexDirection:"column",gap:"8px"}}>
          {sesiones.map(s=>{
            const lciS=lc[s.logistica]||{};
            const expanded=sesionExpandida===s.id;
            const fechaHora=s.creadoEn?new Date(s.creadoEn).toLocaleString("es-AR",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"}):"";
            return(
              <div key={s.id} style={{background:"#0f1420",border:"1px solid #1a1f2e",borderRadius:"12px",overflow:"hidden"}}>
                {/* Cabecera de sesión */}
                <div onClick={()=>setSesionExpandida(expanded?null:s.id)}
                  style={{padding:"0.75rem 1rem",cursor:"pointer",display:"flex",alignItems:"center",gap:"10px",flexWrap:"wrap"}}>
                  <div style={{width:"9px",height:"9px",borderRadius:"50%",background:lciS.color||"#6b7280",flexShrink:0}}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",gap:"6px",alignItems:"center",flexWrap:"wrap"}}>
                      <span style={{fontWeight:700,color:lciS.color||"#fff",fontSize:"0.88rem"}}>{lciS.nombreFormal||s.logistica}</span>
                      {(Array.isArray(s.turno)?s.turno:[s.turno]).filter(Boolean).map(t=>{const tc=TURNO_C[t]||{c:"#8b5cf6",bg:"#1a1f2e"};return(<span key={t} style={{background:tc.bg,color:tc.c,padding:"1px 7px",borderRadius:"5px",fontWeight:700,fontSize:"0.65rem",border:`1px solid ${tc.c}`,marginRight:"3px"}}>{t}</span>);})}
                      {s.firmaDataUrl&&<span style={{background:"#041f14",color:"#34d399",padding:"1px 7px",borderRadius:"5px",fontSize:"0.62rem",fontWeight:700,border:"1px solid #065f46"}}>✓ Firmado</span>}
                    </div>
                    <div style={{color:"#6b7280",fontSize:"0.7rem",marginTop:"2px"}}>{fechaHora}{s.operador&&" · "+s.operador}</div>
                  </div>
                  <div style={{display:"flex",gap:"10px",alignItems:"center",flexShrink:0}}>
                    <div style={{textAlign:"center"}}>
                      <div style={{fontWeight:800,fontSize:"1rem",color:"#fff"}}>{s.totalPedidos}</div>
                      <div style={{color:"#6b7280",fontSize:"0.6rem"}}>pedidos</div>
                    </div>
                    <div style={{textAlign:"center"}}>
                      <div style={{fontWeight:700,fontSize:"0.85rem",color:"#34d399"}}>{s.totalFlex}</div>
                      <div style={{color:"#6b7280",fontSize:"0.6rem"}}>FLEX</div>
                    </div>
                    <div style={{textAlign:"center"}}>
                      <div style={{fontWeight:700,fontSize:"0.85rem",color:"#f59e0b"}}>{s.totalNoFlex}</div>
                      <div style={{color:"#6b7280",fontSize:"0.6rem"}}>NO FL.</div>
                    </div>
                    <div style={{textAlign:"center"}}>
                      <div style={{fontWeight:700,fontSize:"0.85rem",color:"#a78bfa"}}>{s.totalBultos}</div>
                      <div style={{color:"#6b7280",fontSize:"0.6rem"}}>bultos</div>
                    </div>
                    <div style={{color:"#6b7280",fontSize:"0.85rem"}}>{expanded?"▲":"▼"}</div>
                  </div>
                </div>
                {/* Detalle expandido */}
                {expanded&&(
                  <div style={{borderTop:"1px solid #1a1f2e",padding:"0.8rem 1rem"}}>
                    {/* Botón descargar PDF */}
                    <button onClick={()=>generarPDFSesion(s,lciS)}
                      style={{width:"100%",padding:"0.6rem",borderRadius:"8px",background:"#12172a",border:"1px solid "+(lciS.color||"#1a1f2e"),color:lciS.color||"#9ca3af",fontWeight:700,fontSize:"0.8rem",cursor:"pointer",marginBottom:"0.8rem"}}>
                      ⬇ Descargar PDF
                    </button>
                    {/* Firma */}
                    {s.firmaDataUrl&&(
                      <div style={{marginBottom:"0.8rem"}}>
                        <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"5px"}}>Firma</div>
                        <img src={s.firmaDataUrl} alt="Firma" style={{maxWidth:"180px",borderRadius:"6px",border:"1px solid #1a1f2e",background:"#0f1420"}}/>
                      </div>
                    )}
                    {/* Envíos */}
                    {s.enviosDetalle&&s.enviosDetalle.length>0&&(
                      <div>
                        <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"5px"}}>Envíos despachados</div>
                        <div style={{display:"flex",flexDirection:"column",gap:"3px"}}>
                          {s.enviosDetalle.map((e,i)=>(
                            <div key={i} style={{display:"flex",gap:"8px",alignItems:"center",padding:"0.3rem 0.5rem",borderRadius:"6px",background:"#080c14"}}>
                              <div style={{color:"#4b5563",fontSize:"0.65rem",width:"16px",textAlign:"right",flexShrink:0}}>{i+1}</div>
                              <div style={{flex:1,minWidth:0}}>
                                <span style={{color:"#e5e7eb",fontSize:"0.75rem",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",display:"block"}}>{e.direccion}</span>
                                {e.nroOrdenTN&&<span style={{color:"#6b7280",fontSize:"0.65rem"}}>#{e.nroOrdenTN}</span>}
                              </div>
                              <div style={{display:"flex",gap:"5px",flexShrink:0,alignItems:"center"}}>
                                {e.reprogramado&&<span style={{background:"#1c1500",color:"#fbbf24",border:"1px solid #78350f",padding:"0 4px",borderRadius:"3px",fontSize:"0.55rem",fontWeight:700}}>⟳R</span>}
                                <span style={{color:(e.origen||"")==="ML"?"#34d399":"#f59e0b",fontSize:"0.62rem",fontWeight:700}}>{(e.origen||"")==="ML"?"FLEX":"NO FL."}</span>
                                <span style={{color:"#6b7280",fontSize:"0.62rem"}}>{e.bultos||1}b</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Vista selector de logística (Paso 1) ────────────────────────
  if(!logSel&&!logPreSel){
    // Lock: si hay una sesión guardada, mostrar solo la oferta de continuar/descartar
    if(sesionGuardadaOffer){
      return(
        <div style={{maxWidth:"600px",margin:"0 auto",padding:"1rem 0"}}>
          <div style={{background:card,border:"1px solid #065f46",borderRadius:"14px",padding:"1.5rem"}}>
            <div style={{fontWeight:800,fontSize:"1.1rem",marginBottom:"0.5rem"}}>🚚 Salida</div>
            <div style={{padding:"1rem",background:"#041f14",border:"1px solid #065f46",borderRadius:"12px"}}>
              <div style={{color:"#34d399",fontWeight:700,fontSize:"0.95rem",marginBottom:"4px"}}>
                📱 Sesión en curso — {sesionGuardadaOffer.sesionIds?.length??0} despachado{(sesionGuardadaOffer.sesionIds?.length??0)!==1?"s":""}
              </div>
              <div style={{color:"#6b7280",fontSize:"0.78rem",marginBottom:"12px"}}>
                {sesionGuardadaOffer.logSel} · Turno {Array.isArray(sesionGuardadaOffer.turnoSel)?sesionGuardadaOffer.turnoSel.join(" · "):sesionGuardadaOffer.turnoSel} · {sesionGuardadaOffer.fecha}
              </div>
              <div style={{color:"#fbbf24",fontSize:"0.75rem",marginBottom:"12px"}}>
                ⚠ Hay una sesión activa. Para iniciar una nueva, primero cerrá o descartá esta.
              </div>
              <button onClick={()=>{
                const ids=sesionGuardadaOffer.sesionIds||[];
                const t=sesionGuardadaOffer.turnoSel;
                setLogSel(sesionGuardadaOffer.logSel);
                setTurnoSel(Array.isArray(t)?t:t?[t]:[]);
                setSesionIds(ids);
                setFecha(sesionGuardadaOffer.fecha);
                if(ids.length>0){setEnvios(pv=>pv.map(e=>ids.includes(e.id)?{...e,despachado:true}:e));}
                setSesionGuardadaOffer(null);
              }} style={{width:"100%",padding:"0.65rem",borderRadius:"8px",background:"#166534",border:"none",color:"#fff",fontWeight:700,fontSize:"0.85rem",cursor:"pointer",marginBottom:"6px"}}>
                ▶ Continuar sesión
              </button>
              <button onClick={()=>{localStorage.removeItem("salida_sesion_activa");setSesionGuardadaOffer(null);}}
                style={{width:"100%",padding:"0.35rem",background:"transparent",border:"none",color:"#6b7280",fontSize:"0.72rem",cursor:"pointer"}}>
                Descartar y empezar nueva
              </button>
            </div>
          </div>
        </div>
      );
    }
    return(
      <div style={{maxWidth:"600px",margin:"0 auto",padding:"1rem 0"}}>
        <div style={{background:card,border:`1px solid ${brd}`,borderRadius:"14px",padding:"1.5rem"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"0.3rem"}}>
            <div style={{fontWeight:800,fontSize:"1.1rem"}}>🚚 Salida</div>
            <div style={{display:"flex",gap:"6px"}}>
              {puedeHistorial&&<button onClick={()=>setSubTab("historial")} style={{...S.btnSm(false),padding:"4px 10px",fontSize:"0.75rem",color:"#6b7280"}}>📋 Historial</button>}
              {esAdmin&&<button onClick={()=>setSubTab("sesiones")} style={{...S.btnSm(false),padding:"4px 10px",fontSize:"0.75rem",color:"#6b7280"}}>📄 Cierres</button>}
            </div>
          </div>
          <div style={{color:muted,fontSize:"0.8rem",marginBottom:"1.5rem"}}>Seleccioná la logística para iniciar la sesión de despacho</div>
          {/* Selector de fecha */}
          <div style={{marginBottom:"1.2rem"}}>
            <label style={{display:"block",color:muted,fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>Fecha</label>
            <input type="date" value={fecha} onChange={e=>setFecha(e.target.value)}
              style={{background:"#12172a",border:`1px solid ${brd}`,borderRadius:"8px",color:"#fff",padding:"0.45rem 0.7rem",fontSize:"0.85rem",width:"auto"}}/>
          </div>
          {/* Logísticas — paso 1 */}
          <label style={{display:"block",color:muted,fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",marginBottom:"8px"}}>Logística</label>
          <div style={{display:"flex",flexDirection:"column",gap:"10px"}}>
            {logActivas.map(l=>{
              const lci=lc[l]||{};
              const pedL=envios.filter(e=>{const f=e.fecha||e.fechaVenta||"";return f===fecha&&e.trans===l&&getEstado(e)==="asignado"&&e.estado!=="cancelado";});
              const prepL=pedL.filter(e=>e.preparado).length;
              const despL=pedL.filter(e=>e.despachado).length;
              return(
                <button key={l} onClick={()=>setLogPreSel(l)}
                  style={{display:"flex",alignItems:"center",gap:"14px",padding:"1rem 1.2rem",borderRadius:"12px",
                    background:"#12172a",border:`2px solid ${lci.color||brd}22`,cursor:"pointer",textAlign:"left",transition:"border-color 0.15s"}}>
                  <div style={{width:"12px",height:"12px",borderRadius:"50%",background:lci.color||"#6b7280",flexShrink:0}}/>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:800,fontSize:"1rem",color:lci.color||"#fff"}}>{l}</div>
                    {lci.nombreFormal&&<div style={{color:muted,fontSize:"0.72rem"}}>{lci.nombreFormal}</div>}
                  </div>
                  <div style={{textAlign:"right",fontSize:"0.72rem",color:muted}}>
                    <div style={{fontWeight:700,color:"#fff",fontSize:"0.85rem"}}>{pedL.length} pedidos</div>
                    <div>{prepL} prep · {despL} desp</div>
                  </div>
                  <div style={{color:muted,fontSize:"1rem"}}>›</div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // ── Vista selector de turno (Paso 2) ────────────────────────────
  if(!logSel&&logPreSel){
    const lciPre=lc[logPreSel]||{};
    const pedPre=envios.filter(e=>{const f=e.fecha||e.fechaVenta||"";return f===fecha&&e.trans===logPreSel&&getEstado(e)==="asignado"&&e.estado!=="cancelado";});
    const toggleTurno=(t)=>setTurnoSel(prev=>prev.includes(t)?prev.filter(x=>x!==t):[...prev,t]);
    return(
      <div style={{maxWidth:"600px",margin:"0 auto",padding:"1rem 0"}}>
        <div style={{background:card,border:`1px solid ${brd}`,borderRadius:"14px",padding:"1.5rem"}}>
          <button onClick={()=>{setLogPreSel(null);setTurnoSel([]);}} style={{...S.btnSm(false),padding:"4px 12px",fontSize:"0.75rem",marginBottom:"1.2rem"}}>← Volver</button>
          {/* Logística elegida */}
          <div style={{display:"flex",alignItems:"center",gap:"10px",marginBottom:"1.5rem",padding:"0.75rem 1rem",background:"#12172a",borderRadius:"10px",border:`1px solid ${lciPre.color||brd}44`}}>
            <div style={{width:"10px",height:"10px",borderRadius:"50%",background:lciPre.color||"#6b7280",flexShrink:0}}/>
            <div style={{fontWeight:700,color:lciPre.color||"#fff",flex:1}}>{logPreSel}</div>
            {lciPre.nombreFormal&&<div style={{color:muted,fontSize:"0.75rem"}}>{lciPre.nombreFormal}</div>}
            <div style={{color:muted,fontSize:"0.78rem"}}>{pedPre.length} pedidos</div>
          </div>
          {/* Selector multi-turno: toggle buttons */}
          <label style={{display:"block",color:muted,fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",marginBottom:"10px"}}>
            Turno/s — seleccioná todos los que aplican
          </label>
          <div style={{display:"flex",gap:"10px",flexWrap:"wrap",marginBottom:"1.2rem"}}>
            {TURNOS.map(t=>{
              const tc=TURNO_C[t]||{c:"#8b5cf6",bg:"#1a1f2e"};
              const sel=turnoSel.includes(t);
              const pedT=pedPre.filter(e=>!e.turno||e.turno===t);
              return(
                <button key={t} onClick={()=>toggleTurno(t)}
                  style={{flex:"1 1 120px",display:"flex",flexDirection:"column",alignItems:"center",gap:"8px",padding:"1.2rem 1rem",borderRadius:"12px",
                    background:sel?tc.bg+"88":tc.bg+"22",color:tc.c,
                    border:`2px solid ${sel?tc.c:tc.c+"44"}`,cursor:"pointer",fontWeight:800,fontSize:"1.1rem",
                    boxShadow:sel?`0 0 0 2px ${tc.c}44`:"none",transition:"all 0.15s"}}>
                  {sel?"✓ ":""}{t}
                  <span style={{color:muted,fontSize:"0.7rem",fontWeight:400}}>{pedT.length} pedidos</span>
                </button>
              );
            })}
          </div>
          <button
            disabled={turnoSel.length===0}
            onClick={()=>{setLogSel(logPreSel);setSesionIds([]);setResultado(null);}}
            style={{width:"100%",padding:"0.75rem",borderRadius:"10px",
              background:turnoSel.length>0?"linear-gradient(135deg,#6366f1,#4f46e5)":"#1a1f2e",
              border:"none",color:turnoSel.length>0?"#fff":"#374151",
              fontWeight:700,fontSize:"0.95rem",cursor:turnoSel.length>0?"pointer":"not-allowed",transition:"all 0.15s"}}>
            {turnoSel.length===0?"Seleccioná al menos un turno":`Iniciar sesión · ${turnoSel.join(" + ")}`}
          </button>
        </div>
      </div>
    );
  }

  // ── Vista de sesión activa ────────────────────────────────────────
  const lci=lc[logSel]||{};
  const logColor=lci.color||"#6366f1";
  const logBg=lci.bg||"#12172a";

  // Helpers para PDF y UI: dirección sin referencia, nro de envío unificado
  const dirCorta=(dir)=>(dir||"").split(/\s*\/\s*/)[0].trim();
  const nroRef=(e)=>e.nroSeguimiento?e.nroSeguimiento.slice(-10):(e.nroOrdenTN?"#"+e.nroOrdenTN:"");
  const nroRefPDF=(e)=>e.nroSeguimiento||(e.nroOrdenTN?"#"+e.nroOrdenTN:"");

  // Generar PDF con jsPDF y guardar sesión en Firestore.
  // sesionIds es la fuente autoritativa: no depende del flag e.despachado
  // que puede perderse si el browser cierra antes de persistir el estado.
  const generarYCerrar=async(conPDF)=>{
    if(guardandoCierre)return;
    setGuardandoCierre(true);
    try{
      const despachados_cierre=sesionIds.map(id=>enviosMap.get(id)).filter(Boolean);
      const totalFlex=despachados_cierre.filter(e=>(e.origen||"")==="ML").length;
      const totalNoFlex=despachados_cierre.length-totalFlex;
      const totalBultos=despachados_cierre.reduce((s,e)=>s+(e.bultos||1),0);
      const operador=sesion?.nombre||sesion?.usuario||sesion?.email||"";
      const firmanteNombre=firmante.trim();
      if(conPDF){
        const doc=new jsPDF();
        const W=doc.internal.pageSize.getWidth();
        // Título
        doc.setFillColor(15,20,32);doc.rect(0,0,W,24,"F");
        doc.setTextColor(255,255,255);doc.setFontSize(16);doc.setFont("helvetica","bold");
        doc.text("CONSTANCIA DE SALIDA",W/2,15,{align:"center"});
        doc.setTextColor(0,0,0);
        // Info
        let y=32;
        doc.setFontSize(10);doc.setFont("helvetica","normal");
        const logNombre=lci.nombreFormal?`${lci.nombreFormal} (${logSel})`:logSel;
        doc.text(`Logística: ${logNombre}`,20,y);doc.text(`Fecha: ${fecha}`,110,y);y+=6;
        doc.text(`Turno: ${Array.isArray(turnoSel)?turnoSel.join(" + "):turnoSel}`,20,y);doc.text(`Operador: ${operador}`,110,y);y+=6;
        doc.text(`Generado: ${new Date().toLocaleString("es-AR")}`,20,y);y+=8;
        // Resumen
        doc.setFillColor(240,244,255);doc.roundedRect(18,y,W-36,18,3,3,"F");
        doc.setFont("helvetica","bold");doc.setFontSize(9);
        const resItems=[
          {label:"Despachados",val:despachados_cierre.length},
          {label:"FLEX",val:totalFlex},
          {label:"NO FLEX",val:totalNoFlex},
          {label:"Total bultos",val:totalBultos},
        ];
        const colW=(W-36)/4;
        resItems.forEach((item,i)=>{
          const cx=20+i*colW+colW/2;
          doc.setFontSize(16);doc.setTextColor(30,80,200);doc.text(String(item.val),cx,y+10,{align:"center"});
          doc.setFontSize(7);doc.setTextColor(100,100,100);doc.text(item.label,cx,y+15.5,{align:"center"});
        });
        y+=24;doc.setTextColor(0,0,0);
        // Tabla envíos despachados
        if(despachados_cierre.length>0){
          doc.setFont("helvetica","bold");doc.setFontSize(9.5);doc.text("DETALLE DE ENVÍOS",20,y);y+=5;
          doc.setFillColor(30,40,70);doc.rect(20,y,W-40,6.5,"F");
          doc.setTextColor(255,255,255);doc.setFontSize(7);
          doc.text("#",22,y+4.5);doc.text("Dirección / Ciudad",30,y+4.5);
          doc.text("N° Envío/Orden",128,y+4.5);doc.text("Blt",168,y+4.5);doc.text("Tipo",178,y+4.5);y+=6.5;
          doc.setTextColor(0,0,0);doc.setFont("helvetica","normal");
          despachados_cierre.forEach((e,i)=>{
            if(y>272){doc.addPage();y=20;}
            if(i%2===0){doc.setFillColor(248,249,252);doc.rect(20,y,W-40,5.5,"F");}
            doc.setFontSize(7);
            doc.text(String(i+1),22,y+3.8);
            const dc=dirCorta(e.direccion);
            const ciudad=e.ciudad||e.localidad||"";
            const dp=ciudad?dc+" · "+ciudad:dc;
            doc.text(dp.length>44?dp.slice(0,41)+"…":dp,30,y+3.8);
            const nroPDF=nroRefPDF(e);
            const nroPDFTxt=nroPDF.length>20?nroPDF.slice(-20):nroPDF;
            doc.text(nroPDFTxt||"-",128,y+3.8);
            doc.text(String(e.bultos||1),170,y+3.8);
            const tipo=(e.origen||"")==="ML"?"FLEX":"NO FL.";
            doc.text(tipo,178,y+3.8);
            y+=5.5;
          });
        }
        // Tabla pendientes (no despachados)
        if(lotePend.length>0){
          y+=5;if(y>262){doc.addPage();y=20;}
          doc.setFont("helvetica","bold");doc.setFontSize(9.5);doc.setTextColor(180,80,0);doc.text("ENVÍOS NO DESPACHADOS",20,y);y+=5;
          doc.setFillColor(120,53,15);doc.rect(20,y,W-40,6.5,"F");
          doc.setTextColor(255,255,255);doc.setFontSize(7);
          doc.text("#",22,y+4.5);doc.text("Dirección / Ciudad",30,y+4.5);doc.text("N° Envío/Orden",128,y+4.5);doc.text("Motivo",162,y+4.5);y+=6.5;
          doc.setTextColor(0,0,0);doc.setFont("helvetica","normal");
          lotePend.forEach((e,i)=>{
            if(y>272){doc.addPage();y=20;}
            if(i%2===0){doc.setFillColor(255,248,240);doc.rect(20,y,W-40,5.5,"F");}
            doc.setFontSize(7);
            doc.text(String(i+1),22,y+3.8);
            const dc=dirCorta(e.direccion);
            const ciudad=e.ciudad||e.localidad||"";
            const dp=ciudad?dc+" · "+ciudad:dc;
            doc.text(dp.length>38?dp.slice(0,35)+"…":dp,30,y+3.8);
            const nroPDF=nroRefPDF(e);
            doc.text((nroPDF.length>15?nroPDF.slice(-15):nroPDF)||"-",128,y+3.8);
            const nota=(notasPendientes[e.id]||"").slice(0,28);
            if(nota){doc.setTextColor(120,60,0);doc.text(nota,162,y+3.8);doc.setTextColor(0,0,0);}
            y+=5.5;
          });
        }
        // Firma — intentar que quede en la misma hoja
        y+=4;if(y>252){doc.addPage();y=20;}
        doc.setFont("helvetica","bold");doc.setFontSize(10);doc.setTextColor(0,0,0);doc.text("FIRMA DEL TRANSPORTISTA",20,y);y+=8;
        if(firmaData){
          doc.addImage(firmaData,"PNG",20,y,80,36);y+=40;
        }else{
          doc.setDrawColor(180,180,180);doc.rect(20,y,80,36);y+=40;
        }
        doc.setDrawColor(0,0,0);doc.line(20,y+4,100,y+4);
        doc.setFont("helvetica","normal");doc.setFontSize(8);doc.setTextColor(100,100,100);
        const lineaFirma=firmanteNombre||"Firma y aclaración";
        doc.text(lineaFirma,60,y+9,{align:"center"});
        doc.save(`salida_${logSel}_${Array.isArray(turnoSel)?turnoSel.join("-"):turnoSel}_${fecha}.pdf`);
      }
      // Guardar firmante para autocompletar en próximas sesiones
      if(firmanteNombre)localStorage.setItem("salida_firmante_ultimo",firmanteNombre);
      // Limpiar sesión activa del localStorage y Firestore
      localStorage.removeItem("salida_sesion_activa");
      deleteDoc(doc(db,"sesionesSalidaActiva","activa_"+(sesion?.id||"anon"))).catch(()=>{});
      await addDoc(collection(db,"sesionesSalida"),{
        fecha,logistica:logSel,turno:turnoSel,operador,firmante:firmanteNombre||null,
        creadoEn:new Date().toISOString(),
        totalPedidos:despachados_cierre.length,totalFlex,totalNoFlex,totalBultos,
        totalPendientes:lotePend.length,
        firmaDataUrl:conPDF&&firmaData?firmaData:null,
        enviosIds:despachados_cierre.map(e=>e.id),
        enviosDetalle:despachados_cierre.map(e=>({
          id:e.id,direccion:e.direccion,ciudad:e.ciudad||e.localidad||"",bultos:e.bultos||1,
          origen:e.origen||"",nroOrdenTN:e.nroOrdenTN||null,
          nroSeguimiento:e.nroSeguimiento||null,despachoTs:e.despachoTs||null,
          reprogramado:e.reprogramado||false,
        })),
        pendientesDetalle:lotePend.map(e=>({
          id:e.id,direccion:e.direccion,bultos:e.bultos||1,
          nroOrdenTN:e.nroOrdenTN||null,
          nota:notasPendientes[e.id]||null,
        })),
      });
    }catch(err){console.error("Error cierre sesión:",err);}
    finally{setGuardandoCierre(false);}
    liberarLogistica();
  };

  // ── Modal de cierre de sesión ─────────────────────────────────────
  if(modalCierre){
    const totalFlex=despachados.filter(e=>(e.origen||"")==="ML").length;
    const totalNoFlex=despachados.length-totalFlex;
    const totalBultos=despachados.reduce((s,e)=>s+(e.bultos||1),0);
    return(
      <div style={{position:"fixed",inset:0,zIndex:500,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem",overflowY:"auto"}}>
        <div style={{background:"#0f1420",border:"1px solid #1a1f2e",borderRadius:"18px",padding:"1.5rem",width:"100%",maxWidth:"480px",maxHeight:"90vh",overflowY:"auto"}}>
          {/* Header */}
          <div style={{fontWeight:900,fontSize:"1.1rem",marginBottom:"0.3rem"}}>Cerrar sesión de despacho</div>
          <div style={{color:"#6b7280",fontSize:"0.8rem",marginBottom:"1.2rem"}}>{lci.nombreFormal||logSel}{lci.nombreFormal?` (${logSel})`:""} · Turno {Array.isArray(turnoSel)?turnoSel.join(" + "):turnoSel} · {fecha}</div>
          {/* Resumen — lote completo del día */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:"8px",marginBottom:"1.2rem"}}>
            {[
              {label:"Despachados",val:despachados.length,color:logColor},
              {label:"FLEX",val:totalFlex,color:"#34d399"},
              {label:"NO FLEX",val:totalNoFlex,color:"#f59e0b"},
              {label:"Bultos",val:totalBultos,color:"#a78bfa"},
            ].map(({label,val,color})=>(
              <div key={label} style={{background:"#12172a",border:"1px solid #1a1f2e",borderRadius:"10px",padding:"0.7rem 0.5rem",textAlign:"center"}}>
                <div style={{fontSize:"1.6rem",fontWeight:900,color}}>{val}</div>
                <div style={{fontSize:"0.65rem",color:"#6b7280",marginTop:"2px"}}>{label}</div>
              </div>
            ))}
          </div>
          {/* Pendientes (no despachados) con campo de nota */}
          {lotePend.length>0&&(
            <div style={{marginBottom:"1.2rem",padding:"0.9rem",background:"#1c0f04",border:"1px solid #78350f",borderRadius:"10px"}}>
              <div style={{color:"#f59e0b",fontWeight:700,fontSize:"0.78rem",marginBottom:"8px",textTransform:"uppercase",letterSpacing:"0.04em"}}>
                ⚠ {lotePend.length} sin despachar — justificación
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:"6px"}}>
                {lotePend.map(e=>(
                  <div key={e.id} style={{background:"#120a02",borderRadius:"8px",padding:"0.5rem 0.7rem"}}>
                    <div style={{fontSize:"0.75rem",color:"#fbbf24",fontWeight:600,marginBottom:"4px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                      {e.nroOrdenTN?"#"+e.nroOrdenTN+" — ":""}{e.direccion}
                    </div>
                    <input
                      value={notasPendientes[e.id]||""}
                      onChange={ev=>setNotasPendientes(prev=>({...prev,[e.id]:ev.target.value}))}
                      placeholder="Motivo (ej: ausente, dirección incorrecta…)"
                      style={{width:"100%",background:"#0a0602",border:"1px solid #78350f",borderRadius:"6px",color:"#fff",padding:"0.35rem 0.55rem",fontSize:"0.75rem",outline:"none",boxSizing:"border-box"}}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
          {/* Firma */}
          <div style={{marginBottom:"0.8rem"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:"6px"}}>
              <label style={{color:"#6b7280",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase"}}>Firma del transportista</label>
              <button onClick={()=>{
                if(firmaRef.current){
                  const ctx=firmaRef.current.getContext("2d");
                  ctx.fillStyle="#0f1420";ctx.fillRect(0,0,firmaRef.current.width,firmaRef.current.height);
                }
                setFirmaData(null);
              }} style={{fontSize:"0.7rem",color:"#6b7280",background:"transparent",border:"1px solid #1a1f2e",borderRadius:"6px",padding:"2px 8px",cursor:"pointer"}}>
                Limpiar
              </button>
            </div>
            <canvas ref={firmaRef} width={440} height={180}
              style={{width:"100%",height:"180px",borderRadius:"10px",border:"1px solid #1a1f2e",cursor:"crosshair",touchAction:"none",display:"block"}}/>
            {!firmaData&&<div style={{color:"#4b5563",fontSize:"0.72rem",marginTop:"4px",textAlign:"center"}}>Firmá arriba con el dedo o el mouse</div>}
          </div>
          {/* Firmante (nombre y apellido) */}
          <div style={{marginBottom:"1.2rem"}}>
            <label style={{display:"block",color:"#6b7280",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",marginBottom:"5px"}}>Nombre y apellido del firmante</label>
            <input
              value={firmante}
              onChange={e=>setFirmante(e.target.value)}
              placeholder="Ej: Juan García"
              list="firmante-sugerencias"
              style={{width:"100%",background:"#12172a",border:"1px solid #1a1f2e",borderRadius:"8px",color:"#fff",padding:"0.5rem 0.75rem",fontSize:"0.85rem",outline:"none",boxSizing:"border-box"}}
            />
            <datalist id="firmante-sugerencias">
              {firmante&&<option value={firmante}/>}
            </datalist>
          </div>
          {/* Acciones */}
          <div style={{display:"flex",flexDirection:"column",gap:"8px"}}>
            <button onClick={()=>generarYCerrar(true)} disabled={guardandoCierre}
              style={{padding:"0.8rem",borderRadius:"10px",background:`linear-gradient(135deg,${logColor},${logColor}cc)`,border:"none",color:"#fff",fontWeight:700,fontSize:"0.9rem",cursor:"pointer",opacity:guardandoCierre?0.6:1}}>
              {guardandoCierre?"Guardando…":"⬇ Descargar PDF y cerrar"}
            </button>
            <button onClick={()=>generarYCerrar(false)} disabled={guardandoCierre}
              style={{padding:"0.65rem",borderRadius:"10px",background:"transparent",border:"1px solid #374151",color:"#9ca3af",fontWeight:600,fontSize:"0.82rem",cursor:"pointer",opacity:guardandoCierre?0.6:1}}>
              Cerrar sin PDF
            </button>
            <button onClick={()=>setModalCierre(false)} disabled={guardandoCierre}
              style={{padding:"0.5rem",borderRadius:"10px",background:"transparent",border:"none",color:"#4b5563",fontSize:"0.78rem",cursor:"pointer"}}>
              Cancelar
            </button>
          </div>
        </div>
      </div>
    );
  }

  return(
    <div style={{maxWidth:"700px",margin:"0 auto",padding:"1rem 0"}}>
      {/* Header logística */}
      <div style={{background:logBg,border:`2px solid ${logColor}`,borderRadius:"14px",padding:"1rem 1.2rem",marginBottom:"1rem",display:"flex",alignItems:"center",gap:"12px"}}>
        <div style={{width:"14px",height:"14px",borderRadius:"50%",background:logColor,flexShrink:0}}/>
        <div style={{flex:1}}>
          <div style={{display:"flex",alignItems:"center",gap:"8px"}}>
            <div style={{fontWeight:900,fontSize:"1.05rem",color:logColor}}>{logSel}</div>
            {Array.isArray(turnoSel)&&turnoSel.length>0
              ? turnoSel.map(t=>{const tc=TURNO_C[t]||{c:"#8b5cf6",bg:"#1a1f2e"};return(<span key={t} style={{background:tc.bg,color:tc.c,padding:"2px 9px",borderRadius:"6px",fontWeight:700,fontSize:"0.7rem",border:`1px solid ${tc.c}`,marginRight:"4px"}}>{t}</span>);})
              : turnoSel&&<span style={{background:TURNO_C[turnoSel]?.bg||"#1a1f2e",color:TURNO_C[turnoSel]?.c||"#8b5cf6",padding:"2px 9px",borderRadius:"6px",fontWeight:700,fontSize:"0.7rem",border:"1px solid "+(TURNO_C[turnoSel]?.c||"#8b5cf6")}}>{turnoSel}</span>
            }
          </div>
          {lci.nombreFormal&&<div style={{color:muted,fontSize:"0.72rem"}}>{lci.nombreFormal}</div>}
        </div>
        <div style={{textAlign:"right",marginRight:"0.5rem"}}>
          <div style={{fontWeight:800,fontSize:"1.2rem",color:logColor}}>{despachados.length}<span style={{color:muted,fontWeight:400,fontSize:"0.8rem"}}> / {totalLog}</span></div>
          <div style={{color:muted,fontSize:"0.68rem"}}>despachados · {pct}%</div>
        </div>
        <div style={{display:"flex",gap:"6px",flexShrink:0}}>
          {sesionIds.length>0&&(
            <button onClick={()=>setModalCierre(true)}
              style={{padding:"0.4rem 0.8rem",borderRadius:"8px",background:`linear-gradient(135deg,${logColor},${logColor}cc)`,border:"none",color:"#fff",cursor:"pointer",fontSize:"0.72rem",fontWeight:700}}>
              Cerrar sesión
            </button>
          )}
          <button onClick={liberarLogistica}
            style={{padding:"0.4rem 0.8rem",borderRadius:"8px",background:"transparent",border:`1px solid ${muted}`,color:muted,cursor:"pointer",fontSize:"0.72rem",fontWeight:600}}>
            Liberar
          </button>
        </div>
      </div>

      {/* Barra de progreso */}
      {totalLog>0&&(
        <div style={{background:"#12172a",borderRadius:"6px",height:"6px",marginBottom:"1rem",overflow:"hidden"}}>
          <div style={{width:pct+"%",height:"100%",background:logColor,borderRadius:"6px",transition:"width 0.3s"}}/>
        </div>
      )}

      {/* Input de escaneo */}
      <div style={{background:card,border:`1px solid ${brd}`,borderRadius:"14px",padding:"1.2rem",marginBottom:"1rem"}}>
        <div style={{display:"flex",alignItems:"center",gap:"8px",marginBottom:"6px"}}>
          <label style={{color:muted,fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",flex:1}}>Escanear código</label>
          <button onClick={()=>{inputRef.current?.focus();}}
            title="Escribir código manualmente"
            style={{padding:"3px 10px",borderRadius:"6px",background:"#12172a",border:`1px solid ${brd}`,color:muted,fontSize:"0.72rem",cursor:"pointer"}}>
            ✏️ Escribir
          </button>
        </div>
        <div style={{display:"flex",gap:"8px"}}>
          <input ref={inputRef} value={qrInput} onChange={e=>setQrInput(e.target.value)} onKeyDown={handleKey}
            placeholder="Código de barras, nro de orden TN o seguimiento…"
            style={{flex:1,background:"#12172a",border:`1px solid ${logColor}66`,borderRadius:"10px",color:"#fff",padding:"0.7rem 0.9rem",fontSize:"0.9rem",outline:"none"}}/>
          <button onClick={()=>procesarScan(qrInput)}
            style={{padding:"0.7rem 1.2rem",borderRadius:"10px",background:`linear-gradient(135deg,${logColor},${logColor}cc)`,border:"none",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:"0.85rem",flexShrink:0}}>
            OK
          </button>
          {soportaCamera&&(
            <button onClick={()=>setCamara(p=>!p)}
              title="Escanear con cámara"
              style={{padding:"0.7rem 0.9rem",borderRadius:"10px",background:camara?"#0d1c04":"#12172a",border:"1px solid "+(camara?"#84cc16":brd),color:camara?"#84cc16":muted,fontSize:"1.1rem",cursor:"pointer",flexShrink:0}}>
              📷
            </button>
          )}
        </div>
        {camara&&(
          <div style={{marginTop:"0.8rem",borderRadius:"10px",overflow:"hidden",background:"#000",position:"relative"}}>
            <video ref={videoRef} style={{width:"100%",maxHeight:"260px",objectFit:"cover",display:"block"}} playsInline muted/>
            <div style={{position:"absolute",inset:0,border:"2px solid #84cc16",borderRadius:"10px",pointerEvents:"none"}}/>
            <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",width:"170px",height:"170px",border:"2px solid #84cc16",borderRadius:"8px",boxShadow:"0 0 0 9999px rgba(0,0,0,0.45)"}}/>
            <button onClick={()=>setCamara(false)} style={{position:"absolute",top:"8px",right:"8px",background:"rgba(0,0,0,0.75)",border:"1px solid #84cc16",color:"#84cc16",borderRadius:"6px",padding:"4px 10px",fontSize:"0.75rem",cursor:"pointer"}}>Cerrar</button>
          </div>
        )}
        {/* Resultado del último scan */}
        {resultado&&(
          <div style={{marginTop:"0.75rem",padding:"0.65rem 0.9rem",borderRadius:"8px",fontWeight:600,fontSize:"0.85rem",
            background:resultado.ok?"#041f14":"#1c0505",border:`1px solid ${resultado.ok?ok:err}`,color:resultado.ok?"#34d399":"#fca5a5"}}>
            {resultado.msg}
          </div>
        )}
      </div>

      {/* Overlay de confirmación multi-bulto */}
      {confirmBultos&&(
        <div style={{position:"fixed",inset:0,zIndex:9998,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center",padding:"1.5rem"}}>
          <div style={{background:"#0f1420",border:"2px solid #f59e0b",borderRadius:"18px",padding:"1.8rem",width:"100%",maxWidth:"400px",textAlign:"center"}}>
            <div style={{fontSize:"2.5rem",marginBottom:"0.5rem"}}>📦</div>
            <div style={{fontWeight:900,fontSize:"1.3rem",color:"#f59e0b",marginBottom:"0.4rem"}}>
              {confirmBultos.bultos} bultos
            </div>
            <div style={{fontWeight:700,fontSize:"0.95rem",color:"#fff",marginBottom:"0.25rem"}}>
              {confirmBultos.nroOrdenTN?"#"+confirmBultos.nroOrdenTN+" — ":""}{confirmBultos.direccion}
            </div>
            {(confirmBultos.localidad||confirmBultos.ciudad)&&(
              <div style={{color:"#6b7280",fontSize:"0.8rem",marginBottom:"1.2rem"}}>{confirmBultos.localidad||confirmBultos.ciudad}</div>
            )}
            <div style={{color:"#fbbf24",fontSize:"1rem",fontWeight:600,marginBottom:"1.5rem"}}>
              ¿Están los {confirmBultos.bultos} bultos?
            </div>
            <div style={{display:"flex",gap:"10px"}}>
              <button onClick={()=>{
                const ts=new Date().toISOString();
                const despachoPor=sesion?.nombre||sesion?.email||"";
                setEnvios(pv=>pv.map(e=>e.id===confirmBultos.id?{...e,despachado:true,despachoTs:ts,despachoLogistica:logSel,despachoPor}:e));
                setSesionIds(prev=>[confirmBultos.id,...prev]);
                beepOK();
                setResultado({ok:true,envio:confirmBultos,msg:`✓ ${confirmBultos.bultos} bultos despachados: ${confirmBultos.nroOrdenTN?"#"+confirmBultos.nroOrdenTN+" — ":""}${confirmBultos.direccion}`});
                setTimeout(()=>setResultado(null),5000);
                setConfirmBultos(null);
              }} style={{flex:1,padding:"0.9rem",borderRadius:"10px",background:"linear-gradient(135deg,#16a34a,#15803d)",border:"none",color:"#fff",fontWeight:800,fontSize:"1rem",cursor:"pointer"}}>
                ✓ Sí, están todos
              </button>
              <button onClick={()=>{beepError();setConfirmBultos(null);}}
                style={{flex:1,padding:"0.9rem",borderRadius:"10px",background:"#1c0505",border:"1px solid #7f1d1d",color:"#fca5a5",fontWeight:700,fontSize:"0.9rem",cursor:"pointer"}}>
                ✗ Faltan bultos
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Alerta: pedidos preparados sin logística asignada */}
      {(()=>{
        const sinAsignarPrep=envios.filter(e=>{
          const f=e.fecha||e.fechaVenta||"";
          return f===fecha&&!e.trans&&e.preparado&&e.estado!=="cancelado";
        });
        if(!sinAsignarPrep.length)return null;
        return(
          <div style={{background:"#1c1000",border:"1px solid #92400e",borderRadius:"10px",padding:"0.75rem 1rem",marginBottom:"0.75rem",display:"flex",alignItems:"flex-start",gap:"10px"}}>
            <span style={{fontSize:"1.1rem",flexShrink:0}}>⚠️</span>
            <div>
              <div style={{color:"#fbbf24",fontWeight:700,fontSize:"0.82rem"}}>
                {sinAsignarPrep.length} pedido{sinAsignarPrep.length!==1?"s":""} preparado{sinAsignarPrep.length!==1?"s":""} sin logística asignada
              </div>
              <div style={{color:"#d97706",fontSize:"0.72rem",marginTop:"2px"}}>
                {sinAsignarPrep.map(e=>nroRef(e)||dirCorta(e.direccion)).join(", ")}
              </div>
            </div>
          </div>
        );
      })()}

      {/* PENDIENTES DE ESCANEAR */}
      <div style={{background:card,border:`1px solid ${brd}`,borderRadius:"14px",padding:"1.2rem",marginBottom:"0.75rem"}}>
        <div style={{display:"flex",alignItems:"center",gap:"10px",marginBottom:"0.8rem",flexWrap:"wrap"}}>
          <div style={{fontWeight:700,fontSize:"0.82rem",color:muted,textTransform:"uppercase",letterSpacing:"0.05em",flex:1}}>
            Pendientes · {lotePend.length}
          </div>
          {esAdmin&&selSalida.size>0&&(
            <button onClick={despacharSeleccionados}
              style={{padding:"0.3rem 0.8rem",borderRadius:"8px",background:`linear-gradient(135deg,${logColor},${logColor}cc)`,border:"none",color:"#fff",fontWeight:700,fontSize:"0.75rem",cursor:"pointer"}}>
              Despachar {selSalida.size} seleccionado{selSalida.size!==1?"s":""}
            </button>
          )}
        </div>
        {lotePend.length===0
          ? <div style={{textAlign:"center",color:ok,fontSize:"0.82rem",padding:"0.5rem"}}>✓ Todos despachados</div>
          : <div style={{display:"flex",flexDirection:"column",gap:"5px"}}>
              {lotePend.map(e=>{
                const prep=e.preparado;
                const selAdmin=esAdmin&&selSalida.has(e.id);
                return(
                  <div key={e.id} style={{display:"flex",alignItems:"flex-start",gap:"8px",padding:"0.45rem 0.6rem",borderRadius:"7px",
                    background:selAdmin?"#0d0f2a":prep?"#0d0f1a":"transparent",
                    border:`1px solid ${selAdmin?"#6366f1":prep?"#1e293b":"transparent"}`,
                    opacity:prep?1:0.5}}>
                    {esAdmin&&(
                      <div style={{paddingTop:"2px",flexShrink:0}}>
                        <input type="checkbox" checked={selAdmin} onChange={()=>setSelSalida(prev=>{const n=new Set(prev);n.has(e.id)?n.delete(e.id):n.add(e.id);return n;})}
                          style={{width:"15px",height:"15px",cursor:"pointer",accentColor:logColor}}/>
                      </div>
                    )}
                    <div style={{width:"8px",height:"8px",borderRadius:"50%",background:prep?"#f59e0b":muted,flexShrink:0,marginTop:"4px"}}/>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:"5px",flexWrap:"wrap"}}>
                        {e.reprogramado&&<span style={{background:"#1c1500",color:"#fbbf24",border:"1px solid #78350f",padding:"1px 5px",borderRadius:"4px",fontSize:"0.6rem",fontWeight:700,flexShrink:0}}>⟳ Reprog.</span>}
                        <span style={{fontWeight:600,fontSize:"0.78rem",color:"#fff",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{dirCorta(e.direccion)}</span>
                      </div>
                      <div style={{display:"flex",gap:"8px",flexWrap:"wrap",marginTop:"1px"}}>
                        {(e.localidad||e.ciudad||e.partido)&&<span style={{color:muted,fontSize:"0.67rem"}}>{e.localidad||e.ciudad||e.partido}</span>}
                        {nroRef(e)&&<span style={{color:muted,fontSize:"0.67rem",fontFamily:"monospace"}}>{nroRef(e)}</span>}
                        {prep
                          ?<span style={{color:muted,fontSize:"0.67rem"}}>📦 {e.bultos||1} blt</span>
                          :<span style={{color:"#f59e0b",fontSize:"0.67rem",fontWeight:700}}>⚠ NO PREPARADO</span>
                        }
                        {e.armadorNombre&&<span style={{color:"#a78bfa",fontSize:"0.67rem",fontWeight:600}}>👤 {e.armadorNombre}</span>}
                      </div>
                    </div>
                    <div style={{fontSize:"0.68rem",fontWeight:700,color:prep?"#f59e0b":muted,flexShrink:0}}>
                      {prep?"Preparado":"Sin preparar"}
                    </div>
                  </div>
                );
              })}
            </div>
        }
      </div>

      {/* ESCANEADOS EN ESTA SESIÓN */}
      {despachados.length>0&&(
        <div style={{background:card,border:`1px solid #065f46`,borderRadius:"14px",padding:"1.2rem"}}>
          <div style={{fontWeight:700,fontSize:"0.82rem",color:ok,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:"0.8rem"}}>
            ✓ Escaneados · {despachados.length}
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:"6px"}}>
            {despachados.map((e,i)=>(
              <div key={e.id} style={{display:"flex",alignItems:"center",gap:"10px",padding:"0.55rem 0.7rem",borderRadius:"8px",background:"#041f14",border:"1px solid #065f46"}}>
                <div style={{width:"20px",height:"20px",borderRadius:"50%",background:ok,display:"flex",alignItems:"center",justifyContent:"center",fontSize:"0.7rem",fontWeight:900,color:"#fff",flexShrink:0}}>
                  {despachados.length-i}
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:"5px",flexWrap:"wrap",marginBottom:"1px"}}>
                    {e.reprogramado&&<span style={{background:"#1c1500",color:"#fbbf24",border:"1px solid #78350f",padding:"1px 5px",borderRadius:"4px",fontSize:"0.6rem",fontWeight:700,flexShrink:0}}>⟳ Reprog.</span>}
                    <span style={{fontWeight:700,fontSize:"0.82rem",color:"#fff",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{dirCorta(e.direccion)}</span>
                  </div>
                  <div style={{color:muted,fontSize:"0.7rem",display:"flex",gap:"6px",flexWrap:"wrap",alignItems:"center"}}>
                    {(e.localidad||e.ciudad||e.partido)&&<span>{e.localidad||e.ciudad||e.partido}</span>}
                    {nroRef(e)&&<span style={{fontFamily:"monospace"}}>{nroRef(e)}</span>}
                    <span>{e.bultos||1} bulto{(e.bultos||1)===1?"":"s"}</span>
                  </div>
                </div>
                <button onClick={()=>desDespachar(e.id)}
                  style={{padding:"0.25rem 0.55rem",borderRadius:"6px",background:"transparent",border:"1px solid #374151",color:muted,cursor:"pointer",fontSize:"0.68rem",fontWeight:600,flexShrink:0}}>
                  Deshacer
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function App(){
  const [confirmToken]=useState(()=>new URLSearchParams(window.location.search).get('t'));
  const [despachoToken]=useState(()=>new URLSearchParams(window.location.search).get('d'));
  const [sesion,setSesion]=useState(()=>getSession());
  const [pantalla,setPantalla]=useState("dashboard");

  // Validar sesión contra Firebase al arrancar — si el usuario fue desactivado, forzar logout
  // También sincroniza los permisos más recientes para que puedeVer() tenga datos frescos
  useEffect(()=>{
    if(!sesion?.id) return;
    getDoc(doc(db,"usuarios",sesion.id)).then(snap=>{
      if(!snap.exists()||snap.data().activo===false){
        clearSession();
        setSesion(null);
      } else {
        // Actualizar sesion con permisos frescos de Firestore
        const data=snap.data();
        const sesionActualizada={...sesion,permisos:data.permisos||{}};
        setSession(sesionActualizada);
        setSesion(sesionActualizada);
      }
    }).catch(()=>{}); // si no hay internet, dejar pasar (no bloquear)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  const [borrador,setBorrador]=useState([]);
  const [modalPDF,setModalPDF]=useState(null); // archivo pendiente mientras modal abierto
  const [modalPDFColecta,setModalPDFColecta]=useState(null); // archivo Colecta pendiente mientras modal abierto
  const [colectaProgMsg,setColectaProgMsg]=useState(""); // texto de progreso a mostrar en el botón "Colecta" mientras se espera ML Armado
  const [envios,setEnviosLocal]=useState([]);
  const [colectas,setColectas]=useState([]); // colectas ML pendientes de armado (estado=pendiente)
  useEffect(()=>{
    const unsub=onSnapshot(query(collection(db,"colectas"),where("estado","==","pendiente")),snap=>{
      setColectas(snap.docs.map(d=>({...d.data(),id:d.id})));
    });
    return()=>unsub();
  },[]);
  const [zc,setZc]=useState(ZONAS_INIT);
  const [lc,setLc]=useState(LOGISTICAS_INIT);
  const [cpExtra,setCpExtra]=useState({});

  // Cargar lc, zc y cpExtra desde Firebase al iniciar
  useEffect(()=>{
    const unsubLc=onSnapshot(doc(db,"config","logisticas"),snap=>{
      if(snap.exists()){setLc(snap.data());}
    });
    const unsubZc=onSnapshot(doc(db,"config","zonas"),snap=>{
      if(snap.exists()){setZc(snap.data());}
    });
    const unsubCp=onSnapshot(doc(db,"config","cp_extra"),snap=>{
      let data={};
      if(snap.exists()){data=snap.data();}
      else{
        try{
          const local=JSON.parse(localStorage.getItem("envhub_cp_extra")||"{}");
          if(Object.keys(local).length>0){
            setDoc(doc(db,"config","cp_extra"),local).then(()=>{
              localStorage.removeItem("envhub_cp_extra");
              console.log("Localidades migradas de localStorage a Firebase");
            }).catch(console.error);
            data=local;
          }
        }catch(e){}
      }
      Object.entries(data).forEach(([k,v])=>{CP_P[k]=v;});
      setCpExtra(data);
    });
    return()=>{unsubLc();unsubZc();unsubCp();};
  },[]);

  const setLcPersist=useCallback((updater)=>{
    setLc(prev=>{
      const next=typeof updater==="function"?updater(prev):updater;
      setDoc(doc(db,"config","logisticas"),next).catch(console.error);
      return next;
    });
  },[]);

  const setZcPersist=useCallback((updater)=>{
    setZc(prev=>{
      const next=typeof updater==="function"?updater(prev):updater;
      setDoc(doc(db,"config","zonas"),next).catch(console.error);
      return next;
    });
  },[]);
  const [tab,setTab]=useState("tablero");
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(false);
  const [syncLoading,setSyncLoading]=useState(true);
  const [fileName,setFileName]=useState("");
  const [fechaImport,setFechaImport]=useState(fechaHoy());
  const [pagosCC,setPagosCC]=useState([]);
  useEffect(()=>{const unsub=onSnapshot(collection(db,"pagosCC"),snap=>{setPagosCC(snap.docs.map(d=>({...d.data(),_id:d.id})));});return()=>unsub();},[]);

  // facturaClientes: {clienteKey: true} — guardado en config/clientesMeta
  const [facturaClientes,setFacturaClientesLocal]=useState({});
  useEffect(()=>{
    const unsub=onSnapshot(doc(db,"config","clientesMeta"),snap=>{
      if(snap.exists())setFacturaClientesLocal(snap.data().facturaImpresa||{});
    });
    return()=>unsub();
  },[]);
  const setFacturaCliente=(key,val)=>{
    const next=val?{...facturaClientes,[key]:true}:{...facturaClientes};
    if(!val)delete next[key];
    setFacturaClientesLocal(next);
    setDoc(doc(db,"config","clientesMeta"),{facturaImpresa:next},{merge:true}).catch(console.error);
  };

  // configExpedicion: {impresionHabilitada: bool, armadores: [{id,nombre,color}]}
  const [configExpedicion,setConfigExpedicionLocal]=useState({impresionHabilitada:false,armadores:[]});
  useEffect(()=>{
    const unsub=onSnapshot(doc(db,"config","expedicion"),snap=>{
      if(snap.exists())setConfigExpedicionLocal(snap.data());
    });
    return()=>unsub();
  },[]);
  const setConfigExpedicion=useCallback((updater)=>{
    setConfigExpedicionLocal(prev=>{
      const next=typeof updater==="function"?updater(prev):updater;
      setDoc(doc(db,"config","expedicion"),next).catch(console.error);
      return next;
    });
  },[]);

  const [toast,setToast]=useState("");
  const mostrarToast=msg=>{setToast(msg);setTimeout(()=>setToast(""),2500);};
  const [alertas,setAlertas]=useState([]);
  const prevEnviosRef=useRef(null); // para detectar cambios en onSnapshot
  const agregarAlerta=(tipo,msg,persistente=false)=>{
    const id=Date.now()+Math.random();
    setAlertas(prev=>[...prev,{id,tipo,msg,persistente}]);
    if(!persistente)setTimeout(()=>setAlertas(prev=>prev.filter(a=>a.id!==id)),5000);
  };

  useEffect(()=>{
    const unsub=onSnapshot(collection(db,"envios"),(snap)=>{
      const docs=snap.docs.map(d=>({...d.data(),id:d.id}));
      docs.sort((a,b)=>(b.fechaVenta||b.fecha||"").localeCompare(a.fechaVenta||a.fecha||""));

      // Detectar cambios relevantes (saltar carga inicial)
      if(prevEnviosRef.current!==null){
        const prev=prevEnviosRef.current;
        const prevMap=new Map(prev.map(e=>[e.id,e]));
        docs.forEach(nuevo=>{
          const viejo=prevMap.get(nuevo.id);
          // Orden cancelada que tenia logistica asignada → alerta roja persistente
          if(viejo&&viejo.estado!=="cancelado"&&nuevo.estado==="cancelado"&&viejo.trans){
            agregarAlerta("error",`❌ Orden TN #${nuevo.nroOrdenTN||nuevo.id} cancelada — estaba asignada a ${viejo.trans}`,true);
          }
          // Orden cancelada sin asignar → alerta azul que se cierra sola
          if(viejo&&viejo.estado!=="cancelado"&&nuevo.estado==="cancelado"&&!viejo.trans){
            agregarAlerta("info",`🔔 Orden TN #${nuevo.nroOrdenTN||nuevo.id} cancelada`,false);
          }
          // Orden nueva de TN → alerta azul
          if(!viejo&&nuevo.origen==="Tienda Nube"){
            agregarAlerta("info",`🛍 Nuevo pedido TN #${nuevo.nroOrdenTN||nuevo.id} — ${nuevo.clienteNombre||""}`,false);
          }
        });
      }
      prevEnviosRef.current=docs;
      setEnviosLocal(docs);setSyncLoading(false);
    },(err)=>{console.error(err);setSyncLoading(false);});
    return()=>unsub();
  },[]);

  const [pendingSaves,setPendingSaves]=useState(0);

  // Cola de escrituras pendientes: Map<id, envio> — evita duplicados por id
  const saveQueue=useRef(new Map());
  const deleteQueue=useRef(new Set());
  const saveTimerRef=useRef(null);

  // Flushea la cola: escribe todo lo acumulado en un solo ciclo
  const flushSaves=useCallback(async()=>{
    const toSave=[...saveQueue.current.values()];
    const toDel=[...deleteQueue.current];
    if(!toSave.length&&!toDel.length)return;
    saveQueue.current.clear();
    deleteQueue.current.clear();
    try{
      const batch=writeBatch(db);
      toSave.forEach(e=>batch.set(doc(db,"envios",e.id),e));
      toDel.forEach(id=>batch.delete(doc(db,"envios",id)));
      await batch.commit();
    }catch(err){console.error("Error guardando envios:",err);}
    finally{setPendingSaves(p=>Math.max(0,p-1));} // un solo decremento por batch
  },[]);

  // Encola un envío; sube el contador solo cuando la cola estaba vacía
  const guardarEnvio=(e)=>{
    const eraVacia=saveQueue.current.size===0&&deleteQueue.current.size===0;
    saveQueue.current.set(e.id,e);
    if(saveTimerRef.current)clearTimeout(saveTimerRef.current);
    saveTimerRef.current=setTimeout(flushSaves,600);
    if(eraVacia)setPendingSaves(p=>p+1); // un solo incremento por batch
  };

  const eliminarEnvio=(id)=>{
    const eraVacia=saveQueue.current.size===0&&deleteQueue.current.size===0;
    saveQueue.current.delete(id);
    deleteQueue.current.add(id);
    if(saveTimerRef.current)clearTimeout(saveTimerRef.current);
    saveTimerRef.current=setTimeout(flushSaves,600);
    if(eraVacia)setPendingSaves(p=>p+1);
  };

  // Flush inmediato al cerrar la pestaña (no perder cambios)
  useEffect(()=>{
    const handler=()=>flushSaves();
    window.addEventListener("beforeunload",handler);
    return()=>window.removeEventListener("beforeunload",handler);
  },[flushSaves]);

  const setEnvios=useCallback((updater)=>{
    setEnviosLocal(prev=>{
      const next=typeof updater==="function"?updater(prev):updater;
      // O(n) con Map en lugar de O(n²) con find+JSON.stringify
      const prevMap=new Map(prev.map(e=>[e.id,e]));
      const nextSet=new Set(next.map(e=>e.id));
      next.forEach(e=>{const old=prevMap.get(e.id);if(!old||old!==e)guardarEnvio(e);});
      prev.forEach(e=>{if(!nextSet.has(e.id))eliminarEnvio(e.id);});
      return next;
    });
  },[]);

  const cargarArchivo=useCallback(async(file,fechaEntrega)=>{
    if(!file)return;setLoading(true);setError("");
    try{
      const parsed=await parsearExcel(file);
      // Aplicar fecha de entrega seleccionada a todos los envios del lote
      if(fechaEntrega){parsed.forEach(e=>{e.fecha=fechaEntrega;});}
      const dups=parsed.filter(e=>e.nroSeguimiento&&envios.some(ex=>ex.nroSeguimiento===e.nroSeguimiento)).map(e=>e.nroSeguimiento);
      if(dups.length>0){const ok=window.confirm(`Se detectaron ${dups.length} envio(s) duplicado(s) por numero de seguimiento. Continuar de todas formas?`);if(!ok){setLoading(false);return;}}
      setBorrador(parsed);setFileName(file.name);setPantalla("asignacion");
    }catch(e){setError(e.message);}
    setLoading(false);
  },[envios]);

  const confirmarAsignacion=async(asignados)=>{
    const ts=new Date().toISOString();
    for(const e of asignados){
      // Agregar timestamp de asignación si no tiene (NO FLEX no lo trae)
      if(!e.loteImportacion)e.loteImportacion=ts;
      await guardarEnvio(e);
    }
    setPantalla("dashboard");setTab("envios");mostrarToast(asignados.length+" envios guardados");
  };
  const reasignarSel=items=>{setBorrador(items);setPantalla("asignacion");};

  // Auth gates
  if(despachoToken)return<DespachoPage token={despachoToken}/>;
  if(confirmToken)return<ConfirmPage token={confirmToken}/>;
  if(!sesion)return<PantallaLogin onLogin={s=>{setSession(s);setSesion(s);}}/>;
  if(sesion.rol==="logistica"){
    const esChofer=sesion.esChofer===true;
    if(esChofer)return<VistaChofer envios={envios} setEnvios={setEnvios} sesion={sesion} lc={lc}/>;
    return<VistaLogistica envios={envios} sesion={sesion} lc={lc}/>;
  }
  if(sesion.rol==="expedicion")return<VistaExpedicion envios={envios} setEnvios={setEnvios} colectas={colectas} setColectas={setColectas} sesion={sesion} lc={lc} configExpedicion={configExpedicion}/>;
  if(sesion.rol==="armador"){
    const arm=(configExpedicion.armadores||[]).find(a=>a.id===sesion.armadorId);
    return<VistaArmador envios={envios} setEnvios={setEnvios} colectas={colectas} setColectas={setColectas} sesion={sesion} lc={lc} armador={arm} armadores={configExpedicion.armadores||[]} gapUmbralMin={configExpedicion.gapUmbralMin||5}/>;
  }

  if(pantalla==="asignacion"){return<PantallaAsignacion borrador={borrador} fileName={fileName} onConfirmar={confirmarAsignacion} onCancelar={()=>setPantalla("dashboard")} lc={lc} envios={envios} sesion={sesion}/>;}
  if(pantalla==="asignacion-tn"){return<PantallaAsignacionTN borrador={borrador} onConfirmar={confirmarAsignacion} onCancelar={()=>setPantalla("dashboard")} lc={lc} sesion={sesion}/>;}

  const esAdmin=sesion?.rol==="admin";
  const esColaborador=sesion?.rol==="colaborador";
  // Mapa tab id → feature key para filtrado de permisos
  const TAB_FEATURE_MAP={
    tablero:"tab_tablero",envios:"tab_noflex",flex:"tab_flex",
    imprimir:"tab_despacho",manual:"tab_manual",tarifas:"tab_tarifas",
    informe:"tab_informe",liquidacion:"tab_cobranzaslog",
    liquidacionlog:"tab_liquidacionlog",ctasctes:"tab_ctasctes",
    localidades:"tab_localidades",expedicion:"tab_expedicion",statsarmado:"tab_statsarmado",consultaarmado:"tab_consultaarmado",salida:"tab_salida",usuarios:"tab_usuarios",
  };
  const TABS=[
    {id:"tablero",l:"📊 Tablero"},
    {id:"envios",l:"NO FLEX"},
    {id:"flex",l:"FLEX"},
    {id:"imprimir",l:"Despacho"},
    {id:"manual",l:"+ Manual"},
    {id:"tarifas",l:"Tarifas / Log."},
    {id:"informe",l:"Informe"},
    {id:"liquidacion",l:"Cobranzas Log."},
    {id:"liquidacionlog",l:"Liquidacion Log."},
    {id:"ctasctes",l:"Ctas. Ctes."},
    {id:"clientes",l:"Clientes"},
    {id:"localidades",l:"Localidades"},
    {id:"expedicion",l:"Expedicion"},
    {id:"statsarmado",l:"📊 Stats Armado"},
    {id:"consultaarmado",l:"🔍 Consulta Armado"},
    {id:"salida",l:"🚚 Salida"},
    {id:"usuarios",l:"Usuarios"},
  ].filter(t=>{
    const fk=TAB_FEATURE_MAP[t.id];
    return fk?puedeVer(sesion,fk):true;
  });

  return(
    <div style={{minHeight:"100vh",background:"#0a0e1a",color:"#fff",fontFamily:"sans-serif"}}>
      <style>{`*{box-sizing:border-box;}::-webkit-scrollbar{width:6px;height:10px;}::-webkit-scrollbar-track{background:#0f1420;border-radius:4px;}::-webkit-scrollbar-thumb{background:#4b5563;border-radius:4px;border:1px solid #0f1420;}::-webkit-scrollbar-thumb:hover{background:#9ca3af;}::-webkit-scrollbar-corner{background:#0f1420;}html{scrollbar-width:thin;scrollbar-color:#4b5563 #0f1420;}select option{background:#1a1f2e;color:#e5e7eb;}button:hover{opacity:0.85;}`}</style>
      {toast&&<div style={{position:"fixed",top:"16px",right:"16px",zIndex:999,background:"#041f14",border:"1px solid #10b981",borderRadius:"10px",padding:"0.6rem 1.1rem",color:"#34d399",fontWeight:700,fontSize:"0.82rem"}}>{toast}</div>}
      {pendingSaves>0&&<div style={{position:"fixed",bottom:"20px",left:"50%",transform:"translateX(-50%)",zIndex:9999,background:"#12172a",border:"1px solid #4338ca",borderRadius:"20px",padding:"6px 16px",display:"flex",alignItems:"center",gap:"8px",fontSize:"0.75rem",fontWeight:700,color:"#a5b4fc",pointerEvents:"none"}}>
        <span style={{width:"11px",height:"11px",border:"2px solid #6366f1",borderTopColor:"transparent",borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite",flexShrink:0}}/>
        Guardando...
      </div>}
      {/* Alertas flotantes TN — abajo a la derecha */}
      {alertas.length>0&&(
        <div style={{position:"fixed",bottom:"20px",right:"16px",zIndex:1000,display:"flex",flexDirection:"column",gap:"8px",maxWidth:"320px"}}>
          {alertas.map(a=>(
            <div key={a.id} style={{
              background:a.tipo==="error"?"#1c0505":"#0d1c2e",
              border:`1px solid ${a.tipo==="error"?"#f87171":"#38bdf8"}`,
              borderRadius:"10px",padding:"0.65rem 1rem",
              color:a.tipo==="error"?"#fca5a5":"#7dd3fc",
              fontSize:"0.82rem",fontWeight:600,
              display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:"10px",
              boxShadow:"0 4px 16px rgba(0,0,0,0.5)",
            }}>
              <span>{a.msg}</span>
              <button onClick={()=>setAlertas(prev=>prev.filter(x=>x.id!==a.id))} style={{background:"none",border:"none",color:"inherit",cursor:"pointer",fontSize:"1rem",padding:0,flexShrink:0,opacity:0.7}}>✕</button>
            </div>
          ))}
        </div>
      )}
      <div style={{position:"sticky",top:0,zIndex:100,background:"#0f1420",borderBottom:"1px solid #1a1f2e",padding:"0.7rem 1rem",display:"flex",alignItems:"center",gap:"0.55rem",flexWrap:"wrap"}}>
        <div style={{width:"26px",height:"26px",background:"linear-gradient(135deg,#6366f1,#8b5cf6)",borderRadius:"7px",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>🛵</div>
        <div style={{marginRight:"0.2rem"}}>
          <div style={{fontWeight:800,fontSize:"0.92rem"}}>EnviosHub <span style={{color:"#374151",fontSize:"0.6rem",fontWeight:400}}>v{VERSION}</span></div>
          <div style={{color:"#374151",fontSize:"0.58rem"}}>{syncLoading?"Conectando...":(envios.length>0?envios.length+" envios":"Sin envios")}</div>
        </div>
        <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{TABS.map(t =>{
          const isFlex=t.id==="flex";
          const isActive=tab===t.id;
          const style=isFlex
            ?{...S.btn(isActive,"#84cc16"),padding:"0.32rem 0.65rem",fontSize:"0.73rem",
               background:isActive?"#0d1c04":"#0f1420",
               color:isActive?"#84cc16":"#4b7a10",
               border:isActive?"1px solid #84cc16":"1px solid #1a3008"}
            :{...S.btn(isActive),padding:"0.32rem 0.65rem",fontSize:"0.73rem"};
          return <button key={t.id} onClick={()=>setTab(t.id)} style={style}>{t.l}</button>;
        })}</div>
        <div style={{marginLeft:"auto",display:"flex",gap:"0.35rem",flexWrap:"wrap"}}>
          {puedeVer(sesion,"accion_asignartN")&&<button onClick={()=>{const tnSinAsignar=envios.filter(e=>e.origen==="Tienda Nube"&&getEstado(e)==="sin_asignar");if(!tnSinAsignar.length){mostrarToast("No hay pedidos TN sin asignar");return;}setBorrador(tnSinAsignar);setFileName("Pedidos TN sin asignar");setPantalla("asignacion-tn");}} style={{padding:"0.33rem 0.75rem",borderRadius:"7px",background:"#0d1c2e",border:"1px solid #38bdf8",color:"#38bdf8",fontWeight:700,fontSize:"0.72rem",cursor:"pointer"}}>Asignar TN</button>}
          <button onClick={descargarTemplate} style={{padding:"0.33rem 0.75rem",borderRadius:"7px",background:"#0f1420",border:"1px solid #252d40",color:"#9ca3af",fontWeight:700,fontSize:"0.72rem",cursor:"pointer"}} title="Descargar plantilla Excel">⬇ Plantilla</button>
          <label style={{cursor:"pointer"}}>
            <input type="file" accept=".pdf" style={{display:"none"}} onChange={async ev=>{
              const f=ev.target.files[0];if(!f){return;}ev.target.value="";
              setModalPDF(f); // Abrir modal de opciones
            }}/>
            <span style={{display:"inline-block",padding:"0.33rem 0.75rem",borderRadius:"7px",background:"#0a1a0a",border:"1px solid #84cc16",color:"#84cc16",fontWeight:700,fontSize:"0.72rem",cursor:"pointer"}}>{loading?"...":"📦 Etiquetas PDF"}</span>
          </label>
          {/* Modal opciones PDF FLEX */}
          {modalPDF&&<ModalOpcionesPDF
            onCancel={()=>setModalPDF(null)}
            onConfirm={async({cargarEnvios,procesarArmado})=>{
              const f=modalPDF;setModalPDF(null);
              setLoading(true);
              try{
                const etiquetas=cargarEnvios?await parsearEtiquetasPDF(f):[];
                const hoy=fechaHoy();
                const loteTs=new Date().toISOString();
                const nuevos=[];
                if(cargarEnvios&&etiquetas.length){
                  for(const et of etiquetas){
                    const existe=envios.find(e=>e.nroSeguimiento===et.nroSeguimiento);
                    if(existe){
                      const ref=doc(db,"envios",existe.id);
                      const upd={};
                      if(et.destinatario)upd.destinatario=et.destinatario;
                      if(et.referencia)upd.referencia=et.referencia;
                      if(et.tipoEntrega)upd.tipoEntrega=et.tipoEntrega;
                      if(et.localidad&&!existe.localidad)upd.localidad=et.localidad;
                      if(et.fecha&&!existe.fecha)upd.fecha=et.fecha;
                      if(Object.keys(upd).length)await setDoc(ref,upd,{merge:true});
                    } else {
                      nuevos.push({
                        id:et.nroSeguimiento,
                        nroSeguimiento:et.nroSeguimiento,
                        linkML:"https://www.mercadolibre.com.ar/ventas/"+et.nroSeguimiento+"/detalle",
                        origen:"ML",
                        direccion:et.direccion||"",
                        localidad:et.localidad||"",
                        partido:cpAPartido(et.cp)||"",
                        cp:et.cp||"",
                        ciudad:"",
                        fecha:et.fecha||hoy,
                        fechaVenta:hoy,
                        turno:"",
                        trans:"",
                        bultos:null,
                        cobranza:null,
                        cambio:null,
                        retiro:null,
                        observaciones:"",
                        importe:0,
                        destinatario:et.destinatario||"",
                        referencia:et.referencia||"",
                        tipoEntrega:et.tipoEntrega||"",
                        preparado:false,
                        loteImportacion:loteTs,
                      });
                    }
                  }
                }
                // ML Armado — solo si el usuario lo eligió
                if(procesarArmado){
                  try{
                    const logMap = {};
                    for(const e of envios){
                      if(e.nroSeguimiento && e.trans) logMap[e.nroSeguimiento] = e.trans;
                    }
                    await procesarConMLArmado(f,"Flex",null,logMap);
                  }catch(mlErr){
                    mostrarToast("ML Armado no disponible — intentá de nuevo en unos segundos");
                  }
                }
                // Toast resumen
                const partes=[];
                if(cargarEnvios){
                  if(nuevos.length)partes.push(nuevos.length+" envio(s) nuevo(s)");
                  else if(etiquetas.length)partes.push("Envios actualizados");
                  else if(!etiquetas.length)partes.push("Sin etiquetas FLEX detectadas");
                }
                if(procesarArmado)partes.push("PDF procesado");
                if(partes.length)mostrarToast(partes.join(" · "));
                // Abrir popup solo si hay nuevos envíos
                if(nuevos.length){
                  setBorrador(nuevos);
                  setFileName(f.name);
                  setPantalla("asignacion");
                }
              }catch(err){mostrarToast("Error: "+err.message);}
              setLoading(false);
            }}
          />}
          <label style={{cursor:"pointer"}}>
            <input type="file" accept=".pdf" style={{display:"none"}} onChange={async ev=>{
              const f=ev.target.files[0];if(!f){return;}ev.target.value="";
              setModalPDFColecta(f); // Abrir modal de opciones
            }}/>
            <span style={{display:"inline-block",padding:"0.33rem 0.75rem",borderRadius:"7px",background:"#1a0d2e",border:"1px solid #a78bfa",color:"#a78bfa",fontWeight:700,fontSize:"0.72rem",cursor:"pointer",whiteSpace:"nowrap"}}>{loading?(colectaProgMsg||"..."):"📋 Colecta"}</span>
          </label>
          {/* Modal opciones PDF Colecta */}
          {modalPDFColecta&&<ModalOpcionesColecta
            onCancel={()=>setModalPDFColecta(null)}
            onConfirm={async({cargarColectas,procesarArmado})=>{
              const f=modalPDFColecta;setModalPDFColecta(null);
              setLoading(true);
              setColectaProgMsg("");
              try{
                let nuevas=0;
                let noProcesadas=[];
                if(cargarColectas){
                  setColectaProgMsg("Leyendo etiquetas...");
                  const res=await parsearEtiquetasColectaPDF(f);
                  const etiquetas=res.etiquetas;
                  noProcesadas=res.noProcesadas||[];
                  const loteTs=new Date().toISOString();
                  for(const et of etiquetas){
                    if(!et.nroSeguimiento)continue;
                    const yaPendiente=colectas.some(c=>c.nroSeguimiento===et.nroSeguimiento);
                    if(yaPendiente)continue; // ya está cargada y pendiente, no duplicar
                    await addDoc(collection(db,"colectas"),{
                      nroSeguimiento:et.nroSeguimiento,
                      nroVenta:et.nroVenta||"",
                      nroPackId:et.nroPackId||"",
                      destinatario:et.destinatario||"",
                      usuario:et.usuario||"",
                      direccion:et.direccion||"",
                      cp:et.cp||"",
                      localidad:et.localidad||"",
                      partido:cpAPartido(et.cp)||"",
                      referencia:et.referencia||"",
                      fecha:et.fecha||fechaHoy(),
                      estado:"pendiente",
                      armadorId:null,armadorNombre:null,fechaArmado:null,horaArmado:null,
                      loteImportacion:loteTs,
                    });
                    nuevas++;
                  }
                }
                if(procesarArmado){
                  try{
                    await procesarConMLArmado(f,"Colecta",setColectaProgMsg);
                  }catch(mlErr){
                    agregarAlerta("error","ML Armado no disponible — intentá de nuevo en unos segundos",true);
                  }
                }
                const partes=[];
                if(cargarColectas)partes.push(nuevas+" colecta(s) nueva(s) pendiente(s)");
                if(procesarArmado)partes.push("PDF procesado");
                // Confirmación persistente (no un toast de 2.5s que se pierde detrás del diálogo
                // nativo de "guardar archivo" que dispara la descarga del PDF anotado)
                if(partes.length)agregarAlerta("info","✅ "+partes.join(" · "),true);
                if(noProcesadas.length){
                  const detalle=noProcesadas.map(n=>"pág. "+n.pagina+(n.packId?" (Pack ID "+n.packId+")":"")).join(", ");
                  agregarAlerta("error",`⚠️ ${noProcesadas.length} colecta(s) NO se pudieron cargar del PDF — ${detalle}. Revisar manualmente.`,true);
                }
              }catch(err){agregarAlerta("error","Error: "+err.message,true);}
              setColectaProgMsg("");
              setLoading(false);
            }}
          />}
          {puedeVer(sesion,"accion_cargaexcel")&&<div style={{display:"flex",alignItems:"center",gap:"3px",background:"#12172a",border:"1px solid #6366f1",borderRadius:"7px",overflow:"hidden"}}>
            <input type="date" value={fechaImport} onChange={e=>setFechaImport(e.target.value)} style={{...S.input,border:"none",borderRadius:0,padding:"0.28rem 0.5rem",fontSize:"0.72rem",width:"130px",color:"#a5b4fc"}} title="Fecha de entrega para los envios del Excel"/>
            <label style={{cursor:"pointer",margin:0}}>
              <input type="file" accept=".xlsx,.xls" style={{display:"none"}} onChange={e=>{if(e.target.files[0]){cargarArchivo(e.target.files[0],fechaImport);e.target.value="";}}}/>
              <span style={{display:"inline-block",padding:"0.33rem 0.75rem",background:"linear-gradient(135deg,#6366f1,#8b5cf6)",color:"#fff",fontWeight:700,fontSize:"0.72rem",cursor:"pointer"}}>{loading?"...":"Cargar Excel"}</span>
            </label>
          </div>}
          <span style={{color:"#4b5563",fontSize:"0.7rem",borderLeft:"1px solid #1a1f2e",paddingLeft:"0.5rem"}}>{sesion?.usuario}</span>
          <button onClick={()=>{clearSession();setSesion(null);}} style={{...S.btnSm(false),color:"#f87171",fontSize:"0.7rem"}}>Salir</button>
        </div>
      </div>
      <ScrollTop/>
      <div style={{padding:"0.85rem 1rem",maxWidth:"1400px",margin:"0 auto"}}>
        {error&&<div style={{...S.card,padding:"0.65rem 1rem",marginBottom:"0.8rem",background:"#1c0a0a",border:"1px solid #7f1d1d",color:"#fca5a5",fontSize:"0.8rem"}}>{error}</div>}
        {tab==="tablero" &&<TabTablero envios={envios} lc={lc} zc={zc} pagosCC={pagosCC}/>}
        {tab==="envios"  &&<TabEnvios   envios={envios.filter(e=>e.origen!=="ML")} setEnvios={setEnvios} zc={zc} lc={lc} onReasignar={reasignarSel} esAdmin={esAdmin} sesion={sesion} facturaClientes={facturaClientes}/>}
        {tab==="flex"    &&<TabEnvios   envios={envios.filter(e=>e.origen==="ML")}  setEnvios={setEnvios} zc={zc} lc={lc} onReasignar={reasignarSel} esAdmin={esAdmin} sesion={sesion} mostrarResumenFlex={true} facturaClientes={facturaClientes}/>}
        {tab==="imprimir"&&<TabImprimir envios={envios} setEnvios={setEnvios} zc={zc} lc={lc}/>}
        {tab==="manual"  &&<TabManual   setEnvios={setEnvios} onSuccess={()=>{mostrarToast("Envio agregado");}} lc={lc} enviosExistentes={envios} sesion={sesion}/>}
        {tab==="tarifas" &&<TabTarifas  zc={zc} setZc={setZcPersist} lc={lc} setLc={setLcPersist}/>}
        {tab==="informe"     &&<TabInforme     envios={envios} zc={zc} lc={lc}/>}
        {tab==="liquidacion"    &&<TabLiquidacion    envios={envios} setEnvios={setEnvios} lc={lc} sesion={sesion}/>}
        {tab==="liquidacionlog" &&<TabLiquidacionLog envios={envios} setEnvios={setEnvios} zc={zc} lc={lc} esAdmin={esAdmin} sesion={sesion}/>}
        {tab==="ctasctes"       &&<TabCtasCtes       envios={envios} lc={lc} sesion={sesion} pagosInicial={pagosCC} facturaClientes={facturaClientes} setFacturaCliente={setFacturaCliente}/>}
        {tab==="clientes"       &&<TabClientes       envios={envios} lc={lc} pagosCC={pagosCC} facturaClientes={facturaClientes} setFacturaCliente={setFacturaCliente} sesion={sesion}/>}
        {tab==="localidades" &&<TabLocalidades cpExtra={cpExtra} setCpExtra={setCpExtra}/>}
        {tab==="usuarios"   &&<TabUsuarios lc={lc} setLc={setLcPersist} configExpedicion={configExpedicion} setConfigExpedicion={setConfigExpedicion}/>}
        {tab==="expedicion" &&<VistaExpedicion envios={envios} setEnvios={setEnvios} colectas={colectas} setColectas={setColectas} sesion={sesion} lc={lc} configExpedicion={configExpedicion} esAdmin={esAdmin}/>}
        {tab==="statsarmado"   &&<TabStatsArmado configExpedicion={configExpedicion} setConfigExpedicion={setConfigExpedicion} esAdmin={esAdmin}/>}
        {tab==="consultaarmado"&&<TabConsultaArmado esAdmin={esAdmin}/>}
        {tab==="salida"        &&<TabSalida envios={envios} setEnvios={setEnvios} lc={lc} sesion={sesion}/>}
      </div>
    </div>
  );
}
