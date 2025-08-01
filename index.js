import express from "express";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import { fetchDeviceStatus } from "./tuya.js";
import { WebSocketServer } from "ws";
import http from "http";
import cors from "cors";

dotenv.config();

const app = express();
app.use(cors());
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 5000;
const client = new MongoClient(process.env.MONGO_URI);
const dbName = "tuya";
const collectionName = "device_data";

await client.connect();
console.log("Connected to MongoDB Atlas");
const db = client.db(dbName);
const collection = db.collection(collectionName);

const deviceId = process.env.TUYA_DEVICE_ID;

function broadcast(data) {
  const json = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(json);
  });
}

setInterval(async () => {
  try {
    const status = await fetchDeviceStatus(deviceId);
    const doc = {
      timestamp: new Date(),
      status,
    };
    await collection.insertOne(doc);

    const transformed = {
      time: doc.timestamp.toISOString(),
      current: getValue(status, "cur_current"),
      voltage: getValue(status, "cur_voltage"),
      power: getValue(status, "cur_power"),
    };

    broadcast(transformed);
  } catch (err) {
    console.error("Polling failed:", err.message);
  }
}, 2000);

app.get("/data", async (req, res) => {
  const result = await collection
    .find({})
    .sort({ timestamp: -1 })
    .limit(60)
    .toArray();

  res.json(
    result.map((entry) => ({
      time: entry.timestamp.toLocaleTimeString(),
      ...Object.fromEntries(entry.status.map((s) => [s.code, s.value])),
    })),
  );
});

function getValue(statusArray, code) {
  const item = statusArray.find((s) => s.code === code);
  if (!item) return 0;
  if (code === "cur_current") return item.value / 1000; // mA -> A
  if (code === "cur_voltage") return item.value / 10; // 2322 -> 232.2
  if (code === "cur_power") return item.value / 10; // 4176 -> 417.6
  return item.value;
}

server.listen(PORT, () => {
  console.log(`Server running (HTTP + WebSocket) on port ${PORT}`);
});
