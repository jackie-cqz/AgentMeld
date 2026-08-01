import fs from "node:fs";

const source = fs.readFileSync("regex.txt", "utf8").trim();
if (!source || source.includes("\n")) {
  throw new Error("regex.txt must contain exactly one regular expression");
}

const regex = new RegExp(source);
const cases = [
  ["2026-07-21 request from 192.168.1.10 completed", "2026-07-21"],
  ["client=10.0.0.8 opened=2024-02-28 closed=2024-02-29", "2024-02-29"],
  ["invalid-ip=999.1.1.1 date=2025-01-01", null],
  ["client=127.0.0.1 invalid-date=2023-02-29", null],
];

for (const [line, expected] of cases) {
  const match = line.match(regex);
  const actual = match ? (match[1] ?? match[0]) : null;
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)} for ${line}, received ${String(actual)}`);
  }
}

console.log(`verified ${cases.length} public regex cases`);
