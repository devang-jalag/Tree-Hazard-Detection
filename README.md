# Halifax Urban Forestry: Tree Hazard Inspection Triage Platform

An enterprise-grade geospatial triage and risk prioritization engine developed for the Halifax Regional Municipality (HRM) Urban Forestry division. The platform automates public complaint intake, resolves spatial data with automated fallback tiers, performs multi-modal hazard classification, and dynamically ranks arboricultural inspection backlogs to optimize field crew dispatch.

---

## 1. Executive Summary

Municipal forestry teams face substantial backlog volumes, with hundreds of concurrent citizen reports awaiting field review. Standard first-in, first-out (FIFO) scheduling fails during high-wind and storm events, where severe structural tree hazards (e.g., electrical line contact, imminent branch failure over public rights-of-way) require immediate site inspection.

This system provides:
1. **Intelligent Intake:** Public citizen reporting with automatic EXIF GPS extraction and multi-stage geocoding.
2. **Deterministic Risk Triage:** Algorithmic hazard extraction decoupled into static hazard classification and dynamic wait-time prioritization.
3. **Resilient Geospatial Architecture:** Multi-tier mapping supporting Google Maps Platform with zero-downtime automated failover to OpenStreetMap.
4. **Cloud-Native Storage:** Direct Google Cloud Storage (GCS) object storage integration with local database fallback.
5. **Operational Tooling:** Interactive queue management, day-plan route clustering, and printable standardized field inspection posters.

---

## 2. System Architecture

```mermaid
graph TD
    subgraph ClientLayer ["Client Layer (Next.js 14 App Router)"]
        PublicForm["Public Intake Portal (/)"]
        AdminDashboard["Admin Inspection Queue (/admin)"]
        DetailView["Request Detail & Poster (/admin/requests/[id])"]
    end

    subgraph ServerLayer ["Server & Application Services"]
        IntakeService["Intake Service (src/backend/services/intake.ts)"]
        ScoringEngine["Deterministic Scoring Engine (src/backend/domain/scoring.ts)"]
        BundlingEngine["Geospatial Route Planner (src/backend/domain/bundling.ts)"]
        GeoService["Geocoding Service (src/backend/services/geocode.ts)"]
        MapProxy["Basemap Proxy (/api/map)"]
        GCSClient["Google Cloud Storage Engine (src/backend/services/gcs.ts)"]
    end

    subgraph ExternalTiers ["External Infrastructure & Fallback Tiers"]
        GoogleMaps["Primary: Google Maps Platform (Geocoding & Static Maps)"]
        OSM["Fallback: OpenStreetMap / CartoDB Raster Tiles"]
        GCS["Primary Storage: Google Cloud Storage (Bucket: tree-hazard-images-503718)"]
        LocalDB["Database: Supabase PostgreSQL (pg-pool, additive migrations)"]
    end

    PublicForm --> IntakeService
    AdminDashboard --> ScoringEngine
    AdminDashboard --> BundlingEngine
    DetailView --> MapProxy

    IntakeService --> GeoService
    IntakeService --> GCSClient
    IntakeService --> LocalDB

    GeoService -->|Primary| GoogleMaps
    GeoService -->|Fallback| LocalDB

    MapProxy -->|Primary| GoogleMaps
    MapProxy -->|Automated Failover| OSM

    GCSClient -->|Primary Upload| GCS
    GCSClient -->|Fallback| LocalDB
```

---

## 3. End-to-End Data Flow Pipeline

```mermaid
sequenceDiagram
    autonumber
    actor Citizen as Citizen / Reporter
    participant App as Next.js Intake Service
    participant Geo as Geocoding Pipeline
    participant GCS as Google Cloud Storage
    participant DB as PostgreSQL Database
    participant Engine as Triage Engine
    actor Crew as Municipal Arborist

    Citizen->>App: Submits Report (Description, Street Address, Photo)
    App->>App: Extract EXIF GPS coordinates from photo metadata
    alt EXIF Present
        App->>App: Bind exact device GPS coordinates (Precision: Rooftop)
    else EXIF Missing
        App->>Geo: Request Geocoding (Google Maps API)
        alt Google Geocoding Active
            Geo-->>App: Return Geocoded Point & Precision Level
        else Quota Exceeded / Unconfigured
            Geo-->>App: Fallback to Offline Halifax Peninsula Gazetteer
        end
    end

    App->>GCS: Upload Image Buffer via Native RS256 JWT Client
    alt GCS Upload Success
        GCS-->>App: Return Public Object Storage URL
        App->>DB: Persist Record with CDN Image Reference
    else GCS Unconfigured / Fallback
        App->>DB: Persist Record with Base64 Payload in Database
    end

    App->>Engine: Run static classification (classifyComplaint)
    Engine->>DB: Store detected hazards & danger score (Engine: fused-v1)

    Note over DB,Crew: Arborist Queue Operation
    Crew->>App: Access Inspection Queue (/admin)
    App->>DB: Query active complaints
    App->>Engine: Recompute dynamic priority (scoreRequest with live wait decay)
    App-->>Crew: Render ranked queue & spatial inspection view
```

---

## 4. Architectural Decision Records (ADRs)

### ADR-001: Zero-Dependency Google Cloud Storage Engine
- **Context:** Complaint photos must be stored and served reliably on serverless infrastructure (Vercel) without exceeding execution payload limits or bloating the PostgreSQL database with base64 strings.
- **Decision:** Implement a custom, zero-dependency GCS client (`src/backend/services/gcs.ts`) utilizing native Node.js `crypto` (`RSA-SHA256`) and `fetch` to exchange signed service-account JWTs for OAuth2 tokens directly.
- **Rationale:** 
  1. Avoids pulling in the official `@google-cloud/storage` SDK, which introduces over 45 transitive dependencies, increasing cold-start latencies on edge runtimes.
  2. Ensures portability across serverless execution targets.
  3. Includes automated fallback to local/database storage when service credentials are unavailable.

### ADR-002: Multi-Tier Resilient Geospatial & Mapping Architecture
- **Context:** Field crews rely on map tiles for spatial context. Relying solely on a paid external API risks downtime when API quotas expire or billing credits lapse.
- **Decision:** Implement a 3-tier geospatial fallback pipeline:
  - **Tier 1 (Primary):** Google Maps Geocoding and Google Static Maps API for high-resolution vector and roadmap generation.
  - **Tier 2 (Secondary):** Automated server-side failover in `/api/map` to OpenStreetMap Web Mercator raster tiles upon upstream HTTP failure (non-200 or timeout).
  - **Tier 3 (Offline):** Embedded offline SVG street grid and local Halifax municipal gazetteer for peninsula address matching.
- **Rationale:** Eliminates hard single-point-of-failure dependencies on third-party API vendors while providing direct navigation links to Google Maps (`https://www.google.com/maps/search/?api=1&query=lat,lng`) for field crews.

### ADR-003: Bifurcated Scoring System (Static Classification vs. Live Triage)
- **Context:** Triage ranking depends both on intrinsic hazard severity (e.g., power line proximity, leaning angle) and elapsed wait time. Storing a precomputed "final score" in the database causes rankings to become stale every 24 hours.
- **Decision:** Decouple scoring into two strictly isolated functions:
  1. `classifyComplaint(text)`: Heavyweight NLP and vision classification executed once upon intake and persisted immutably with engine version stamping (`fused-v1`).
  2. `scoreRequest(classification, context)`: Lightweight, deterministic calculation executed on-demand during queue reads, dynamically factoring in live elapsed days (`daysWaiting * weight`).
- **Rationale:** Ensures all 290+ queued requests reflect mathematically accurate priority without requiring batch nightly database updates.

### ADR-004: Strict Layer Isolation
- **Context:** Shared codebases frequently suffer from server-side leaks into browser bundles, compromising environment credentials.
- **Decision:** Enforce architectural isolation:
  - `src/backend/`: Server-only logic (PostgreSQL client, GCS client, auth tokens). Never imported by client components.
  - `src/frontend/`: React client components and styling.
  - `src/shared/`: Isomorphic types and pure mathematical calculation functions (e.g., Haversine distance, Web Mercator projection).
- **Rationale:** Guarantees zero credential leakage to client bundles while maximizing testability.

---

## 5. Technology Stack

| Layer | Technologies | Rationale |
|---|---|---|
| **Framework** | Next.js 14 (App Router), React 18, TypeScript 5.6 | Fullstack execution, server actions, strict typing, route optimization. |
| **Database** | PostgreSQL via Supabase Pooler (`pg` 8.23) | Transactional data integrity, connection pooling for serverless elasticity. |
| **Cloud Storage** | Google Cloud Storage (Bucket: `tree-hazard-images-503718`) | Native JWT/OAuth2 RS256 client for zero-dependency image offloading. |
| **Geospatial** | Google Maps Platform, OpenStreetMap, Web Mercator projection | Tiered resiliency for geocoding and map tile rendering. |
| **Testing** | Vitest 2.1, TypeScript Compiler (`tsc --noEmit`) | High-speed unit testing, strict contract enforcement. |
| **Styling** | Vanilla CSS, Tailwind CSS 3.4, Lucide Icons | Responsive arborist dispatch UI and standardized printable field sheets. |
| **CI/CD** | GitHub Actions (`.github/workflows/ci.yml`) | Automated multi-version build, type-check, and test matrix. |

---

## 6. Directory Structure

```text
├── .github/
│   └── workflows/
│       └── ci.yml               # Automated CI pipeline (Build, Typecheck, Test)
├── backend/                     # Standalone Express services & GCS integration
│   ├── src/
│   │   ├── cloudStorage.js      # Zero-dependency GCS storage client
│   │   ├── complaintGenerator.js# Synthetic HRM complaint data generator
│   │   ├── hrmApi.js            # Open Data Halifax municipal integration
│   │   ├── server.js            # Standalone API server
│   │   └── supabaseClient.js    # Database connection layer
│   └── service-account.json     # Protected GCP service account (git-ignored)
├── docs/                        # Technical documentation & project specifications
│   └── specs/                   # System requirement specifications and tasks
├── src/
│   ├── app/                     # Next.js App Router (Routes & Server Handlers)
│   │   ├── admin/               # Administrative dispatch & authentication
│   │   ├── api/                 # API route handlers (maps, images, intake)
│   │   └── report/              # Public reporting interface
│   ├── backend/                 # Server-only domain services
│   │   ├── db/                  # PostgreSQL client, repository, migrations
│   │   ├── domain/              # Scoring, hazard classification, bundling
│   │   ├── seed/                # Halifax municipal fixtures and mock dataset
│   │   └── services/            # GCS, geocoding, static maps, EXIF extraction
│   ├── frontend/                # UI presentation components
│   │   └── components/          # MapView, RequestDetail, QueueView, DayPlan
│   └── shared/                  # Pure isomorphic utilities (geo, scoring, types)
├── README.md                    # System architecture and engineering manual
├── package.json                 # Project manifest and scripts
├── tsconfig.json                # Strict TypeScript configuration
└── vitest.config.ts             # Vitest test runner configuration
```

---

## 7. Environment Variables & Configuration

Copy `.env.example` to `.env.local` to configure local runtime settings:

```bash
# Database Configuration (Required)
DATABASE_URL=postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres

# Google Cloud Platform (Optional - Enables Cloud Storage)
GCS_BUCKET=tree-hazard-images-503718
GOOGLE_APPLICATION_CREDENTIALS=backend/service-account.json

# Geospatial Mapping (Optional - Enables Tier 1 Google Maps)
GOOGLE_MAPS_API_KEY=your_google_maps_api_key
MAP_PROXY_SECRET=your_hmac_signing_secret

# AI Vision Model (Optional - Enables Multimodal Analysis)
ANTHROPIC_API_KEY=your_anthropic_api_key
VISION_MODEL=claude-opus-5

# Authentication & Security
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin
ADMIN_SESSION_SECRET=your_session_secret
ADMIN_SESSION_HOURS=12
```

---

## 8. Development & Verification Runbook

### Prerequisites
- Node.js 20.x or higher
- npm 10.x or higher

### Local Setup
```bash
# 1. Install dependencies
npm install

# 2. Verify database connection
npm run db:check

# 3. Apply schema and seed engineered Halifax dataset
npm run db:reset

# 4. Run local development server
npm run dev
# Server accessible at: http://localhost:5177
```

### Verification & Testing
```bash
# Run strict TypeScript compilation check (0 errors required)
npm run typecheck

# Run complete Vitest unit test suite (36 tests)
npm test

# Build production bundle
npm run build
```

---

## 9. Engineering Team & Technical Ownership

- **Devang Jalag** ([@devang-jalag](https://github.com/devang-jalag)) — Geospatial Architecture Lead & Cloud Infrastructure
  - Engineered the multi-tier resilient Google Maps SDK with automated OpenStreetMap fallback.
  - Architected the zero-dependency Google Cloud Storage client with native RS256 token exchange.
  - Implemented the inspection map UI, field navigation integration, and investor technical deck.
- **Ketan Khunti** ([@ketan5050](https://github.com/ketan5050)) — Backend Architecture & Database
  - Engineered the Supabase PostgreSQL repository layer and serverless LLM pipeline.
- **Sanif Ali Momin** ([@sanifalimomin](https://github.com/sanifalimomin)) — Intake Workflow & Authentication
  - Implemented citizen complaint intake forms, session cookies, and admin gatekeeping.
- **Tarun Chauhan** — Data Engineering & Integration
  - Constructed municipal data models and test coordinates.

### Presentation Assets
- `CanopyGuard_Executive_Pitch.pptx`: Technical investor briefing.
- `Tree_Hazard_Detection_Pitch.pptx`: Platform overview presentation.
- `presentation.html`: Interactive browser-based system walkthrough.
