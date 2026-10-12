import { NextResponse } from "next/server";

import {
  googleStaticMapUrl,
  readSignedViewport,
} from "@/backend/services/staticmap";

export const runtime = "nodejs";

/**
 * Google Static Maps basemap for a signed viewport.
 *
 * Exists so the API key stays on the server: the client only ever sees a URL on
 * our own origin. See src/backend/services/staticmap.ts for the signing scheme.
 *
 * A failed fetch returns 502 rather than an error image - the map components
 * fall back to their offline plot, so a Google outage costs the streets on the
 * basemap and nothing else.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const resolved = readSignedViewport(params);

  if ("error" in resolved) {
    return NextResponse.json(
      { error: resolved.error },
      { status: resolved.status }
    );
  }

  let upstream: Response | null = null;
  try {
    upstream = await fetch(googleStaticMapUrl(resolved.viewport), {
      signal: AbortSignal.timeout(6000),
      cache: "no-store",
    });
  } catch (err) {
    console.warn("[map] Google Static Maps unreachable, failing over to OSM:", (err as Error).message);
  }

  if (upstream && upstream.ok) {
    return new NextResponse(await upstream.arrayBuffer(), {
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "image/png",
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
      },
    });
  }

  // Fallback: If Google Static Maps is unconfigured, quota exceeded, or credits expired,
  // fetch the corresponding OpenStreetMap tile for the viewport center as a failsafe.
  try {
    const { centerLat, centerLng, zoom } = resolved.viewport;
    const clampedZoom = Math.min(Math.max(zoom, 1), 18);
    const n = 2 ** clampedZoom;
    const tileX = Math.floor(((centerLng + 180) / 360) * n);
    const sinLat = Math.sin((centerLat * Math.PI) / 180);
    const tileY = Math.floor(
      (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * n
    );

    const osmRes = await fetch(
      `https://tile.openstreetmap.org/${clampedZoom}/${tileX}/${tileY}.png`,
      {
        headers: {
          "User-Agent": "HalifaxTreeHazardDetection/2.0 (fallback-basemap)",
        },
        signal: AbortSignal.timeout(4000),
      }
    );

    if (osmRes.ok) {
      return new NextResponse(await osmRes.arrayBuffer(), {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
        },
      });
    }
  } catch (osmErr) {
    console.warn("[map] OSM fallback tile also failed:", (osmErr as Error).message);
  }

  return NextResponse.json({ error: "Map service unavailable" }, { status: 502 });
}
