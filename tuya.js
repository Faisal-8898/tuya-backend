import crypto from "crypto";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const { TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, TUYA_API_REGION } = process.env;

const BASE_URL = `https://openapi.${TUYA_API_REGION}.com`;

let cachedToken = null;
let cachedTokenExpire = 0;

function genSignature({ method, url, body, t, accessToken = "" }) {
  const contentHash = crypto
    .createHash("sha256")
    .update(body || "")
    .digest("hex");
  const stringToSign = [method, contentHash, "", url].join("\n");
  const signStr = TUYA_CLIENT_ID + accessToken + t + stringToSign;
  return crypto
    .createHmac("sha256", TUYA_CLIENT_SECRET)
    .update(signStr)
    .digest("hex")
    .toUpperCase();
}

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpire) return cachedToken;

  const t = now.toString();
  const method = "GET";
  const url = "/v1.0/token?grant_type=1";
  const sign = genSignature({ method, url, t });

  const res = await axios.get(`${BASE_URL}${url}`, {
    headers: {
      client_id: TUYA_CLIENT_ID,
      sign,
      t,
      sign_method: "HMAC-SHA256",
    },
  });

  cachedToken = res.data.result.access_token;
  cachedTokenExpire = now + res.data.result.expire_time - 60 * 1000; // refresh 1 min before expiry
  return cachedToken;
}

export async function fetchDeviceStatus(deviceId) {
  const token = await getAccessToken();
  const t = Date.now().toString();
  const method = "GET";
  const urlPath = `/v1.0/devices/${deviceId}/status`;
  const sign = genSignature({ method, url: urlPath, t, accessToken: token });

  const res = await axios.get(`${BASE_URL}${urlPath}`, {
    headers: {
      client_id: TUYA_CLIENT_ID,
      sign,
      t,
      sign_method: "HMAC-SHA256",
      access_token: token,
    },
  });

  return res.data.result; // returns array of status
}
