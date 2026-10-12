import { NextResponse } from "next/server";

import { getImage, getRequest } from "@/backend/db/repository";
import { PLACEHOLDER_MIME, placeholderPhotoSvg } from "@/backend/seed/placeholder-photo";
import { CLOSED_STATUSES } from "@/shared/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serves a complaint photo by image id.
 *
 * Photos are stored as base64 in the database `images.data` column so they
 * work on serverless platforms (Vercel) with no persistent filesystem.
 * Seeded SVG placeholders are generated on the fly when the data column is null.
 */
export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const image = await getImage(params.id);
  if (!image) {
    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  }

  let bytes: Buffer | null = null;

  if (image.data) {
    if (image.data.startsWith("http://") || image.data.startsWith("https://")) {
      return NextResponse.redirect(image.data, 307);
    }
    bytes = Buffer.from(image.data, "base64");
  } else if (image.mimeType === PLACEHOLDER_MIME) {
    const request = await getRequest(image.requestId);
    if (request) {
      bytes = Buffer.from(
        placeholderPhotoSvg({
          reference: request.reference,
          address: request.address,
          muted: (CLOSED_STATUSES as string[]).includes(request.status),
        }),
        "utf8"
      );
    }
  }

  if (!bytes) {
    return NextResponse.json(
      { error: "Image record exists but the file is missing" },
      { status: 410 }
    );
  }

  const contentType =
    image.mimeType === PLACEHOLDER_MIME
      ? `${PLACEHOLDER_MIME}; charset=utf-8`
      : image.mimeType;

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
