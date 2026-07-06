#!/usr/bin/env npx tsx
// ---------------------------------------------------------------------------
// P8: Quality Gates CLI — run pre-release gates from the command line
//
// Usage: pnpm quality:gates
// ---------------------------------------------------------------------------

import { runQualityGates } from "@/server/context-metrics/quality-gates";

const report = runQualityGates();
console.log(JSON.stringify(report, null, 2));

if (!report.allPassed) process.exit(1);
