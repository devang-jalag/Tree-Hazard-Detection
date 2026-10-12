import { describe, expect, it } from "vitest";

import { fixtures } from "@/backend/seed/fixtures";
import {
  ENGINE_VERSION,
  applyEscalation,
  assess,
  calculateDangerScore,
  calculateLocationScore,
  calculateWaitScore,
  classifyComplaint,
  daysSince,
  detectHazards,
  getPriorityLevel,
  scoreRequest,
} from "./scoring";

describe("hazard detection", () => {
  it("detects leaning, property and power line from the spec example", () => {
    const hazards = detectHazards("Tree is leaning toward my house and power line.");
    const ids = hazards.map((h) => h.id);
    expect(ids).toContain("leaning");
    expect(ids).toContain("property");
    expect(ids).toContain("powerline");
    expect(calculateDangerScore(hazards)).toBe(65);
  });

  it("caps the danger score at 100", () => {
    const text =
      "Leaning tree has fallen onto the house and the car in the driveway, the power line is down, the trunk is split, a large dead branch is hanging, storm damage is blocking the road and the sidewalk.";
    expect(calculateDangerScore(detectHazards(text))).toBe(100);
  });

  it("returns no hazards for purely cosmetic text", () => {
    expect(detectHazards("Tree looks ugly and needs trimming.")).toHaveLength(0);
  });

  it("scores each rule at most once", () => {
    const hazards = detectHazards("Leaning, leaning, leaning tree.");
    expect(hazards.filter((h) => h.id === "leaning")).toHaveLength(1);
  });
});

describe("wait score", () => {
  it("maps days onto the 180-day ramp", () => {
    expect(calculateWaitScore(0)).toBe(0);
    expect(calculateWaitScore(90)).toBe(50);
    expect(calculateWaitScore(180)).toBe(100);
    expect(calculateWaitScore(290)).toBe(100);
  });

  it("derives whole days from an ISO submission timestamp", () => {
    const now = new Date("2026-09-12T12:00:00.000Z");
    expect(daysSince("2026-09-12T11:00:00.000Z", now)).toBe(0);
    expect(daysSince("2026-09-02T12:00:00.000Z", now)).toBe(10);
    // A future timestamp must not produce a negative wait.
    expect(daysSince("2026-10-01T12:00:00.000Z", now)).toBe(0);
  });
});

describe("location score", () => {
  it("ranks major streets above residential and quiet streets", () => {
    expect(calculateLocationScore("Barrington Street")).toBe(100);
    expect(calculateLocationScore("Quinpool Road")).toBe(90);
    expect(calculateLocationScore("Young Street")).toBe(40);
    expect(calculateLocationScore("Lawrence Street")).toBe(25);
  });
});

describe("priority thresholds", () => {
  it("uses the exact documented boundaries", () => {
    expect(getPriorityLevel(100)).toBe("Critical");
    expect(getPriorityLevel(80)).toBe("Critical");
    expect(getPriorityLevel(79)).toBe("High");
    expect(getPriorityLevel(60)).toBe("High");
    expect(getPriorityLevel(59)).toBe("Medium");
    expect(getPriorityLevel(35)).toBe("Medium");
    expect(getPriorityLevel(34)).toBe("Low");
    expect(getPriorityLevel(0)).toBe("Low");
  });
});

describe("human review flag", () => {
  const flagged = (text: string) => classifyComplaint(text).reviewStatus;

  it("flags bare vague complaints", () => {
    expect(flagged("Tree looks weird.")).toBe("Unsure");
    expect(flagged("Please check this tree.")).toBe("Unsure");
    expect(flagged("Tree needs attention.")).toBe("Unsure");
  });

  it("flags vague text even when a locator word trips a weak hazard rule", () => {
    const classification = classifyComplaint(
      "Something seems wrong with the tree behind my house."
    );
    expect(classification.reviewStatus).toBe("Unsure");
    expect(
      scoreRequest(classification, { daysWaiting: 0, street: "Test Street" })
        .breakdown.review
    ).toBe(100);
  });

  it("does not flag cosmetic complaints as unsure", () => {
    expect(flagged("Tree looks ugly and needs trimming.")).toBe("Reviewed");
  });

  it("does not flag detailed hazard complaints as unsure", () => {
    expect(
      flagged(
        "Massive oak leaning 45 degrees toward the house after the storm, trunk splitting at the base."
      )
    ).toBe("Reviewed");
  });

  it("keeps priority independent of the review flag", () => {
    const result = assess({
      description: "Tree looks weird.",
      daysWaiting: 0,
      street: "Test Street",
    });
    // review 100 * 0.10 + location 40 * 0.15 = 16 -> Low, not "Unsure"
    expect(result.priority).toBe("Low");
    expect(result.reviewStatus).toBe("Unsure");
  });
});

describe("final score", () => {
  it("applies the documented weights", () => {
    const result = assess({
      description: "Tree is leaning toward my house and power line.",
      street: "Quinpool Road",
      daysWaiting: 90,
    });
    // danger 65*.5 + wait 50*.25 + location 90*.15 + review 0*.10 = 59
    expect(result.breakdown).toEqual({ danger: 65, wait: 50, location: 90, review: 0 });
    expect(result.weightedScore).toBe(59);
    // danger 65 clears the 50+ threshold, so the floor lifts it to 60.
    expect(result.finalScore).toBe(60);
    expect(result.escalated).toBe(true);
  });

  it("leaves the weighted score alone when no floor binds", () => {
    const result = assess({
      description: "Leaves are blocking the sidewalk every fall.",
      street: "Test Street",
      daysWaiting: 90,
    });
    expect(result.escalated).toBe(false);
    expect(result.finalScore).toBe(result.weightedScore);
    expect(result.escalationReason).toBeNull();
  });

  it("builds reasoning from the factors it actually scored", () => {
    const result = assess({
      description: "Tree is leaning toward my house and power line.",
      street: "Quinpool Road",
      daysWaiting: 74,
    });
    expect(result.reasoning).toContain("leaning");
    expect(result.reasoning).toContain("74 days");
    expect(result.reasoning).toContain("Quinpool Road");
  });
});

describe("imminent-hazard escalation", () => {
  it("stops a severe same-day hazard from being buried at Medium", () => {
    const result = assess({
      description:
        "Massive oak leaning 45 degrees onto the house, trunk splitting at the base, large limbs hanging over the roof after the storm.",
      street: "Lawrence Street",
      daysWaiting: 0,
    });
    expect(result.weightedScore).toBeLessThan(60);
    expect(result.priority).toBe("Critical");
    expect(result.escalated).toBe(true);
    expect(result.escalationReason).toContain("Critical");
  });

  it("never lowers a score that already clears the floor", () => {
    expect(applyEscalation(95, 100)).toEqual({
      score: 95,
      escalated: false,
      reason: null,
    });
  });

  it("does not escalate low-danger complaints however long they have waited", () => {
    const result = assess({
      description: "Tree looks ugly and needs trimming.",
      street: "Test Street",
      daysWaiting: 290,
    });
    expect(result.escalated).toBe(false);
    expect(result.priority).not.toBe("Critical");
  });
});

describe("classification is stable and storable", () => {
  it("round-trips through JSON unchanged", () => {
    const classification = classifyComplaint(
      "Dead tree leaning toward overhead power lines after the storm."
    );
    const restored = JSON.parse(JSON.stringify(classification));
    expect(restored.dangerScore).toBe(classification.dangerScore);
    expect(restored.hazards).toEqual(classification.hazards);
  });

  it("stamps the engine version so stale rows can be found later", () => {
    expect(classifyComplaint("Tree looks weird.").engineVersion).toBe(ENGINE_VERSION);
  });

  it("produces the same score for the same inputs regardless of clock", () => {
    const classification = classifyComplaint("Large dead branch hanging over the road.");
    const a = scoreRequest(classification, { daysWaiting: 10, street: "Robie Street" });
    const b = scoreRequest(classification, { daysWaiting: 10, street: "Robie Street" });
    expect(a).toEqual(b);
  });
});

describe("the seed dataset", () => {
  const scored = fixtures.map((fixture) => ({
    fixture,
    assessment: assess({
      description: fixture.description,
      daysWaiting: fixture.daysAgo,
      street: fixture.street,
    }),
  }));

  it("has unique ids and references", () => {
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(fixtures.length);
    expect(new Set(fixtures.map((f) => f.reference)).size).toBe(fixtures.length);
  });

  it("never seeds a real email address", () => {
    for (const fixture of fixtures) {
      expect(fixture.reporterEmail.endsWith("@example.com")).toBe(true);
    }
  });

  it("gives every record usable coordinates", () => {
    for (const fixture of fixtures) {
      expect(fixture.latitude).toBeGreaterThan(44.5);
      expect(fixture.latitude).toBeLessThan(44.8);
      expect(fixture.longitude).toBeGreaterThan(-63.8);
      expect(fixture.longitude).toBeLessThan(-63.4);
    }
  });

  it("points every duplicate at a real primary", () => {
    const ids = new Set(fixtures.map((f) => f.id));
    for (const fixture of fixtures) {
      if (fixture.duplicateOf) expect(ids.has(fixture.duplicateOf)).toBe(true);
    }
  });

  it("produces every priority level", () => {
    const levels = new Set(scored.map((s) => s.assessment.priority));
    expect(levels).toContain("Critical");
    expect(levels).toContain("High");
    expect(levels).toContain("Medium");
    expect(levels).toContain("Low");
  });

  it("flags the two deliberately vague complaints for review", () => {
    const unsure = scored
      .filter((s) => s.assessment.reviewStatus === "Unsure")
      .map((s) => s.fixture.id);
    expect(unsure).toContain("r-e3-lawrence");
    expect(unsure).toContain("r-e2-seaforth");
  });
});
