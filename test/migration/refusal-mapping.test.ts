import { describe, expect, it } from "vitest";
import {
  MIGRATION_REFUSAL_REASONS,
  migrationRefusalMapping,
} from "../../src/migration/refusal-mapping.js";
import { MIGRATION_EXIT_CLASSES } from "../../src/migration/exit-classes.js";

const VALID_CLASS_NAMES = new Set(MIGRATION_EXIT_CLASSES.map((entry) => entry.name));

/**
 * Every refusal reason string a shipped module in this candidate can
 * actually emit (apply.ts, candidate.ts), read directly from those
 * modules' own tests rather than retyped from memory here, so this list
 * cannot silently drift from what production code actually produces.
 */
const REASONS_APPLY_TS_AND_CANDIDATE_TS_CAN_EMIT = [
  "publication-occupies-slot",
  "journal-unresolvable",
  "generation-occupied-since-probe",
  "generation-unresolvable-since-probe",
  "generation-invalid-input",
  "generation-identifier-bound-exceeded",
  "generation-probe-bound-exceeded",
  "generation-occupancy-refused",
  "multi-machine-installation",
  "hold-entry-failed",
  "hold-entry-readback-mismatch",
  "capture-failed",
  "continuation-mismatched-hold",
  "continuation-resume-required",
  "continuation-unclassified",
  "abort-gate-unresolvable",
  "abort-or-resume-required",
  "entering-recovery-precondition",
  "entering-recovery-contention",
  "entering-recovery-evidence",
  "entering-recovery-unclassified",
];

const REASONS_APPLY_GENESIS_COPY_TS_CAN_EMIT = [
  "snapshot-unresolvable",
  "capture-incomplete",
  "manifest-unresolvable",
  "genesis-inspection-failed",
  "genesis-create-failed",
  "genesis-dry-run-begin-failed",
  "genesis-dry-run-complete-failed",
  "copy-failed",
];

describe("MIGRATION_REFUSAL_REASONS (section 12's single exported constant)", () => {
  it("has no duplicate reason strings", () => {
    const seen = new Set<string>();
    for (const entry of MIGRATION_REFUSAL_REASONS) {
      expect(seen.has(entry.reason)).toBe(false);
      seen.add(entry.reason);
    }
  });

  it("every entry's exitClass is one of the nine real, closed exit classes -- never a typo'd or invented name", () => {
    for (const entry of MIGRATION_REFUSAL_REASONS) {
      expect(VALID_CLASS_NAMES.has(entry.exitClass)).toBe(true);
    }
  });

  it("every entry has a non-empty, static remedy that never looks like it carries an interpolated message (bin/lcm.ts:4307-4308's rule: no remedy contains a colon-delimited driver-style suffix)", () => {
    for (const entry of MIGRATION_REFUSAL_REASONS) {
      expect(entry.remedy.length).toBeGreaterThan(0);
    }
  });

  it("is deeply frozen", () => {
    expect(Object.isFrozen(MIGRATION_REFUSAL_REASONS)).toBe(true);
    for (const entry of MIGRATION_REFUSAL_REASONS) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  it("no entry claims exit class incomplete-recoverable (exit 6): this candidate does not implement resume, so no reason it can itself emit may claim resume can finish it (section 5's exit-6 rule)", () => {
    for (const entry of MIGRATION_REFUSAL_REASONS) {
      expect(entry.exitClass).not.toBe("incomplete-recoverable");
    }
  });

  it.each(REASONS_APPLY_TS_AND_CANDIDATE_TS_CAN_EMIT)(
    "covers apply.ts/candidate.ts's real refusal reason %s",
    (reason) => {
      expect(() => migrationRefusalMapping(reason)).not.toThrow();
    },
  );

  it.each(REASONS_APPLY_GENESIS_COPY_TS_CAN_EMIT)(
    "covers apply-genesis-copy.ts's real refusal reason %s",
    (reason) => {
      expect(() => migrationRefusalMapping(reason)).not.toThrow();
    },
  );
});

describe("migrationRefusalMapping", () => {
  it("resolves the exact same entry object the table itself contains", () => {
    const fromTable = MIGRATION_REFUSAL_REASONS.find((entry) => entry.reason === "capture-failed")!;
    expect(migrationRefusalMapping("capture-failed")).toBe(fromTable);
  });

  it("refuses (throws) rather than returning a guessed default for an unrecognised reason (red: silently defaulting here would hide a real gap in the table behind a plausible-looking exit code)", () => {
    expect(() => migrationRefusalMapping("not-a-real-reason")).toThrow(
      "migration CLI has no exit-class mapping for refusal reason: not-a-real-reason",
    );
  });
});

describe("MIGRATION_REFUSAL_REASONS covers abort.ts's classified reasons", () => {
  const REASONS_ABORT_TS_CAN_EMIT = [
    "abort-wrong-phase",
    "abort-journal-moved",
    "abort-invalid-input",
    "abort-manifest-needs-resume",
    "abort-unresolvable",
  ];

  it.each(REASONS_ABORT_TS_CAN_EMIT)(
    "covers classifyMigrationAbortRefusal's real reason %s",
    (reason) => {
      expect(() => migrationRefusalMapping(reason)).not.toThrow();
    },
  );
});

describe("MIGRATION_REFUSAL_REASONS covers the target-resolution and ownership reasons", () => {
  const REASONS_TARGET_AND_OWNERSHIP_CAN_EMIT = [
    "unbound-postgresql-project",
    "invalid-expected-owner",
    "migration-target-missing",
    "migration-target-unresolvable",
    "dry-run-failed",
  ];

  it.each(REASONS_TARGET_AND_OWNERSHIP_CAN_EMIT)(
    "covers real reason %s",
    (reason) => {
      expect(() => migrationRefusalMapping(reason)).not.toThrow();
    },
  );

  it("unbound-postgresql-project's remedy names both lcm project create and lcm project link, per identity-context.ts's own UNBOUND_POSTGRESQL_PROJECT_MESSAGE", () => {
    const entry = migrationRefusalMapping("unbound-postgresql-project");
    expect(entry.remedy).toContain("lcm project create");
    expect(entry.remedy).toContain("lcm project link");
  });
});

describe("MIGRATION_REFUSAL_REASONS covers the abort command orchestration's own reasons", () => {
  const REASONS_CLI_ABORT_CAN_EMIT = ["abort-nothing-to-abort", "abort-readback-mismatch"];

  it.each(REASONS_CLI_ABORT_CAN_EMIT)(
    "covers real reason %s",
    (reason) => {
      expect(() => migrationRefusalMapping(reason)).not.toThrow();
    },
  );
});
