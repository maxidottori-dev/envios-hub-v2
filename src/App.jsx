import { useState, useCallback, useEffect, useRef } from "react";
import * as XLSXLib from "xlsx";
import { db } from "./firebase.js";
import { collection, onSnapshot, doc, setDoc, deleteDoc } from "firebase/firestore";

const VERSION = "2.0";

// Estado derivado: si tiene trans asignado = asignado, si fue cancelado = cancelado, sino = sin_asignar
function getEstado(e) {
  if (e.estado === "cancelado") return "cancelado";
  if (e.trans) return "asignado";
  return "sin_asignar";
}

function cargarXLSX() { return Promise.resolve(XLSXLib); }

const CP_P = {"1601":"La Plata","1607":"San Isidro","1608":"Tigre","1609":"San Isidro","1610":"Tigre","1611":"Tigre","1612":"Malvinas Argentinas","1613":"Malvinas Argentinas","1614":"Malvinas Argentinas","1615":"Malvinas Argentinas","1616":"Malvinas Argentinas","1617":"Tigre","1618":"Tigre","1619":"Escobar","1620":"Escobar","1621":"Tigre","1622":"Escobar","1623":"Escobar","1624":"Tigre","1625":"Escobar","1626":"Escobar","1627":"Escobar","1628":"Escobar","1629":"Pilar","1630":"Pilar","1631":"Pilar","1632":"Pilar","1633":"Pilar","1634":"Pilar","1635":"Pilar","1636":"Vicente Lopez","1637":"Vicente Lopez","1638":"Vicente Lopez","1640":"San Isidro","1641":"San Isidro","1642":"San Isidro","1643":"San Isidro","1644":"San Fernando","1645":"San Fernando","1646":"San Fernando","1647":"Zarate","1648":"Tigre","1649":"San Fernando","1650":"San Martin","1651":"San Martin","1653":"San Martin","1655":"San Martin","1657":"San Martin","1659":"San Miguel","1660":"Jose C Paz","1661":"San Miguel","1662":"San Miguel","1663":"San Miguel","1664":"Pilar","1665":"Jose C Paz","1666":"Jose C Paz","1667":"Pilar","1669":"Pilar","1670":"Tigre","1671":"Tigre","1672":"San Martin","1674":"Tres de Febrero","1675":"Tres de Febrero","1676":"Tres de Febrero","1678":"Tres de Febrero","1682":"Tres de Febrero","1683":"Tres de Febrero","1684":"Moron","1685":"Moron","1686":"Hurlingham","1687":"Tres de Febrero","1688":"Hurlingham","1689":"La Matanza Norte","1692":"Tres de Febrero","1702":"Tres de Febrero","1703":"Tres de Febrero","1704":"La Matanza Norte","1706":"Moron","1707":"Moron","1708":"Moron","1712":"Moron","1713":"Ituzaingo","1714":"Ituzaingo","1715":"Ituzaingo","1716":"Merlo","1718":"Merlo","1721":"Merlo","1722":"Merlo","1723":"Merlo","1724":"Merlo","1727":"Marcos Paz","1736":"Moreno","1738":"Moreno","1740":"Moreno","1742":"Moreno","1743":"Moreno","1744":"Moreno","1745":"Moreno","1746":"Moreno","1748":"Gral. Rodriguez","1749":"Gral. Rodriguez","1751":"La Matanza Norte","1752":"La Matanza Norte","1753":"La Matanza Norte","1754":"La Matanza Norte","1755":"La Matanza Norte","1757":"La Matanza Sur","1758":"La Matanza Sur","1759":"La Matanza Sur","1761":"La Matanza Norte","1763":"La Matanza Sur","1764":"La Matanza Sur","1765":"La Matanza Sur","1766":"La Matanza Norte","1768":"La Matanza Norte","1770":"La Matanza Norte","1771":"La Matanza Norte","1772":"La Matanza Norte","1774":"La Matanza Norte","1778":"La Matanza Norte","1785":"La Matanza Norte","1786":"La Matanza Sur","1801":"Ezeiza","1802":"Ezeiza","1803":"Ezeiza","1804":"Ezeiza","1805":"Esteban Echeverria","1806":"Ezeiza","1807":"Ezeiza","1808":"Canuelas","1812":"Canuelas","1813":"Ezeiza","1814":"Canuelas","1815":"Canuelas","1816":"Canuelas","1821":"Lomas de Zamora","1822":"Lanus","1823":"Lanus","1824":"Lanus","1825":"Lanus","1826":"Lanus","1827":"Lomas de Zamora","1828":"Lomas de Zamora","1829":"Lomas de Zamora","1831":"Lomas de Zamora","1832":"Lomas de Zamora","1833":"Lomas de Zamora","1834":"Lomas de Zamora","1835":"Lomas de Zamora","1836":"Lomas de Zamora","1837":"Berazategui","1838":"Esteban Echeverria","1839":"Esteban Echeverria","1840":"Quilmes","1841":"Esteban Echeverria","1842":"Esteban Echeverria","1843":"Almirante Brown","1844":"Almirante Brown","1845":"Almirante Brown","1846":"Almirante Brown","1847":"Almirante Brown","1848":"Almirante Brown","1849":"Almirante Brown","1851":"Almirante Brown","1852":"Almirante Brown","1853":"Florencio Varela","1854":"Almirante Brown","1855":"Almirante Brown","1856":"Almirante Brown","1858":"Presidente Peron","1859":"Florencio Varela","1860":"Berazategui","1861":"Berazategui","1862":"Presidente Peron","1863":"Florencio Varela","1864":"San Vicente","1865":"San Vicente","1867":"Florencio Varela","1868":"Avellaneda","1869":"Avellaneda","1870":"Avellaneda","1871":"Avellaneda","1872":"Avellaneda","1873":"Avellaneda","1874":"Avellaneda","1875":"Avellaneda","1876":"Quilmes","1877":"Quilmes","1878":"Quilmes","1879":"Quilmes","1880":"Berazategui","1881":"Quilmes","1882":"Quilmes","1883":"Quilmes","1884":"Berazategui","1885":"Berazategui","1886":"Berazategui","1887":"Florencio Varela","1888":"Florencio Varela","1889":"Florencio Varela","1890":"Berazategui","1891":"Florencio Varela","1893":"Berazategui","1894":"La Plata","1895":"La Plata","1896":"La Plata","1897":"La Plata","1900":"La Plata","1901":"La Plata","1902":"La Plata","1903":"La Plata","1904":"La Plata","1905":"La Plata","1906":"La Plata","1907":"La Plata","1908":"La Plata","1909":"La Plata","1910":"La Plata","1912":"La Plata","1914":"La Plata","1923":"Berisso","1924":"Berisso","1925":"Ensenada","1926":"Ensenada","1927":"Ensenada","1929":"Berisso","1931":"Ensenada","1984":"San Vicente","2800":"Zarate","2801":"Zarate","2802":"Zarate","2804":"Campana","2805":"Campana","2806":"Zarate","2808":"Zarate","2812":"Campana","2814":"Ex.de la Cruz","2816":"Campana","6700":"Lujan","6701":"Lujan","6702":"Lujan","6703":"Ex.de la Cruz","6706":"Lujan","6708":"Lujan","6712":"Lujan"};

function cpAPartido(cp) {
  const s = String(cp||"").replace(/\D/g,"");
  const n = parseInt(s);
  if (n >= 1000 && n <= 1499) return "CABA";
  return CP_P[s] || "";
}

const ZONA_ML = {"CABA":"CABA","Avellaneda":"PL","Lanus":"PL","Quilmes":"PL","Lomas de Zamora":"LOMAS","Almirante Brown":"SUR","Berazategui":"SUR","Esteban Echeverria":"SUR","Florencio Varela":"SUR","Hurlingham":"NOE","Ituzaingo":"NOE","Jose C Paz":"NOE","La Matanza Norte":"NOE","La Matanza Sur":"NOE","Malvinas Argentinas":"NOE","Merlo":"NOE","Moreno":"NOE","Moron":"NOE","San Fernando":"NOE","San Isidro":"NOE","San Martin":"NOE","San Miguel":"NOE","Tigre":"NOE","Tres de Febrero":"NOE","Vicente Lopez":"NOE","La Plata":"GBA2","Zarate":"GBA2","Ensenada":"GBA2","Berisso":"GBA2","Escobar":"GBA2","Marcos Paz":"GBA2","Pilar":"GBA2","Presidente Peron":"GBA2","Canuelas":"GBA2","Lujan":"GBA2","Gral. Rodriguez":"GBA2","Ex.de la Cruz":"GBA2","San Vicente":"GBA2","Campana":"GBA2","Ezeiza":"GBA2"};
const ZONAS_ML_LIST = ["CABA","NOE","SUR","PL","LOMAS","GBA2"];
const ZONA_ML_COLOR = {CABA:"#84cc16",NOE:"#f59e0b",SUR:"#ef4444",PL:"#10b981",LOMAS:"#ec4899",GBA2:"#8b5cf6"};
const ZONA_ML_BG    = {CABA:"#0d1c04",NOE:"#1c1400",SUR:"#1c0404",PL:"#021a0e",LOMAS:"#1c0514",GBA2:"#130d2a"};
function getZonaML(p) { return ZONA_ML[p] || ""; }

function fechaHoy()    { return new Date().toISOString().split("T")[0]; }
function fechaAyer()   { const d=new Date();d.setDate(d.getDate()-1);return d.toISOString().split("T")[0]; }
function fechaManana() { const d=new Date();d.setDate(d.getDate()+1);return d.toISOString().split("T")[0]; }
function fechaInicioSemana() { const d=new Date();d.setDate(d.getDate()-((d.getDay()||7)-1));return d.toISOString().split("T")[0]; }
function fmtCorta(ds) { if(!ds)return"";const[,m,d]=ds.split("-");return d+"/"+m; }
const MESES={enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12};
function parseFechaES(str){const m=String(str||"").toLowerCase().match(/(\d+)\s+de\s+(\w+)\s+de\s+(\d{4})/);if(!m)return"";const mes=MESES[m[2]];if(!mes)return"";return m[3]+"-"+String(mes).padStart(2,"0")+"-"+String(m[1]).padStart(2,"0");}

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
        let hFila = -1;
        for(let i=0;i<Math.min(filas.length,15);i++){if(filas[i].some(c=>typeof c==="string"&&c.includes("# de venta"))){hFila=i;break;}}
        if(hFila<0) throw new Error("No se encontro el encabezado. Es un reporte de Mercado Libre?");
        const h = filas[hFila];
        const col = t => h.findIndex(c=>typeof c==="string"&&c.toLowerCase().includes(t.toLowerCase()));
        const iOrden=col("# de venta"),iFecha=col("fecha"),iDir=col("domicilio");
        const iCiudad=col("ciudad");
        const iCP=col("postal");
        const iSeg=col("seguimiento");
        if(iDir<0) throw new Error("No se encontro la columna Domicilio.");
        const envios = [];
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
        if(envios.length===0) throw new Error("No se encontraron envios con domicilio.");
        resolve(envios);
      } catch(err) { reject(err); }
    };
    reader.readAsArrayBuffer(file);
  });
}

const LOGISTICAS_INIT = {
  CARLOS: {nombre:"CARLOS",color:"#f59e0b",bg:"#1c1400",activa:true,preciosBultos:[{b:1,p:0},{b:2,p:0},{b:3,p:0}]},
  GUS:    {nombre:"GUS",   color:"#3b82f6",bg:"#0c1a2e",activa:true,preciosBultos:[{b:1,p:0},{b:2,p:0},{b:3,p:0}]},
  DELFRAN:{nombre:"DELFRAN",color:"#10b981",bg:"#041f14",activa:true,preciosBultos:[{b:1,p:0},{b:2,p:0},{b:3,p:0}]},
  SYM:    {nombre:"SYM",   color:"#ec4899",bg:"#1c0514",activa:true,preciosBultos:[{b:1,p:0},{b:2,p:0},{b:3,p:0}]},
  HNOS:   {nombre:"HNOS",  color:"#8b5cf6",bg:"#130d2a",activa:true,preciosBultos:[{b:1,p:0},{b:2,p:0},{b:3,p:0}]},
};

const TURNOS=["AM","MD","PM","Turbo"];
const TURNO_C={AM:{c:"#60a5fa",bg:"#0c1a2e"},MD:{c:"#a78bfa",bg:"#130d2a"},PM:{c:"#93c5fd",bg:"#0c1a2e"},Turbo:{c:"#f472b6",bg:"#1c0514"}};
const ESTADO_C={sin_asignar:{t:"#f59e0b",bg:"#1c1400",label:"Sin asignar"},asignado:{t:"#34d399",bg:"#041f14",label:"Asignado"},cancelado:{t:"#f87171",bg:"#1c0a0a",label:"Cancelado"}};

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
function calcImp(e,tmap,lc){
  if(!e.trans)return 0;
  const b=e.bultos||1;
  const cfg=lc[e.trans];
  if(cfg&&b>1){const pb=cfg.preciosBultos?.find(x=>x.b===b);if(pb&&pb.p>0)return pb.p;}
  return tmap[e.partido]?.[e.trans]||0;
}

function getWeekNum(ds){const d=new Date(ds+"T00:00:00"),day=d.getDay()||7;d.setDate(d.getDate()+4-day);const y=new Date(d.getFullYear(),0,1);return{w:Math.ceil((((d-y)/86400000)+1)/7),y:d.getFullYear()};}
function weekLabel(ds){const d=new Date(ds+"T00:00:00"),day=d.getDay()||7;const mon=new Date(d);mon.setDate(d.getDate()-(day-1));const sun=new Date(mon);sun.setDate(mon.getDate()+6);const f=x=>String(x.getDate()).padStart(2,"0")+"/"+String(x.getMonth()+1).padStart(2,"0");return"Sem."+getWeekNum(ds).w+" ("+f(mon)+"-"+f(sun)+")";}

const fmt=n=>n?"$"+Number(n).toLocaleString("es-AR"):"-";
const fmtN=n=>Number(n).toLocaleString("es-AR");

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
  const grupoKeys=modo==="zona"?[...ZONAS_ML_LIST,"Otra"].filter(k=>grupos[k]):Object.keys(grupos).sort();
  const totalAsig=borrador.filter(e=>getA(e.id).trans).length;
  const confirmar=()=>onConfirmar(borrador.map(e=>({...e,...getA(e.id),estado:getA(e.id).trans?"asignado":"sin_asignar"})));
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
                    {logActivas.map(l=><button key={l} onClick={()=>setGrupo(ids,"trans",gT===l?"":l)} style={S.btnSm(gT===l,lc[l].color)}>{l}</button>)}
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
                    {TURNOS.map(t=><button key={t} onClick={()=>setGrupo(ids,"turno",gTu===t?"":t)} style={S.btnSm(gTu===t,"#8b5cf6")}>{t}</button>)}
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
                      {logActivas.map(l=><button key={l} onClick={()=>setA(e.id,"trans",a.trans===l?"":l)} style={S.btnSm(a.trans===l,lc[l].color)}>{l}</button>)}
                      <span style={{color:"#252d40",padding:"0 2px"}}>|</span>
                      {TURNOS.map(t=><button key={t} onClick={()=>setA(e.id,"turno",a.turno===t?"":t)} style={S.btnSm(a.turno===t,"#8b5cf6")}>{t}</button>)}
                      {a.trans&&<Bdg label={a.fecha?fmtCorta(a.fecha):"sin fecha"} bg="#12172a" t="#6b7280"/>}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
        <div style={{display:"flex",justifyContent:"flex-end",gap:"0.75rem",marginTop:"1rem",paddingBottom:"2rem"}}>
          <button onClick={onCancelar} style={S.btn(false)}>Cancelar</button>
          <button onClick={confirmar} style={{...S.btn(true),background:"linear-gradient(135deg,#6366f1,#8b5cf6)",padding:"0.55rem 1.4rem"}}>Confirmar ({totalAsig}/{borrador.length})</button>
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

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.6rem 1rem",marginBottom:"0.65rem"}}>
        <div>
          <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>Logistica</div>
          <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{logActivas.map(l=><button key={l} onClick={()=>handleTrans(l)} style={S.chip(e.trans===l,lc[l].color,lc[l].bg)}>{l}</button>)}</div>
        </div>
        <div>
          <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>Turno</div>
          <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{TURNOS.map(t=>{const tc=TURNO_C[t]||{c:"#a78bfa",bg:"#130d2a"};return <button key={t} onClick={()=>set("turno",e.turno===t?"":t)} style={S.chip(e.turno===t,tc.c,tc.bg)}>{t}</button>;})}</div>
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
          <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{[1,2,3,4,5].map(n=><button key={n} onClick={()=>set("bultos",n)} style={S.btnSm(e.bultos===n,"#6366f1")}>{n}</button>)}</div>
        </div>
        <div>
          <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>Cobranza</div>
          <div style={{display:"flex",gap:"3px",alignItems:"center"}}>
            <button onClick={()=>set("cobranza",e.cobranza!==null?null:0)} style={S.btnSm(e.cobranza!==null,"#f59e0b")}>{e.cobranza!==null?"Activa":"Agregar"}</button>
            {e.cobranza!==null&&<input type="number" placeholder="Monto" value={e.cobranza||""} onChange={ev=>set("cobranza",parseFloat(ev.target.value)||0)} style={{...S.input,width:"120px",padding:"3px 8px",fontSize:"0.8rem"}}/>}
          </div>
        </div>
      </div>

      {/* Notas de la orden — editable (incluye datepicker) */}
      <div style={{marginBottom:"0.5rem"}}>
        <div style={{color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"4px"}}>{esTN?"Notas de la orden":"Observaciones"}</div>
        <textarea value={esTN?(e.notasOrden||""):(e.observaciones||"")} onChange={ev=>set(esTN?"notasOrden":"observaciones",ev.target.value)} placeholder={esTN?"Notas de la orden...":"Notas adicionales..."} style={{...S.input,display:"block",width:"100%",height:"52px",resize:"vertical",fontSize:"0.8rem"}}/>
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

function TabEnvios({envios,setEnvios,zc,lc,onReasignar}){
  const hoy=fechaHoy();
  const [modFecha,setModFecha]=useState("hoy");
  const [rangoD,setRangoD]=useState(hoy);
  const [rangoH,setRangoH]=useState(hoy);
  const [filTrans,setFilTrans]=useState("TODOS");
  const [filEstado,setFilEstado]=useState("TODOS");
  const [filZona,setFilZona]=useState("TODAS");
  const [filTurno,setFilTurno]=useState("TODOS");
  const [busqueda,setBusqueda]=useState("");
  const [editId,setEditId]=useState(null);
  const [seleccionados,setSeleccionados]=useState(new Set());
  const [modoSel,setModoSel]=useState(false);
  const tmap=buildTarifaMap(zc);
  const getImp=e=>calcImp(e,tmap,lc);
  const logActivas=Object.entries(lc).filter(([,v])=>v.activa).map(([k])=>k);
  const getRango=()=>{
    if(modFecha==="todos") return{d:"",h:""};
    if(modFecha==="hoy")    return{d:hoy,h:hoy};
    if(modFecha==="ayer")   return{d:fechaAyer(),h:fechaAyer()};
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
    if(filEstado!=="TODOS"&&est!==filEstado)return false;
    if(filZona!=="TODAS"&&getZonaML(e.partido)!==filZona)return false;
    if(filTurno!=="TODOS"&&e.turno!==filTurno)return false;
    if(filOrigen!=="TODOS"){
      const o=e.origen==="Tienda Nube"?"TN":e.origen==="ML"?"FLEX":"Manual";
      if(o!==filOrigen)return false;
    }
    if(busqueda){const q=busqueda.toLowerCase();return e.direccion.toLowerCase().includes(q)||e.id.includes(q)||e.partido.toLowerCase().includes(q)||(e.nroSeguimiento||"").includes(q)||(e.clienteNombre||"").toLowerCase().includes(q)||(e.nroOrdenTN||"").includes(q);}
    return true;
  });
  const activos=filtrados.filter(e=>getEstado(e)!=="cancelado");
  const totalImp=activos.reduce((s,e)=>s+getImp(e),0);
  const sinAsig=filtrados.filter(e=>getEstado(e)==="sin_asignar").length;
  const porTrans=logActivas.map(l=>({l,n:activos.filter(e=>e.trans===l).length,v:activos.filter(e=>e.trans===l).reduce((s,e)=>s+getImp(e),0)})).filter(x=>x.n>0);
  const [filOrigen,setFilOrigen]=useState("TODOS");
  const toggleSel=id=>setSeleccionados(p=>{const n=new Set(p);n.has(id)?n.delete(id):n.add(id);return n;});
  const saveEnvio=updated=>{setEnvios(p=>p.map(e=>e.id===updated.id?{...updated,estado:getEstado(updated)}:e));setEditId(null);};
  const eliminar=id=>{if(window.confirm("Eliminar este envio?"))setEnvios(p=>p.filter(e=>e.id!==id));};
  const eliminarSel=()=>{if(!window.confirm(`Eliminar ${seleccionados.size} envio(s)?`))return;setEnvios(p=>p.filter(e=>!seleccionados.has(e.id)));setSeleccionados(new Set());setModoSel(false);};
  const reasignarSel=()=>{const items=envios.filter(e=>seleccionados.has(e.id));onReasignar(items);setSeleccionados(new Set());setModoSel(false);};
  const cancelarSel=()=>{if(!window.confirm(`Cancelar ${seleccionados.size} envio(s)?`))return;setEnvios(p=>p.map(e=>seleccionados.has(e.id)?{...e,estado:"cancelado"}:e));setSeleccionados(new Set());setModoSel(false);};
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
    <div>
      <div style={{...S.card,padding:"0.65rem 1rem",marginBottom:"0.7rem"}}>
        <div style={{display:"flex",gap:"4px",flexWrap:"wrap",alignItems:"center",marginBottom:modFecha==="rango"?"0.5rem":"0"}}>
          <span style={{color:"#4b5563",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase",marginRight:"4px"}}>Fecha</span>
          {[{k:"todos",l:"Todos"},{k:"hoy",l:"Hoy"},{k:"ayer",l:"Ayer"},{k:"semana",l:"Esta semana"},{k:"rango",l:"Rango"}].map(x=><button key={x.k} onClick={()=>setModFecha(x.k)} style={S.btn(modFecha===x.k)}>{x.l}</button>)}
        </div>
        {modFecha==="rango"&&<div style={{display:"flex",gap:"0.5rem",alignItems:"center",flexWrap:"wrap"}}>
          <span style={{color:"#6b7280",fontSize:"0.8rem"}}>Desde</span>
          <input type="date" value={rangoD} onChange={e=>setRangoD(e.target.value)} style={{...S.input,padding:"4px 8px",width:"132px"}}/>
          <span style={{color:"#6b7280",fontSize:"0.8rem"}}>hasta</span>
          <input type="date" value={rangoH} onChange={e=>setRangoH(e.target.value)} style={{...S.input,padding:"4px 8px",width:"132px"}}/>
        </div>}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(110px,1fr))",gap:"0.55rem",marginBottom:"0.7rem"}}>
        <div onClick={()=>{setFilTrans("TODOS");setFilEstado("TODOS");}} style={{...S.card,padding:"0.75rem 1rem",cursor:"pointer",borderLeft:(filTrans==="TODOS"&&filEstado==="TODOS")?"3px solid #6366f1":"3px solid transparent"}}><div style={{color:"#6366f1",fontWeight:800,fontSize:"1.8rem",lineHeight:1}}>{filtrados.length}</div><div style={{color:"#6b7280",fontSize:"0.62rem",marginTop:"2px"}}>Todos</div></div>
        <div style={{...S.card,padding:"0.75rem 1rem"}}><div style={{color:"#10b981",fontWeight:800,fontSize:"1.05rem"}}>{fmt(totalImp)}</div><div style={{color:"#6b7280",fontSize:"0.62rem",marginTop:"2px"}}>Total</div></div>
        {sinAsig>0&&<div onClick={()=>setFilEstado(filEstado==="sin_asignar"?"TODOS":"sin_asignar")} style={{...S.card,padding:"0.75rem 1rem",borderLeft:"3px solid #f59e0b",cursor:"pointer",opacity:filEstado==="sin_asignar"?1:0.75}}><div style={{color:"#f59e0b",fontWeight:800,fontSize:"1.8rem",lineHeight:1}}>{sinAsig}</div><div style={{color:"#6b7280",fontSize:"0.62rem",marginTop:"2px"}}>Sin asignar</div></div>}
        {porTrans.map(({l,n,v})=><div key={l} onClick={()=>filtrarPorLogistica(l)} style={{...S.card,padding:"0.75rem 1rem",borderLeft:"3px solid "+lc[l].color,cursor:"pointer",opacity:filTrans===l?1:0.75,outline:filTrans===l?"2px solid "+lc[l].color:"none"}}><div style={{color:lc[l].color,fontWeight:800,fontSize:"1.8rem",lineHeight:1}}>{n}</div><div style={{color:"#6b7280",fontSize:"0.62rem",marginTop:"2px"}}>{l}</div><div style={{color:"#10b981",fontSize:"0.72rem",fontWeight:600,marginTop:"2px"}}>{fmt(v)}</div></div>)}
      </div>
      <div style={{...S.card,padding:"0.6rem 1rem",marginBottom:"0.7rem",display:"flex",gap:"0.4rem",flexWrap:"wrap",alignItems:"center"}}>
        <input value={busqueda} onChange={e=>setBusqueda(e.target.value)} placeholder="Buscar..." style={{...S.input,width:"180px"}}/>
        <span style={{color:"#374151",fontSize:"0.6rem"}}>|</span>
        {["TODOS",...logActivas,"SIN ASIGNAR"].map(t=><button key={t} onClick={()=>setFilTrans(t)} style={S.btnSm(filTrans===t,t==="SIN ASIGNAR"?"#f59e0b":lc[t]?.color||"#6366f1")}>{t}</button>)}
        <span style={{color:"#374151",fontSize:"0.6rem"}}>|</span>
        {["TODAS",...ZONAS_ML_LIST].map(z=><button key={z} onClick={()=>setFilZona(z)} style={S.btnSm(filZona===z,ZONA_ML_COLOR[z]||"#6366f1")}>{z}</button>)}
        <span style={{color:"#374151",fontSize:"0.6rem"}}>|</span>
        {["TODOS",...TURNOS].map(t=><button key={t} onClick={()=>setFilTurno(t)} style={S.btnSm(filTurno===t,"#8b5cf6")}>{t}</button>)}
        <span style={{color:"#374151",fontSize:"0.6rem"}}>|</span>
        {["TODOS","sin_asignar","asignado","cancelado"].map(k=><button key={k} onClick={()=>setFilEstado(k)} style={S.btnSm(filEstado===k,ESTADO_C[k]?.t||"#6366f1")}>{ESTADO_C[k]?.label||"Todos"}</button>)}
        <span style={{color:"#374151",fontSize:"0.6rem"}}>|</span>
        <button onClick={()=>{setModoSel(!modoSel);if(modoSel)setSeleccionados(new Set());}} style={S.btnSm(modoSel,"#6366f1")}>{modoSel?"Cancelar seleccion":"Seleccionar"}</button>
        {modoSel&&<button onClick={()=>setSeleccionados(new Set(filtradosOrdenados.map(e=>e.id)))} style={S.btnSm(false)}>Todos ({filtrados.length})</button>}
        {modoSel&&seleccionados.size>0&&<button onClick={()=>setSeleccionados(new Set())} style={S.btnSm(false)}>Ninguno</button>}
        <span style={{color:"#374151",fontSize:"0.6rem"}}>|</span>
        <span style={{color:"#4b5563",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase"}}>Origen</span>
        {[{k:"TODOS",l:"Todos"},{k:"TN",l:"TN"},{k:"FLEX",l:"FLEX"},{k:"Manual",l:"Manual"}].map(x=><button key={x.k} onClick={()=>setFilOrigen(x.k)} style={S.btnSm(filOrigen===x.k,x.k==="TN"?"#38bdf8":x.k==="FLEX"?"#84cc16":x.k==="Manual"?"#f59e0b":"#6366f1")}>{x.l}</button>)}
      </div>
      <div style={{display:"grid",gap:"4px",paddingBottom:"80px"}}>
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
            <div key={e.id}>
              <div style={{...S.card,padding:"0.55rem 0.75rem",display:"flex",alignItems:"flex-start",gap:"0.5rem",opacity:getEstado(e)==="cancelado"?0.45:1,borderColor:isEdit||isSel?"#6366f1":e.alertaDireccion?"#f59e0b":"#252d40",background:isSel?"#12172a":"#1a1f2e"}}>
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
                  </div>
                  {/* Nombre cliente (TN) o direccion como titulo */}
                  {esTN&&e.clienteNombre&&<div style={{color:"#e5e7eb",fontSize:"0.82rem",fontWeight:600,marginBottom:"1px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.clienteNombre}</div>}
                  <div style={{color:esTN&&e.clienteNombre?"#9ca3af":"#e5e7eb",fontSize:"0.8rem",lineHeight:1.35,textDecoration:getEstado(e)==="cancelado"?"line-through":"none",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.direccion}</div>
                  <div style={{color:"#9ca3af",fontSize:"0.74rem",marginTop:"2px",display:"flex",gap:"6px",flexWrap:"wrap",alignItems:"center"}}>
                    {esTN?<span style={{fontFamily:"monospace",color:"#7dd3fc",fontWeight:600}}>#{e.nroOrdenTN}</span>:<span style={{fontFamily:"monospace",color:"#9ca3af"}}>...{e.id.slice(-10)}</span>}
                    {e.nroSeguimiento&&<span style={{background:"#0f1420",padding:"0 5px",borderRadius:"4px",border:"1px solid #252d40",color:"#9ca3af"}}>📦 {e.nroSeguimiento}</span>}
                    <span style={{color:"#9ca3af"}}>· {e.localidad?e.localidad+" · ":""}{e.partido}</span>
                    {e.fechaVenta&&<span style={{color:"#6b7280"}}>· venta {fmtCorta(e.fechaVenta)}</span>}
                    {e.formaPago&&esTN&&<span style={{color:e.formaPago==="Efectivo"?"#fbbf24":"#9ca3af",fontWeight:e.formaPago==="Efectivo"?700:400}}>· {e.formaPago}</span>}
                    {e.observaciones&&<span style={{color:"#6b7280",fontStyle:"italic"}}>· "{e.observaciones.slice(0,30)}{e.observaciones.length>30?"...":""}"</span>}
                  </div>
                </div>
                <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:"3px",flexShrink:0}}>
                  <div style={{display:"flex",gap:"3px",alignItems:"center"}}>
                    {esTN&&e.linkTN&&<a href={e.linkTN} target="_blank" rel="noreferrer" onClick={ev=>ev.stopPropagation()} title="Ver en Tienda Nube" style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:"26px",height:"26px",borderRadius:"6px",background:"#0d1c2e",border:"1px solid #38bdf8",textDecoration:"none",flexShrink:0,fontSize:"0.7rem"}}>TN</a>}
                    {e.linkML&&<a href={e.linkML} target="_blank" rel="noreferrer" onClick={ev=>ev.stopPropagation()} title="Ver en ML" style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:"26px",height:"26px",borderRadius:"6px",background:"#0f1420",border:"1px solid #252d40",textDecoration:"none",flexShrink:0}}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>}
                    {!modoSel&&<button onClick={ev=>{ev.stopPropagation();eliminar(e.id);}} style={{...S.btnSm(false),padding:"1px 6px",fontSize:"0.68rem",color:"#f87171"}}>x</button>}
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
        <div style={{position:"fixed",bottom:"20px",left:"50%",transform:"translateX(-50%)",background:"#1a1f2e",border:"1px solid #6366f1",borderRadius:"12px",padding:"0.7rem 1.25rem",display:"flex",gap:"0.75rem",alignItems:"center",zIndex:50,boxShadow:"0 4px 20px rgba(0,0,0,0.5)",flexWrap:"wrap"}}>
          <span style={{color:"#e5e7eb",fontWeight:700,fontSize:"0.9rem"}}>{seleccionados.size} seleccionados</span>
          <button onClick={reasignarSel} style={{...S.btn(true),background:"linear-gradient(135deg,#6366f1,#8b5cf6)",padding:"0.45rem 1.1rem"}}>Reasignar</button>
          <button onClick={cancelarSel} style={{...S.btn(true),background:"#7f1d1d",padding:"0.45rem 1.1rem"}}>Cancelar envios</button>
          <button onClick={eliminarSel} style={{...S.btn(true),background:"#450a0a",padding:"0.45rem 1.1rem",color:"#fca5a5"}}>Eliminar</button>
          <button onClick={()=>{setModoSel(false);setSeleccionados(new Set());}} style={S.btn(false)}>Salir</button>
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
  const logActivas=Object.entries(lc).filter(([,v])=>v.activa).map(([k])=>k);
  const tmap=buildTarifaMap(zc);
  const getImp=e=>calcImp(e,tmap,lc);
  const lista=envios.filter(e=>{const f=e.fecha||e.fechaVenta||"";if(fecha&&f!==fecha)return false;if(trans!=="TODOS"&&e.trans!==trans)return false;if(turno!=="TODOS"&&e.turno!==turno)return false;if(filZona!=="TODAS"&&getZonaML(e.partido)!==filZona)return false;return e.estado!=="cancelado";});
  const totalImp=lista.reduce((s,e)=>s+getImp(e),0);
  const cobTotal=lista.filter(e=>e.cobranza).reduce((s,e)=>s+(e.cobranza||0),0);
  const hayCobro=lista.some(e=>e.cobranza);
  const hayCambio=lista.some(e=>e.cambio);
  const hayRetiro=lista.some(e=>e.retiro);
  const hayBultos=lista.some(e=>(e.bultos||1)>1);
  const hayObs=lista.some(e=>e.observaciones);
  const generarPDF=()=>{
    const ahora=new Date();
    const ts=ahora.toLocaleDateString("es-AR",{weekday:"long",day:"numeric",month:"long",year:"numeric"})+" "+ahora.toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"});
    const rows=lista.map((e,i)=>{const zi=getZonaLogistica(zc,e.trans,e.partido);const zml=getZonaML(e.partido);return`<tr><td style="text-align:center;padding:4px 6px;border:1px solid #ddd;">${i+1}</td><td style="padding:4px 6px;border:1px solid #ddd;"><strong>${e.direccion}</strong><br><span style="font-size:9px;color:#555;">${e.partido} CP ${e.cp}</span></td><td style="padding:4px 6px;border:1px solid #ddd;font-family:monospace;font-size:9px;">...${e.id.slice(-10)}</td><td style="padding:4px 6px;border:1px solid #ddd;font-family:monospace;font-size:9px;">${e.nroSeguimiento||"-"}</td><td style="padding:4px 6px;border:1px solid #ddd;">${e.trans||"-"}</td><td style="padding:4px 6px;border:1px solid #ddd;">${zml||"-"}${zi?" / "+zi.nombre:""}</td><td style="padding:4px 6px;border:1px solid #ddd;text-align:center;">${e.turno||"-"}</td><td style="padding:4px 6px;border:1px solid #ddd;text-align:center;">${e.fecha?fmtCorta(e.fecha):"-"}</td>${hayBultos?"<td style='padding:4px 6px;border:1px solid #ddd;text-align:center;'>"+(e.bultos||1)+"</td>":""}${hayCobro?"<td style='padding:4px 6px;border:1px solid #ddd;text-align:right;'>"+(e.cobranza?"$"+Number(e.cobranza).toLocaleString("es-AR"):"-")+"</td>":""}${hayCambio?"<td style='padding:4px 6px;border:1px solid #ddd;font-size:9px;'>"+(e.cambio||"-")+"</td>":""}${hayRetiro?"<td style='padding:4px 6px;border:1px solid #ddd;font-size:9px;'>"+(e.retiro||"-")+"</td>":""}${hayObs?"<td style='padding:4px 6px;border:1px solid #ddd;font-size:9px;color:#666;'>"+(e.observaciones||"-")+"</td>":""}<td style="padding:4px 6px;border:1px solid #ddd;text-align:center;">&#9633;</td></tr>`;}).join("");
    const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Envios ${fecha}</title><style>@page{size:A4 landscape;margin:10mm;}body{font-family:Arial,sans-serif;font-size:10px;margin:0;}h2{margin:0 0 2px;font-size:12px;}table{width:100%;border-collapse:collapse;}th{background:#e8e8e8;padding:3px 6px;text-align:left;font-size:9px;text-transform:uppercase;border:1px solid #ccc;}td{vertical-align:top;}tr:nth-child(even) td{background:#fafafa;}.meta{display:flex;gap:10px;margin:4px 0 8px;font-size:9px;flex-wrap:wrap;}.meta span{background:#f0f0f0;padding:1px 7px;border-radius:3px;}.footer{margin-top:8px;padding-top:5px;border-top:1px solid #ccc;font-size:9px;}@media print{button{display:none!important;}}</style></head><body><h2>Hoja de salida de envios</h2><div style="font-size:8px;color:#666;margin-bottom:4px;">Impreso: ${ts}</div><div class="meta"><span>Envios: <strong>${lista.length}</strong></span><span>Logistica: <strong>${trans==="TODOS"?"Todas":trans}</strong></span><span>Zona ML: <strong>${filZona==="TODAS"?"Todas":filZona}</strong></span><span>Turno: <strong>${turno==="TODOS"?"Todos":turno}</strong></span><span>Fecha: <strong>${fecha}</strong></span><span>Total: <strong>$${totalImp.toLocaleString("es-AR")}</strong></span>${cobTotal?`<span>Cobranzas: <strong>$${cobTotal.toLocaleString("es-AR")}</strong></span>`:""}</div><table><thead><tr><th style="width:22px;">#</th><th>Direccion</th><th style="width:80px;">Nro.venta</th><th style="width:85px;">Nro.envio</th><th style="width:55px;">Logistica</th><th style="width:75px;">Zona</th><th style="width:40px;">Turno</th><th style="width:48px;">Fecha</th>${hayBultos?"<th style='width:30px;'>Blts</th>":""}${hayCobro?"<th style='width:65px;'>Cobrar</th>":""}${hayCambio?"<th>Cambio</th>":""}${hayRetiro?"<th>Retiro</th>":""}${hayObs?"<th>Observ.</th>":""}<th style="width:24px;text-align:center;">Chk</th></tr></thead><tbody>${rows}</tbody></table><div class="footer">Total: <strong>$${totalImp.toLocaleString("es-AR")}</strong> · ${lista.length} envios${cobTotal?" · Cobranzas: $"+cobTotal.toLocaleString("es-AR"):""}</div><script>window.onload=function(){window.print();}<\/script></body></html>`;
    const w=window.open("","_blank");if(!w){alert("Permite ventanas emergentes.");return;}w.document.write(html);w.document.close();
  };
  return(
    <div>
      <div style={{...S.card,padding:"0.75rem 1rem",marginBottom:"0.9rem",display:"flex",gap:"0.5rem",flexWrap:"wrap",alignItems:"center"}}>
        <div style={{display:"flex",alignItems:"center",gap:"0.5rem"}}><span style={{color:"#6b7280",fontSize:"0.65rem",fontWeight:700,textTransform:"uppercase"}}>Fecha</span><input type="date" value={fecha} onChange={e=>setFecha(e.target.value)} style={{...S.input,padding:"5px 10px",width:"140px"}}/></div>
        <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{["TODOS",...logActivas].map(t=><button key={t} onClick={()=>setTrans(t)} style={S.btnSm(trans===t,lc[t]?.color||"#6366f1")}>{t}</button>)}</div>
        <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{["TODAS",...ZONAS_ML_LIST].map(z=><button key={z} onClick={()=>setFilZona(z)} style={S.btnSm(filZona===z,ZONA_ML_COLOR[z]||"#6366f1")}>{z}</button>)}</div>
        <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{["TODOS",...TURNOS].map(t=><button key={t} onClick={()=>setTurno(t)} style={S.btnSm(turno===t,"#8b5cf6")}>{t}</button>)}</div>
        <button onClick={generarPDF} style={{marginLeft:"auto",...S.btn(true),background:"linear-gradient(135deg,#6366f1,#8b5cf6)",padding:"0.5rem 1.1rem"}}>Generar PDF</button>
      </div>
      <div style={{...S.card,padding:"0.65rem 1rem",marginBottom:"0.9rem",display:"flex",gap:"1.5rem",flexWrap:"wrap"}}>
        <div><span style={{color:"#6b7280",fontSize:"0.72rem"}}>Envios: </span><span style={{color:"#e5e7eb",fontWeight:700}}>{lista.length}</span></div>
        <div><span style={{color:"#6b7280",fontSize:"0.72rem"}}>Total: </span><span style={{color:"#10b981",fontWeight:700}}>{fmt(totalImp)}</span></div>
        {cobTotal>0&&<div><span style={{color:"#6b7280",fontSize:"0.72rem"}}>A cobrar: </span><span style={{color:"#fbbf24",fontWeight:700}}>{fmt(cobTotal)}</span></div>}
      </div>
      {lista.length===0?<div style={{textAlign:"center",padding:"3rem",color:"#4b5563"}}><div style={{fontSize:"2rem"}}>📋</div><p>Sin envios para los filtros</p></div>:(
        <div style={{...S.card,overflow:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:"0.8rem"}}>
            <thead><tr style={{background:"#12172a",borderBottom:"1px solid #252d40"}}>
              <th style={{...thSt,width:"28px",textAlign:"center"}}>#</th><th style={thSt}>Direccion</th><th style={thSt}>Nro.venta</th><th style={thSt}>Nro.envio</th><th style={thSt}>Logistica</th><th style={thSt}>Zona</th><th style={thSt}>Turno</th><th style={thSt}>Fecha</th>
              {hayBultos&&<th style={thSt}>Blts</th>}{hayCobro&&<th style={thSt}>Cobrar</th>}{hayCambio&&<th style={thSt}>Cambio</th>}{hayRetiro&&<th style={thSt}>Retiro</th>}{hayObs&&<th style={thSt}>Observ.</th>}
              <th style={{...thSt,textAlign:"center",width:"28px"}}>Chk</th>
            </tr></thead>
            <tbody>{lista.map((e,i)=>{const zi=getZonaLogistica(zc,e.trans,e.partido);const zml=getZonaML(e.partido);const li=lc[e.trans];return(
              <tr key={e.id} style={{borderBottom:"1px solid #1a1f2e",background:i%2===0?"transparent":"#0d1119"}}>
                <td style={{...tdSt,textAlign:"center",color:"#4b5563"}}>{i+1}</td>
                <td style={{...tdSt,maxWidth:"200px"}}><div style={{color:"#e5e7eb",fontSize:"0.8rem",whiteSpace:"normal",lineHeight:1.3}}>{e.direccion}</div><div style={{color:"#4b5563",fontSize:"0.66rem"}}>{e.partido} CP {e.cp}</div></td>
                <td style={{...tdSt,fontFamily:"monospace",fontSize:"0.7rem",color:"#6b7280"}}>...{e.id.slice(-10)}</td>
                <td style={{...tdSt,fontFamily:"monospace",fontSize:"0.7rem",color:"#9ca3af"}}>{e.nroSeguimiento||"-"}</td>
                <td style={tdSt}>{e.trans?<Bdg label={e.trans} bg={li?.bg||"#1a1f2e"} t={li?.color||"#6b7280"}/>:<span style={{color:"#374151"}}>-</span>}</td>
                <td style={tdSt}><div style={{display:"flex",gap:"3px"}}>{zml&&<Bdg label={zml} bg={ZONA_ML_BG[zml]||"#1a1f2e"} t={ZONA_ML_COLOR[zml]||"#6b7280"}/>}{zi&&<Bdg label={zi.nombre} bg={zi.color+"22"} t={zi.color}/>}</div></td>
                <td style={tdSt}>{e.turno?<Bdg label={e.turno} bg={TURNO_C[e.turno]?.bg||"#130d2a"} t={TURNO_C[e.turno]?.c||"#a78bfa"}/>:<span style={{color:"#374151"}}>-</span>}</td>
                <td style={{...tdSt,color:"#9ca3af"}}>{e.fecha?fmtCorta(e.fecha):"-"}</td>
                {hayBultos&&<td style={{...tdSt,textAlign:"center",color:(e.bultos||1)>1?"#60a5fa":"#4b5563"}}>{e.bultos||1}</td>}
                {hayCobro&&<td style={tdSt}>{e.cobranza?<span style={{color:"#fbbf24",fontWeight:700}}>{fmt(e.cobranza)}</span>:<span style={{color:"#374151"}}>-</span>}</td>}
                {hayCambio&&<td style={{...tdSt,maxWidth:"100px",fontSize:"0.73rem",color:"#ec4899",whiteSpace:"normal"}}>{e.cambio||"-"}</td>}
                {hayRetiro&&<td style={{...tdSt,maxWidth:"100px",fontSize:"0.73rem",color:"#f97316",whiteSpace:"normal"}}>{e.retiro||"-"}</td>}
                {hayObs&&<td style={{...tdSt,maxWidth:"100px",fontSize:"0.73rem",color:"#6b7280",whiteSpace:"normal"}}>{e.observaciones||"-"}</td>}
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
  const vacio={id:"",nroSeguimiento:"",linkML:"",direccion:"",ciudad:"",cp:"",origen:"ML",trans:"",fecha:hoy,turno:"",estado:"sin_asignar",cobranza:null,cambio:null,retiro:null,observaciones:"",bultos:1,partido:"",importe:0,fechaVenta:hoy};
  const [f,setF]=useState(vacio);
  const [err,setErr]=useState("");
  const [dupWarn,setDupWarn]=useState("");
  const set=(k,v)=>setF(p=>({...p,[k]:v}));
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
          <div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Origen</label><div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{["ML","Tienda Nube","Particular","Otro"].map(o=><button key={o} onClick={()=>set("origen",o)} style={S.btnSm(f.origen===o,"#6366f1")}>{o}</button>)}</div></div>
          <div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Bultos</label><div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{[1,2,3,4,5].map(n=><button key={n} onClick={()=>set("bultos",n)} style={S.btnSm(f.bultos===n,"#6366f1")}>{n}</button>)}</div></div>
        </div>
        <div style={{marginBottom:"0.7rem"}}><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Direccion completa</label><textarea value={f.direccion} onChange={e=>set("direccion",e.target.value)} style={{...S.input,width:"100%",height:"56px",resize:"vertical"}} placeholder="Calle, numero..."/></div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"0.7rem",marginBottom:"0.7rem"}}>
          <div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>CP</label><input value={f.cp} onChange={e=>set("cp",e.target.value)} style={{...S.input,width:"100%"}} placeholder="1642"/></div>
          <div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Partido (auto)</label><input value={f.partido} onChange={e=>set("partido",e.target.value)} style={{...S.input,width:"100%",color:f.partido?"#10b981":"#6b7280"}} placeholder="Por CP"/></div>
          <div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Zona ML</label><div style={{...S.input,padding:"0.45rem 0.6rem",color:ZONA_ML_COLOR[getZonaML(f.partido)]||"#6b7280",fontSize:"0.8rem",fontWeight:700}}>{getZonaML(f.partido)||"-"}</div></div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.7rem",marginBottom:"0.7rem"}}>
          <div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Logistica</label><div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{logActivas.map(l=><button key={l} onClick={()=>handleTrans(l)} style={S.btnSm(f.trans===l,lc[l].color)}>{l}</button>)}</div></div>
          <div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Turno</label><div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{TURNOS.map(t=><button key={t} onClick={()=>set("turno",f.turno===t?"":t)} style={S.btnSm(f.turno===t,"#8b5cf6")}>{t}</button>)}</div></div>
          <div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Fecha entrega</label><input type="date" value={f.fecha} onChange={e=>set("fecha",e.target.value)} style={{...S.input,width:"100%"}}/></div>
        </div>
        <div style={{marginBottom:"0.6rem"}}><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Observaciones</label><textarea value={f.observaciones} onChange={e=>set("observaciones",e.target.value)} style={{...S.input,display:"block",width:"100%",height:"44px",resize:"vertical",fontSize:"0.8rem"}} placeholder="Notas adicionales..."/></div>
        <div style={{...S.card,padding:"0.65rem 1rem",marginBottom:"0.55rem",background:"#0f1420"}}><div style={{display:"flex",alignItems:"center",gap:"0.75rem"}}><button onClick={()=>set("cobranza",f.cobranza!==null?null:0)} style={S.btnSm(f.cobranza!==null,"#f59e0b")}>Cobranza</button>{f.cobranza!==null?<input type="number" placeholder="Monto" value={f.cobranza||""} onChange={e=>set("cobranza",parseFloat(e.target.value)||0)} style={{...S.input,width:"150px",padding:"4px 10px"}}/>:<span style={{color:"#374151",fontSize:"0.78rem"}}>Sin cobranza</span>}</div></div>
        <div style={{...S.card,padding:"0.65rem 1rem",marginBottom:"0.55rem",background:"#0f1420"}}><button onClick={()=>set("cambio",f.cambio!==null?null:"")} style={S.btnSm(f.cambio!==null,"#ec4899")}>Cambio</button>{f.cambio!==null?<textarea value={f.cambio||""} onChange={e=>set("cambio",e.target.value)} placeholder="Que retirar para el cambio..." style={{...S.input,display:"block",width:"100%",marginTop:"6px",height:"44px",resize:"vertical"}}/>:<span style={{color:"#374151",fontSize:"0.78rem",marginLeft:"8px"}}>Sin cambio</span>}</div>
        <div style={{...S.card,padding:"0.65rem 1rem",marginBottom:"0.9rem",background:"#0f1420"}}><button onClick={()=>set("retiro",f.retiro!==null?null:"")} style={S.btnSm(f.retiro!==null,"#f97316")}>Retiro</button>{f.retiro!==null?<textarea value={f.retiro||""} onChange={e=>set("retiro",e.target.value)} placeholder="Que tiene que retirar..." style={{...S.input,display:"block",width:"100%",marginTop:"6px",height:"44px",resize:"vertical"}}/>:<span style={{color:"#374151",fontSize:"0.78rem",marginLeft:"8px"}}>Sin retiro</span>}</div>
        <div style={{display:"flex",justifyContent:"flex-end",gap:"0.5rem"}}><button onClick={()=>{setF(vacio);setErr("");setDupWarn("");}} style={S.btn(false)}>Limpiar</button><button onClick={guardar} style={{...S.btn(true),background:"linear-gradient(135deg,#6366f1,#8b5cf6)",padding:"0.5rem 1.2rem"}}>Agregar envio</button></div>
      </div>
    </div>
  );
}

function TabTarifas({zc,setZc,lc,setLc}){
  const [subTab,setSubTab]=useState("zonas");
  const [logSel,setLogSel]=useState("HNOS");
  const [editando,setEditando]=useState(null);
  const [moverModal,setMoverModal]=useState(null);
  const [addModal,setAddModal]=useState(false);
  const [newZona,setNewZona]=useState({nombre:"",color:"#6366f1",precio:0});
  const logActivas=Object.keys(lc).filter(k=>lc[k].activa);
  useEffect(()=>{if(!lc[logSel]?.activa&&logActivas.length>0)setLogSel(logActivas[0]);},[lc]);
  const cfg=zc[logSel]||{zonas:[]};
  const asig=new Set(cfg.zonas.flatMap(z=>z.partidos));
  const sinAsig=ALL_PARTIDOS.filter(p=>!asig.has(p));
  const upd=fn=>setZc(p=>({...p,[logSel]:{...p[logSel],zonas:fn(p[logSel]?.zonas||[])}}));
  const updP=(id,v)=>upd(zs=>zs.map(z=>z.id===id?{...z,precio:parseInt(v)||0}:z));
  const updC=(id,c)=>upd(zs=>zs.map(z=>z.id===id?{...z,color:c}:z));
  const updN=(id,n)=>upd(zs=>zs.map(z=>z.id===id?{...z,nombre:n}:z));
  const elimZ=id=>{if(!window.confirm("Eliminar zona?"))return;upd(zs=>zs.filter(z=>z.id!==id));};
  const moverP=(p,dest)=>upd(zs=>zs.map(z=>({...z,partidos:z.id===dest?[...new Set([...z.partidos,p])]:z.partidos.filter(x=>x!==p)})));
  const quitarP=p=>upd(zs=>zs.map(z=>({...z,partidos:z.partidos.filter(x=>x!==p)})));
  const addZ=()=>{if(!newZona.nombre.trim())return;const id=newZona.nombre.toUpperCase().replace(/\s+/g,"_")+"_"+Date.now();upd(zs=>[...zs,{id,...newZona,partidos:[]}]);setAddModal(false);setNewZona({nombre:"",color:"#6366f1",precio:0});};
  const toggleLog=k=>setLc(p=>({...p,[k]:{...p[k],activa:!p[k].activa}}));
  const updBulto=(k,b,p2)=>setLc(p=>({...p,[k]:{...p[k],preciosBultos:p[k].preciosBultos.map(x=>x.b===b?{...x,p:parseInt(p2)||0}:x)}}));
  const addBulto=k=>setLc(p=>{const lk=p[k];const maxB=Math.max(...(lk.preciosBultos||[]).map(x=>x.b),0);return{...p,[k]:{...lk,preciosBultos:[...(lk.preciosBultos||[]),{b:maxB+1,p:0}]}};});
  const delBulto=(k,b)=>setLc(p=>({...p,[k]:{...p[k],preciosBultos:p[k].preciosBultos.filter(x=>x.b!==b)}}));
  return(
    <div>
      <div style={{...S.card,padding:"0.65rem 1rem",marginBottom:"1rem",display:"flex",gap:"4px",flexWrap:"wrap",alignItems:"center"}}>
        <button onClick={()=>setSubTab("zonas")} style={S.btn(subTab==="zonas")}>Zonas y precios</button>
        <button onClick={()=>setSubTab("bultos")} style={S.btn(subTab==="bultos")}>Precios por bultos</button>
        <button onClick={()=>setSubTab("logisticas")} style={S.btn(subTab==="logisticas")}>Logisticas</button>
        {subTab!=="logisticas"&&<><span style={{color:"#374151",fontSize:"0.65rem",margin:"0 4px"}}>|</span>{Object.entries(lc).filter(([,v])=>v.activa).map(([k,v])=><button key={k} onClick={()=>setLogSel(k)} style={S.btn(logSel===k,v.color)}>{k}</button>)}</>}
        {subTab==="zonas"&&<span style={{marginLeft:"auto",color:"#4b5563",fontSize:"0.72rem"}}>Doble clic en el precio</span>}
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
                {zona.partidos.map(p=><div key={p} style={{display:"flex",alignItems:"center",gap:"0.2rem",padding:"2px 6px",background:"#0f1420",border:"1px solid "+zona.color+"44",borderRadius:"5px"}}><button onClick={()=>setMoverModal({p,from:zona.id})} style={{background:"none",border:"none",color:"#d1d5db",cursor:"pointer",fontSize:"0.68rem",padding:0}}>{p}</button><button onClick={()=>quitarP(p)} style={{background:"none",border:"none",color:"#374151",cursor:"pointer",fontSize:"0.6rem",padding:0}}>x</button></div>)}
              </div>
            </div>
          ))}
          <div onClick={()=>setAddModal(true)} style={{...S.card,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:"0.4rem",minHeight:"130px",cursor:"pointer",border:"1px dashed #252d40",background:"transparent"}}><span style={{color:"#374151",fontSize:"1.6rem"}}>+</span><span style={{color:"#4b5563",fontSize:"0.78rem"}}>Nueva zona</span></div>
        </div>
        {sinAsig.length>0&&<div style={{...S.card,padding:"0.65rem 1rem"}}><div style={{color:"#f59e0b",fontWeight:700,fontSize:"0.68rem",marginBottom:"0.4rem"}}>Sin asignar ({sinAsig.length})</div><div style={{display:"flex",flexWrap:"wrap",gap:"0.3rem"}}>{sinAsig.map(p=><button key={p} onClick={()=>setMoverModal({p,from:null})} style={{padding:"2px 8px",background:"#1c1500",border:"1px solid #78350f",borderRadius:"5px",color:"#fbbf24",fontSize:"0.7rem",cursor:"pointer"}}>{p}</button>)}</div></div>}
      </>}
      {subTab==="bultos"&&<div style={{...S.card,overflow:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:"0.85rem"}}>
          <thead><tr style={{background:"#12172a",borderBottom:"1px solid #252d40"}}><th style={thSt}>Bultos</th><th style={{...thSt,color:"#6b7280"}}>Precio (0 = usa precio de zona)</th><th style={{...thSt,width:"40px"}}></th></tr></thead>
          <tbody>{(lc[logSel]?.preciosBultos||[]).map(({b,p})=><tr key={b} style={{borderBottom:"1px solid #1a1f2e"}}><td style={{...tdSt,color:"#e5e7eb",fontWeight:700}}>{b} {b===1?"bulto":"bultos"}</td><td style={tdSt}><input type="number" value={p||""} onChange={e=>updBulto(logSel,b,e.target.value)} placeholder="0 = precio de zona" style={{...S.input,width:"200px",padding:"4px 10px"}}/>{p>0&&<span style={{color:"#10b981",marginLeft:"8px",fontSize:"0.8rem"}}>{fmt(p)}</span>}</td><td style={tdSt}>{b>1&&<button onClick={()=>delBulto(logSel,b)} style={{background:"none",border:"none",color:"#f87171",cursor:"pointer",fontSize:"0.8rem"}}>x</button>}</td></tr>)}</tbody>
        </table>
        <div style={{padding:"0.75rem 1rem"}}><button onClick={()=>addBulto(logSel)} style={{...S.btn(false),border:"1px dashed #252d40"}}>+ Agregar fila de bultos</button></div>
      </div>}
      {subTab==="logisticas"&&<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:"0.85rem"}}>
        {Object.entries(lc).map(([k,v])=>(
          <div key={k} style={{...S.card,borderTop:"3px solid "+(v.activa?v.color:"#374151"),overflow:"hidden",opacity:v.activa?1:0.6}}>
            <div style={{padding:"0.75rem 1rem",display:"flex",alignItems:"center",justifyContent:"space-between"}}><span style={{color:v.activa?v.color:"#6b7280",fontWeight:800,fontSize:"1rem"}}>{v.nombre}</span><button onClick={()=>toggleLog(k)} style={{...S.btnSm(v.activa,v.color),padding:"4px 12px"}}>{v.activa?"Activa":"Desactivada"}</button></div>
            <div style={{padding:"0 1rem 0.75rem",color:"#4b5563",fontSize:"0.75rem"}}>{v.activa?"Visible en la app":"No aparece en asignacion ni filtros"}</div>
          </div>
        ))}
      </div>}
      {moverModal&&<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}><div style={{...S.card,padding:"1.1rem",width:"100%",maxWidth:"320px"}}><h3 style={{margin:"0 0 0.2rem",fontWeight:800,fontSize:"0.95rem"}}>Mover: {moverModal.p}</h3><p style={{margin:"0 0 0.9rem",color:"#9ca3af",fontSize:"0.82rem"}}>A que zona?</p><div style={{display:"grid",gap:"0.35rem"}}>{cfg.zonas.filter(z=>z.id!==moverModal.from).map(z=><button key={z.id} onClick={()=>{moverP(moverModal.p,z.id);setMoverModal(null);}} style={{padding:"0.5rem 0.9rem",background:"#0f1420",border:"1px solid "+z.color,borderRadius:"8px",color:z.color,fontWeight:700,cursor:"pointer",textAlign:"left",fontSize:"0.82rem",display:"flex",justifyContent:"space-between"}}><span>{z.nombre}</span><span style={{color:"#6b7280",fontWeight:400}}>{fmt(z.precio)}</span></button>)}</div><button onClick={()=>setMoverModal(null)} style={{...S.btn(false),marginTop:"0.65rem",width:"100%"}}>Cancelar</button></div></div>}
      {addModal&&<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}><div style={{...S.card,padding:"1.25rem",width:"100%",maxWidth:"320px"}}><h3 style={{margin:"0 0 0.9rem",fontWeight:800}}>Nueva zona - {logSel}</h3><div style={{display:"grid",gap:"0.65rem"}}><div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Nombre</label><input value={newZona.nombre} onChange={e=>setNewZona(p=>({...p,nombre:e.target.value}))} style={{...S.input,width:"100%"}} placeholder="ej. ZONA 4"/></div><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.65rem"}}><div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Color</label><input type="color" value={newZona.color} onChange={e=>setNewZona(p=>({...p,color:e.target.value}))} style={{width:"100%",height:"34px",borderRadius:"7px",border:"1px solid #252d40",cursor:"pointer"}}/></div><div><label style={{display:"block",color:"#6b7280",fontSize:"0.62rem",fontWeight:700,textTransform:"uppercase",marginBottom:"3px"}}>Precio</label><input type="number" value={newZona.precio} onChange={e=>setNewZona(p=>({...p,precio:parseInt(e.target.value)||0}))} style={{...S.input,width:"100%"}}/></div></div></div><div style={{display:"flex",gap:"0.5rem",marginTop:"1rem",justifyContent:"flex-end"}}><button onClick={()=>setAddModal(false)} style={S.btn(false)}>Cancelar</button><button onClick={addZ} style={{...S.btn(true),background:lc[logSel]?.color||"#6366f1"}}>Crear</button></div></div></div>}
    </div>
  );
}

function TabInforme({envios,zc,lc}){
  const [semanaSel,setSemanaSel]=useState("");
  const [logSel,setLogSel]=useState("TODAS");
  const logActivas=Object.entries(lc).filter(([,v])=>v.activa).map(([k])=>k);
  const tmap=buildTarifaMap(zc);
  const getImp=e=>calcImp(e,tmap,lc);
  const semMap={};
  envios.forEach(e=>{const ds=e.fecha||e.fechaVenta||"";if(!ds)return;const{w,y}=getWeekNum(ds);const key=y+"-"+String(w).padStart(2,"0");if(!semMap[key])semMap[key]={key,label:weekLabel(ds),fechas:new Set()};semMap[key].fechas.add(ds);});
  const semanas=Object.keys(semMap).sort().reverse();
  useEffect(()=>{if(semanas.length&&!semanaSel)setSemanaSel(semanas[0]);},[envios]);
  const semFechas=semanaSel&&semMap[semanaSel]?[...semMap[semanaSel].fechas].sort():[];
  const envSem=envios.filter(e=>{const ds=e.fecha||e.fechaVenta||"";return semFechas.includes(ds)&&e.estado!=="cancelado"&&(logSel==="TODAS"||e.trans===logSel);});
  const logsMost=logSel==="TODAS"?logActivas:[logSel];
  if(!envios.length)return<div style={{textAlign:"center",padding:"3rem",color:"#4b5563"}}><div style={{fontSize:"2rem"}}>📊</div><p>Carga un Excel primero</p></div>;
  return(
    <div>
      <div style={{...S.card,padding:"0.65rem 1rem",marginBottom:"0.8rem",display:"flex",gap:"0.4rem",flexWrap:"wrap",alignItems:"center"}}>
        <span style={{color:"#4b5563",fontSize:"0.65rem",fontWeight:700}}>SEMANA</span>
        {semanas.map(s=><button key={s} onClick={()=>setSemanaSel(s)} style={S.btn(semanaSel===s)}>{semMap[s].label}</button>)}
      </div>
      <div style={{...S.card,padding:"0.55rem 1rem",marginBottom:"0.8rem",display:"flex",gap:"0.35rem",flexWrap:"wrap"}}>
        <button onClick={()=>setLogSel("TODAS")} style={S.btn(logSel==="TODAS")}>TODAS</button>
        {logActivas.map(l=><button key={l} onClick={()=>setLogSel(l)} style={S.btn(logSel===l,lc[l].color)}>{l}</button>)}
      </div>
      {logsMost.map(l=>{
        const lcD=lc[l];const envL=envSem.filter(e=>e.trans===l);if(!envL.length)return null;
        const porZona={};
        envL.forEach(e=>{const zi=getZonaLogistica(zc,l,e.partido);const k=zi?zi.nombre:"Sin zona";if(!porZona[k])porZona[k]={nombre:k,color:zi?.color||"#374151",envios:[]};porZona[k].envios.push(e);});
        const totalL=envL.reduce((s,e)=>s+getImp(e),0);
        return(
          <div key={l} style={{...S.card,marginBottom:"1rem",overflow:"hidden"}}>
            <div style={{padding:"0.7rem 1rem",background:"#12172a",borderBottom:"1px solid #252d40",display:"flex",alignItems:"center",gap:"0.75rem"}}>
              <span style={{color:lcD.color,fontWeight:800,fontSize:"1rem"}}>{l}</span>
              <span style={{color:"#e5e7eb",fontWeight:700}}>{envL.length} envios</span>
              <span style={{color:"#10b981",fontWeight:700,marginLeft:"auto"}}>{fmt(totalL)}</span>
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
      {logSel==="TODAS"&&<div style={{...S.card,padding:"0.8rem 1rem",background:"#12172a",display:"flex",gap:"1.5rem",flexWrap:"wrap"}}><span style={{color:"#6366f1",fontWeight:800,fontSize:"0.9rem"}}>TOTAL SEMANA</span><span style={{color:"#e5e7eb",fontWeight:700}}>{envSem.length} envios</span><span style={{color:"#10b981",fontWeight:800,fontSize:"1rem"}}>{fmt(envSem.reduce((s,e)=>s+getImp(e),0))}</span></div>}
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
    if (filTurno !== "TODOS" && e.turno !== filTurno) return false;
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
        {["TODOS", ...TURNOS].map(t => <button key={t} onClick={() => setFilTurno(t)} style={S.btnSm(filTurno === t, "#8b5cf6")}>{t}</button>)}
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
  const [seccion, setSeccion] = useState("cobranzas"); // cobranzas | retiros
  const [filTrans, setFilTrans] = useState("TODOS");
  const [filEstado, setFilEstado] = useState("pendiente"); // pendiente | recibido | todos
  const [notaModal, setNotaModal] = useState(null); // {id, tipo, nota}
  const logActivas = Object.entries(lc).filter(([,v]) => v.activa).map(([k]) => k);

  // Envios con cobranza
  const conCobranza = envios.filter(e =>
    e.cobranza !== null && e.cobranza !== undefined && e.cobranza > 0 && getEstado(e) !== "cancelado"
  );
  // Envios con cambio o retiro
  const conRetiro = envios.filter(e =>
    (e.cambio !== null || e.retiro !== null) && getEstado(e) !== "cancelado"
  );

  const lista = (seccion === "cobranzas" ? conCobranza : conRetiro).filter(e => {
    if (filTrans !== "TODOS" && e.trans !== filTrans) return false;
    const campo = seccion === "cobranzas" ? "cobranzaRecibida" : "retiroRecibido";
    const recibido = !!e[campo];
    if (filEstado === "pendiente" && recibido) return false;
    if (filEstado === "recibido" && !recibido) return false;
    return true;
  });

  // Totales cobranzas
  const totalEsperado = conCobranza.filter(e => filTrans === "TODOS" || e.trans === filTrans).reduce((s,e) => s + (e.cobranza||0), 0);
  const totalRecibido = conCobranza.filter(e => (filTrans === "TODOS" || e.trans === filTrans) && e.cobranzaRecibida).reduce((s,e) => s + (e.cobranza||0), 0);
  const totalPendiente = totalEsperado - totalRecibido;

  // Por logistica - cobranzas
  const porLogCob = logActivas.map(l => {
    const envL = conCobranza.filter(e => e.trans === l);
    return {
      l,
      total: envL.reduce((s,e) => s + (e.cobranza||0), 0),
      recibido: envL.filter(e => e.cobranzaRecibida).reduce((s,e) => s + (e.cobranza||0), 0),
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
          {porLogCob.map(({ l, total, recibido, pendienteN }) => (
            <div key={l} style={{ ...S.card, padding: "0.75rem 1rem", borderLeft: "3px solid " + lc[l].color }}>
              <div style={{ color: lc[l].color, fontWeight: 800, fontSize: "0.9rem" }}>{l}</div>
              <div style={{ color: "#10b981", fontWeight: 700, fontSize: "0.85rem" }}>{fmt(total)}</div>
              {pendienteN > 0 && <div style={{ color: "#f59e0b", fontSize: "0.68rem", marginTop: "2px" }}>{pendienteN} pendiente{pendienteN !== 1 ? "s" : ""}</div>}
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
                    {e.fecha && <Bdg label={fmtCorta(e.fecha)} bg="#12172a" t="#6b7280" />}
                    {recibido && <Bdg label={"Recibido" + (fecha ? " " + fmtCorta(fecha) : "")} bg="#041f14" t="#34d399" />}
                  </div>
                  <div style={{ color: "#e5e7eb", fontSize: "0.82rem", lineHeight: 1.35 }}>{e.direccion}</div>
                  <div style={{ color: "#374151", fontSize: "0.68rem", marginTop: "2px" }}>
                    <span style={{ fontFamily: "monospace" }}>...{e.id.slice(-10)}</span>
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

function TabLocalidades() {
  const [tabla, setTabla] = useState(() => {
    const stored = localStorage.getItem("envhub_cp_extra");
    const extra = stored ? JSON.parse(stored) : {};
    return { ...CP_P_INIT, ...extra };
  });
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
      const q = busqueda.toLowerCase();
      return cp.includes(q) || p.toLowerCase().includes(q);
    })
    .sort(([a], [b]) => parseInt(a) - parseInt(b));

  const guardar = (cp, partido) => {
    const nueva = { ...tabla, [cp]: partido };
    setTabla(nueva);
    // Guardar extras (los que no estan en el init)
    const extra = {};
    Object.entries(nueva).forEach(([k, v]) => { if (CP_P_INIT[k] !== v) extra[k] = v; });
    localStorage.setItem("envhub_cp_extra", JSON.stringify(extra));
    // Actualizar el mapa global en runtime
    CP_P[cp] = partido;
    setEditCP(null);
    mostrarToast("Guardado");
  };

  const eliminar = (cp) => {
    if (!window.confirm("Eliminar CP " + cp + "?")) return;
    const nueva = { ...tabla };
    delete nueva[cp];
    setTabla(nueva);
    const extra = {};
    Object.entries(nueva).forEach(([k, v]) => { if (CP_P_INIT[k] !== v) extra[k] = v; });
    localStorage.setItem("envhub_cp_extra", JSON.stringify(extra));
    delete CP_P[cp];
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

export default function App(){
  const [pantalla,setPantalla]=useState("dashboard");
  const [borrador,setBorrador]=useState([]);
  const [envios,setEnviosLocal]=useState([]);
  const [zc,setZc]=useState(ZONAS_INIT);
  const [lc,setLc]=useState(LOGISTICAS_INIT);
  const [tab,setTab]=useState("envios");
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(false);
  const [syncLoading,setSyncLoading]=useState(true);
  const [fileName,setFileName]=useState("");
  const [toast,setToast]=useState("");
  const mostrarToast=msg=>{setToast(msg);setTimeout(()=>setToast(""),2500);};

  useEffect(()=>{
    const unsub=onSnapshot(collection(db,"envios"),(snap)=>{
      const docs=snap.docs.map(d=>({...d.data(),id:d.id}));
      docs.sort((a,b)=>(b.fechaVenta||b.fecha||"").localeCompare(a.fechaVenta||a.fecha||""));
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

  const confirmarAsignacion=async(asignados)=>{for(const e of asignados){await guardarEnvio(e);}setPantalla("dashboard");setTab("envios");mostrarToast(asignados.length+" envios guardados");};
  const reasignarSel=items=>{setBorrador(items);setPantalla("asignacion");};

  if(pantalla==="asignacion"){return<PantallaAsignacion borrador={borrador} fileName={fileName} onConfirmar={confirmarAsignacion} onCancelar={()=>setPantalla("dashboard")} lc={lc}/>;}

  const TABS=[{id:"envios",l:"Envios"},{id:"imprimir",l:"Imprimir"},{id:"manual",l:"+ Manual"},{id:"tarifas",l:"Tarifas"},{id:"informe",l:"Informe"},{id:"liquidacion",l:"Liquidacion"},{id:"localidades",l:"Localidades"}];

  return(
    <div style={{minHeight:"100vh",background:"#0a0e1a",color:"#fff",fontFamily:"sans-serif"}}>
      <style>{`*{box-sizing:border-box;}::-webkit-scrollbar{width:4px;height:4px;}::-webkit-scrollbar-track{background:#0a0e1a;}::-webkit-scrollbar-thumb{background:#252d40;border-radius:3px;}select option{background:#1a1f2e;color:#e5e7eb;}button:hover{opacity:0.85;}`}</style>
      {toast&&<div style={{position:"fixed",top:"16px",right:"16px",zIndex:999,background:"#041f14",border:"1px solid #10b981",borderRadius:"10px",padding:"0.6rem 1.1rem",color:"#34d399",fontWeight:700,fontSize:"0.82rem"}}>{toast}</div>}
      <div style={{position:"sticky",top:0,zIndex:100,background:"#0f1420",borderBottom:"1px solid #1a1f2e",padding:"0.7rem 1rem",display:"flex",alignItems:"center",gap:"0.55rem",flexWrap:"wrap"}}>
        <div style={{width:"26px",height:"26px",background:"linear-gradient(135deg,#6366f1,#8b5cf6)",borderRadius:"7px",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>🛵</div>
        <div style={{marginRight:"0.2rem"}}>
          <div style={{fontWeight:800,fontSize:"0.92rem"}}>EnviosHub <span style={{color:"#374151",fontSize:"0.6rem",fontWeight:400}}>v{VERSION}</span></div>
          <div style={{color:"#374151",fontSize:"0.58rem"}}>{syncLoading?"Conectando...":(envios.length>0?envios.length+" envios":"Sin envios")}</div>
        </div>
        <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{TABS.map(t=><button key={t.id} onClick={()=>setTab(t.id)} style={{...S.btn(tab===t.id),padding:"0.32rem 0.65rem",fontSize:"0.73rem"}}>{t.l}</button>)}</div>
        <div style={{marginLeft:"auto",display:"flex",gap:"0.35rem",flexWrap:"wrap"}}>
          <label style={{cursor:"pointer"}}>
            <input type="file" accept=".xlsx,.xls" style={{display:"none"}} onChange={e=>{if(e.target.files[0]){cargarArchivo(e.target.files[0]);e.target.value="";}}}/>
            <span style={{display:"inline-block",padding:"0.33rem 0.75rem",borderRadius:"7px",background:"linear-gradient(135deg,#6366f1,#8b5cf6)",color:"#fff",fontWeight:700,fontSize:"0.72rem",cursor:"pointer"}}>{loading?"...":"Cargar Excel"}</span>
          </label>
        </div>
      </div>
      <div style={{padding:"0.85rem 1rem",maxWidth:"1400px",margin:"0 auto"}}>
        {error&&<div style={{...S.card,padding:"0.65rem 1rem",marginBottom:"0.8rem",background:"#1c0a0a",border:"1px solid #7f1d1d",color:"#fca5a5",fontSize:"0.8rem"}}>{error}</div>}
        {tab==="envios"  &&<TabEnvios   envios={envios} setEnvios={setEnvios} zc={zc} lc={lc} onReasignar={reasignarSel}/>}
        {tab==="imprimir"&&<TabImprimir envios={envios} zc={zc} lc={lc}/>}
        {tab==="manual"  &&<TabManual   setEnvios={setEnvios} onSuccess={()=>{setTab("envios");mostrarToast("Envio agregado");}} lc={lc} enviosExistentes={envios}/>}
        {tab==="tarifas" &&<TabTarifas  zc={zc} setZc={setZc} lc={lc} setLc={setLc}/>}
        {tab==="informe"     &&<TabInforme     envios={envios} zc={zc} lc={lc}/>}
        {tab==="liquidacion" &&<TabLiquidacion envios={envios} setEnvios={setEnvios} lc={lc}/>}
        {tab==="localidades" &&<TabLocalidades/>}
      </div>
    </div>
  );
}
