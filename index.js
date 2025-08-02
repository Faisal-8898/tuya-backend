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


async function getTodayDataFromDB() {
  console.log("--- Running Optimized MongoDB Aggregation for Today's Data ---");
  const today = new Date();
  const todayStart = new Date(today);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(today);
  todayEnd.setHours(23, 59, 59, 999);

  const pipeline = [
    {
      $match: {
        timestamp: { $gte: todayStart, $lte: todayEnd }
      }
    },
    {
      $unwind: "$status"
    },
    {
      $group: {
        _id: {
          hour: { $hour: "$timestamp" },
          code: "$status.code"
        },
        value: { $avg: "$status.value" }
      }
    },
    {
      $group: {
        _id: "$_id.hour",
        power: {
          $avg: {
            $cond: [
              { $eq: ["$_id.code", "cur_power"] },
              { $divide: ["$value", 10] },
              null
            ]
          }
        },
        current: {
          $avg: {
            $cond: [
              { $eq: ["$_id.code", "cur_current"] },
              "$value",
              null
            ]
          }
        },
        voltage: {
          $avg: {
            $cond: [
              { $eq: ["$_id.code", "cur_voltage"] },
              { $divide: ["$value", 10] },
              null
            ]
          }
        }
      }
    },
    {
      $sort: { _id: 1 }
    }
  ];

  const result = await collection.aggregate(pipeline).toArray();

  // Create the 24-hour structure
  const todayData = createEmptyTodayData();
  result.forEach(hourData => {
    const hour = hourData._id;
    if (hourData.power !== null) todayData[hour].power = hourData.power;
    if (hourData.current !== null) todayData[hour].current = hourData.current;
    if (hourData.voltage !== null) todayData[hour].voltage = hourData.voltage;
  });

  console.log(`Today aggregation finished. Found data for ${result.length} hours.`);
  return todayData;
}

async function getWeekDataFromDB() {
  console.log("--- Running Optimized MongoDB Aggregation for Week Data ---");
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
  sevenDaysAgo.setHours(0, 0, 0, 0);

  const pipeline = [
    {
      $match: {
        timestamp: { $gte: sevenDaysAgo }
      }
    },
    {
      $unwind: "$status"
    },
    {
      $group: {
        _id: {
          date: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp", timezone: "UTC" } },
          code: "$status.code"
        },
        value: { $avg: "$status.value" }
      }
    },
    {
      $group: {
        _id: "$_id.date",
        power: {
          $avg: {
            $cond: [
              { $eq: ["$_id.code", "cur_power"] },
              { $divide: ["$value", 10] },
              null
            ]
          }
        },
        current: {
          $avg: {
            $cond: [
              { $eq: ["$_id.code", "cur_current"] },
              "$value",
              null
            ]
          }
        },
        voltage: {
          $avg: {
            $cond: [
              { $eq: ["$_id.code", "cur_voltage"] },
              { $divide: ["$value", 10] },
              null
            ]
          }
        }
      }
    },
    {
      $sort: { _id: 1 }
    }
  ];

  const result = await collection.aggregate(pipeline).toArray();

  // Create the 7-day structure
  const week = createEmptyWeekData();
  result.forEach(dayData => {
    const dayIndex = week.findIndex(d => d.date === dayData._id);
    if (dayIndex !== -1) {
      if (dayData.power !== null) week[dayIndex].power = dayData.power;
      if (dayData.current !== null) week[dayIndex].current = dayData.current;
      if (dayData.voltage !== null) week[dayIndex].voltage = dayData.voltage;
    }
  });

  console.log(`Week aggregation finished. Found data for ${result.length} days.`);
  return week;
}

async function getMonthlyDataFromDB() {
  console.log("--- Running Optimized MongoDB Aggregation for Monthly Data ---");
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const pipeline = [
    {
      $match: {
        timestamp: { $gte: thirtyDaysAgo }
      }
    },
    {
      $unwind: "$status"
    },
    {
      $group: {
        _id: {
          date: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp", timezone: "UTC" } },
          code: "$status.code"
        },
        value: { $avg: "$status.value" }
      }
    },
    {
      $group: {
        _id: "$_id.date",
        power: {
          $avg: {
            $cond: [
              { $eq: ["$_id.code", "cur_power"] },
              { $divide: ["$value", 10] },
              null
            ]
          }
        },
        current: {
          $avg: {
            $cond: [
              { $eq: ["$_id.code", "cur_current"] },
              "$value",
              null
            ]
          }
        },
        voltage: {
          $avg: {
            $cond: [
              { $eq: ["$_id.code", "cur_voltage"] },
              { $divide: ["$value", 10] },
              null
            ]
          }
        }
      }
    },
    {
      $sort: { _id: 1 }
    }
  ];

  const result = await collection.aggregate(pipeline).toArray();

  // Create the 30-day structure
  const month = createEmptyMonthData();
  result.forEach(dayData => {
    const dayIndex = month.findIndex(d => d.date === dayData._id);
    if (dayIndex !== -1) {
      if (dayData.power !== null) month[dayIndex].power = dayData.power;
      if (dayData.current !== null) month[dayIndex].current = dayData.current;
      if (dayData.voltage !== null) month[dayIndex].voltage = dayData.voltage;
    }
  });

  console.log(`Month aggregation finished. Found data for ${result.length} days.`);
  return month;
}

// Simple helper functions
function getValue(statusArray, code) {
  if (!statusArray || !Array.isArray(statusArray)) return 0;
  const item = statusArray.find((s) => s.code === code);
  if (!item) return 0;
  if (code === "cur_voltage") return item.value / 10;
  if (code === "cur_power") return item.value / 10;
  if (code === "cur_current") return item.value;
  return item.value;
}

function getLocalDateString(utcDate) {
  return new Date(utcDate).toLocaleDateString('en-CA');
}

function getLocalHour(utcDate) {
  return new Date(utcDate).getHours();
}

function createEmptyTodayData() {
  const today = [];
  for (let hour = 0; hour < 24; hour++) {
    today.push({ hour, power: 0, current: 0, voltage: 0 });
  }
  return today;
}

function createEmptyWeekData() {
  const week = [];
  const today = new Date();
  console.log("Creating week data for today:", getLocalDateString(today));

  for (let i = 6; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateString = getLocalDateString(date);
    console.log(`Week day ${i}: ${dateString}`);
    week.push({
      date: dateString,
      power: 0,
      current: 0,
      voltage: 0
    });
  }
  return week;
}

function createEmptyMonthData() {
  const month = [];
  const today = new Date();
  console.log("Creating month data for today:", getLocalDateString(today));

  for (let i = 29; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateString = getLocalDateString(date);
    if (i % 5 === 0) console.log(`Month day ${i}: ${dateString}`);
    month.push({
      date: dateString,
      power: 0,
      current: 0,
      voltage: 0
    });
  }
  return month;
}

app.get("/main-chart/data", async (req, res) => {
  try {
    console.log("=== OPTIMIZED CHART DATA REQUEST ===");

    // Run all aggregations in parallel for maximum efficiency
    const [todayData, weekData, monthData] = await Promise.all([
      getTodayDataFromDB(),
      getWeekDataFromDB(),
      getMonthlyDataFromDB()
    ]);

    res.json({
      success: true,
      data: {
        today: todayData,
        week: weekData,
        month: monthData
      }
    });

  } catch (error) {
    console.error("Error fetching chart data:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch chart data",
      details: error.message
    });
  }
});

server.listen(PORT, () => {
  console.log(`Server running (HTTP + WebSocket) on port ${PORT}`);
});
