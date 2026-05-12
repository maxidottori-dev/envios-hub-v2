import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import * as XLSXLib from "xlsx";
import { db } from "./firebase.js";
import { collection, onSnapshot, doc, getDoc, setDoc, deleteDoc, query, where, getDocs, addDoc, serverTimestamp, limit } from "firebase/firestore";

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

  if (onProgress) onProgress("Procesando con ML Armado...");

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
function fechaAyer()   { const d=new Date();d.setDate(d.getDate()-1);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().split("T")[0]; }
function fechaManana() { const d=new Date();d.setDate(d.getDate()+1);return d.toISOString().split("T")[0]; }
function fechaInicioSemana() { const d=new Date();d.setDate(d.getDate()-((d.getDay()||7)-1));return d.toISOString().split("T")[0]; }
function fmtCorta(ds) { if(!ds)return"";const[,m,d]=ds.split("-");return d+"/"+m; }
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
};

const TURNOS=["AM","MD","PM","Turbo"];
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
  SYM:{zonas:[{id:"CABA",nombre:"CABA",color:"#6366f1",precio:3509,partidos:["CABA"]},{id:"PL",nombre:"PL",color:"#10b981",precio:3509,partidos:["Avellaneda","Lanus"]},{id:"LOMAS",nombre:"LOMAS",color:"#ec4899",precio:3509,partidos:["Lomas de Zamora"]},{id:"QUILMES",nombre:"QUILMES",color:"#14b8a6",precio:7865,partidos:["Quilmes"]},{id:"NOE",nombre:"NOE",color:"#f59e0b",precio:7865,partidos:["Hurlingham","Ituzaingo","Jose C Paz","La Matanza Norte","La Matanza Sur","Malvinas Argentinas","Merlo","Moreno","Moron","San Fernando","San Isidro","San Martin","San Miguel","Tigre","Tres de Febrero","Vicente Lopez"]},{id:"SUR",nombre:"SUR",color:"#ef4444",precio:7865,partidos:["Almirante Brown","Berazategui","Esteban Echeverria","Florencio Varela"]},{id:"GBA2",nombre:"GBA2",color:"#8b5cf6",precio:10527,partidos:["La Plata","Zarate","Ensenada","Berisso","Escobar","Marcos Paz","Pilar","Presidente Peron","Canuelas","Lujan","Gral. Rodriguez","Ex.de la Cruz","San Vicente","Campana","Ezeiza"]}]}
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
  if(zc){
    const zona=getZonaLogistica(zc,e.trans,e.partido);
    if(zona){
      let bk=bultos;
      if(bultos>=4&&bultos<=10)bk=10;
      else if(bultos>=11)bk=11;
      // 1. Intentar matriz FLEX si corresponde
      if(esFlex&&cfg?.tarifaMatrixFlex){
        const mxF=cfg.tarifaMatrixFlex[zona.id]||{};
        const pF=mxF[String(bk)];
        if(pF!==undefined&&pF>0)return pF;
      }
      // 2. Matriz NO FLEX (con vigencia)
      const mx=getMatrizVigente(cfg,fechaEnvio);
      if(mx){
        const mxZ=mx[zona.id]||{};
        const p=mxZ[String(bk)];
        if(p!==undefined&&p>0)return p;
      }
    }
  }
  if(cfg&&bultos>1){const pb=cfg.preciosBultos?.find(x =>x.b===bultos);if(pb&&pb.p>0)return pb.p;}
  return tmap[e.partido]?.[e.trans]||0;
}

function getWeekNum(ds){const d=new Date(ds+"T00:00:00"),day=d.getDay()||7;d.setDate(d.getDate()+4-day);const y=new Date(d.getFullYear(),0,1);return{w:Math.ceil((((d-y)/86400000)+1)/7),y:d.getFullYear()};}
function weekLabel(ds){const d=new Date(ds+"T00:00:00"),day=d.getDay()||7;const mon=new Date(d);mon.setDate(d.getDate()-(day-1));const sun=new Date(mon);sun.setDate(mon.getDate()+6);const f=x=>String(x.getDate()).padStart(2,"0")+"/"+String(x.getMonth()+1).padStart(2,"0");return"Sem."+getWeekNum(ds).w+" ("+f(mon)+"-"+f(sun)+")";}

const fmt=n=>n?"$"+Number(n).toLocaleString("es-AR"):"-";
function beepOK(){try{const ctx=new(window.AudioContext||window.webkitAudioContext)();const o=ctx.createOscillator();const g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.frequency.setValueAtTime(880,ctx.currentTime);o.frequency.setValueAtTime(1100,ctx.currentTime+0.1);g.gain.setValueAtTime(0.3,ctx.currentTime);g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.3);o.start(ctx.currentTime);o.stop(ctx.currentTime+0.3);}catch(e){}}
const fmtN=n=>Number(n).toLocaleString("es-AR");

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

function PantallaAsignacion({borrador,fileName,onConfirmar,onCancelar,lc}){
  const hoy=fechaHoy();
  const [asig,setAsig]=useState({});
  const [modo,setModo]=useState("zona");
  const logActivas=Object.entries(lc).filter(([,v])=>v.activa).map(([k])=>k);
  const getA=id=>asig[id]||{trans:"",fecha:hoy,turno:""};
  const setA=(id,k,v)=>setAsig(p=>({...p,[id]:{...getA(id),[k]:v}}));
  const setGrupo=(ids,k,v)=>setAsig(p=>{const n={...p};ids.forEach(id=>{n[id]={...getA(id),[k]:v}});return n;});
  const getGrupo=(ids,k)=>{const vals=[...new Set(ids.map(id=>getA(id)[k]||""))];return vals.length===1?vals[0]:"";};
  const grupos={};
  borrador.forEach(e=>{const key=modo==="zona"?(getZonaML(e.partido)||"Otra"):(e.partido||"Sin partido");if(!grupos[key])grupos[key]=[];grupos[key].push(e);});
  const grupoKeys=modo==="zona"?[...ZONAS_ML_LIST,"Otra"].filter(k =>grupos[k]):Object.keys(grupos).sort();
  const totalAsig=borrador.filter(e=>getA(e.id).trans).length;
  const confirmar=()=>onConfirmar(borrador.map(e=>({...e,...getA(e.id),estado:getA(e.id).trans?"asignado":"sin_asignar"})));
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
      <style>{`*{box-sizing:border-box;}select option{background:#1a1f2e;}`}</style>
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
          <button onClick={confirmar} style={{...S.btn(true),background:"linear-gradient(135deg,#6366f1,#8b5cf6)"}}>Confirmar</button>
        </div>
      </div>
      <div style={{padding:"1rem",maxWidth:"980px",margin:"0 auto"}}>
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
                return(
                  <div key={e.id} style={{padding:"0.45rem 1rem",borderBottom:i<grupo.length-1?"1px solid #1a1f2e":"none",display:"flex",alignItems:"center",gap:"0.6rem",flexWrap:"wrap"}}>
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
        <div style={{display:"flex",justifyContent:"flex-end",gap:"0.75rem",marginTop:"1rem",paddingBottom:"2rem"}}>
          <button onClick={imprimirLote} disabled={totalAsig===0} style={{...S.btn(false),color:totalAsig>0?"#84cc16":"#4b5563",borderColor:totalAsig>0?"#84cc16":"#252d40",opacity:totalAsig>0?1:0.5}}>Imprimir lote</button>
          <button onClick={onCancelar} style={S.btn(false)}>Cancelar</button>
          <button onClick={confirmar} style={{...S.btn(true),background:"linear-gradient(135deg,#6366f1,#8b5cf6)",padding:"0.55rem 1.4rem"}}>Confirmar ({totalAsig}/{borrador.length})</button>
        </div>
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

function PanelEdit({envio,onSave,onClose,lc}){
  const [e,setE]=useState({...envio});
  const set=(k,v)=>setE(p=>({...p,[k]:v}));
  const logActivas=Object.entries(lc).filter(([,v])=>v.activa).map(([k])=>k);
  const handleTrans=l=>{const t=e.trans===l?"":l;setE(p=>({...p,trans:t,estado:t?"asignado":(p.estado==="cancelado"?"cancelado":"sin_asignar")}));};
  const esTN = e.origen === "Tienda Nube";
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
          <button onClick={()=>setE(p=>({...p,pagoEstado:"cuenta_corriente"}))} style={{...S.btn(true,"#7c3aed"),padding:"0.35rem 0.9rem",fontSize:"0.72rem",whiteSpace:"nowrap"}}>Autorizar — Cta. Corriente</button>
        </div>
      )}
      {esTN && e.pagoEstado === "cuenta_corriente" && (
        <div style={{background:"#130d2a",border:"1px solid #a78bfa",borderRadius:"10px",padding:"0.5rem 1rem",marginBottom:"0.75rem",display:"flex",alignItems:"center",gap:"0.5rem"}}>
          <span style={{color:"#a78bfa",fontWeight:700,fontSize:"0.82rem"}}>✓ Autorizado como Cuenta Corriente</span>
        </div>
      )}

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
          <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{Object.entries(ESTADO_C).map(([k,v])=><button key={k} onClick={()=>set("estado",k)} style={S.chip(e.estado===k,v.t,v.bg)}>{v.label}</button>)}</div>
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
          <div style={{display:"flex",gap:"3px",alignItems:"center"}}>
            <button onClick={()=>set("cobranza",e.cobranza!==null?null:0)} style={S.btnSm(e.cobranza!==null,"#f59e0b")}>{e.cobranza!==null?"Activa":"Agregar"}</button>
            {e.cobranza!==null&&<input type="number" placeholder="Monto" value={e.cobranza||""} onChange={ev=>set("cobranza",parseFloat(ev.target.value)||0)} style={{...S.input,width:"120px",padding:"3px 8px",fontSize:"0.8rem"}}/>}
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

      {/* Notas de la orden — editable (incluye datepicker) */}
      <div style={{marginBottom:"0.5rem"}}>
        <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>{esTN?"Notas de la orden":"Observaciones"}</div>
        <textarea value={esTN?(e.notasOrden||""):(e.observaciones||"")} onChange={ev=>set(esTN?"notasOrden":"observaciones",ev.target.value)} placeholder={esTN?"Notas de la orden...":"Notas adicionales..."} style={{...S.input,display:"block",width:"100%",height:"52px",resize:"vertical",fontSize:"0.8rem"}}/>
      </div>

      {/* Estado de liquidacion */}
      {e.trans&&<div style={{marginBottom:"0.65rem"}}>
        <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"6px"}}>Estado de liquidacion</div>
        <div style={{display:"flex",gap:"4px",flexWrap:"wrap"}}>
          {[{k:"normal",l:"Normal",c:"#10b981"},{k:"cancelado_liq",l:"Cancelado",c:"#f87171"},{k:"no_abonado",l:"No abonado por demora",c:"#f59e0b"}].map(x =>(
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
        <button onClick={()=>imprimirEtiquetas(e,lc)} style={{...S.btnSm(false),color:"#6366f1",border:"1px solid #6366f1",padding:"3px 12px",fontSize:"0.72rem"}}>🖨 Imprimir etiquetas</button>
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
      <div style={{display:"flex",gap:"0.5rem",justifyContent:"flex-end"}}>
        <button onClick={onClose} style={S.btn(false)}>Cancelar</button>
        <button onClick={()=>onSave(e)} style={{...S.btn(true),background:"linear-gradient(135deg,#6366f1,#8b5cf6)"}}>Guardar</button>
      </div>
    </div>
  );
}

function TabEnvios({envios,setEnvios,zc,lc,onReasignar,esAdmin=false}){
  const hoy=fechaHoy();
  const [modFecha,setModFecha]=useState("hoy");
  const [rangoD,setRangoD]=useState(hoy);
  const [rangoH,setRangoH]=useState(hoy);
  const [filTrans,setFilTrans]=useState("TODOS");
  const [filEstado,setFilEstado]=useState("no_cancelado");
  const [filZona,setFilZona]=useState("TODAS");
  const [filTurno,setFilTurno]=useState("TODOS");
  const [filOrigen,setFilOrigen]=useState("TODOS");
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
    if(busqueda){const srch=busqueda.toLowerCase();return e.direccion.toLowerCase().includes(srch)||e.id.includes(srch)||e.partido.toLowerCase().includes(srch)||(e.nroSeguimiento||"").includes(srch)||(e.clienteNombre||"").toLowerCase().includes(srch)||(e.nroOrdenTN||"").includes(srch);}
    return true;
  });
  const activos=filtrados.filter(e=>getEstado(e)!=="cancelado");
  const totalImp=activos.reduce((s,e)=>s+getImp(e),0);
  const sinAsig=filtrados.filter(e=>getEstado(e)==="sin_asignar").length;
  const porTrans=logActivas.map(l =>({l,n:activos.filter(e=>e.trans===l).length,v:activos.filter(e=>e.trans===l).reduce((s,e)=>s+getImp(e),0)})).filter(x =>x.n>0);
  const toggleSel=id=>setSeleccionados(p=>{const n=new Set(p);n.has(id)?n.delete(id):n.add(id);return n;});
  const saveEnvio=updated=>{setEnvios(p=>p.map(e=>e.id===updated.id?{...updated,estado:getEstado(updated)}:e));setEditId(null);};
  const eliminar=async id=>{if(window.confirm("Eliminar este envio?")){await deleteDoc(doc(db,"envios",id));setEnvios(p=>p.filter(e=>e.id!==id));}};
  const eliminarSel=async()=>{if(!window.confirm(`Eliminar ${seleccionados.size} envio(s)?`))return;await Promise.all([...seleccionados].map(id=>deleteDoc(doc(db,"envios",id))));setEnvios(p=>p.filter(e=>!seleccionados.has(e.id)));setSeleccionados(new Set());setModoSel(false);};
  const reasignarSel=()=>{const items=envios.filter(e=>seleccionados.has(e.id));onReasignar(items);setSeleccionados(new Set());setModoSel(false);};
  const cancelarSel=async()=>{if(!window.confirm(`Cancelar ${seleccionados.size} envio(s)?`))return;await Promise.all([...seleccionados].map(id=>setDoc(doc(db,"envios",id),{estado:"cancelado"},{merge:true})));setEnvios(p=>p.map(e=>seleccionados.has(e.id)?{...e,estado:"cancelado"}:e));setSeleccionados(new Set());setModoSel(false);};
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
      <div style={{...S.card,padding:"0.6rem 1rem",marginBottom:"0.7rem",display:"flex",flexDirection:"column",gap:"6px"}}>
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
          <input value={busqueda} onChange={e=>setBusqueda(e.target.value)} placeholder="🔍 Buscar..." style={{...S.input,width:"190px",marginLeft:"auto"}}/>
          <button onClick={()=>{
            const tmap2=buildTarifaMap(zc);
            const filas=filtradosOrdenados.map((e,i)=>({
              "#":i+1,Origen:e.origen,Estado:getEstado(e),
              NroOrdenTN:e.nroOrdenTN||"",Cliente:e.clienteNombre||"",
              Direccion:e.direccion,Localidad:e.localidad||"",Partido:e.partido,CP:e.cp||"",
              Logistica:e.trans||"",Zona:getZonaML(e.partido)||"",Turno:e.turno||"",
              Fecha:e.fecha||"",FechaVenta:e.fechaVenta||"",Bultos:e.bultos||1,
              Importe:calcImp(e,tmap2,lc,zc),Cobranza:e.cobranza||"",
              Cambio:e.cambio||"",Retiro:e.retiro||"",Nota:e.nota||"",
              EstadoLiq:e.estadoLiq||"normal",NotaLiq:e.notaLiq||"",
            }));
            exportarXLSX(filas,"envios_"+fechaHoy());
          }} style={{...S.btnSm(false),color:"#10b981",border:"1px solid #10b981",padding:"4px 10px",fontSize:"0.72rem"}}>⬇ Excel</button>
        </div>
        {/* Fila 4: Acciones */}
        <div style={{display:"flex",gap:"6px",alignItems:"center",flexWrap:"wrap",borderTop:"1px solid #252d40",paddingTop:"5px"}}>
          <span style={{color:"#4b5563",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",minWidth:"38px"}}>Accion</span>
          <button onClick={()=>{setModoSel(!modoSel);if(modoSel)setSeleccionados(new Set());}} style={S.btnSm(modoSel,"#6366f1")}>{modoSel?"Cancelar seleccion":"Seleccionar"}</button>
          {modoSel&&<button onClick={()=>setSeleccionados(new Set(filtradosOrdenados.map(e=>e.id)))} style={S.btnSm(false)}>Todos ({filtrados.length})</button>}
          {modoSel&&seleccionados.size>0&&<button onClick={()=>setSeleccionados(new Set())} style={S.btnSm(false)}>Ninguno</button>}
        </div>
      </div>
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
          const imp=getImp(e);
          const estKey=getEstado(e);
          const estC=ESTADO_C[estKey]||ESTADO_C.sin_asignar;
          const esTN=e.origen==="Tienda Nube";
          return(
            <div key={e.id} style={{width:"100%",minWidth:0,overflow:"hidden"}}>
              <div style={{...S.card,padding:"0.55rem 0.75rem",display:"flex",alignItems:"flex-start",gap:"0.5rem",opacity:getEstado(e)==="cancelado"?0.45:1,borderColor:isEdit||isSel?"#6366f1":e.alertaDireccion?"#f59e0b":"#252d40",background:isSel?"#12172a":"#1a1f2e",minWidth:0,overflow:"hidden"}}>
                {modoSel?<div style={{paddingTop:"2px"}}><Chk checked={isSel} onChange={()=>toggleSel(e.id)}/></div>:<span style={{color:"#374151",fontSize:"0.65rem",minWidth:"20px",textAlign:"right",paddingTop:"3px"}}>{i+1}</span>}
                <div style={{flex:1,cursor:"pointer",minWidth:0}} onClick={()=>{if(modoSel)toggleSel(e.id);else setEditId(isEdit?null:e.id);}}>
                  <div style={{display:"flex",gap:"3px",flexWrap:"wrap",alignItems:"center",marginBottom:"3px"}}>
                    {origenBadge(e)}
                    <Bdg label={estC.label} bg={estC.bg} t={estC.t}/>
                    {e.trans&&<Bdg label={e.trans} bg={lc[e.trans]?.bg||"#1a1f2e"} t={lc[e.trans]?.color||"#6b7280"}/>}
                    {zml&&<Bdg label={zml} bg={ZONA_ML_BG[zml]||"#1a1f2e"} t={ZONA_ML_COLOR[zml]||"#6b7280"}/>}
                    {zi&&<Bdg label={zi.nombre} bg={zi.color+"22"} t={zi.color}/>}
                    {e.turno&&<Bdg label={e.turno} bg={TURNO_C[e.turno]?.bg||"#130d2a"} t={TURNO_C[e.turno]?.c||"#a78bfa"}/>}
                    {e.fecha&&<Bdg label={fmtCorta(e.fecha)} bg="#12172a" t="#6b7280"/>}
                    {(e.bultos||1)>1&&<Bdg label={e.bultos+" bultos"} bg="#0c1a2e" t="#60a5fa"/>}
                    {e.cobranza!==null&&<Bdg label={"$"+Number(e.cobranza).toLocaleString("es-AR")} bg="#1c1500" t="#fbbf24"/>}
                    {e.cambio!==null&&<Bdg label="Cambio" bg="#1c0514" t="#ec4899"/>}
                    {e.retiro!==null&&<Bdg label="Retiro" bg="#1c1000" t="#f97316"/>}
                    {e.alertaDireccion&&<Bdg label="Sin CP/Dir" bg="#1c0a00" t="#fb923c"/>}
                    {e.estadoLiq==="cancelado_liq"&&<Bdg label="Canc. liquidacion" bg="#1c0a0a" t="#f87171" style={{border:"1px solid #f87171"}}/>}
                    {e.estadoLiq==="no_abonado"&&<Bdg label="No abonado" bg="#1c1400" t="#f59e0b" style={{border:"1px solid #f59e0b"}}/>}
                    {getPagoEstado(e)==="pendiente"&&<Bdg label="Pago pendiente" bg="#1c0a00" t="#fb923c" style={{border:"1px solid #fb923c"}}/>}
                    {getPagoEstado(e)==="cuenta_corriente"&&<Bdg label="Cta. Corriente" bg="#130d2a" t="#a78bfa"/>}
                  </div>
                  {/* Nro orden + Nombre en la misma linea, luego direccion */}
                  {esTN&&<div style={{display:"flex",gap:"8px",alignItems:"baseline",marginBottom:"1px",overflow:"hidden"}}>
                    <span style={{color:"#7dd3fc",fontWeight:700,fontSize:"0.82rem",flexShrink:0}}>#{e.nroOrdenTN}</span>
                    {e.clienteNombre&&<span style={{color:"#e5e7eb",fontWeight:600,fontSize:"0.82rem",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.clienteNombre}</span>}
                  </div>}
                  <div style={{color:esTN&&e.clienteNombre?"#9ca3af":"#e5e7eb",fontSize:"0.8rem",lineHeight:1.35,textDecoration:getEstado(e)==="cancelado"?"line-through":"none",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",width:"100%",display:"block"}}>{e.direccion}{e.referencia&&!e.direccion.toLowerCase().includes(e.referencia.toLowerCase().slice(0,20))?" — "+e.referencia:""}</div>
                  <div style={{color:"#9ca3af",fontSize:"0.74rem",marginTop:"2px",display:"flex",gap:"6px",flexWrap:"wrap",alignItems:"center"}}>
                    {!esTN&&<span style={{fontFamily:"monospace",color:"#9ca3af"}}>...{e.id.slice(-10)}</span>}
                    {e.nroSeguimiento&&<span style={{background:"#0f1420",padding:"0 5px",borderRadius:"4px",border:"1px solid #252d40",color:"#9ca3af"}}>📦 {e.nroSeguimiento}</span>}
                    {e.tipoEntrega&&<span style={{background:e.tipoEntrega==="COMERCIAL"?"#0c1a40":"#0a1a0a",color:e.tipoEntrega==="COMERCIAL"?"#38bdf8":"#86efac",border:"1px solid "+(e.tipoEntrega==="COMERCIAL"?"#1e4060":"#1a3a1a"),borderRadius:"4px",padding:"0 5px",fontSize:"0.68rem",fontWeight:700}}>{e.tipoEntrega}</span>}
                    {e.destinatario&&<span style={{color:"#cbd5e1",fontWeight:500,fontSize:"0.74rem"}}>· {e.destinatario}</span>}
                    <span style={{color:"#9ca3af"}}>· {e.localidad?e.localidad+" · ":""}{e.partido}{e.cp?" · "+e.cp:""}</span>
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
                  {imp>0&&<span style={{color:"#10b981",fontWeight:700,fontSize:"0.82rem"}}>{fmt(imp)}</span>}
                  {esTN&&e.importeOrden>0&&<span style={{color:"#6b7280",fontSize:"0.7rem"}}>{fmt(e.importeOrden)}</span>}
                </div>
              </div>
              {isEdit&&!modoSel&&<PanelEdit envio={e} onSave={saveEnvio} onClose={()=>setEditId(null)} lc={lc}/>}
            </div>
          );
        })}
      </div>

      {modoSel&&seleccionados.size>0&&(
        <div style={{position:"fixed",bottom:"20px",left:"50%",transform:"translateX(-50%)",background:"#1a1f2e",border:"1px solid #6366f1",borderRadius:"12px",padding:"0.7rem 1.25rem",display:"flex",gap:"0.6rem",alignItems:"center",zIndex:50,boxShadow:"0 4px 20px rgba(0,0,0,0.5)",flexWrap:"wrap",maxWidth:"95vw"}}>
          <span style={{color:"#e5e7eb",fontWeight:700,fontSize:"0.9rem"}}>{seleccionados.size} selec.</span>
          <button onClick={reasignarSel} style={{...S.btn(true),background:"linear-gradient(135deg,#6366f1,#8b5cf6)",padding:"0.4rem 0.9rem",fontSize:"0.75rem"}}>Reasignar</button>
          <button onClick={()=>{const f=window.prompt("Nueva fecha (YYYY-MM-DD):");if(!f)return;setEnvios(p=>p.map(e=>seleccionados.has(e.id)?{...e,fecha:f}:e));setSeleccionados(new Set());setModoSel(false);}} style={{...S.btn(false),padding:"0.4rem 0.9rem",fontSize:"0.75rem"}}>Cambiar fecha</button>
          <button onClick={()=>{const t=window.prompt("Turno (AM/MD/PM/Turbo):");if(!t)return;setEnvios(p=>p.map(e=>seleccionados.has(e.id)?{...e,turno:t}:e));setSeleccionados(new Set());setModoSel(false);}} style={{...S.btn(false),padding:"0.4rem 0.9rem",fontSize:"0.75rem"}}>Cambiar turno</button>
          <button onClick={cancelarSel} style={{...S.btn(true),background:"#7f1d1d",padding:"0.4rem 0.9rem",fontSize:"0.75rem"}}>Cancelar</button>
          {esAdmin&&<button onClick={eliminarSel} style={{...S.btn(true),background:"#450a0a",padding:"0.4rem 0.9rem",fontSize:"0.75rem",color:"#fca5a5"}}>Eliminar</button>}
          <button onClick={()=>{setModoSel(false);setSeleccionados(new Set());}} style={{...S.btn(false),padding:"0.4rem 0.9rem",fontSize:"0.75rem"}}>Salir</button>
        </div>
      )}
    </div>
  );
}

function TabImprimir({envios,zc,lc}){
  const hoy=fechaHoy();
  const [fecha,setFecha]=useState(hoy);
  const [trans,setTrans]=useState("TODOS");
  const [turno,setTurno]=useState("TODOS");
  const [filZona,setFilZona]=useState("TODAS");
  const [filOrigen,setFilOrigen]=useState("TODOS"); // TODOS | FLEX | NO_FLEX
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

  const [pdfOrient,setPdfOrient]=useState("landscape");
  const [pdfFontSize,setPdfFontSize]=useState(11);
  const [pdfVersion,setPdfVersion]=useState("completa"); // "completa" | "simple"
  const generarPDF=()=>{
    const ahora=new Date();
    const ts=ahora.toLocaleDateString("es-AR",{weekday:"long",day:"numeric",month:"long",year:"numeric"})+" "+ahora.toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"});
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
      const loteCell=e.loteImportacion?new Date(e.loteImportacion).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"}):"—";
      const tipoCell=e.tipoEntrega?`<span style="background:${e.tipoEntrega==="COMERCIAL"?"#dbeafe":"#dcfce7"};color:${e.tipoEntrega==="COMERCIAL"?"#1d4ed8":"#15803d"};border-radius:3px;padding:0 4px;font-size:${fs-2}px;font-weight:700;">${e.tipoEntrega==="COMERCIAL"?"COM":"RES"}</span>`:"—";
      const origenBadge=esFlex?`<span style="background:#1a3008;color:#84cc16;border-radius:3px;padding:0 4px;font-size:${fs-3}px;font-weight:700;">FLEX</span>`:`<span style="background:#0c1a40;color:#38bdf8;border-radius:3px;padding:0 4px;font-size:${fs-3}px;font-weight:700;">TN</span>`;

      if(esSimple){
        return`<tr style="background:${i%2===0?"#fff":"#f9f9f9"};border-bottom:0.5px solid #e5e7eb;">
          <td style="padding:3px 4px;text-align:center;color:#888;width:20px;">${i+1}</td>
          <td style="padding:3px 4px;width:50px;color:#16a34a;font-weight:700;font-size:${fs-1}px;">${loteCell}</td>
          <td style="padding:3px 4px;font-family:monospace;font-size:${fs-1}px;color:#444;width:100px;">${nroRef}</td>
          <td style="padding:3px 4px;text-align:center;width:35px;">${tipoCell}</td>
          <td style="padding:3px 4px;text-align:center;width:25px;font-weight:${(e.bultos||1)>1?700:400};">${e.bultos||1}</td>
          <td style="padding:3px 4px;text-align:center;width:18px;"><div style="width:11px;height:11px;border:1px solid #aaa;border-radius:1px;display:inline-block;"></div></td>
          <td style="padding:3px 4px;font-weight:600;">${dirCorta}</td>
          <td style="padding:3px 4px;color:#555;">${(e.localidad&&!/referencia/i.test(e.localidad))?e.localidad:""}</td>
          <td style="padding:3px 4px;color:#555;">${e.partido||""}</td>
          <td style="padding:3px 4px;width:50px;">${zml}</td>
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
          ${td("","font-weight:500;",dir+refExtra)}
          ${td(45,"",zml)}
          ${td(32,"text-align:center;",e.turno||"—")}
          ${td(42,"text-align:center;",e.fecha?fmtCorta(e.fecha):"—")}
          ${hayCobro?td(72,"text-align:right;font-weight:"+(e.cobranza?600:400)+";color:"+(e.cobranza?"#b45309":"#aaa")+";",cobrar):""}
        </tr>`;
      }
    }).join("");

    const thPDF="background:#e8e8e8;padding:3px 4px;text-align:left;font-size:"+(fs-2)+"px;font-weight:700;text-transform:uppercase;color:#555;border-bottom:1.5px solid #333;";
    const headerRow=esSimple
      ?`<tr><th style="${thPDF}width:20px;">#</th><th style="${thPDF}width:50px;">Lote</th><th style="${thPDF}width:100px;">Nro envio</th><th style="${thPDF}width:35px;text-align:center;">Tipo</th><th style="${thPDF}width:25px;text-align:center;">Blts</th><th style="${thPDF}width:18px;text-align:center;">Chk</th><th style="${thPDF}">Direccion</th><th style="${thPDF}">Ciudad</th><th style="${thPDF}">Partido</th><th style="${thPDF}width:50px;">Zona</th><th style="${thPDF}width:30px;text-align:center;">Turno</th><th style="${thPDF}width:40px;text-align:center;">Fecha</th>${hayCobro?`<th style="${thPDF}width:70px;text-align:right;">Cobrar</th>`:""}</tr>`
      :`<tr><th style="${thPDF}width:20px;">#</th><th style="${thPDF}width:55px;text-align:center;">Lote</th><th style="${thPDF}width:100px;">Nro envio / orden</th><th style="${thPDF}width:38px;text-align:center;">Tipo</th><th style="${thPDF}width:28px;text-align:center;">Blts</th><th style="${thPDF}width:18px;text-align:center;">Chk</th><th style="${thPDF}">Direccion · Localidad · Partido · CP · Referencia</th><th style="${thPDF}width:45px;">Zona</th><th style="${thPDF}width:32px;text-align:center;">Turno</th><th style="${thPDF}width:42px;text-align:center;">Fecha</th>${hayCobro?`<th style="${thPDF}width:72px;text-align:right;">Cobrar</th>`:""}</tr>`;

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
      <span style="font-weight:700;font-size:${fs+2}px;">${trans!=="TODOS"?trans:origenLabel} · ${ts}</span>
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
        <div style={{marginLeft:"auto",display:"flex",gap:"6px"}}>
          <button onClick={()=>{
            const filas=lista.map((e,i)=>{
              const esFlex=e.origen==="ML";
              const lote=esFlex&&e.loteImportacion?new Date(e.loteImportacion).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"}):"";
              return{"#":i+1,
                Lote:lote,
                Tipo:e.tipoEntrega==="COMERCIAL"?"COM":e.tipoEntrega==="RESIDENCIAL"?"RES":"",
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
        </div>
      </div>
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
                    ?<span style={{background:"#0d1c04",color:"#84cc16",padding:"1px 5px",borderRadius:"4px",fontSize:"0.68rem",fontWeight:700,whiteSpace:"nowrap"}}>{new Date(e.loteImportacion).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"})}</span>
                    :<span style={{color:"#374151"}}>—</span>}
                </td>
                <td style={{...tdSt,textAlign:"center"}}>
                  {e.tipoEntrega
                    ?<span style={{padding:"1px 6px",borderRadius:"3px",fontSize:"0.65rem",fontWeight:700,background:e.tipoEntrega==="COMERCIAL"?"#0c1a40":"#0a1a0a",color:e.tipoEntrega==="COMERCIAL"?"#38bdf8":"#86efac"}}>{e.tipoEntrega==="COMERCIAL"?"COM":"RES"}</span>
                    :<span style={{color:"#374151"}}>—</span>}
                </td>
                <td style={{...tdSt,whiteSpace:"normal",lineHeight:1.3}}>
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

function TabManual({setEnvios,onSuccess,lc,enviosExistentes}){
  const hoy=fechaHoy();
  const vacio={id:"",nroSeguimiento:"",linkML:"",direccion:"",ciudad:"",cp:"",origen:"Manual",trans:"",fecha:hoy,turno:"",estado:"sin_asignar",cobranza:null,cambio:null,retiro:null,observaciones:"",bultos:null,partido:"",importe:0,fechaVenta:hoy,clienteNombre:"",telefono:"",esCC:false,importeCC:0};
  const [f,setF]=useState(vacio);
  const [err,setErr]=useState("");
  const [dupWarn,setDupWarn]=useState("");
  const [sugsVisible,setSugsVisible]=useState(false);
  const set=(k,v)=>setF(p=>({...p,[k]:v}));

  // Lista de clientes únicos ya registrados (para autocomplete)
  const clientesExistentes=useMemo(()=>{
    const nombres=new Set();
    (enviosExistentes||[]).forEach(e=>{if(e.clienteNombre?.trim())nombres.add(e.clienteNombre.trim());});
    return[...nombres].sort((a,b)=>a.localeCompare(b));
  },[enviosExistentes]);
  const sugerencias=sugsVisible&&f.clienteNombre.length>=2
    ?clientesExistentes.filter(n=>n.toLowerCase().includes(f.clienteNombre.toLowerCase())&&n.toLowerCase()!==f.clienteNombre.toLowerCase()).slice(0,8)
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
    setEnvios(p=>[{...f,id:f.id.trim(),partido:f.partido||(cpAPartido(f.cp)||f.ciudad)},...p]);
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
          <div style={{position:"relative"}}><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Nombre cliente</label><input value={f.clienteNombre} onChange={e=>{set("clienteNombre",e.target.value);setSugsVisible(true);}} onFocus={()=>setSugsVisible(true)} onBlur={()=>setTimeout(()=>setSugsVisible(false),150)} style={{...S.input,width:"100%"}} placeholder="Nombre completo o buscar existente"/>{sugerencias.length>0&&(<div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:200,background:"#1a1f2e",border:"1px solid #6366f1",borderRadius:"6px",marginTop:"2px",boxShadow:"0 6px 16px rgba(0,0,0,0.5)",overflow:"hidden"}}>{sugerencias.map(n=>(<div key={n} onMouseDown={()=>{set("clienteNombre",n);setSugsVisible(false);}} style={{padding:"0.5rem 0.75rem",cursor:"pointer",color:"#e5e7eb",fontSize:"0.85rem",borderBottom:"1px solid #252d40",transition:"background 0.1s"}} onMouseEnter={e=>e.currentTarget.style.background="#252d40"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>{n}</div>))}</div>)}</div>
          <div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Teléfono</label><input value={f.telefono} onChange={e=>set("telefono",e.target.value)} style={{...S.input,width:"100%"}} placeholder="ej. 1165432100"/></div>
          <div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Origen</label><div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{["ML","Tienda Nube","Particular","Otro"].map(o =><button key={o} onClick={()=>set("origen",o)} style={S.btnSm(f.origen===o,"#6366f1")}>{o}</button>)}</div></div>
          <div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Bultos</label><input type="number" min="1" value={f.bultos||""} onChange={ev=>{const v=parseInt(ev.target.value);set("bultos",v>0?v:"");}} placeholder="1" style={{...S.input,width:"120px",padding:"4px 10px"}}/></div>
        </div>
        <div style={{marginBottom:"0.7rem"}}><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Direccion completa</label><textarea value={f.direccion} onChange={e=>set("direccion",e.target.value)} style={{...S.input,width:"100%",height:"56px",resize:"vertical"}} placeholder="Calle, numero..."/></div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"0.7rem",marginBottom:"0.7rem"}}>
          <div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>CP</label><input value={f.cp} onChange={e=>set("cp",e.target.value)} style={{...S.input,width:"100%"}} placeholder="1642"/></div>
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
        <div style={{...S.card,padding:"0.65rem 1rem",marginBottom:"0.55rem",background:"#0f1420"}}><button onClick={()=>set("cambio",f.cambio!==null?null:"")} style={S.btnSm(f.cambio!==null,"#ec4899")}>Cambio</button>{f.cambio!==null?<textarea value={f.cambio||""} onChange={e=>set("cambio",e.target.value)} placeholder="Que retirar para el cambio..." style={{...S.input,display:"block",width:"100%",marginTop:"6px",height:"44px",resize:"vertical"}}/>:<span style={{color:"#374151",fontSize:"0.78rem",marginLeft:"8px"}}>Sin cambio</span>}</div>
        <div style={{...S.card,padding:"0.65rem 1rem",marginBottom:"0.9rem",background:"#0f1420"}}><button onClick={()=>set("retiro",f.retiro!==null?null:"")} style={S.btnSm(f.retiro!==null,"#f97316")}>Retiro</button>{f.retiro!==null?<textarea value={f.retiro||""} onChange={e=>set("retiro",e.target.value)} placeholder="Que tiene que retirar..." style={{...S.input,display:"block",width:"100%",marginTop:"6px",height:"44px",resize:"vertical"}}/>:<span style={{color:"#374151",fontSize:"0.78rem",marginLeft:"8px"}}>Sin retiro</span>}</div>
        <div style={{...S.card,padding:"0.65rem 1rem",marginBottom:"0.9rem",background:f.esCC?"#130d2a":"#0f1420",border:f.esCC?"1px solid #a78bfa":"1px solid #1e2535"}}><div style={{display:"flex",alignItems:"center",gap:"0.75rem"}}><button onClick={()=>set("esCC",!f.esCC)} style={S.btnSm(f.esCC,"#a78bfa")}>Cta. Corriente</button>{f.esCC?<><span style={{color:"#6b7280",fontSize:"0.78rem"}}>Importe:</span><input type="number" placeholder="Monto" value={f.importeCC||""} onChange={e=>set("importeCC",parseFloat(e.target.value)||0)} style={{...S.input,width:"150px",padding:"4px 10px"}}/><span style={{color:"#a78bfa",fontSize:"0.72rem"}}>El cliente te debe este monto</span></>:<span style={{color:"#374151",fontSize:"0.78rem"}}>Marcar como Cuenta Corriente</span>}</div></div>
        <div style={{display:"flex",justifyContent:"flex-end",gap:"0.5rem"}}><button onClick={()=>{setF(vacio);setErr("");setDupWarn("");}} style={S.btn(false)}>Limpiar</button><button onClick={guardar} style={{...S.btn(true),background:"linear-gradient(135deg,#6366f1,#8b5cf6)",padding:"0.5rem 1.2rem"}}>Agregar envio</button></div>
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
              <div style={{padding:"0.75rem 1rem",display:"flex",alignItems:"center",justifyContent:"space-between"}}><span style={{color:v.activa?v.color:"#6b7280",fontWeight:800,fontSize:"1rem"}}>{v.nombre}</span><button onClick={()=>toggleLog(k)} style={{...S.btnSm(v.activa,v.color),padding:"4px 12px"}}>{v.activa?"Activa":"Desactivar"}</button></div>
              <div style={{padding:"0 1rem 0.75rem",display:"flex",flexDirection:"column",gap:"6px"}}>
                <div style={{color:"#4b5563",fontSize:"0.75rem"}}>{v.activa?"Visible en la app":"No aparece en asignacion ni filtros"}</div>
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
  // Calcular lunes y domingo de la semana actual
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
  const toggleTipo=t=>setFilTipos(prev=>{const n=new Set(prev);n.has(t)?n.delete(t):n.add(t);return n;});
  const logActivas=Object.entries(lc).filter(([,v])=>v.activa).map(([k])=>k);
  const tmap=buildTarifaMap(zc);
  const getImp=e=>calcImp(e,tmap,lc,zc);
  const getTipo=e=>e.origen==="ML"?"FLEX":e.origen==="Tienda Nube"?"TN":"Manual";
  const envSem=envios.filter(e=>{
    const ds=e.fecha||e.fechaVenta||"";
    if(e.estado==="cancelado")return false;
    if(logSel!=="TODAS"&&e.trans!==logSel)return false;
    if(filTipos.size>0&&!filTipos.has(getTipo(e)))return false;
    return ds>=desde&&ds<=hasta;
  });
  const logsMost=logSel==="TODAS"?logActivas:[logSel];
  if(!envios.length)return<div style={{textAlign:"center",padding:"3rem",color:"#4b5563"}}><div style={{fontSize:"2rem"}}>📊</div><p>Sin envios para mostrar</p></div>;
  return(
    <div>
      <div style={{...S.card,padding:"0.65rem 1rem",marginBottom:"0.8rem",display:"flex",gap:"8px",alignItems:"center",flexWrap:"wrap"}}>
        <span style={{color:"#4b5563",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase"}}>Desde</span>
        <input type="date" value={desde} onChange={ev=>setDesde(ev.target.value)} style={{...S.input,padding:"4px 8px",width:"140px"}}/>
        <span style={{color:"#4b5563",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase"}}>Hasta</span>
        <input type="date" value={hasta} onChange={ev=>setHasta(ev.target.value)} style={{...S.input,padding:"4px 8px",width:"140px"}}/>
        <button onClick={()=>{const s=initSem();setDesde(s.d);setHasta(s.h);}} style={S.btnSm(false)}>Esta semana</button>
      </div>
      <div style={{...S.card,padding:"0.55rem 1rem",marginBottom:"0.8rem",display:"flex",gap:"0.35rem",flexWrap:"wrap",alignItems:"center"}}>
        <span style={{color:"#4b5563",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",marginRight:"4px"}}>Tipo</span>
        {[{k:"FLEX",c:"#84cc16"},{k:"TN",c:"#38bdf8"},{k:"Manual",c:"#a78bfa"}].map(({k,c})=>(
          <button key={k} onClick={()=>toggleTipo(k)} style={{...S.btnSm(filTipos.has(k),c),opacity:filTipos.size>0&&!filTipos.has(k)?0.45:1}}>{k}</button>
        ))}
        {filTipos.size>0&&<button onClick={()=>setFilTipos(new Set())} style={{...S.btnSm(false),fontSize:"0.65rem",padding:"2px 8px",color:"#6b7280"}}>✕ Limpiar</button>}
      </div>
      <div style={{...S.card,padding:"0.55rem 1rem",marginBottom:"0.8rem",display:"flex",gap:"0.35rem",flexWrap:"wrap",alignItems:"center"}}>
        <button onClick={()=>setLogSel("TODAS")} style={S.btn(logSel==="TODAS")}>TODAS</button>
        {logActivas.map(l =><button key={l} onClick={()=>setLogSel(l)} style={S.btn(logSel===l,lc[l]?.color||"#6366f1")}>{l}</button>)}
        <button onClick={()=>{
          const filas=envSem.map((e,i)=>({
            "#":i+1,Tipo:getTipo(e),Logistica:e.trans||"",Partido:e.partido,Direccion:e.direccion,
            Fecha:e.fecha||"",Turno:e.turno||"",Bultos:e.bultos||1,
            Zona:(()=>{const zi=getZonaLogistica(zc,e.trans,e.partido);return zi?zi.nombre:"";})(),
            Importe:getImp(e),EstadoLiq:e.estadoLiq||"normal",NotaLiq:e.notaLiq||"",
          }));
          exportarXLSX(filas,"informe_"+desde+"_"+hasta);
        }} style={{...S.btnSm(false),color:"#10b981",border:"1px solid #10b981",marginLeft:"auto",padding:"3px 12px",fontSize:"0.72rem"}}>⬇ Excel</button>
      </div>
      {logsMost.map(l =>{
        const lcD=lc[l];const envL=envSem.filter(e=>e.trans===l);if(!envL.length)return null;
        const envLNormal=envL.filter(e=>!e.estadoLiq||e.estadoLiq==="normal");
        const envLNoAbonado=envL.filter(e=>e.estadoLiq==="cancelado_liq"||e.estadoLiq==="no_abonado");
        const porZona={};
        envLNormal.forEach(e=>{const zi=getZonaLogistica(zc,l,e.partido);const k=zi?zi.nombre:"Sin zona";if(!porZona[k])porZona[k]={nombre:k,color:zi?.color||"#374151",envios:[]};porZona[k].envios.push(e);});
        // Agregar no abonados en seccion separada si existen
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
                <thead><tr style={{borderBottom:"1px solid #1e2535",background:"#0f1420"}}><th style={thSt}>Zona / Partido</th><th style={{...thSt,textAlign:"center"}}>Envios</th><th style={{...thSt,textAlign:"right"}}>Valor unitario</th><th style={{...thSt,textAlign:"right"}}>Total</th></tr></thead>
                <tbody>
                  {Object.values(porZona).map(zona=>{
                    const porValor={};
                    zona.envios.forEach(e=>{const imp=getImp(e);const vk=String(imp);if(!porValor[vk])porValor[vk]={valor:imp,count:0,total:0,partidos:new Set()};porValor[vk].count++;porValor[vk].total+=imp;porValor[vk].partidos.add(e.partido);});
                    const zonaTotal=zona.envios.reduce((s,e)=>s+getImp(e),0);
                    return([
                      <tr key={zona.nombre+"_h"} style={{background:"#12172a",borderTop:"1px solid #252d40"}}><td colSpan={4} style={{...tdSt,padding:"0.35rem 0.8rem"}}><span style={{display:"inline-block",padding:"1px 8px",borderRadius:"5px",background:zona.color+"22",color:zona.color,fontWeight:700,fontSize:"0.75rem"}}>{zona.nombre}</span><span style={{color:"#4b5563",fontSize:"0.7rem",marginLeft:"8px"}}>{zona.envios.length} envios · {fmt(zonaTotal)}</span></td></tr>,
                      ...Object.values(porValor).sort((a,b)=>b.valor-a.valor).map(({valor,count,total,partidos})=>(
                        <tr key={zona.nombre+valor} style={{borderBottom:"1px solid #1a1f2e"}}><td style={{...tdSt,color:"#6b7280",paddingLeft:"1.5rem",fontSize:"0.75rem",whiteSpace:"normal"}}>{[...partidos].join(", ")}</td><td style={{...tdSt,textAlign:"center",color:"#e5e7eb"}}>{count}</td><td style={{...tdSt,textAlign:"right",color:"#9ca3af"}}>{fmt(valor)}</td><td style={{...tdSt,textAlign:"right",color:"#10b981",fontWeight:600}}>{fmt(total)}</td></tr>
                      ))
                    ]);
                  })}
                </tbody>
                <tfoot><tr style={{borderTop:"2px solid #252d40",background:"#12172a"}}><td style={{...tdSt,color:lcD.color,fontWeight:800}}>TOTAL {l}</td><td style={{...tdSt,textAlign:"center",color:"#e5e7eb",fontWeight:700}}>{envL.length}</td><td style={tdSt}></td><td style={{...tdSt,textAlign:"right",color:"#10b981",fontWeight:800}}>{fmt(totalL)}</td></tr></tfoot>
              </table>
            </div>
          </div>
        );
      })}
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
// TAB LIQUIDACION — cobranzas y cambios/retiros pendientes
// ════════════════════════════════════════════════════════════════════
function TabLiquidacion({ envios, setEnvios, lc }) {
  const hoy=fechaHoy();
  const [seccion, setSeccion] = useState("cobranzas"); // cobranzas | retiros
  const [filTrans, setFilTrans] = useState("TODOS");
  const [filEstado, setFilEstado] = useState("pendiente"); // pendiente | recibido | todos
  const [filFecha, setFilFecha] = useState("todos"); // todos | hoy | ayer | rango
  const [rangoD, setRangoD] = useState(hoy);
  const [rangoH, setRangoH] = useState(hoy);
  const [notaModal, setNotaModal] = useState(null); // {id, tipo, nota}
  const [busqueda, setBusqueda] = useState("");
  const logActivas = Object.entries(lc).filter(([,v]) => v.activa).map(([k]) => k);

  // Envios con cobranza
  const conCobranza = envios.filter(e =>
    e.cobranza !== null && e.cobranza !== undefined && e.cobranza > 0 && getEstado(e) !== "cancelado"
  );
  // Envios con cambio o retiro
  const conRetiro = envios.filter(e =>
    (e.cambio !== null || e.retiro !== null) && getEstado(e) !== "cancelado"
  );

  const lista = [...(seccion === "cobranzas" ? conCobranza : conRetiro)].filter(e => {
    if (filTrans !== "TODOS" && e.trans !== filTrans) return false;
    const campo = seccion === "cobranzas" ? "cobranzaRecibida" : "retiroRecibido";
    const recibido = !!e[campo];
    if (filEstado === "pendiente" && recibido) return false;
    if (filEstado === "recibido" && !recibido) return false;
    const fEnv = e.fecha || e.fechaVenta || "";
    if (filFecha === "hoy" && fEnv !== hoy) return false;
    if (filFecha === "ayer" && fEnv !== fechaAyer()) return false;
    if (filFecha === "rango" && (fEnv < rangoD || fEnv > rangoH)) return false;
    if (busqueda) {
      const srch = busqueda.toLowerCase();
      return (e.direccion||"").toLowerCase().includes(srch) ||
             (e.nroOrdenTN||"").includes(srch) ||
             (e.id||"").includes(srch) ||
             (e.clienteNombre||"").toLowerCase().includes(srch);
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
    setEnvios(p => p.map(e => e.id === id ? { ...e, cobranzaRecibida: recibido, cobranzaFecha: recibido ? fechaHoy() : null } : e));
  };

  const marcarRetiro = (id, recibido) => {
    setEnvios(p => p.map(e => e.id === id ? { ...e, retiroRecibido: recibido, retiroFecha: recibido ? fechaHoy() : null } : e));
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
            return{"#":i+1,Logistica:e.trans||"",Direccion:e.direccion,Partido:e.partido,
              NroOrden:e.nroOrdenTN?"#"+e.nroOrdenTN:e.id.slice(-8),
              Fecha:e.fecha||"",Turno:e.turno||"",
              Monto:seccion==="cobranzas"?(e.cobranza||""):"",
              Detalle:seccion==="retiros"?((e.cambio||"")+(e.retiro||"")):"",
              Estado:recibido?"Recibido":"Pendiente",FechaRecibido:fechaR||"",
            };
          });
          exportarXLSX(filas,"liquidacion_"+seccion+"_"+fechaHoy());
        }} style={{...S.btnSm(false),color:"#10b981",border:"1px solid #10b981",padding:"3px 10px",fontSize:"0.72rem"}}>⬇ Excel</button>
        <button onClick={()=>{
          const ahora=new Date();
          const ts=ahora.toLocaleDateString("es-AR",{weekday:"long",day:"numeric",month:"long",year:"numeric"})+" "+ahora.toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"});
          const rows=lista.map((e,i)=>{
            const campo=seccion==="cobranzas"?"cobranzaRecibida":"retiroRecibido";
            const recibido=!!e[campo];
            const monto=seccion==="cobranzas"?("$"+Number(e.cobranza||0).toLocaleString("es-AR")):"-";
            const detalle=seccion==="retiros"?(e.cambio||e.retiro||"-"):"-";
            return`<tr style="background:${i%2===0?"#fff":"#f9f9f9"}"><td style="padding:3px 6px;border-bottom:0.5px solid #ddd;">${i+1}</td><td style="padding:3px 6px;border-bottom:0.5px solid #ddd;font-weight:500;">${e.direccion}</td><td style="padding:3px 6px;border-bottom:0.5px solid #ddd;font-family:monospace;font-size:9px;">${e.nroOrdenTN?"#"+e.nroOrdenTN:e.id.slice(-8)}</td><td style="padding:3px 6px;border-bottom:0.5px solid #ddd;">${e.trans||"-"}</td><td style="padding:3px 6px;border-bottom:0.5px solid #ddd;">${e.fecha?fmtCorta(e.fecha):"-"}</td><td style="padding:3px 6px;border-bottom:0.5px solid #ddd;font-weight:600;color:${seccion==="cobranzas"?"#b45309":"#555"};">${monto}</td><td style="padding:3px 6px;border-bottom:0.5px solid #ddd;color:${recibido?"#15803d":"#b45309"};font-weight:600;">${recibido?"Recibido":"Pendiente"}</td></tr>`;
          }).join("");
          const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Liquidacion</title><style>@page{size:A4;margin:10mm;}body{font-family:Arial,sans-serif;font-size:10px;color:#111;}table{width:100%;border-collapse:collapse;}th{background:#e8e8e8;padding:3px 6px;text-align:left;font-size:8px;text-transform:uppercase;font-weight:700;border-bottom:1.5px solid #333;}@media print{button{display:none!important;}}</style></head><body><div style="display:flex;justify-content:space-between;margin-bottom:4px;"><strong style="font-size:12px;">Liquidacion — ${seccion==="cobranzas"?"Cobranzas":"Cambios y Retiros"}</strong><span style="font-size:8px;color:#888;">Impreso: ${ts}</span></div><table><thead><tr><th style="width:20px;">#</th><th>Direccion</th><th style="width:80px;">Nro orden</th><th style="width:60px;">Logistica</th><th style="width:48px;">Fecha</th><th style="width:70px;">${seccion==="cobranzas"?"Monto":"-"}</th><th style="width:65px;">Estado</th></tr></thead><tbody>${rows}</tbody></table><div style="border-top:1.5px solid #333;margin-top:4px;padding-top:3px;font-size:8px;color:#555;">${lista.length} registros</div><script>window.onload=function(){window.print();}<\/script></body></html>`;
          const w=window.open("","_blank");if(!w){alert("Permite ventanas emergentes.");return;}w.document.write(html);w.document.close();
        }} style={{...S.btn(true),background:"#0f1420",border:"1px solid #252d40",marginLeft:"auto",padding:"0.3rem 0.8rem",fontSize:"0.72rem"}}>🖨️ Imprimir</button>
      </div>

      {/* Resumen cards */}
      {seccion === "cobranzas" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: "0.55rem", marginBottom: "0.8rem" }}>
          <div style={{ ...S.card, padding: "0.75rem 1rem" }}>
            <div style={{ color: "#f59e0b", fontWeight: 800, fontSize: "1.1rem" }}>{fmt(totalEsperado)}</div>
            <div style={{ color: "#6b7280", fontSize: "0.62rem", marginTop: "2px" }}>Total esperado</div>
          </div>
          <div style={{ ...S.card, padding: "0.75rem 1rem", borderLeft: "3px solid #10b981" }}>
            <div style={{ color: "#10b981", fontWeight: 800, fontSize: "1.1rem" }}>{fmt(totalRecibido)}</div>
            <div style={{ color: "#6b7280", fontSize: "0.62rem", marginTop: "2px" }}>Recibido</div>
          </div>
          <div style={{ ...S.card, padding: "0.75rem 1rem", borderLeft: "3px solid #f59e0b" }}>
            <div style={{ color: "#f59e0b", fontWeight: 800, fontSize: "1.1rem" }}>{fmt(totalPendiente)}</div>
            <div style={{ color: "#6b7280", fontSize: "0.62rem", marginTop: "2px" }}>Pendiente</div>
          </div>
          {porLogCob.map(({ l, pendienteImporte, pendienteN }) => (
            <div key={l} style={{ ...S.card, padding: "0.75rem 1rem", borderLeft: "3px solid " + lc[l].color }}>
              <div style={{ color: lc[l].color, fontWeight: 800, fontSize: "0.9rem" }}>{l}</div>
              <div style={{ color: "#f59e0b", fontWeight: 700, fontSize: "0.85rem" }}>{fmt(pendienteImporte)}</div>
              {pendienteN > 0 && <div style={{ color: "#6b7280", fontSize: "0.68rem", marginTop: "2px" }}>{pendienteN} pendiente{pendienteN !== 1 ? "s" : ""}</div>}
            </div>
          ))}
        </div>
      )}

      {seccion === "retiros" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: "0.55rem", marginBottom: "0.8rem" }}>
          <div style={{ ...S.card, padding: "0.75rem 1rem" }}>
            <div style={{ color: "#ec4899", fontWeight: 800, fontSize: "1.8rem" }}>{conRetiro.length}</div>
            <div style={{ color: "#6b7280", fontSize: "0.62rem", marginTop: "2px" }}>Total</div>
          </div>
          <div style={{ ...S.card, padding: "0.75rem 1rem", borderLeft: "3px solid #f59e0b" }}>
            <div style={{ color: "#f59e0b", fontWeight: 800, fontSize: "1.8rem" }}>{conRetiro.filter(e => !e.retiroRecibido).length}</div>
            <div style={{ color: "#6b7280", fontSize: "0.62rem", marginTop: "2px" }}>Pendientes</div>
          </div>
          <div style={{ ...S.card, padding: "0.75rem 1rem", borderLeft: "3px solid #10b981" }}>
            <div style={{ color: "#10b981", fontWeight: 800, fontSize: "1.8rem" }}>{conRetiro.filter(e => e.retiroRecibido).length}</div>
            <div style={{ color: "#6b7280", fontSize: "0.62rem", marginTop: "2px" }}>Recibidos</div>
          </div>
          {porLogRet.map(({ l, total, pendiente }) => (
            <div key={l} style={{ ...S.card, padding: "0.75rem 1rem", borderLeft: "3px solid " + lc[l].color }}>
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
            const recibido = seccion === "cobranzas" ? !!e.cobranzaRecibida : !!e.retiroRecibido;
            const fecha = seccion === "cobranzas" ? e.cobranzaFecha : e.retiroFecha;
            const nota = seccion === "cobranzas" ? e.cobranzaNota : e.retiroNota;
            const lci = lc[e.trans];
            return (
              <div key={e.id} style={{ ...S.card, padding: "0.6rem 1rem", display: "flex", alignItems: "flex-start", gap: "0.6rem", flexWrap: "wrap", opacity: recibido ? 0.6 : 1 }}>
                {/* Checkbox recibido */}
                <div style={{ paddingTop: "2px" }}>
                  <Chk checked={recibido} onChange={() => seccion === "cobranzas" ? marcarCobranza(e.id, !recibido) : marcarRetiro(e.id, !recibido)} size={18} />
                </div>
                <div style={{ flex: 1, minWidth: "160px" }}>
                  <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", marginBottom: "3px", alignItems: "center" }}>
                    {e.trans && <Bdg label={e.trans} bg={lci?.bg || "#1a1f2e"} t={lci?.color || "#6b7280"} />}
                    {e.turno && <Bdg label={e.turno} bg={TURNO_C[e.turno]?.bg || "#130d2a"} t={TURNO_C[e.turno]?.c || "#a78bfa"} />}
                    {e.fechaVenta && <Bdg label={"V:"+fmtCorta(e.fechaVenta)} bg="#0d1a12" t="#4ade80" />}
                    {e.fecha && <Bdg label={"E:"+fmtCorta(e.fecha)} bg="#12172a" t="#6b7280" />}
                    {recibido && <Bdg label={"Recibido" + (fecha ? " " + fmtCorta(fecha) : "")} bg="#041f14" t="#34d399" />}
                  </div>
                  <div style={{ color: "#e5e7eb", fontSize: "0.82rem", lineHeight: 1.35 }}>{e.direccion}</div>
                  <div style={{ color: "#374151", fontSize: "0.68rem", marginTop: "2px" }}>
                    <span style={{ fontFamily: "monospace" }}>...{e.id.slice(-10)}</span>
                    {e.nroOrdenTN&&<><span style={{margin:"0 4px"}}>·</span><span style={{fontFamily:"monospace"}}>#{e.nroOrdenTN}</span></>}
                    <span style={{ margin: "0 4px" }}>·</span>
                    <span>{e.partido}</span>
                  </div>
                  {seccion === "cobranzas" && e.cambio !== null && (
                    <div style={{ color: "#ec4899", fontSize: "0.72rem", marginTop: "2px" }}>Cambio: {e.cambio}</div>
                  )}
                  {seccion === "retiros" && (
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
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// TAB LOCALIDADES — ver, editar y agregar CP → Partido
// ════════════════════════════════════════════════════════════════════
const CP_P_INIT = {"1601":"La Plata","1607":"San Isidro","1608":"Tigre","1609":"San Isidro","1610":"Tigre","1611":"Tigre","1612":"Malvinas Argentinas","1613":"Malvinas Argentinas","1614":"Malvinas Argentinas","1615":"Malvinas Argentinas","1616":"Malvinas Argentinas","1617":"Tigre","1618":"Tigre","1619":"Escobar","1620":"Escobar","1621":"Tigre","1622":"Escobar","1623":"Escobar","1624":"Tigre","1625":"Escobar","1626":"Escobar","1627":"Escobar","1628":"Escobar","1629":"Pilar","1630":"Pilar","1631":"Pilar","1632":"Pilar","1633":"Pilar","1634":"Pilar","1635":"Pilar","1636":"Vicente Lopez","1637":"Vicente Lopez","1638":"Vicente Lopez","1640":"San Isidro","1641":"San Isidro","1642":"San Isidro","1643":"San Isidro","1644":"San Fernando","1645":"San Fernando","1646":"San Fernando","1647":"Zarate","1648":"Tigre","1649":"San Fernando","1650":"San Martin","1651":"San Martin","1653":"San Martin","1655":"San Martin","1657":"San Martin","1659":"San Miguel","1660":"Jose C Paz","1661":"San Miguel","1662":"San Miguel","1663":"San Miguel","1664":"Pilar","1665":"Jose C Paz","1666":"Jose C Paz","1667":"Pilar","1669":"Pilar","1670":"Tigre","1671":"Tigre","1672":"San Martin","1674":"Tres de Febrero","1675":"Tres de Febrero","1676":"Tres de Febrero","1678":"Tres de Febrero","1682":"Tres de Febrero","1683":"Tres de Febrero","1684":"Moron","1685":"Moron","1686":"Hurlingham","1687":"Tres de Febrero","1688":"Hurlingham","1689":"La Matanza Norte","1692":"Tres de Febrero","1702":"Tres de Febrero","1703":"Tres de Febrero","1704":"La Matanza Norte","1706":"Moron","1707":"Moron","1708":"Moron","1712":"Moron","1713":"Ituzaingo","1714":"Ituzaingo","1715":"Ituzaingo","1716":"Merlo","1718":"Merlo","1721":"Merlo","1722":"Merlo","1723":"Merlo","1724":"Merlo","1727":"Marcos Paz","1736":"Moreno","1738":"Moreno","1740":"Moreno","1742":"Moreno","1743":"Moreno","1744":"Moreno","1745":"Moreno","1746":"Moreno","1748":"Gral. Rodriguez","1749":"Gral. Rodriguez","1751":"La Matanza Norte","1752":"La Matanza Norte","1753":"La Matanza Norte","1754":"La Matanza Norte","1755":"La Matanza Norte","1757":"La Matanza Sur","1758":"La Matanza Sur","1759":"La Matanza Sur","1761":"La Matanza Norte","1763":"La Matanza Sur","1764":"La Matanza Sur","1765":"La Matanza Sur","1766":"La Matanza Norte","1768":"La Matanza Norte","1770":"La Matanza Norte","1771":"La Matanza Norte","1772":"La Matanza Norte","1774":"La Matanza Norte","1778":"La Matanza Norte","1785":"La Matanza Norte","1786":"La Matanza Sur","1801":"Ezeiza","1802":"Ezeiza","1803":"Ezeiza","1804":"Ezeiza","1805":"Esteban Echeverria","1806":"Ezeiza","1807":"Ezeiza","1808":"Canuelas","1812":"Canuelas","1813":"Ezeiza","1814":"Canuelas","1815":"Canuelas","1816":"Canuelas","1821":"Lomas de Zamora","1822":"Lanus","1823":"Lanus","1824":"Lanus","1825":"Lanus","1826":"Lanus","1827":"Lomas de Zamora","1828":"Lomas de Zamora","1829":"Lomas de Zamora","1831":"Lomas de Zamora","1832":"Lomas de Zamora","1833":"Lomas de Zamora","1834":"Lomas de Zamora","1835":"Lomas de Zamora","1836":"Lomas de Zamora","1837":"Berazategui","1838":"Esteban Echeverria","1839":"Esteban Echeverria","1840":"Quilmes","1841":"Esteban Echeverria","1842":"Esteban Echeverria","1843":"Almirante Brown","1844":"Almirante Brown","1845":"Almirante Brown","1846":"Almirante Brown","1847":"Almirante Brown","1848":"Almirante Brown","1849":"Almirante Brown","1851":"Almirante Brown","1852":"Almirante Brown","1853":"Florencio Varela","1854":"Almirante Brown","1855":"Almirante Brown","1856":"Almirante Brown","1858":"Presidente Peron","1859":"Florencio Varela","1860":"Berazategui","1861":"Berazategui","1862":"Presidente Peron","1863":"Florencio Varela","1864":"San Vicente","1865":"San Vicente","1867":"Florencio Varela","1868":"Avellaneda","1869":"Avellaneda","1870":"Avellaneda","1871":"Avellaneda","1872":"Avellaneda","1873":"Avellaneda","1874":"Avellaneda","1875":"Avellaneda","1876":"Quilmes","1877":"Quilmes","1878":"Quilmes","1879":"Quilmes","1880":"Berazategui","1881":"Quilmes","1882":"Quilmes","1883":"Quilmes","1884":"Berazategui","1885":"Berazategui","1886":"Berazategui","1887":"Florencio Varela","1888":"Florencio Varela","1889":"Florencio Varela","1890":"Berazategui","1891":"Florencio Varela","1893":"Berazategui","1894":"La Plata","1895":"La Plata","1896":"La Plata","1897":"La Plata","1900":"La Plata","1901":"La Plata","1902":"La Plata","1903":"La Plata","1904":"La Plata","1905":"La Plata","1906":"La Plata","1907":"La Plata","1908":"La Plata","1909":"La Plata","1910":"La Plata","1912":"La Plata","1914":"La Plata","1923":"Berisso","1924":"Berisso","1925":"Ensenada","1926":"Ensenada","1927":"Ensenada","1929":"Berisso","1931":"Ensenada","1984":"San Vicente","2800":"Zarate","2801":"Zarate","2802":"Zarate","2804":"Campana","2805":"Campana","2806":"Zarate","2808":"Zarate","2812":"Campana","2814":"Ex.de la Cruz","2816":"Campana","6700":"Lujan","6701":"Lujan","6702":"Lujan","6703":"Ex.de la Cruz","6706":"Lujan","6708":"Lujan","6712":"Lujan"};


// ════════════════════════════════════════════════════════════════════
// TAB CUENTAS CORRIENTES
// ════════════════════════════════════════════════════════════════════
function TabCtasCtes({envios,lc}){
  const [pagos,setPagos]=useState([]);
  const [loadingPagos,setLoadingPagos]=useState(true);
  const [vistaCliente,setVistaCliente]=useState(null);
  const [filtro,setFiltro]=useState("todos");
  const [busqueda,setBusqueda]=useState("");
  const [modalPago,setModalPago]=useState(null);
  const [limites,setLimites]=useState({});
  const [loadingLim,setLoadingLim]=useState(true);

  useEffect(()=>{
    const unsub=onSnapshot(collection(db,"pagosCC"),snap=>{
      setPagos(snap.docs.map(d=>({...d.data(),_id:d.id})));
      setLoadingPagos(false);
    });
    return()=>unsub();
  },[]);

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

  // Derivar clienteKey normalizado
  const getClienteKey=(e)=>{
    const nombre=(e.clienteNombre||"").toLowerCase().trim().replace(/\s+/g,"_");
    return nombre||"sin_nombre_"+e.id;
  };
  const getClienteNombre=(e)=>e.clienteNombre||"Sin nombre ("+e.id.slice(-6)+")";

  // Calcular deuda de cada envio
  const getDeudaEnvio=(e)=>{
    if(e.pagoEstado==="cuenta_corriente"&&e.importeOrden>0)return{monto:e.importeOrden,tipo:"TN CC",logistica:e.trans||""};
    if(e.cobranza>0)return{monto:e.cobranza,tipo:"Efectivo",logistica:e.trans||""};
    if(e.esCC&&e.importeCC>0)return{monto:e.importeCC,tipo:"Manual CC",logistica:e.trans||""};
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

  // Lista de clientes con saldo
  const clientes=Object.values(clientesMap).map(c=>{
    const cobrado=pagosPorCliente[c.key]||0;
    const saldo=Math.max(0,c.deudaTotal-cobrado);
    const dias=diasDeuda(c.fechaMin);
    const limite=limites[c.key]||15;
    return{...c,cobrado,saldo,dias,limite,logisticas:[...c.logisticas]};
  }).sort((a,b)=>b.saldo-a.saldo);

  const fmt=(n)=>"$"+Math.round(n).toLocaleString("es-AR");
  const hoy=new Date();hoy.setHours(0,0,0,0);

  // Filtros
  const clientesFiltrados=clientes.filter(c=>{
    if(filtro==="deuda"&&c.saldo===0)return false;
    if(filtro==="vencidos"&&c.dias<c.limite)return false;
    if(filtro==="saldados"&&c.saldo>0)return false;
    if(busqueda&&!c.nombre.toLowerCase().includes(busqueda.toLowerCase()))return false;
    return true;
  });

  // Metricas globales
  const deudaTotal=clientes.reduce((s,c)=>s+c.saldo,0);
  const vencidosTotal=clientes.filter(c=>c.dias>=c.limite&&c.saldo>0).reduce((s,c)=>s+c.saldo,0);
  const cobradoMes=(()=>{
    const inicio=new Date();inicio.setDate(1);inicio.setHours(0,0,0,0);
    return pagos.filter(p=>{const f=p.creadoEn?.toDate?.();return f&&f>=inicio;}).reduce((s,p)=>s+(p.monto||0),0);
  })();
  const clientesActivos=clientes.filter(c=>c.saldo>0).length;

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
            <div style={{display:"flex",gap:"0.5rem",flexWrap:"wrap"}}>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:"0.62rem",color:"#6b7280",textTransform:"uppercase",fontWeight:700}}>Deuda total</div>
                <div style={{fontSize:"1.1rem",fontWeight:800,color:"#f59e0b"}}>{fmt(c.deudaTotal)}</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:"0.62rem",color:"#6b7280",textTransform:"uppercase",fontWeight:700}}>Cobrado</div>
                <div style={{fontSize:"1.1rem",fontWeight:800,color:"#10b981"}}>{fmt(c.cobrado)}</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:"0.62rem",color:"#6b7280",textTransform:"uppercase",fontWeight:700}}>Saldo</div>
                <div style={{fontSize:"1.1rem",fontWeight:800,color:c.saldo>0?"#ef4444":"#10b981"}}>{fmt(c.saldo)}</div>
              </div>
            </div>
          </div>
          <button onClick={()=>setModalPago({clienteKey:c.key,clienteNombre:c.nombre,saldoPendiente:c.saldo})} disabled={c.saldo===0} style={{...S.btn(true),background:"linear-gradient(135deg,#10b981,#059669)",padding:"0.4rem 1rem",fontSize:"0.8rem",opacity:c.saldo===0?0.4:1}}>Registrar pago</button>
        </div>

        <div style={{...S.card,marginBottom:"1rem",overflow:"hidden"}}>
          <div style={{padding:"0.6rem 1rem",background:"#12172a",borderBottom:"1px solid #1e2535",fontSize:"0.72rem",fontWeight:700,color:"#6b7280",textTransform:"uppercase"}}>Pedidos con deuda</div>
          {c.envios.map((e,i)=>{
            const pagEnvio=pagos.filter(p=>p.envioIds?.includes(e.id)).reduce((s,p)=>s+(p.monto||0),0);
            const saldoEnvio=Math.max(0,(e._deuda.monto||0)-pagEnvio);
            return(
              <div key={e.id} style={{padding:"0.65rem 1rem",borderBottom:i<c.envios.length-1?"1px solid #1a1f2e":"none",display:"flex",gap:"0.75rem",alignItems:"center",flexWrap:"wrap"}}>
                <div style={{flex:1,minWidth:"200px"}}>
                  <div style={{fontSize:"0.82rem",color:"#d1d5db",fontWeight:500}}>{e.direccion?.slice(0,60)}</div>
                  <div style={{fontSize:"0.68rem",color:"#4b5563",marginTop:"2px"}}>
                    ID {e.id.slice(-8)}{e.fechaVenta?<span> · Venta: {fmtCorta(e.fechaVenta)}</span>:null}{e.fecha?<span> · Envio: {fmtCorta(e.fecha)}</span>:null}
                    {e.trans&&<span style={{marginLeft:"6px",padding:"1px 6px",background:lc[e.trans]?.color+"22",color:lc[e.trans]?.color,borderRadius:"4px",fontSize:"0.65rem",fontWeight:700}}>{e.trans}</span>}
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
                    <div style={{fontWeight:700,color:saldoEnvio>0?"#ef4444":"#10b981"}}>{fmt(saldoEnvio)}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {pagosCli.length>0&&(
          <div style={{...S.card,overflow:"hidden"}}>
            <div style={{padding:"0.6rem 1rem",background:"#12172a",borderBottom:"1px solid #1e2535",fontSize:"0.72rem",fontWeight:700,color:"#6b7280",textTransform:"uppercase"}}>Historial de pagos</div>
            {pagosCli.map((p,i)=>(
              <div key={p._id} style={{padding:"0.55rem 1rem",borderBottom:i<pagosCli.length-1?"1px solid #1a1f2e":"none",display:"flex",justifyContent:"space-between",alignItems:"center",gap:"0.5rem",flexWrap:"wrap"}}>
                <div>
                  <div style={{fontSize:"0.82rem",color:"#10b981",fontWeight:700}}>{fmt(p.monto)}</div>
                  {p.nota&&<div style={{fontSize:"0.7rem",color:"#6b7280",marginTop:"1px"}}>{p.nota}</div>}
                </div>
                <div style={{fontSize:"0.72rem",color:"#4b5563"}}>{p.creadoEn?.toDate?.()?.toLocaleDateString("es-AR")||"—"}</div>
              </div>
            ))}
          </div>
        )}
      {modalPago&&<ModalRegistrarPago {...modalPago} onClose={()=>setModalPago(null)} envios={envios.filter(e=>{const deuda=getDeudaEnvio(e);return deuda&&getClienteKey(e)===modalPago.clienteKey;})} pagos={pagos.filter(p=>p.clienteKey===modalPago.clienteKey)} getDeudaEnvio={getDeudaEnvio}/>}
      </div>
    );
  }

  return(
    <div>
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

      {/* Filtros */}
      <div style={{display:"flex",gap:"6px",flexWrap:"wrap",alignItems:"center",marginBottom:"0.85rem"}}>
        {[{k:"todos",l:"Todos"},{k:"deuda",l:"Con deuda"},{k:"vencidos",l:"Vencidos"},{k:"saldados",l:"Saldados"}].map(f=>(
          <button key={f.k} onClick={()=>setFiltro(f.k)} style={S.btnSm(filtro===f.k,"#6366f1")}>{f.l}</button>
        ))}
        <input value={busqueda} onChange={e=>setBusqueda(e.target.value)} placeholder="Buscar cliente..." style={{...S.input,width:"200px",marginLeft:"auto"}}/>
      </div>

      {/* Tabla */}
      <div style={{...S.card,overflow:"hidden"}}>
        <table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead>
            <tr style={{background:"#12172a"}}>
              {["Cliente","Logisticas","Deuda total","Cobrado","Saldo","Antigüedad",""].map(h=>(
                <th key={h} style={{padding:"8px 10px",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",color:"#6b7280",textAlign:h==="Deuda total"||h==="Cobrado"||h==="Saldo"?"right":"left",borderBottom:"1px solid #1e2535"}}>{h}</th>
              ))}
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
                    <div style={{fontSize:"0.68rem",color:"#4b5563",marginTop:"1px"}}>{c.envios.length} pedido{c.envios.length!==1?"s":""}</div>
                  </td>
                  <td style={{padding:"10px 10px"}}>
                    <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>
                      {c.logisticas.map(l=><span key={l} style={{fontSize:"0.65rem",padding:"1px 6px",background:lc[l]?.color+"22",color:lc[l]?.color,borderRadius:"4px",fontWeight:700}}>{l}</span>)}
                    </div>
                  </td>
                  <td style={{padding:"10px 10px",textAlign:"right",fontWeight:700,color:"#f59e0b"}}>{fmt(c.deudaTotal)}</td>
                  <td style={{padding:"10px 10px",textAlign:"right",color:"#10b981"}}>{fmt(c.cobrado)}</td>
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
      {modalPago&&<ModalRegistrarPago {...modalPago} onClose={()=>setModalPago(null)} envios={envios.filter(e=>{const deuda=getDeudaEnvio(e);return deuda&&getClienteKey(e)===modalPago.clienteKey;})} pagos={pagos.filter(p=>p.clienteKey===modalPago.clienteKey)} getDeudaEnvio={getDeudaEnvio}/>}
    </div>
  );
}

function ModalRegistrarPago({clienteKey,clienteNombre,saldoPendiente,onClose,envios,pagos,getDeudaEnvio}){
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
    const pagEnvio=pagos.filter(p=>p.envioIds?.includes(e.id)).reduce((s,p)=>s+(p.monto||0),0);
    return Math.max(0,(getDeudaEnvio(e)?.monto||0)-pagEnvio);
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
  const enviosIds=Object.keys(seleccion).length>0?Object.keys(seleccion):envios.map(e=>e.id);

  const guardar=async()=>{
    const m=parseFloat(monto);
    if(!m||m<=0){alert("Ingresa un monto valido.");return;}
    setGuardando(true);
    try{
      await addDoc(collection(db,"pagosCC"),{
        clienteKey,clienteNombre,monto:m,nota:nota.trim(),
        envioIds,
        fechaCobro,
        creadoEn:serverTimestamp(),
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
          {Object.keys(seleccion).length>0&&<div style={{fontSize:"0.7rem",color:"#10b981",marginTop:"5px",textAlign:"right"}}>Seleccionado: {fmt(montoSeleccionado)}</div>}
          {Object.keys(seleccion).length===0&&<div style={{fontSize:"0.68rem",color:"#4b5563",marginTop:"4px"}}>Sin seleccion — el pago se aplica al cliente en general</div>}
        </div>

        {/* Monto */}
        <div style={{marginBottom:"0.75rem"}}>
          <label style={{display:"block",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",color:"#6b7280",marginBottom:"4px"}}>Monto cobrado</label>
          <div style={{display:"flex",gap:"6px",alignItems:"center"}}>
            <input type="number" value={monto} onChange={e=>{setMonto(e.target.value);setMontoManual(true);}} placeholder="0" style={{...S.input,flex:1}}/>
            <button onClick={()=>{setMonto(String(saldoPendiente));setMontoManual(false);}} style={{...S.btnSm(false,"#10b981"),whiteSpace:"nowrap",fontSize:"0.7rem"}}>Total</button>
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
      const srch = busqueda.toLowerCase();
      return cp.includes(srch) || p.toLowerCase().includes(srch);
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
function PantallaAsignacionTN({borrador,onConfirmar,onCancelar,lc}){
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
  const confirmar=()=>onConfirmar(borrador.map(e=>({...e,...getA(e.id),estado:getA(e.id).trans?"asignado":"sin_asignar"})));

  return(
    <div style={{minHeight:"100vh",background:"#0a0e1a",color:"#fff",fontFamily:"sans-serif"}}>
      <style>{`*{box-sizing:border-box;}`}</style>
      <div style={{position:"sticky",top:0,zIndex:100,background:"#0f1420",borderBottom:"1px solid #1a1f2e",padding:"0.75rem 1rem",display:"flex",alignItems:"center",gap:"0.75rem",flexWrap:"wrap"}}>
        <div style={{width:"28px",height:"28px",background:"#0d1c2e",border:"1px solid #38bdf8",borderRadius:"7px",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"0.85rem"}}>TN</div>
        <div><div style={{fontWeight:800,fontSize:"0.95rem"}}>Asignar pedidos Tienda Nube</div><div style={{color:"#4b5563",fontSize:"0.62rem"}}>{borrador.length} pedidos sin asignar · agrupados por fecha y turno</div></div>
        <div style={{marginLeft:"auto",display:"flex",gap:"0.5rem",alignItems:"center"}}>
          <span style={{color:totalAsig===borrador.length?"#10b981":"#f59e0b",fontSize:"0.82rem",fontWeight:700}}>{totalAsig}/{borrador.length}</span>
          <button onClick={onCancelar} style={S.btn(false)}>Cancelar</button>
          <button onClick={confirmar} style={{...S.btn(true),background:"#0d1c2e",border:"1px solid #38bdf8",color:"#38bdf8"}}>Confirmar ({totalAsig}/{borrador.length})</button>
        </div>
      </div>
      <div style={{padding:"1rem",maxWidth:"980px",margin:"0 auto"}}>
        {grupoKeys.map(key=>{
          const grupo=grupos[key];
          const ids=grupo.envios.map(e=>e.id);
          const gT=getGrupo(ids,"trans");
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
                <div style={{display:"flex",alignItems:"center",gap:"0.5rem",flexWrap:"wrap"}}>
                  <span style={{color:"#6b7280",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase"}}>Logistica:</span>
                  {logActivas.map(l =><button key={l} onClick={()=>setGrupo(ids,"trans",gT===l?"":l)} style={S.btnSm(gT===l,lc[l]?.color||"#6366f1")}>{l}</button>)}
                  {gT&&<button onClick={()=>setGrupo(ids,"trans","")} style={{...S.btnSm(false),color:"#6b7280"}}>x</button>}
                </div>
              </div>
              {grupo.envios.map((e,i)=>{
                const a=getA(e.id);
                const zml=getZonaML(e.partido);
                return(
                  <div key={e.id} style={{padding:"0.45rem 1rem",borderBottom:i<grupo.envios.length-1?"1px solid #1a1f2e":"none",display:"flex",alignItems:"center",gap:"0.75rem",flexWrap:"wrap",opacity:!puedeAsignar(e)?0.5:1}}>
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
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
        <div style={{display:"flex",justifyContent:"flex-end",gap:"0.75rem",marginTop:"1rem",paddingBottom:"2rem"}}>
          <button onClick={onCancelar} style={S.btn(false)}>Cancelar</button>
          <button onClick={confirmar} style={{...S.btn(true),background:"#0d1c2e",border:"1px solid #38bdf8",color:"#38bdf8",padding:"0.55rem 1.4rem"}}>Confirmar ({totalAsig}/{borrador.length})</button>
        </div>
      </div>
    </div>
  );
}


// ════════════════════════════════════════════════════════════════════
// TAB USUARIOS — solo admin
// ════════════════════════════════════════════════════════════════════
function TabUsuarios({lc}){
  const [usuarios,setUsuarios]=useState([]);
  const [loading,setLoading]=useState(true);
  const [form,setForm]=useState({usuario:"",password:"",rol:"colaborador",logistica:"",esChofer:false,activo:true});
  const [editId,setEditId]=useState(null);
  const [toast,setToast]=useState("");
  const logActivas=Object.keys(lc).filter(k =>lc[k].activa);

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
    const id=editId||("usr_"+Date.now());
    await setDoc(doc(db,"usuarios",id),{...form,usuario:form.usuario.toLowerCase().trim()});
    setForm({usuario:"",password:"",rol:"colaborador",logistica:"",esChofer:false,activo:true});
    setEditId(null);
    mostrarToast(editId?"Usuario actualizado":"Usuario creado");
  };

  const toggleActivo=async(u)=>{
    await setDoc(doc(db,"usuarios",u.id),{...u,activo:!u.activo});
  };

  const editar=u=>{setForm({usuario:u.usuario,password:u.password,rol:u.rol,logistica:u.logistica||"",activo:u.activo});setEditId(u.id);};

  const ROL_C={admin:{label:"Admin",color:"#6366f1"},colaborador:{label:"Colaborador",color:"#10b981"},logistica:{label:"Logistica",color:"#8b5cf6"},expedicion:{label:"Expedicion",color:"#f59e0b"}};

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
            <select value={form.rol} onChange={e=>setForm(p=>({...p,rol:e.target.value,logistica:""}))} style={{...S.input,width:"100%"}}>
              <option value="admin">Administrador</option>
              <option value="colaborador">Colaborador</option>
              <option value="logistica">Logistica</option>
                  <option value="expedicion">Expedicion</option>
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
              {logActivas.map(l =><option key={l} value={l}>{l}</option>)}
            </select>
          </div>}
        </div>
        <div style={{display:"flex",gap:"0.5rem"}}>
          <button onClick={guardar} style={{...S.btn(true),background:"linear-gradient(135deg,#6366f1,#8b5cf6)"}}>{editId?"Guardar cambios":"Crear usuario"}</button>
          {editId&&<button onClick={()=>{setEditId(null);setForm({usuario:"",password:"",rol:"colaborador",logistica:"",esChofer:false,activo:true});}} style={S.btn(false)}>Cancelar</button>}
        </div>
      </div>

      {/* Lista usuarios */}
      <div style={{...S.card,padding:0,overflow:"hidden"}}>
        <div style={{padding:"0.75rem 1rem",background:"#12172a",borderBottom:"1px solid #252d40",fontSize:"0.72rem",fontWeight:700,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.06em"}}>Usuarios del sistema</div>
        {usuarios.length===0&&<div style={{padding:"2rem",textAlign:"center",color:"#4b5563"}}>No hay usuarios creados</div>}
        {usuarios.map(u=>{
          const rc=ROL_C[u.rol]||ROL_C.colaborador;
          return(
            <div key={u.id} style={{padding:"0.75rem 1rem",borderBottom:"1px solid #1a1f2e",display:"flex",alignItems:"center",gap:"0.75rem",flexWrap:"wrap",opacity:u.activo?1:0.5}}>
              <div style={{flex:1,minWidth:"120px"}}>
                <div style={{display:"flex",alignItems:"center",gap:"8px"}}>
                  <span style={{color:"#e5e7eb",fontWeight:600,fontSize:"0.88rem"}}>{u.usuario}</span>
                  <span style={{padding:"1px 8px",background:rc.color+"22",color:rc.color,borderRadius:"5px",fontSize:"0.65rem",fontWeight:700}}>{rc.label}</span>
                  {u.rol==="logistica"&&u.logistica&&<span style={{padding:"1px 8px",background:lc[u.logistica]?.bg||"#1a1f2e",color:lc[u.logistica]?.color||"#6b7280",borderRadius:"5px",fontSize:"0.65rem",fontWeight:700}}>{u.logistica}</span>}
                  {u.esChofer&&<span style={{padding:"1px 8px",background:"#1c1500",color:"#f59e0b",borderRadius:"5px",fontSize:"0.65rem",fontWeight:700}}>🛵 Chofer</span>}
                  {!u.activo&&<span style={{padding:"1px 8px",background:"#1c0a0a",color:"#f87171",borderRadius:"5px",fontSize:"0.65rem",fontWeight:700}}>Inactivo</span>}
                </div>
              </div>
              <div style={{display:"flex",gap:"0.4rem"}}>
                <button onClick={()=>editar(u)} style={{...S.btnSm(false),color:"#6366f1"}}>Editar</button>
                <button onClick={()=>toggleActivo(u)} style={S.btnSm(u.activo,u.activo?"#ef4444":"#10b981")}>{u.activo?"Desactivar":"Activar"}</button>
              </div>
            </div>
          );
        })}
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
    if(busqueda){const srch=busqueda.toLowerCase();return e.direccion.toLowerCase().includes(srch)||e.partido.toLowerCase().includes(srch)||(e.clienteNombre||"").toLowerCase().includes(srch)||(e.nroOrdenTN||"").includes(srch);}
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
              const lote=e.loteImportacion?new Date(e.loteImportacion).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"}):"";
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
            const ts=ahora.toLocaleDateString("es-AR",{weekday:"long",day:"numeric",month:"long",year:"numeric"})+" "+ahora.toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"});
            const hayCobro=filtrados.some(e=>e.cobranza!==null&&e.cobranza>0);
            const rows=filtrados.map((e,i)=>{
              const esFlex=e.origen==="ML";
              const dir=[e.direccion,e.localidad,e.partido,e.cp].filter(Boolean).join(" · ");
              const nroRef=esFlex?(e.nroSeguimiento||e.id.slice(-10)):("#"+(e.nroOrdenTN||e.id.slice(-8)));
              const lote=esFlex&&e.loteImportacion?new Date(e.loteImportacion).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"}):"—";
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
                  {e.origen==="ML"&&e.loteImportacion&&<Bdg label={new Date(e.loteImportacion).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"})} bg="#0d1c04" t="#84cc16"/>}
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

function TabTablero({envios,lc,zc}){
  const hoy=fechaHoy();
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
    const envsLog=envios.filter(e=>e.trans===l&&e.cobranza!==null&&e.cobranza>0);
    const deudaAnterior=envsLog.filter(e=>{const f=e.fecha||"";return f<hoy&&!e.cobranzaRecibida;}).reduce((s,e)=>s+(e.cobranza||0),0);
    const diasDeuda=envsLog.filter(e=>{const f=e.fecha||"";return f<hoy&&!e.cobranzaRecibida;}).reduce((max,e)=>{
      const dias=Math.floor((new Date(hoy)-new Date(e.fecha||hoy))/86400000);
      return Math.max(max,dias);
    },0);
    const saleHoy=envsLog.filter(e=>(e.fecha||"")==hoy&&!e.cobranzaRecibida).reduce((s,e)=>s+(e.cobranza||0),0);
    return{l,deudaAnterior,saleHoy,total:deudaAnterior+saleHoy,diasDeuda};
  }).filter(x =>x.total>0||x.saleHoy>0);

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
          <div style={{color:"#4b5563",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",letterSpacing:".08em",marginBottom:"8px"}}>Cobranzas por logística</div>
          <div style={{...cardSt,padding:0,overflow:"hidden"}}>
            <div style={{background:"#12172a",padding:"8px 14px",borderBottom:"1px solid #252d40",display:"grid",gridTemplateColumns:"80px 1fr 1fr 1fr",gap:"8px"}}>
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
          </div>
        </div>
      </div>
    </div>
  );
}


function VistaExpedicion({envios,setEnvios,sesion,lc}){
  const hoy=fechaHoy();
  const [fecha,setFecha]=useState(hoy);
  const [qrInput,setQrInput]=useState("");
  const [resultado,setResultado]=useState(null);
  const [filLog,setFilLog]=useState("TODOS");
  const [soloPendientes,setSoloPendientes]=useState(false);
  const [filTipo,setFilTipo]=useState("TODOS"); // TODOS | FLEX | NOFLEX
  const [busqueda,setBusqueda]=useState("");
  const [camara,setCamara]=useState(false);
  const [bultosEdit,setBultosEdit]=useState({}); // {id: value}
  const inputRef=useRef(null);
  const videoRef=useRef(null);
  const logActivas=Object.entries(lc).filter(([,v])=>v.activa).map(([k])=>k);

  const ayer=()=>{const d=new Date(hoy+"T00:00:00");d.setDate(d.getDate()-1);return d.toISOString().split("T")[0];};
  const manana=()=>{const d=new Date(hoy+"T00:00:00");d.setDate(d.getDate()+1);return d.toISOString().split("T")[0];};

  // NO FLEX de la fecha seleccionada
  const deFecha=envios.filter(e=>{
    const f=e.fecha||e.fechaVenta||"";
    if(f!==fecha)return false;
    if(getEstado(e)!=="asignado")return false;
    if(e.origen==="ML")return false;
    return true;
  });

  // FLEX de la fecha seleccionada (se muestran en lista + scanner)
  const flexFecha=envios.filter(e=>{
    const f=e.fecha||e.fechaVenta||"";
    return e.origen==="ML"&&f===fecha&&getEstado(e)==="asignado";
  });

  // Todos juntos para el listado
  const todosLista=[...deFecha,...flexFecha];

  const filtrados=[...todosLista].filter(e=>{
    if(filLog!=="TODOS"&&e.trans!==filLog)return false;
    if(filTipo==="FLEX"&&e.origen!=="ML")return false;
    if(filTipo==="NOFLEX"&&e.origen==="ML")return false;
    if(soloPendientes&&e.preparado)return false;
    if(busqueda){const s=busqueda.toLowerCase();return e.direccion.toLowerCase().includes(s)||(e.nroOrdenTN||"").includes(s)||(e.nroSeguimiento||"").includes(s)||e.partido.toLowerCase().includes(s);}
    return true;
  }).sort((a,b)=>{
    if(a.trans!==b.trans)return (a.trans||"").localeCompare(b.trans||"");
    if(a.origen!==b.origen)return a.origen==="ML"?1:-1; // NO FLEX primero
    const ta=TURNOS.indexOf(a.turno),tb=TURNOS.indexOf(b.turno);
    return ta-tb;
  });

  const preparados=todosLista.filter(e=>e.preparado).length;
  const total=todosLista.length;
  const prepNoflex=deFecha.filter(e=>e.preparado).length;
  const prepFlex=flexFecha.filter(e=>e.preparado).length;
  const pct=total>0?Math.round(preparados/total*100):0;

  // procesarScan debe declararse ANTES del useEffect que lo usa como dep
  const procesarScan=useCallback((nro)=>{
    const srch=nro.trim();if(!srch)return;
    setResultado(null); // limpiar mensaje anterior inmediatamente
    const nums=srch.replace(/\D/g,"");
    // 1. Match exacto por nroSeguimiento o id
    let found=envios.find(e=>e.nroSeguimiento===srch||e.id===srch||e.nroSeguimiento===nums);
    // 2. El QR tiene datos extra al final: el nro del envio es prefijo del QR escaneado
    if(!found) found=envios.find(e=>e.nroSeguimiento&&nums.startsWith(e.nroSeguimiento));
    // 3. El nro del envio tiene datos extra: el QR es prefijo del nro registrado
    if(!found) found=envios.find(e=>e.nroSeguimiento&&e.nroSeguimiento.startsWith(nums));
    if(!found){setResultado({ok:false,msg:"No encontrado: "+srch.slice(0,20)});setTimeout(()=>setResultado(null),10000);return;}
    if(found.preparado){setResultado({ok:"ya",envio:found,msg:"Ya estaba preparado"});setTimeout(()=>setResultado(null),10000);return;}
    setEnvios(pv=>pv.map(e=>e.id===found.id?{...e,preparado:true}:e));
    setResultado({ok:true,envio:found,msg:"✓ Preparado"});
    beepOK();
    setTimeout(()=>setResultado(null),10000);
  },[envios,setEnvios]);

  const confirmarBultos=useCallback((envio)=>{
    const bv=parseInt(bultosEdit[envio.id]??envio.bultos);
    if(!bv||bv<1)return;
    setEnvios(pv=>pv.map(e=>e.id===envio.id?{...e,bultos:bv,preparado:true}:e));
    setBultosEdit(pv=>({...pv,[envio.id]:bv}));
  },[bultosEdit,setEnvios]);

  // Focus en input al montar
  useEffect(()=>{if(inputRef.current)inputRef.current.focus();},[]);

  // Escaneo QR via camara — BarcodeDetector API (Chrome Android nativo)
  useEffect(()=>{
    if(!camara)return;
    let stream=null;
    let rafId=null;
    let activo=true;
    const canvas=document.createElement("canvas");
    const ctx=canvas.getContext("2d");

    const startCam=async()=>{
      try{
        stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment",width:{ideal:1280},height:{ideal:720}}});
        if(!videoRef.current||!activo)return;
        videoRef.current.srcObject=stream;
        await videoRef.current.play();

        // Verificar soporte de BarcodeDetector
        if(!("BarcodeDetector" in window)){
          setResultado({ok:false,msg:"Tu navegador no soporta escaneo QR. Usá el campo de texto."});
          setCamara(false);
          return;
        }
        const detector=new window.BarcodeDetector({formats:["qr_code","code_128","code_39","ean_13"]});

        const scan=async()=>{
          if(!activo||!videoRef.current||videoRef.current.readyState<2){rafId=requestAnimationFrame(scan);return;}
          try{
            const barcodes=await detector.detect(videoRef.current);
            if(barcodes.length>0){
              const val=barcodes[0].rawValue;
              // Delay de 1 seg para feedback visual antes de procesar
              setResultado({ok:"scanning",msg:"Escaneando..."});
              await new Promise(r=>setTimeout(r,1000));
              if(!activo)return;
              procesarScan(val);
              setCamara(false);
              return;
            }
          }catch(e){}
          if(activo)rafId=requestAnimationFrame(scan);
        };
        rafId=requestAnimationFrame(scan);
      }catch(err){
        console.error("Camara error:",err);
        setResultado({ok:false,msg:"No se pudo acceder a la cámara. Verificá los permisos."});
        setCamara(false);
      }
    };
    startCam();
    return()=>{
      activo=false;
      if(rafId)cancelAnimationFrame(rafId);
      if(stream)stream.getTracks().forEach(t =>t.stop());
    };
  },[camara,procesarScan]);

  // Agrupar por logistica
  const grupos={};
  filtrados.forEach(e=>{
    const k=e.trans||"Sin asignar";
    if(!grupos[k])grupos[k]=[];
    grupos[k].push(e);
  });

  return(
    <div style={{minHeight:"100vh",background:"#0a0e1a",color:"#fff",fontFamily:"sans-serif"}}>
      <style>{`*{box-sizing:border-box;}input[type=number]::-webkit-inner-spin-button{opacity:1;}`}</style>

      {/* Header */}
      <div style={{position:"sticky",top:0,zIndex:100,background:"#0f1420",borderBottom:"1px solid #1a1f2e",padding:"0.7rem 1rem",display:"flex",alignItems:"center",gap:"0.75rem",flexWrap:"wrap"}}>
        <div style={{width:"26px",height:"26px",background:"linear-gradient(135deg,#6366f1,#8b5cf6)",borderRadius:"7px",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>🛵</div>
        <div>
          <div style={{fontWeight:800,fontSize:"0.92rem"}}>EnviosHub <span style={{color:"#374151",fontSize:"0.6rem",fontWeight:400}}>v{VERSION}</span></div>
          <div style={{color:"#f59e0b",fontSize:"0.65rem",fontWeight:700}}>Expedición</div>
        </div>
        <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:"0.5rem",flexWrap:"wrap"}}>
          <button onClick={()=>{
            const filas=filtrados.sort((a,b)=>(a.loteImportacion||"9").localeCompare(b.loteImportacion||"9")).map((e,i)=>{
              const esFlex=e.origen==="ML";
              const lote=e.loteImportacion?new Date(e.loteImportacion).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"}):"";
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
            const ts=ahora.toLocaleDateString("es-AR",{weekday:"long",day:"numeric",month:"long",year:"numeric"})+" "+ahora.toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"});
            const hayCobro=filtrados.some(e=>e.cobranza!==null&&e.cobranza>0);
            const rows=filtrados.map((e,i)=>{
              const esFlex=e.origen==="ML";
              const dir=[e.direccion,e.localidad,e.partido,e.cp].filter(Boolean).join(" · ");
              const nroRef=esFlex?(e.nroSeguimiento||e.id.slice(-10)):("#"+(e.nroOrdenTN||e.id.slice(-8)));
              const lote=esFlex&&e.loteImportacion?new Date(e.loteImportacion).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"}):"—";
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

      <div style={{padding:"0.85rem 1rem",maxWidth:"700px",margin:"0 auto"}}>

        {/* Selector de fecha */}
        <div style={{...S.card,padding:"0.6rem 1rem",marginBottom:"0.75rem",display:"flex",gap:"6px",alignItems:"center",flexWrap:"wrap"}}>
          <span style={{color:"#4b5563",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase"}}>Fecha</span>
          {[{l:"Ayer",v:ayer()},{l:"Hoy",v:hoy},{l:"Mañana",v:manana()}].map(x =>(
            <button key={x.v} onClick={()=>setFecha(x.v)} style={S.btnSm(fecha===x.v)}>{x.l}</button>
          ))}
          <input type="date" value={fecha} onChange={e=>setFecha(e.target.value)} style={{...S.input,padding:"3px 8px",width:"138px",fontSize:"0.78rem"}}/>
          <span style={{color:"#4b5563",fontSize:"0.72rem",marginLeft:"4px"}}>{total} pedidos · {preparados} prep.</span>
        </div>

        {/* Resumen */}
        <div style={{display:"flex",gap:"8px",marginBottom:"0.75rem"}}>
          <div style={{...S.card,padding:"0.7rem 1rem",flex:1,borderLeft:"3px solid #6366f1"}}>
            <div style={{color:"#6366f1",fontWeight:800,fontSize:"1.5rem",lineHeight:1}}>{total}</div>
            <div style={{color:"#6b7280",fontSize:"0.6rem",textTransform:"uppercase",marginTop:"2px"}}>Total</div>
            <div style={{display:"flex",gap:"4px",marginTop:"4px"}}>
              <span style={{background:"#0d1c04",color:"#84cc16",border:"1px solid #84cc16",padding:"1px 6px",borderRadius:"4px",fontSize:"9px",fontWeight:700}}>FLEX {flexFecha.length}</span>
              <span style={{background:"#12172a",color:"#6366f1",border:"1px solid #6366f1",padding:"1px 6px",borderRadius:"4px",fontSize:"9px",fontWeight:700}}>NOFLEX {deFecha.length}</span>
            </div>
          </div>
          <div style={{...S.card,padding:"0.7rem 1rem",flex:1,borderLeft:"3px solid #10b981"}}>
            <div style={{color:"#10b981",fontWeight:800,fontSize:"1.5rem",lineHeight:1}}>{preparados}</div>
            <div style={{color:"#6b7280",fontSize:"0.6rem",textTransform:"uppercase",marginTop:"2px"}}>Preparados</div>
            <div style={{display:"flex",gap:"4px",marginTop:"4px"}}>
              <span style={{color:"#84cc16",fontSize:"9px",fontWeight:700}}>F:{prepFlex}/{flexFecha.length}</span>
              <span style={{color:"#6366f1",fontSize:"9px",fontWeight:700}}>NF:{prepNoflex}/{deFecha.length}</span>
            </div>
          </div>
          <div style={{...S.card,padding:"0.7rem 1rem",flex:1,borderLeft:"3px solid #f59e0b"}}>
            <div style={{color:"#f59e0b",fontWeight:800,fontSize:"1.5rem",lineHeight:1}}>{total-preparados}</div>
            <div style={{color:"#6b7280",fontSize:"0.6rem",textTransform:"uppercase",marginTop:"2px"}}>Pendientes</div>
          </div>
          <div style={{...S.card,padding:"0.7rem 1rem",flex:2}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:"5px"}}>
              <span style={{color:"#6b7280",fontSize:"0.6rem",textTransform:"uppercase"}}>Progreso</span>
              <span style={{color:pct>=80?"#10b981":pct>=50?"#f59e0b":"#f87171",fontWeight:700,fontSize:"0.8rem"}}>{pct}%</span>
            </div>
            <div style={{height:"10px",background:"#0f1420",borderRadius:"5px",overflow:"hidden"}}>
              <div style={{width:pct+"%",height:"100%",background:pct>=80?"#10b981":pct>=50?"#f59e0b":"#f87171",borderRadius:"5px",transition:"width 0.3s"}}/>
            </div>
          </div>
        </div>

        {/* Scanner FLEX */}
        <div style={{...S.card,padding:"0.85rem 1rem",marginBottom:"0.75rem",border:"1px solid #84cc1633"}}>
          <div style={{color:"#84cc16",fontWeight:700,fontSize:"0.7rem",textTransform:"uppercase",letterSpacing:".06em",marginBottom:"8px"}}>
            Escaner FLEX {flexFecha.length>0?`· ${prepFlex}/${flexFecha.length} preparados`:"· sin FLEX esta fecha"}
          </div>
          <div style={{display:"flex",gap:"8px",marginBottom:resultado?"8px":"0"}}>
            <input ref={inputRef} value={qrInput} onChange={e=>setQrInput(e.target.value)}
              onKeyDown={e=>{if(e.key==="Enter"){procesarScan(qrInput);setQrInput("");}}}
              placeholder="Ingresá o escaneá el nro de seguimiento..."
              style={{...S.input,flex:1,fontSize:"0.88rem",padding:"8px 12px"}} autoComplete="off"/>
            <button onClick={()=>{procesarScan(qrInput);setQrInput("");}} style={{...S.btn(true),background:"#0d1c04",border:"1px solid #84cc16",color:"#84cc16",padding:"8px 14px",fontWeight:700,fontSize:"0.8rem"}}>OK</button>
            <button onClick={()=>setCamara(!camara)} style={{...S.btn(camara),background:camara?"#0d1c04":"#0f1420",border:"1px solid "+(camara?"#84cc16":"#252d40"),color:camara?"#84cc16":"#6b7280",padding:"8px 12px",fontSize:"1rem"}} title="Abrir cámara">📷</button>
          </div>
          {camara&&<div style={{marginTop:"8px",borderRadius:"8px",overflow:"hidden",background:"#000",position:"relative"}}>
            <video ref={videoRef} style={{width:"100%",maxHeight:"220px",objectFit:"cover",display:"block"}} playsInline muted/>
            <div style={{position:"absolute",inset:0,border:"2px solid #84cc16",borderRadius:"8px",pointerEvents:"none"}}/>
            <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",width:"140px",height:"140px",border:"2px solid #84cc16",borderRadius:"8px",boxShadow:"0 0 0 9999px rgba(0,0,0,0.4)"}}/>
            <button onClick={()=>setCamara(false)} style={{position:"absolute",top:"8px",right:"8px",background:"rgba(0,0,0,0.7)",border:"1px solid #84cc16",color:"#84cc16",borderRadius:"6px",padding:"4px 10px",fontSize:"12px",cursor:"pointer"}}>Cerrar</button>
          </div>}
          {resultado&&<div onClick={()=>resultado.ok!=="scanning"&&setResultado(null)} style={{padding:"8px 12px",borderRadius:"8px",cursor:resultado.ok==="scanning"?"default":"pointer",
            background:resultado.ok===true?"#041f14":resultado.ok==="ya"?"#12172a":resultado.ok==="scanning"?"#0d1c2e":"#1c0404",
            border:"1px solid "+(resultado.ok===true?"#065f46":resultado.ok==="ya"?"#252d40":resultado.ok==="scanning"?"#38bdf8":"#7f1d1d"),color:resultado.ok===true?"#34d399":resultado.ok==="ya"?"#6b7280":resultado.ok==="scanning"?"#38bdf8":"#f87171",fontSize:"0.82rem",fontWeight:700,display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:"8px"}}>
            <div>{resultado.ok==="scanning"?"⏳ "+resultado.msg:resultado.msg}{resultado.envio&&<div style={{fontWeight:400,color:"#9ca3af",marginTop:"2px",fontSize:"0.75rem"}}>{resultado.envio.direccion} {resultado.envio.trans?<span style={{color:resultado.envio.trans&&lc[resultado.envio.trans]?.color||"#6b7280",fontWeight:700}}>· {resultado.envio.trans}</span>:""}</div>}</div>
            {resultado.ok!=="scanning"&&<span style={{opacity:0.5,fontSize:"0.75rem",flexShrink:0}}>✕ cerrar</span>}
          </div>}
        </div>

        {/* Filtros por logistica */}
        <div style={{display:"flex",gap:"6px",flexWrap:"wrap",marginBottom:"0.5rem",alignItems:"center"}}>
          <button onClick={()=>setFilLog("TODOS")} style={S.btnSm(filLog==="TODOS")}>Todos</button>
          {logActivas.map(l =><button key={l} onClick={()=>setFilLog(l)} style={S.btnSm(filLog===l,lc[l]?.color)}>{l}</button>)}
          <button onClick={()=>setSoloPendientes(!soloPendientes)} style={{...S.btnSm(soloPendientes,"#f59e0b"),marginLeft:"auto"}}>Solo pendientes</button>
        </div>
        {/* Filtro FLEX / NO FLEX */}
        <div style={{display:"flex",gap:"6px",marginBottom:"0.6rem",alignItems:"center"}}>
          <button onClick={()=>setFilTipo("TODOS")} style={S.btnSm(filTipo==="TODOS")}>Todos</button>
          <button onClick={()=>setFilTipo("FLEX")} style={{...S.btnSm(filTipo==="FLEX"),background:filTipo==="FLEX"?"#0d1c04":"#0f1420",color:filTipo==="FLEX"?"#84cc16":"#4b7a10",border:"1px solid "+(filTipo==="FLEX"?"#84cc16":"#1a3008")}}>FLEX</button>
          <button onClick={()=>setFilTipo("NOFLEX")} style={S.btnSm(filTipo==="NOFLEX","#6366f1")}>NO FLEX</button>
          <span style={{color:"#4b5563",fontSize:"0.68rem",marginLeft:"4px"}}>{filtrados.length} pedidos</span>
        </div>

        {/* Buscar */}
        <div style={{marginBottom:"0.6rem"}}>
          <input value={busqueda} onChange={e=>setBusqueda(e.target.value)} placeholder="🔍 Buscar por nro de orden o dirección..." style={{...S.input,width:"100%"}}/>
        </div>

        {/* Lista agrupada por logistica */}
        {filtrados.length===0&&<div style={{textAlign:"center",padding:"3rem",color:"#4b5563"}}><div style={{fontSize:"2rem"}}>📦</div><p style={{marginTop:"8px"}}>Sin pedidos NO FLEX para esta fecha</p></div>}
        {Object.entries(grupos).map(([log,items])=>{
          const lcD=lc[log]||{color:"#6b7280",bg:"#1a1f2e"};
          const prepG=items.filter(e=>e.preparado).length;
          return(
            <div key={log} style={{marginBottom:"16px"}}>
              {/* Separador logistica */}
              <div style={{display:"flex",alignItems:"center",gap:"8px",marginBottom:"6px"}}>
                <div style={{flex:1,height:"1px",background:"#1a1f2e"}}/>
                <div style={{background:lcD.bg||"#12172a",color:lcD.color,padding:"2px 12px",borderRadius:"10px",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase"}}>
                  {log} · {prepG}/{items.length} preparados
                </div>
                <div style={{flex:1,height:"1px",background:"#1a1f2e"}}/>
              </div>
              {/* Pedidos */}
              <div style={{display:"grid",gap:"6px"}}>
                {items.map(e=>{
                  const bVal=bultosEdit[e.id]??e.bultos??"";
                  const esTN=e.origen==="Tienda Nube";
                  return(
                    <div key={e.id} style={{...S.card,overflow:"hidden",opacity:e.preparado?0.6:1,borderColor:e.preparado?"#065f46":"#252d40"}}>
                      {/* Info del pedido */}
                      <div style={{padding:"10px 14px",display:"flex",alignItems:"flex-start",gap:"10px"}}>
                        <div style={{width:"26px",height:"26px",borderRadius:"7px",background:e.preparado?"#041f14":"#0f1420",border:"2px solid "+(e.preparado?"#10b981":"#374151"),display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:"2px"}}>
                          {e.preparado&&<span style={{color:"#10b981",fontSize:"15px",lineHeight:1}}>✓</span>}
                        </div>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{display:"flex",gap:"4px",flexWrap:"wrap",marginBottom:"3px"}}>
                            {esTN&&<span style={{color:"#7dd3fc",fontWeight:700,fontSize:"0.8rem"}}>#{e.nroOrdenTN}</span>}
                            {e.turno&&<Bdg label={e.turno} bg={TURNO_C[e.turno]?.bg||"#130d2a"} t={TURNO_C[e.turno]?.c||"#a78bfa"}/>}
                            {e.preparado&&<Bdg label={`Preparado · ${e.bultos} bulto${e.bultos>1?"s":""}`} bg="#041f14" t="#10b981"/>}
                            {e.cobranza&&<Bdg label={"$"+Number(e.cobranza).toLocaleString("es-AR")} bg="#1c1500" t="#fbbf24"/>}
                          </div>
                          <div style={{color:"#e5e7eb",fontSize:"0.85rem",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.direccion}</div>
                          <div style={{color:"#6b7280",fontSize:"0.72rem",marginTop:"1px"}}>{e.localidad?e.localidad+" · ":""}{e.partido}{e.cp?" · CP "+e.cp:""}</div>
                        </div>
                      </div>
                      {/* Zona bultos */}
                      <div style={{borderTop:"1px solid #1a1f2e",padding:"10px 14px",display:"flex",alignItems:"center",gap:"10px",background:"#12172a"}}>
                        <span style={{color:"#6b7280",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",minWidth:"50px"}}>Bultos</span>
                        <input
                          type="number" min="1"
                          value={bVal}
                          onChange={ev=>setBultosEdit(p=>({...p,[e.id]:ev.target.value}))}
                          onKeyDown={ev=>{if(ev.key==="Enter")confirmarBultos(e);}}
                          placeholder="—"
                          style={{width:"80px",background:"#0f1420",border:"2px solid "+(bVal?"#6366f1":"#252d40"),borderRadius:"8px",padding:"7px 10px",color:"#e5e7eb",fontSize:"1.2rem",fontWeight:700,textAlign:"center"}}
                        />
                        {!e.preparado
                          ?<button onClick={()=>confirmarBultos(e)} style={{...S.btn(true),background:"linear-gradient(135deg,#6366f1,#8b5cf6)",padding:"7px 18px",fontSize:"0.82rem",fontWeight:700}}>Confirmar</button>
                          :<button onClick={()=>confirmarBultos(e)} style={{...S.btn(false),background:"#041f14",border:"1px solid #10b981",color:"#10b981",padding:"7px 18px",fontSize:"0.82rem",fontWeight:700}}>✓ Preparado</button>
                        }
                        {e.preparado&&!e.bultos&&null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
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

export default function App(){
  const [sesion,setSesion]=useState(()=>getSession());
  const [pantalla,setPantalla]=useState("dashboard");

  // Validar sesión contra Firebase al arrancar — si el usuario fue desactivado, forzar logout
  useEffect(()=>{
    if(!sesion?.id) return;
    getDoc(doc(db,"usuarios",sesion.id)).then(snap=>{
      if(!snap.exists()||snap.data().activo===false){
        clearSession();
        setSesion(null);
      }
    }).catch(()=>{}); // si no hay internet, dejar pasar (no bloquear)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  const [borrador,setBorrador]=useState([]);
  const [modalPDF,setModalPDF]=useState(null); // archivo pendiente mientras modal abierto
  const [envios,setEnviosLocal]=useState([]);
  const [zc,setZc]=useState(ZONAS_INIT);
  const [lc,setLc]=useState(LOGISTICAS_INIT);
  const [cpExtra,setCpExtra]=useState({});

  // Cargar lc, zc y cpExtra desde Firebase al iniciar
  useEffect(()=>{
    const unsubLc=onSnapshot(doc(db,"config","logisticas"),snap=>{
      if(snap.exists()){const data=snap.data();setLc(p=>({...LOGISTICAS_INIT,...p,...data}));}
    });
    const unsubZc=onSnapshot(doc(db,"config","zonas"),snap=>{
      if(snap.exists()){const data=snap.data();setZc(p=>({...ZONAS_INIT,...p,...data}));}
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
        docs.forEach(nuevo=>{
          const viejo=prev.find(e=>e.id===nuevo.id);
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

  const guardarEnvio=async(e)=>{try{await setDoc(doc(db,"envios",e.id),e);}catch(err){console.error(err);}};
  const eliminarEnvio=async(id)=>{try{await deleteDoc(doc(db,"envios",id));}catch(err){console.error(err);}};

  const setEnvios=useCallback((updater)=>{
    setEnviosLocal(prev=>{
      const next=typeof updater==="function"?updater(prev):updater;
      next.forEach(e=>{const old=prev.find(p=>p.id===e.id);if(!old||JSON.stringify(old)!==JSON.stringify(e))guardarEnvio(e);});
      prev.forEach(e=>{if(!next.find(n=>n.id===e.id))eliminarEnvio(e.id);});
      return next;
    });
  },[]);

  const cargarArchivo=useCallback(async(file)=>{
    if(!file)return;setLoading(true);setError("");
    try{
      const parsed=await parsearExcel(file);
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
  if(!sesion)return<PantallaLogin onLogin={s=>{setSession(s);setSesion(s);}}/>;
  if(sesion.rol==="logistica"){
    const esChofer=sesion.esChofer===true;
    if(esChofer)return<VistaChofer envios={envios} setEnvios={setEnvios} sesion={sesion} lc={lc}/>;
    return<VistaLogistica envios={envios} sesion={sesion} lc={lc}/>;
  }
  if(sesion.rol==="expedicion")return<VistaExpedicion envios={envios} setEnvios={setEnvios} sesion={sesion} lc={lc}/>;

  if(pantalla==="asignacion"){return<PantallaAsignacion borrador={borrador} fileName={fileName} onConfirmar={confirmarAsignacion} onCancelar={()=>setPantalla("dashboard")} lc={lc}/>;}
  if(pantalla==="asignacion-tn"){return<PantallaAsignacionTN borrador={borrador} onConfirmar={confirmarAsignacion} onCancelar={()=>setPantalla("dashboard")} lc={lc}/>;}

  const esAdmin=sesion?.rol==="admin";
  const esColaborador=sesion?.rol==="colaborador";
  const TABS=[
    {id:"tablero",l:"📊 Tablero"},
    {id:"envios",l:"NO FLEX"},
    {id:"flex",l:"FLEX"},
    {id:"imprimir",l:"Imprimir"},
    {id:"manual",l:"+ Manual"},
    ...(esAdmin?[{id:"tarifas",l:"Tarifas / Log."}]:[]),
    {id:"informe",l:"Informe"},
    {id:"liquidacion",l:"Liquidacion"},
    {id:"ctasctes",l:"Ctas. Ctes."},
    {id:"localidades",l:"Localidades"},
    ...(esAdmin?[{id:"expedicion",l:"Expedicion"},{id:"usuarios",l:"Usuarios"}]:[]),
  ];

  return(
    <div style={{minHeight:"100vh",background:"#0a0e1a",color:"#fff",fontFamily:"sans-serif"}}>
      <style>{`*{box-sizing:border-box;}::-webkit-scrollbar{width:6px;height:10px;}::-webkit-scrollbar-track{background:#0f1420;border-radius:4px;}::-webkit-scrollbar-thumb{background:#4b5563;border-radius:4px;border:1px solid #0f1420;}::-webkit-scrollbar-thumb:hover{background:#9ca3af;}::-webkit-scrollbar-corner{background:#0f1420;}html{scrollbar-width:thin;scrollbar-color:#4b5563 #0f1420;}select option{background:#1a1f2e;color:#e5e7eb;}button:hover{opacity:0.85;}`}</style>
      {toast&&<div style={{position:"fixed",top:"16px",right:"16px",zIndex:999,background:"#041f14",border:"1px solid #10b981",borderRadius:"10px",padding:"0.6rem 1.1rem",color:"#34d399",fontWeight:700,fontSize:"0.82rem"}}>{toast}</div>}
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
          <button onClick={()=>{const tnSinAsignar=envios.filter(e=>e.origen==="Tienda Nube"&&getEstado(e)==="sin_asignar");if(!tnSinAsignar.length){mostrarToast("No hay pedidos TN sin asignar");return;}setBorrador(tnSinAsignar);setFileName("Pedidos TN sin asignar");setPantalla("asignacion-tn");}} style={{padding:"0.33rem 0.75rem",borderRadius:"7px",background:"#0d1c2e",border:"1px solid #38bdf8",color:"#38bdf8",fontWeight:700,fontSize:"0.72rem",cursor:"pointer"}}>Asignar TN</button>
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
              setLoading(true);
              try{
                await procesarConMLArmado(f,"Colecta",null);
                mostrarToast("PDF Colecta procesado");
              }catch(err){
                mostrarToast("Error: "+(err.message||"ML Armado no disponible"));
              }
              setLoading(false);
            }}/>
            <span style={{display:"inline-block",padding:"0.33rem 0.75rem",borderRadius:"7px",background:"#1a0d2e",border:"1px solid #a78bfa",color:"#a78bfa",fontWeight:700,fontSize:"0.72rem",cursor:"pointer"}}>{loading?"...":"📋 Colecta"}</span>
          </label>
          <label style={{cursor:"pointer"}}>
            <input type="file" accept=".xlsx,.xls" style={{display:"none"}} onChange={e=>{if(e.target.files[0]){cargarArchivo(e.target.files[0]);e.target.value="";}}}/>
            <span style={{display:"inline-block",padding:"0.33rem 0.75rem",borderRadius:"7px",background:"linear-gradient(135deg,#6366f1,#8b5cf6)",color:"#fff",fontWeight:700,fontSize:"0.72rem",cursor:"pointer"}}>{loading?"...":"Cargar Excel"}</span>
          </label>
          <span style={{color:"#4b5563",fontSize:"0.7rem",borderLeft:"1px solid #1a1f2e",paddingLeft:"0.5rem"}}>{sesion?.usuario}</span>
          <button onClick={()=>{clearSession();setSesion(null);}} style={{...S.btnSm(false),color:"#f87171",fontSize:"0.7rem"}}>Salir</button>
        </div>
      </div>
      <ScrollTop/>
      <div style={{padding:"0.85rem 1rem",maxWidth:"1400px",margin:"0 auto"}}>
        {error&&<div style={{...S.card,padding:"0.65rem 1rem",marginBottom:"0.8rem",background:"#1c0a0a",border:"1px solid #7f1d1d",color:"#fca5a5",fontSize:"0.8rem"}}>{error}</div>}
        {tab==="tablero" &&<TabTablero envios={envios} lc={lc} zc={zc}/>}
        {tab==="envios"  &&<TabEnvios   envios={envios.filter(e=>e.origen!=="ML")} setEnvios={setEnvios} zc={zc} lc={lc} onReasignar={reasignarSel} esAdmin={esAdmin}/>}
        {tab==="flex"    &&<TabEnvios   envios={envios.filter(e=>e.origen==="ML")}  setEnvios={setEnvios} zc={zc} lc={lc} onReasignar={reasignarSel} esAdmin={esAdmin}/>}
        {tab==="imprimir"&&<TabImprimir envios={envios} zc={zc} lc={lc}/>}
        {tab==="manual"  &&<TabManual   setEnvios={setEnvios} onSuccess={()=>{setTab("envios");mostrarToast("Envio agregado");}} lc={lc} enviosExistentes={envios}/>}
        {tab==="tarifas" &&<TabTarifas  zc={zc} setZc={setZcPersist} lc={lc} setLc={setLcPersist}/>}
        {tab==="informe"     &&<TabInforme     envios={envios} zc={zc} lc={lc}/>}
        {tab==="liquidacion" &&<TabLiquidacion envios={envios} setEnvios={setEnvios} lc={lc}/>}
        {tab==="ctasctes"   &&<TabCtasCtes   envios={envios} lc={lc}/>}
        {tab==="localidades" &&<TabLocalidades cpExtra={cpExtra} setCpExtra={setCpExtra}/>}
        {tab==="usuarios"   &&esAdmin&&<TabUsuarios lc={lc} setLc={setLcPersist}/>}
        {tab==="expedicion" &&esAdmin&&<VistaExpedicion envios={envios} setEnvios={setEnvios} sesion={sesion} lc={lc}/>}
      </div>
    </div>
  );
}
