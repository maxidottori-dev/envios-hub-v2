import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export function initDb() {
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
