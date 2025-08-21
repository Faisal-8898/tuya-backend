const TuyAPI = require("tuyapi");
require("dotenv").config();

// Disable debug mode for cleaner output
// process.env.DEBUG = 'TuyAPI';

async function testDevice() {
    console.log("🔧 SIMPLE TUYA DEVICE TEST");
    console.log("Device ID:", process.env.TUYA_DEVICE_ID ? "✅ Set" : "❌ Missing");
    console.log("Device Key:", process.env.TUYA_DEVICE_KEY ? "✅ Set" : "❌ Missing");
    console.log("Device IP: 192.168.0.100\n");

    // Configuration that works most commonly
    const device = new TuyAPI({
        id: process.env.TUYA_DEVICE_ID,
        key: process.env.TUYA_DEVICE_KEY,
        ip: "192.168.0.100",
        version: "3.1",
        // These settings often help with unresponsive devices
        issueGetOnConnect: false,
        issueRefreshOnConnect: false,
        nullPayloadOnJSONError: false,
        persistentConnection: false
    });

    let dataReceived = false;
    let isConnected = false;

    // Set up event listeners
    device.on('data', (data) => {
        dataReceived = true;
        console.log("🎉 SUCCESS! Received data:");
        console.log(JSON.stringify(data, null, 2));

        // Parse the data
        const dps = data.dps || data;
        if (dps && typeof dps === 'object') {
            console.log("\n📊 Parsed Values:");
            Object.keys(dps).forEach(key => {
                const value = dps[key];
                console.log(`DPS ${key}: ${value} (${typeof value})`);

                // Common interpretations
                if (key === '1') console.log("  → Power State:", value ? "ON" : "OFF");
                if (key === '18') console.log("  → Current:", value, "mA");
                if (key === '19') console.log("  → Power:", (value / 10), "W");
                if (key === '20') console.log("  → Voltage:", (value / 10), "V");
                if (key === '21') console.log("  → Energy Today:", (value / 100), "kWh");
                if (key === '22') console.log("  → Energy Total:", (value / 1000), "kWh");
            });
        }
    });

    device.on('error', (error) => {
        console.log("❌ Error:", error.message);
    });

    device.on('connected', () => {
        console.log("✅ Connected to device");
        isConnected = true;
    });

    device.on('disconnect', () => {
        console.log("🔌 Disconnected");
        isConnected = false;
    });

    try {
        console.log("🔍 Finding device...");
        await device.find();
        console.log("📍 Device found at:", device.device.ip);

        console.log("🔗 Connecting...");
        await device.connect();

        // Wait for connection to stabilize
        await new Promise(resolve => setTimeout(resolve, 2000));

        if (!isConnected) {
            throw new Error("Connection failed");
        }

        console.log("⏳ Waiting for automatic data (10 seconds)...");

        // Wait for data or timeout
        const timeout = new Promise(resolve => setTimeout(resolve, 10000));
        const dataPromise = new Promise(resolve => {
            device.on('data', () => resolve('data'));
        });

        await Promise.race([timeout, dataPromise]);

        if (!dataReceived) {
            console.log("⚠️  No automatic data received. Trying manual methods...\n");

            // Method 1: Try to wake up the device by setting something
            console.log("🔄 Method 1: Attempting to wake device with toggle...");
            try {
                // Get current state first (this sometimes works)
                const currentState = await Promise.race([
                    device.get({ dps: '1' }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
                ]);

                if (currentState !== undefined) {
                    console.log("Current state:", currentState);
                    dataReceived = true;
                } else {
                    // Try to toggle to wake it up
                    console.log("Toggling device state to wake it up...");
                    await device.set({ dps: 1, set: true });
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    await device.set({ dps: 1, set: false });
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            } catch (e) {
                console.log("Toggle method failed:", e.message);
            }

            if (!dataReceived) {
                console.log("\n🔄 Method 2: Direct status query...");
                try {
                    const status = await Promise.race([
                        device.get(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000))
                    ]);

                    if (status && Object.keys(status).length > 0) {
                        console.log("Status received:", JSON.stringify(status, null, 2));
                        dataReceived = true;
                    }
                } catch (e) {
                    console.log("Direct query failed:", e.message);
                }
            }

            if (!dataReceived) {
                console.log("\n🔄 Method 3: Refresh command...");
                try {
                    await Promise.race([
                        device.refresh(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
                    ]);
                    console.log("Refresh sent, waiting for response...");
                    await new Promise(resolve => setTimeout(resolve, 3000));
                } catch (e) {
                    console.log("Refresh failed:", e.message);
                }
            }
        }

        // Final wait
        if (!dataReceived) {
            console.log("\n⏳ Final wait (5 seconds)...");
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

    } catch (error) {
        console.error("❌ Test failed:", error.message);
    } finally {
        try {
            await device.disconnect();
            console.log("🔌 Disconnected");
        } catch (e) {
            // Ignore disconnect errors
        }
    }

    if (dataReceived) {
        console.log("\n🎉 SUCCESS! Your device is working!");
        console.log("💡 Tip: Some devices only send data when their state changes.");
        console.log("💡 Try physically pressing the device button or using the Smart Life app.");
    } else {
        console.log("\n❌ No data received from device.");
        console.log("\n🔧 TROUBLESHOOTING STEPS:");
        console.log("1. Make sure device is powered on and connected to WiFi");
        console.log("2. Try using the Smart Life app to interact with the device");
        console.log("3. Physical button press on the device might wake it up");
        console.log("4. Some devices only report when power consumption changes");
        console.log("5. Verify IP address is correct (check router admin or use nmap)");
        console.log("6. Double-check device ID and key from Tuya IoT platform");
        console.log("\n💡 Note: Energy monitoring often only works when something is plugged in and drawing power!");
    }
}

// Handle graceful shutdown
process.on("SIGINT", () => {
    console.log("\n🛑 Shutting down...");
    process.exit(0);
});

testDevice();