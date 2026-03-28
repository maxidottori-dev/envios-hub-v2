import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export function initDb() {
  if (getApps().length > 0) return getFirestore();

  // Maneja la private key en cualquier formato
  let privateKey = process.env.FIREBASE_PRIVATE_KEY || "";
  
  // Si viene con \n literales, los convierte a saltos reales
  if (privateKey.includes("\\n")) {
    privateKey = privateKey.replace(/\\n/g, "\n");
  }
  
  // Si viene sin los headers de PEM, los agrega
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
