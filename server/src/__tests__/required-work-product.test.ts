import { describe, expect, it } from "vitest";
import {
  requiredWorkProductBlockReason,
  requiredWorkProductChangeBlockReason,
} from "../services/issues.ts";

const approvedPr = { type: "pull_request", status: "active", reviewState: "approved" };
const mergedPr = { type: "pull_request", status: "merged", reviewState: "none" };
const unreviewedPr = { type: "pull_request", status: "active", reviewState: "none" };
const approvedDoc = { type: "document", status: "active", reviewState: "approved" };

describe("requiredWorkProductBlockReason", () => {
  it("1. issue with no required type can close", () => {
    expect(requiredWorkProductBlockReason(null, [])).toBeNull();
    expect(requiredWorkProductBlockReason(undefined, [unreviewedPr])).toBeNull();
  });

  it("2. issue with required type cannot close without a matching accepted work product", () => {
    // no work products at all
    expect(requiredWorkProductBlockReason("pull_request", [])).toMatch(/requires an accepted 'pull_request'/);
    // work product of the wrong type
    expect(requiredWorkProductBlockReason("test_report", [approvedPr])).toMatch(/test_report/);
    // matching type but not reviewed/accepted
    expect(requiredWorkProductBlockReason("pull_request", [unreviewedPr])).toMatch(/pull_request/);
  });

  it("3. issue can close once a matching accepted work product exists", () => {
    // review-state approval satisfies
    expect(requiredWorkProductBlockReason("pull_request", [approvedPr])).toBeNull();
    // merged status satisfies without explicit review approval
    expect(requiredWorkProductBlockReason("pull_request", [mergedPr])).toBeNull();
    // mixed bag: one match among others
    expect(requiredWorkProductBlockReason("document", [unreviewedPr, approvedDoc])).toBeNull();
  });

  it("4. human waive = clearing requiredWorkProductType lifts the block", () => {
    // update() resolves the effective type as incoming ?? existing, so a PATCH
    // with { requiredWorkProductType: null, status: "done" } evaluates to null here.
    expect(requiredWorkProductBlockReason(null, [])).toBeNull();
  });
});

describe("requiredWorkProductChangeBlockReason (waiver guard)", () => {
  const AGENT = "agent-1";

  it("human can clear the requirement (waive) and close", () => {
    expect(requiredWorkProductChangeBlockReason(null, "pull_request", null)).toBeNull();
    expect(requiredWorkProductChangeBlockReason(undefined, "pull_request", null)).toBeNull();
  });

  it("agent cannot clear the requirement", () => {
    expect(requiredWorkProductChangeBlockReason(AGENT, "pull_request", null)).toMatch(/only a human/);
  });

  it("agent cannot change the required type to an easier one", () => {
    expect(requiredWorkProductChangeBlockReason(AGENT, "test_report", "document")).toMatch(/only a human/);
  });

  it("agent updates that leave the field untouched still close normally", () => {
    // field not in the patch at all
    expect(requiredWorkProductChangeBlockReason(AGENT, "pull_request", undefined)).toBeNull();
    // re-sending the same value is not a change
    expect(requiredWorkProductChangeBlockReason(AGENT, "pull_request", "pull_request")).toBeNull();
    // and the satisfied-deliverable path is unaffected (criterion 4)
    expect(
      requiredWorkProductBlockReason("pull_request", [
        { type: "pull_request", status: "merged", reviewState: "none" },
      ]),
    ).toBeNull();
  });

  it("agent may set the requirement when it is empty (strengthening only)", () => {
    expect(requiredWorkProductChangeBlockReason(AGENT, null, "pull_request")).toBeNull();
  });
});
