import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDJzxxuv5kPjp3LEpeBcrDdkZDLH-zyooQ",
  authDomain: "envios-hub.firebaseapp.com",
  projectId: "envios-hub",
  storageBucket: "envios-hub.firebasestorage.app",
  messagingSenderId: "126144078919",
  appId: "1:126144078919:web:a58918c0aa3bcc3670bd62"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
