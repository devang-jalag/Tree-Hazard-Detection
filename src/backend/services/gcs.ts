/**
 * Google Cloud Storage Service (Zero Runtime Dependencies)
 *
 * Uses native Node.js crypto and fetch with a Google Cloud Service Account
 * to securely upload complaint photos directly to GCS buckets without adding heavy SDK dependencies.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const BUCKET_NAME = process.env.GCS_BUCKET || "tree-hazard-images-503718";

interface ServiceAccountKey {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const candidatePaths = [
  process.env.GOOGLE_APPLICATION_CREDENTIALS,
  path.join(process.cwd(), "backend", "service-account.json"),
  path.join(process.cwd(), "service-account.json"),
].filter((p): p is string => Boolean(p));

let serviceAccount: ServiceAccountKey | null = null;
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

try {
  const foundPath = candidatePaths.find((p) => fs.existsSync(p));
  if (foundPath) {
    serviceAccount = JSON.parse(fs.readFileSync(foundPath, "utf8"));
    console.info(
      `[GCS] Initialized from ${path.basename(foundPath)} for bucket: ${BUCKET_NAME}`
    );
  } else if (process.env.GCP_SERVICE_ACCOUNT_KEY) {
    serviceAccount = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY);
    console.info(`[GCS] Initialized from env for bucket: ${BUCKET_NAME}`);
  }
} catch (err) {
  console.warn("[GCS] Could not load Google Cloud Service Account:", (err as Error).message);
}

/**
 * Creates a signed JWT and exchanges it for a Google OAuth2 access token.
 */
async function getAccessToken(): Promise<string | null> {
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

  const data = (await tokenRes.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: unknown;
  };

  if (data.error || !data.access_token) {
    console.error("[GCS] OAuth2 Token Error:", data);
    return null;
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

/**
 * Uploads a file buffer to Google Cloud Storage.
 * Returns the public HTTPS URL, or null on failure/fallback.
 */
export async function uploadImageToGCS({
  filename,
  data,
  contentType = "image/jpeg",
}: {
  filename: string;
  data: Buffer | Uint8Array;
  contentType?: string;
}): Promise<string | null> {
  if (!serviceAccount) return null;

  try {
    const accessToken = await getAccessToken();
    if (!accessToken) return null;

    const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET_NAME}/o?uploadType=media&name=${encodeURIComponent(
      filename
    )}`;

    const bodyPayload = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": contentType,
      },
      body: bodyPayload as unknown as BodyInit,
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn("[GCS] Upload failed:", res.status, errText);
      return null;
    }

    const publicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${filename}`;
    console.info(`[GCS] Image successfully uploaded to Google Cloud Storage: ${publicUrl}`);
    return publicUrl;
  } catch (err) {
    console.warn("[GCS] Upload error, falling back to database/local storage:", (err as Error).message);
    return null;
  }
}

/**
 * Check if cloud storage is configured and available.
 */
export function isCloudStorageConfigured(): boolean {
  return serviceAccount !== null;
}
