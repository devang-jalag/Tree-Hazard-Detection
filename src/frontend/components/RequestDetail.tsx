"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Camera,
  Copy,
  ExternalLink,
  History,
  MapPin,
  MessageSquare,
  Printer,
} from "lucide-react";

import { AssessmentBreakdown } from "./AssessmentBreakdown";
import { FieldPhoto } from "./FieldPhoto";
import { DayPlan } from "./DayPlan";
import { HazardPoster } from "./HazardPoster";
import { HazardTag } from "./HazardTag";
import { PhotoAssessment } from "./PhotoAssessment";
import { PriorityBadge, ReviewBadge } from "./PriorityBadge";
import { StatusControl } from "./StatusControl";
import type { StaticMapImage } from "@/shared/map";
import type { BundlePlan } from "@/shared/types";
import type {
  Feedback,
  RequestImage,
  ScoredRequest,
  StatusChange,
} from "@/shared/types";

/**
 * Where the inspection is.
 *
 * Google basemap when a key is configured, and a stylized grid when it is not -
 * the pin is drawn here either way, centred because the viewport was built
 * around this request's coordinates.
 */
function LocationMap({
  request,
  basemap,
}: {
  request: ScoredRequest;
  basemap: StaticMapImage | null;
}) {
  const [mapError, setMapError] = useState(false);
  const located = request.latitude !== null && request.longitude !== null;
  const showBasemap = basemap && !mapError;

  return (
    <div className="border border-slate-200">
      <div
        className="relative w-full overflow-hidden bg-slate-100"
        style={{
          aspectRatio: basemap
            ? `${basemap.viewport.width} / ${basemap.viewport.height}`
            : "4 / 3",
        }}
      >
        {showBasemap ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={basemap.src}
            alt={`Map of ${request.address}`}
            onError={() => setMapError(true)}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <svg
            className="absolute inset-0 h-full w-full"
            viewBox="0 0 200 150"
            preserveAspectRatio="none"
            aria-hidden
          >
            <rect width="200" height="150" fill="#f1f5f9" />
            {[18, 52, 86, 120].map((y) => (
              <rect key={y} x="0" y={y} width="200" height="9" fill="#e2e8f0" />
            ))}
            {[26, 74, 122, 170].map((x) => (
              <rect key={x} x={x} y="0" width="9" height="150" fill="#e2e8f0" />
            ))}
            <rect x="80" y="24" width="36" height="24" fill="#e7e5e4" stroke="#d6d3d1" />
            <rect x="128" y="60" width="34" height="22" fill="#e7e5e4" stroke="#d6d3d1" />
            <rect x="36" y="94" width="30" height="22" fill="#e7e5e4" stroke="#d6d3d1" />
            <rect x="128" y="96" width="34" height="20" fill="#dcfce7" stroke="#bbf7d0" />
          </svg>
        )}

        {located && (
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-full">
            <MapPin
              className="h-8 w-8 fill-red-600 text-white drop-shadow"
              aria-hidden
            />
          </div>
        )}
      </div>

      {/* Below the raster, not over it: Google's attribution sits along the
          bottom edge of the image and has to stay legible. */}
      <div className="border-t border-slate-200 bg-white px-3 py-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-xs font-semibold text-slate-900">{request.address}</p>
            <p className="font-mono text-[10px] text-slate-500">
              {located
                ? `${request.latitude!.toFixed(4)}, ${request.longitude!.toFixed(4)} · ${request.locationSource}`
                : "No coordinates on file"}
            </p>
          </div>
          <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-500">
            {showBasemap ? "Google Maps" : "Offline Failsafe"}
          </span>
        </div>

        {located && (
          <div className="mt-2.5 flex items-center justify-between border-t border-slate-100 pt-2">
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${request.latitude},${request.longitude}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 hover:text-emerald-800 hover:underline"
            >
              <ExternalLink className="h-3 w-3" aria-hidden />
              Open in Google Maps ↗
            </a>
            <span className="text-[10px] text-slate-400">Arborist Navigation</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="label-caps">{label}</p>
      <div className="mt-1 text-sm font-medium text-slate-900">{children}</div>
    </div>
  );
}

export function RequestDetail({
  request,
  images,
  history,
  duplicates,
  feedback,
  plan,
  otherOpen,
  queueRank,
  ranks,
  locationMap,
  bundleMap,
}: {
  request: ScoredRequest;
  images: RequestImage[];
  history: StatusChange[];
  duplicates: ScoredRequest[];
  feedback: Feedback[];
  /** Null for a closed request - there is nothing left to schedule. */
  plan: BundlePlan | null;
  otherOpen: ScoredRequest[];
  queueRank: number | null;
  ranks: Record<string, number>;
  /** Signed basemaps built on the server; null when Google Maps is unconfigured. */
  locationMap: StaticMapImage | null;
  bundleMap: StaticMapImage | null;
}) {
  const { assessment } = request;

  return (
    <>
      <div className="no-print mx-auto max-w-[1500px] px-4 py-6 sm:px-6">
        <Link
          href="/admin"
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-600 transition-colors hover:text-slate-900"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to Queue
        </Link>

        <div className="mt-4 flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-5">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              Tree Hazard Assessment
            </h1>
            <p className="mt-1 text-lg text-slate-700">{request.address}</p>
            <p className="font-mono text-xs text-slate-500">
              {request.neighborhood} &middot; {request.reference}
              {queueRank !== null && (
                <> &middot; queue position #{String(queueRank).padStart(2, "0")}</>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <PriorityBadge priority={assessment.priority} size="lg" />
            <ReviewBadge status={assessment.reviewStatus} size="lg" />
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-2 border border-slate-900 bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-700"
            >
              <Printer className="h-4 w-4" aria-hidden />
              Print Poster
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border border-slate-200 bg-slate-50 px-4 py-3">
          <div>
            <p className="label-caps">Crew action</p>
            <p className="mt-0.5 text-xs text-slate-500">
              Completed work leaves the inspection queue and notifies the resident.
            </p>
          </div>
          <StatusControl requestId={request.id} status={request.status} />
        </div>

        <section className="mt-5 grid grid-cols-2 gap-5 border border-slate-200 bg-slate-50 p-4 sm:grid-cols-3 lg:grid-cols-6">
          <Fact label="Final Score">
            <span className="font-mono text-xl font-bold tabular-nums">
              {assessment.finalScore}
              <span className="text-sm font-normal text-slate-400"> / 100</span>
            </span>
          </Fact>
          <Fact label="Danger Score">
            <span className="font-mono text-xl font-bold tabular-nums">
              {assessment.breakdown.danger}
              <span className="text-sm font-normal text-slate-400"> / 100</span>
            </span>
          </Fact>
          <Fact label="Days Waiting">
            <span className="font-mono text-xl font-bold tabular-nums">
              {request.daysWaiting}
            </span>
          </Fact>
          <Fact label="Submitted">{request.submittedAt.slice(0, 10)}</Fact>
          <Fact label="Status">{request.status}</Fact>
          <Fact label="Est. Crew Time">{request.estimatedHours} h</Fact>
        </section>

        {duplicates.length > 0 && (
          <div className="mt-4 flex items-start gap-3 border-l-4 border-slate-400 bg-slate-50 px-4 py-3">
            <Copy className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden />
            <div>
              <p className="text-sm font-semibold text-slate-900">
                {duplicates.length} other report
                {duplicates.length === 1 ? "" : "s"} linked to this tree
              </p>
              <ul className="mt-1 space-y-0.5">
                {duplicates.map((duplicate) => (
                  <li key={duplicate.id} className="text-xs text-slate-600">
                    <span className="font-mono">{duplicate.reference}</span> ·{" "}
                    {duplicate.reporterName} · {duplicate.address}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[1fr_330px]">
          <div className="space-y-5">
            <section className="panel p-4">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-900">
                Resident Complaint
              </h2>
              <blockquote className="mt-3 border-l-4 border-slate-300 pl-4 text-[15px] leading-relaxed text-slate-800">
                {request.description}
              </blockquote>
              <p className="mt-3 text-xs text-slate-500">
                Reported by {request.reporterName} &middot;{" "}
                <span className="font-mono">{request.reporterEmail}</span>
              </p>
            </section>

            <section className="panel p-4">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-900">
                Why this was prioritized
              </h2>
              <p className="mt-3 text-[15px] leading-relaxed text-slate-800">
                {assessment.reasoning}
              </p>

              <div className="mt-5 border-t border-slate-200 pt-4">
                <h3 className="label-caps mb-3">Scoring Breakdown</h3>
                <AssessmentBreakdown assessment={assessment} />
              </div>
            </section>

            {plan && (
              <DayPlan
                plan={plan}
                others={otherOpen}
                ranks={ranks}
                basemap={bundleMap}
              />
            )}

            <PhotoAssessment assessment={assessment} />

            <section className="panel p-4">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-900">
                Hazards Detected
              </h2>
              {assessment.hazards.length > 0 ? (
                <>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {assessment.hazards.map((hazard) => (
                      <HazardTag key={hazard.id} hazard={hazard} />
                    ))}
                  </div>
                  <p className="mt-3 text-xs text-slate-500">
                    Each tag shows the phrase from the complaint that triggered it
                    and the points it contributed.
                  </p>
                </>
              ) : (
                <p className="mt-3 text-sm text-slate-600">
                  No specific hazards detected from complaint text.
                </p>
              )}

              <div className="mt-4 border-t border-slate-200 pt-3">
                <h3 className="label-caps">Review Assessment</h3>
                <p className="mt-1.5 text-sm text-slate-700">{assessment.reviewNote}</p>
              </div>
            </section>

            {feedback.length > 0 && (
              <section className="panel p-4">
                <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-900">
                  <MessageSquare className="h-4 w-4 text-slate-400" aria-hidden />
                  Resident Feedback
                </h2>
                <ul className="mt-3 space-y-3">
                  {feedback.map((entry) => (
                    <li key={entry.id} className="border-l-2 border-slate-200 pl-3">
                      {entry.rating !== null && (
                        <p className="font-mono text-xs font-semibold text-slate-700">
                          {entry.rating} / 5
                        </p>
                      )}
                      {entry.comment && (
                        <p className="mt-0.5 text-sm text-slate-700">{entry.comment}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>

          <aside className="space-y-5">
            <section className="panel p-4">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-900">
                <MapPin className="h-4 w-4 text-slate-400" aria-hidden />
                Inspection Location
              </h2>
              <LocationMap request={request} basemap={locationMap} />
            </section>

            <section className="panel p-4">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-900">
                <Camera className="h-4 w-4 text-slate-400" aria-hidden />
                Field Photo
              </h2>
              {images.length > 0 ? (
                <div className="space-y-3">
                  {images.map((image) => (
                    <FieldPhoto
                      key={image.id}
                      image={image}
                      reference={request.reference}
                    />
                  ))}
                </div>
              ) : (
                <div className="flex aspect-[4/3] items-center justify-center border-2 border-dashed border-slate-300 bg-slate-50">
                  <p className="text-sm text-slate-400">Field photo unavailable</p>
                </div>
              )}
            </section>

            <section className="panel p-4">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-900">
                <History className="h-4 w-4 text-slate-400" aria-hidden />
                Status History
              </h2>
              <ol className="space-y-2">
                {history.map((entry) => (
                  <li key={entry.id} className="text-xs">
                    <span className="font-mono text-slate-400">
                      {entry.createdAt.slice(0, 10)}
                    </span>{" "}
                    <span className="font-semibold text-slate-800">
                      {entry.toStatus}
                    </span>
                    <span className="text-slate-500"> · {entry.actor}</span>
                  </li>
                ))}
              </ol>
            </section>
          </aside>
        </div>

        <div className="mt-6 border-t border-slate-200 pt-4">
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-900">
            Printable Hazard Assessment Poster
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Preview of the one-page field sheet. &ldquo;Print Poster&rdquo; sends only
            this sheet to the printer.
          </p>
        </div>
      </div>

      {/* Outside .no-print: the only element that reaches the printer. */}
      <div className="px-4 pb-10 sm:px-6 print:p-0">
        <HazardPoster complaint={request} />
      </div>
    </>
  );
}
