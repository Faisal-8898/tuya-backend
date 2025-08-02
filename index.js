import express from "express";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import { fetchDeviceStatus, controlDeviceSwitch } from "./tuya.js";
import { WebSocketServer } from "ws";
import http from "http";
import cors from "cors";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json()); // Add this to parse JSON request bodies
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
  // const result = await collection
  //   .find({})
  //   .sort({ timestamp: -1 })
  //   .limit(60)
  //   .toArray();
  //
  // res.json(
  //   result.map((entry) => ({
  //     time: entry.timestamp.toLocaleTimeString(),
  //     ...Object.fromEntries(entry.status.map((s) => [s.code, s.value])),
  //   })),
  // );
  res.json("msg :hello");
});

// Switch control endpoint
app.post("/switch", async (req, res) => {
  try {
    const { state } = req.body; // state should be true for on, false for off

    if (typeof state !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: "Invalid state parameter. Must be true (on) or false (off)"
      });
    }

    const result = await controlDeviceSwitch(deviceId, state);

    console.log("Tuya API response:", JSON.stringify(result, null, 2));

    if (result && result.success !== false) {
      res.json({
        success: true,
        message: `Device switched ${state ? 'on' : 'off'} successfully`,
        data: result
      });
    } else {
      res.status(500).json({
        success: false,
        error: "Failed to control device switch",
        data: result
      });
    }

  } catch (error) {
    console.error("Error controlling device switch:", error);
    res.status(500).json({
      success: false,
      error: "Failed to control device switch",
      details: error.message
    });
  }
});

// Get current switch status endpoint
app.get("/switch-status", async (req, res) => {
  try {
    const status = await fetchDeviceStatus(deviceId);

    if (!status || !Array.isArray(status)) {
      return res.status(500).json({
        success: false,
        error: "Invalid response from Tuya API"
      });
    }

    // Find the switch_1 status
    const switchStatus = status.find(s => s.code === "switch_1");

    if (!switchStatus) {
      return res.status(404).json({
        success: false,
        error: "Switch status not found in device data"
      });
    }

    res.json({
      success: true,
      data: {
        switch: switchStatus.value, // true for on, false for off
        timestamp: new Date().toISOString(),
        lastUpdated: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error("Error fetching switch status:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch switch status from Tuya API",
      details: error.message
    });
  }
});

// Helper function to get value from status array (keeping current in mA)
function getValue(statusArray, code) {
  // Check if statusArray is null, undefined, or not an array
  if (!statusArray || !Array.isArray(statusArray)) {
    return 0;
  }

  const item = statusArray.find((s) => s.code === code);
  if (!item) return 0;
  if (code === "cur_voltage") return item.value / 10; // 2322 -> 232.2
  if (code === "cur_power") return item.value / 10; // 7220 -> 722.0
  return item.value; // Keep current in mA
}

// Helper function to convert UTC date to local date string
function getLocalDateString(utcDate) {
  return new Date(utcDate).toLocaleDateString('en-CA'); // YYYY-MM-DD format
}

// Helper function to get local hour from UTC date
function getLocalHour(utcDate) {
  return new Date(utcDate).getHours();
}

// Helper function to create empty data structure for today (24 hours)
function createEmptyTodayData() {
  const today = [];
  for (let hour = 0; hour < 24; hour++) {
    today.push({
      hour,
      power: 0,
      current: 0,
      voltage: 0
    });
  }
  return today;
}

// Helper function to create empty data structure for week (7 days)
function createEmptyWeekData() {
  const week = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    week.push({
      date: getLocalDateString(date),
      power: 0,
      current: 0,
      voltage: 0
    });
  }
  return week;
}

// Helper function to create empty data structure for month (30 days)
function createEmptyMonthData() {
  const month = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    month.push({
      date: getLocalDateString(date),
      power: 0,
      current: 0,
      voltage: 0
    });
  }
  return month;
}

app.get("/main-chart/data", async (req, res) => {
  try {
    const now = new Date();

    // Get today's data (last 24 hours)
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);

    // Get week's data (last 7 days)
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - 6);
    weekStart.setHours(0, 0, 0, 0);

    // Get month's data (last 30 days)
    const monthStart = new Date(now);
    monthStart.setDate(monthStart.getDate() - 29);
    monthStart.setHours(0, 0, 0, 0);

    // Fetch data from MongoDB
    const todayData = await collection.find({
      timestamp: { $gte: todayStart, $lte: todayEnd }
    }).toArray();

    const weekData = await collection.find({
      timestamp: { $gte: weekStart, $lte: todayEnd }
    }).toArray();

    const monthData = await collection.find({
      timestamp: { $gte: monthStart, $lte: todayEnd }
    }).toArray();

    // Process today's data (24 hours)
    const today = createEmptyTodayData();
    todayData.forEach(entry => {
      // Skip entries without valid status data
      if (!entry.status || !Array.isArray(entry.status)) {
        return;
      }

      const localHour = getLocalHour(entry.timestamp);
      const power = getValue(entry.status, "cur_power");
      const current = getValue(entry.status, "cur_current");
      const voltage = getValue(entry.status, "cur_voltage");

      today[localHour].power = power;
      today[localHour].current = current;
      today[localHour].voltage = voltage;
    });

    // Process week's data (7 days)
    const week = createEmptyWeekData();
    const weekDataByDate = {};
    weekData.forEach(entry => {
      // Skip entries without valid status data
      if (!entry.status || !Array.isArray(entry.status)) {
        return;
      }

      const localDate = getLocalDateString(entry.timestamp);
      if (!weekDataByDate[localDate]) {
        weekDataByDate[localDate] = [];
      }
      weekDataByDate[localDate].push(entry);
    });

    week.forEach(day => {
      if (weekDataByDate[day.date]) {
        const entries = weekDataByDate[day.date];
        const totalPower = entries.reduce((sum, entry) => sum + getValue(entry.status, "cur_power"), 0);
        const totalCurrent = entries.reduce((sum, entry) => sum + getValue(entry.status, "cur_current"), 0);
        const totalVoltage = entries.reduce((sum, entry) => sum + getValue(entry.status, "cur_voltage"), 0);

        day.power = totalPower / entries.length;
        day.current = totalCurrent / entries.length;
        day.voltage = totalVoltage / entries.length;
      }
    });

    // Process month's data (30 days)
    const month = createEmptyMonthData();
    const monthDataByDate = {};
    monthData.forEach(entry => {
      // Skip entries without valid status data
      if (!entry.status || !Array.isArray(entry.status)) {
        return;
      }

      const localDate = getLocalDateString(entry.timestamp);
      if (!monthDataByDate[localDate]) {
        monthDataByDate[localDate] = [];
      }
      monthDataByDate[localDate].push(entry);
    });

    month.forEach(day => {
      if (monthDataByDate[day.date]) {
        const entries = monthDataByDate[day.date];
        const totalPower = entries.reduce((sum, entry) => sum + getValue(entry.status, "cur_power"), 0);
        const totalCurrent = entries.reduce((sum, entry) => sum + getValue(entry.status, "cur_current"), 0);
        const totalVoltage = entries.reduce((sum, entry) => sum + getValue(entry.status, "cur_voltage"), 0);

        day.power = totalPower / entries.length;
        day.current = totalCurrent / entries.length;
        day.voltage = totalVoltage / entries.length;
      }
    });

    res.json({
      success: true,
      data: {
        today,
        week,
        month
      }
    });

  } catch (error) {
    console.error("Error fetching chart data:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch chart data"
    });
  }
});

server.listen(PORT, () => {
  console.log(`Server running (HTTP + WebSocket) on port ${PORT}`);
});
