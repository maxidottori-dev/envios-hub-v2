import { initializeApp } from "firebase/app";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDJzxxuv5kPjp3LEpeBcrDdkZDLH-zyooQ",
  authDomain: "envios-hub.firebaseapp.com",
  projectId: "envios-hub",
  storageBucket: "envios-hub.firebasestorage.app",
  messagingSenderId: "126144078919",
  appId: "1:126144078919:web:a58918c0aa3bcc3670bd62"
};

const app = initializeApp(firebaseConfig);

// Caché offline: los datos se guardan en el dispositivo.
// Al reabrir la app, muestra los datos de disco al instante
// mientras actualiza en segundo plano desde internet.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager() // soporta múltiples pestañas
  })
});
