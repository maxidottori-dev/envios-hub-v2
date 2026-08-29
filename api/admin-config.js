import { initDb } from "./_firebase.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end();
  const db = initDb();
  const snap = await db.collection("config").doc("expedicion").get();
  const data = snap.data() || {};
  return res.status(200).json({ armadores: data.armadores || [] });
}
