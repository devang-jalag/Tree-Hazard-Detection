import crypto from "node:crypto";

import { z } from "zod";

import { classifyComplaint } from "@/backend/domain/scoring";
import {
  findDuplicateCandidates,
  pickAutoLink,
  type DuplicateCandidate,
} from "@/backend/domain/duplicates";
import { hasLLM } from "@/backend/config";
import { extractGps } from "@/backend/services/exif";
import { resolveLocation } from "@/backend/services/geocode";
import {
  insertImage,
  insertRequest,
  listOpenRequests,
  nextReference,
  recordStatusChange,
  saveClassification,
} from "@/backend/db/repository";
import {
  ACCEPTED_MIME_TYPES,
  MAX_IMAGE_BYTES,
  filenameFor,
  newImageId,
} from "@/backend/services/storage";
import { uploadImageToGCS } from "@/backend/services/gcs";
import type { Classification, RequestStatus } from "@/shared/types";
import {
  analyzeHazard,
  aiResultToClassification,
} from "@/backend/services/llmClient";

/**
 * The submission pipeline.
 *
 * One resident submission runs: validate -> store photo -> locate -> classify
 * text -> analyze photo -> fuse -> duplicate check -> persist.
 *
 * Every external step is optional and degrades locally, so a submission is
 * only ever rejected for bad input, never for an unavailable service.
 */

export const submissionSchema = z.object({
  reporterName: z.string().trim().min(2, "Please enter your name").max(120),
  reporterEmail: z
    .string()
    .trim()
    .email("Please enter a valid email address")
    .max(200),
  address: z
    .string()
    .trim()
    .min(5, "Please enter the street address or nearest intersection")
    .max(200),
  description: z
    .string()
    .trim()
    .min(10, "Please describe what you can see - at least a few words")
    .max(4000),
});

export type SubmissionInput = z.infer<typeof submissionSchema>;

export interface SubmittedPhoto {
  data: Buffer;
  mimeType: string;
  originalName: string;
}

export interface IntakeResult {
  id: string;
  reference: string;
  status: RequestStatus;
  classification: Classification;
  location: { latitude: number | null; longitude: number | null; note: string };
  /** Set when the report was auto-linked to an existing tree. */
  linkedTo: { id: string; reference: string; reason: string } | null;
  /** Near-misses left for a human to confirm. */
  duplicateSuggestions: DuplicateCandidate[];
  photoAnalyzed: boolean;
}

/**
 * Crew hours budgeted for the job, from severity.
 *
 * A placeholder until crews record real durations, but it has to exist: the
 * same-day bundling feature needs to know how much of a shift each job eats.
 */
export function estimateHours(dangerScore: number): number {
  if (dangerScore >= 80) return 6;
  if (dangerScore >= 60) return 4.5;
  if (dangerScore >= 40) return 3;
  if (dangerScore >= 20) return 2;
  return 1;
}

export function validatePhoto(photo: SubmittedPhoto): string | null {
  if (!ACCEPTED_MIME_TYPES.includes(photo.mimeType)) {
    return `Unsupported image type. Accepted: JPEG, PNG, WebP, HEIC.`;
  }
  if (photo.data.byteLength > MAX_IMAGE_BYTES) {
    return `Image is too large. Maximum ${Math.round(
      MAX_IMAGE_BYTES / (1024 * 1024)
    )} MB.`;
  }
  return null;
}

export async function submitRequest(
  input: SubmissionInput,
  photo: SubmittedPhoto | null
): Promise<IntakeResult> {
  const id = crypto.randomUUID();
  const reference = await nextReference(new Date().getFullYear());
  const submittedAt = new Date().toISOString();

  // --- Location: photo GPS beats the typed address -------------------------
  const exif = photo ? await extractGps(photo.data) : null;
  const location = await resolveLocation({ address: input.address, exif });

  // --- Classification: text-only first (instant) ---------------------------
  // The AI analysis runs in the background after we persist, so the resident
  // gets an immediate response. The text-only score is a safe fallback.
  let classification = classifyComplaint(input.description);
  let photoAnalyzed = false;

  // --- Duplicate check against everything currently open --------------------
  const candidates = findDuplicateCandidates(
    {
      id,
      description: input.description,
      submittedAt,
      latitude: location.latitude,
      longitude: location.longitude,
      street: location.street,
    },
    await listOpenRequests()
  );
  const autoLink = pickAutoLink(candidates);
  const status: RequestStatus = autoLink ? "Duplicate" : "Submitted";

  // --- Persist immediately (before AI analysis) -----------------------------
  await insertRequest({
    id,
    reference,
    reporterName: input.reporterName,
    reporterEmail: input.reporterEmail,
    address: input.address,
    street: location.street,
    neighborhood: location.neighborhood,
    latitude: location.latitude,
    longitude: location.longitude,
    locationSource: location.source,
    description: input.description,
    submittedAt,
    status,
    duplicateOfId: autoLink ? autoLink.request.id : null,
    estimatedHours: estimateHours(classification.dangerScore),
  });

  await saveClassification(id, classification);

  await recordStatusChange({
    requestId: id,
    fromStatus: null,
    toStatus: "Submitted",
    actor: input.reporterName,
    note: "Submitted via public form",
    createdAt: submittedAt,
  });

  if (autoLink) {
    await recordStatusChange({
      requestId: id,
      fromStatus: "Submitted",
      toStatus: "Duplicate",
      actor: "system",
      note: `Auto-linked to ${autoLink.request.reference}. ${autoLink.reason}`,
    });
  }

  if (photo) {
    const imageId = newImageId();
    const filename = filenameFor(imageId, photo.mimeType);

    // Try Google Cloud Storage first; fallback to base64 in DB
    const gcsUrl = await uploadImageToGCS({
      filename,
      data: photo.data,
      contentType: photo.mimeType,
    });

    await insertImage({
      id: imageId,
      requestId: id,
      filename,
      mimeType: photo.mimeType,
      byteSize: photo.data.byteLength,
      data: gcsUrl ?? photo.data.toString("base64"),
      exifLatitude: exif?.latitude ?? null,
      exifLongitude: exif?.longitude ?? null,
    });
  }

  // --- Run AI analysis before returning (serverless-safe) -------------------
  // On Vercel/serverless, background promises are killed when the response is
  // sent. We must await the AI analysis so it completes within the request
  // lifecycle. The API route already sets maxDuration=60 to allow for this.
  // Failures are caught — the text-only classification remains as fallback.
  const aiClassification = await runAiAnalysis(
    id,
    input.description,
    photo
  ).catch((err) => {
    console.error("[LLM] Background analysis failed:", (err as Error).message);
    return null;
  });

  if (aiClassification) {
    classification = aiClassification;
    photoAnalyzed = !!aiClassification.imageFindings;
  }

  return {
    id,
    reference,
    status,
    classification,
    location: {
      latitude: location.latitude,
      longitude: location.longitude,
      note: location.note,
    },
    linkedTo: autoLink
      ? {
          id: autoLink.request.id,
          reference: autoLink.request.reference,
          reason: autoLink.reason,
        }
      : null,
    // Anything that looked close but did not clear the bar stays visible to a
    // human rather than being silently dropped.
    duplicateSuggestions: autoLink ? [] : candidates.slice(0, 3),
    photoAnalyzed,
  };
}

/**
 * Background AI analysis — runs after the request is persisted.
 *
 * Calls GLM-5.2 (with Llama Parse for photos) to re-score the request, then
 * saves the updated classification. Failures are logged but never thrown —
 * the text-only classification from submitRequest remains as the fallback.
 */
async function runAiAnalysis(
  requestId: string,
  description: string,
  photo: SubmittedPhoto | null
): Promise<Classification | null> {
  if (!hasLLM()) return null;

  try {
    const aiResult = await analyzeHazard(
      description,
      photo?.data ?? null,
      photo?.mimeType ?? null
    );
    const classification = aiResultToClassification(aiResult);
    await saveClassification(requestId, classification);
    console.log(
      `[LLM] Background analysis complete for ${requestId} — dangerScore=${classification.dangerScore}`
    );
    return classification;
  } catch (err) {
    console.error(
      `[LLM] Background analysis failed for ${requestId}:`,
      (err as Error).message
    );
    return null;
  }
}
