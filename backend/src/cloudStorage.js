/**
 * Google Cloud Storage Client (Zero Runtime Dependencies)
 *
 * Uses native Node.js crypto and fetch with a Google Cloud Service Account
 * to securely upload complaint photos directly to GCS buckets.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUCKET_NAME = process.env.GCS_BUCKET || "tree-hazard-images-503718";

const candidatePaths = [
  process.env.GOOGLE_APPLICATION_CREDENTIALS,
  path.join(__dirname, "..", "service-account.json"),
  path.join(process.cwd(), "service-account.json"),
  path.join(process.cwd(), "backend", "service-account.json"),
].filter(Boolean);

let serviceAccount = null;
let cachedToken = null;
let tokenExpiresAt = 0;

try {
  const foundPath = candidatePaths.find((p) => fs.existsSync(p));
  if (foundPath) {
    serviceAccount = JSON.parse(fs.readFileSync(foundPath, "utf8"));
    console.info(`☁ Google Cloud Storage initialized from ${path.basename(foundPath)} for project: ${serviceAccount.project_id}, bucket: ${BUCKET_NAME}`);
  } else if (process.env.GCP_SERVICE_ACCOUNT_KEY) {
    serviceAccount = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY);
    console.info(`☁ Google Cloud Storage initialized from env for project: ${serviceAccount.project_id}`);
  }
} catch (err) {
  console.warn("Could not load Google Cloud Service Account:", err.message);
}

/**
 * Creates a signed JWT and exchanges it for a Google OAuth2 access token.
 */
async function getAccessToken() {
  if (!serviceAccount) return null;

  // Use cached token if valid (with 60s safety buffer)
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claimSet = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/devstorage.read_write https://www.googleapis.com/auth/cloud-platform",
    aud: serviceAccount.token_uri || "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const payload = Buffer.from(JSON.stringify(claimSet)).toString("base64url");
  const signInput = `${header}.${payload}`;

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signInput);
  const signature = signer.sign(serviceAccount.private_key, "base64url");
  const assertion = `${signInput}.${signature}`;

  const tokenRes = await fetch(serviceAccount.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const data = await tokenRes.json();
  if (data.error || !data.access_token) {
    console.error("GCS OAuth2 Token Error:", data);
    return null;
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

/**
 * Uploads a file buffer to Google Cloud Storage.
 * Returns the public HTTPS URL, or null on failure/fallback.
 *
 * @param {Object} file
 * @param {string} file.filename - Object name in the bucket (e.g. CIT-1001.jpg)
 * @param {Buffer} file.data - File buffer content
 * @param {string} file.contentType - MIME type (e.g. image/jpeg)
 * @returns {Promise<string|null>} Public URL
 */
export async function uploadImageToGCS({ filename, data, contentType = "image/jpeg" }) {
  if (!serviceAccount) return null;

  try {
    const accessToken = await getAccessToken();
    if (!accessToken) return null;

    const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET_NAME}/o?uploadType=media&name=${encodeURIComponent(
      filename
    )}`;

    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": contentType,
      },
      body: data,
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn("GCS Upload failed:", res.status, errText);
      return null;
    }

    const publicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${filename}`;
    console.info(`☁ Image successfully stored in Google Cloud Storage: ${publicUrl}`);
    return publicUrl;
  } catch (err) {
    console.warn("GCS Upload error, falling back to local storage:", err.message);
    return null;
  }
}

/**
 * Check if cloud storage is configured and available.
 */
export function isCloudStorageConfigured() {
  return serviceAccount !== null;
}
