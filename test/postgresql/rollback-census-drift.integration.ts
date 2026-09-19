/**
 * PostgreSQL census drift test for item #626 (rollback), plan-v2 section
 * 7's mandatory requirement: "At least one drift test takes its census
 * from a real PG18 scan rather than a hand-built fixture, because a
 * fixture built by the same code path as the classifier cannot fail on a
 * shared canonicalization bug."
 *
 * This deliberately does NOT invent #624's production census algorithm
 * (activation-witness.ts does not exist on this branch, and #626 must
 * not create it -- see rollback-eligibility.ts's own boundary note). The
 * classifier under test is referenceClassifyRollbackMode, the same
 * independently-written reference implementation of witness-schema-
 * FROZEN-v2.md section 9 the rest of this item's tests already use. What
 * is real here is the SOURCE of the census/delta values: a straightforward
 * SQL scan (row count plus a content digest) over a REAL PostgreSQL 18
 * database provisioned by this repository's own harness, with a genuine
 * row mutation in between two scans -- not a fixture seeded by a string
 * and hashed the same way on both sides of the comparison.
 */

import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import { assertHarnessReady, withPostgreSqlTestDatabase } from "./harness.js";
import { referenceClassifyRollbackMode } from "../fixtures/rollback-eligibility-witness-schema.js";
import type {
  MigrationCanonicalDeltaShape,
  MigrationCensusVectorShape,
} from "../../src/migration/rollback-eligibility.js";

beforeAll(assertHarnessReady);

const options = { domain: "factory", operation: "testRollbackCensusDrift" } as const;

/**
 * A REAL PG18-sourced census/delta pair for the "project" domain: row
 * count plus a SHA-256 over the actual ordered row content, computed by
 * a live SQL query against lcm.projects. Two calls against unchanged
 * data must agree byte-for-byte; two calls straddling a real mutation
 * must disagree -- both are asserted below rather than assumed.
 */
async function scanProjectDomain(
  migrator: PostgreSqlRuntime,
): Promise<Readonly<{ delta: MigrationCanonicalDeltaShape; census: MigrationCensusVectorShape }>> {
  const result = await migrator.query<{ identity_key: string; display_name: string }>({
    text: "SELECT identity_key, display_name FROM lcm.projects ORDER BY identity_key",
  }, options);
  const recordCount = result.rows.length;
  const contentDigestInput = result.rows.map((row) => `${row.identity_key}:${row.display_name}`).join("\n");
  const contentSha256 = createHash("sha256").update(contentDigestInput, "utf8").digest("hex");
  return {
    delta: {
      version: 1,
      domains: [{ domain: "project", recordCount, terminalIdentitySha256: contentSha256 }],
    },
    census: {
      version: 1,
      domains: [{ domain: "project", recordCount, prefixSha256: contentSha256 }],
      contentSha256,
    },
  };
}

describe("PostgreSQL rollback census drift (donadiosolutions/lcm#626 plan-v2 section 7)", () => {
  it("classifies post-write when a real PG18 re-scan observes drift after the baseline, and pre-write when an identical re-scan observes none", async () => {
    await withPostgreSqlTestDatabase("rollback-census-drift", async ({ migrator }) => {
      const identityKey = "a".repeat(64);
      await migrator.query({
        text: "INSERT INTO lcm.projects (identity_key, display_name) VALUES (\$1, 'Baseline project')",
        values: [identityKey],
      }, options);

      const baseline = await scanProjectDomain(migrator);

      // Positive control: re-scan the SAME, unmutated state. Two
      // independent live scans of unchanged data must agree byte-for-byte
      // and classify pre-write -- proving the classifier does not simply
      // always report drift.
      const rescanUnchanged = await scanProjectDomain(migrator);
      expect(rescanUnchanged.delta).toEqual(baseline.delta);
      expect(rescanUnchanged.census).toEqual(baseline.census);
      const unchangedClassification = referenceClassifyRollbackMode({
        postEpochDelta: rescanUnchanged.delta,
        canonicalDeltaBaseline: baseline.delta,
        postEpochCensus: rescanUnchanged.census,
        censusVector: baseline.census,
      });
      expect(unchangedClassification).toEqual({ mode: "pre-write" });

      // Real drift: mutate a row for real, then re-scan for real.
      await migrator.query({
        text: "UPDATE lcm.projects SET display_name = 'Drifted project' WHERE identity_key = \$1",
        values: [identityKey],
      }, options);
      const drifted = await scanProjectDomain(migrator);

      // Breakable independently: the drifted scan's content digest must
      // actually differ from the baseline's -- proving the UPDATE above
      // landed in the real database, not merely that the classifier was
      // told to say so.
      expect(drifted.delta.domains[0]!.terminalIdentitySha256).not.toBe(
        baseline.delta.domains[0]!.terminalIdentitySha256,
      );
      expect(drifted.census.contentSha256).not.toBe(baseline.census.contentSha256);

      const driftedClassification = referenceClassifyRollbackMode({
        postEpochDelta: drifted.delta,
        canonicalDeltaBaseline: baseline.delta,
        postEpochCensus: drifted.census,
        censusVector: baseline.census,
      });
      expect(driftedClassification).toEqual({ mode: "post-write" });
    });
  });
});

