import fs from "node:fs";

const source = fs.readFileSync("regex.txt", "utf8").trim();
if (!source || source.includes("\n")) throw new Error("regex.txt must contain one expression");
const regex = new RegExp(source);
const cases = JSON.parse(fs.readFileSync(".benchmark/hidden/cases.json", "utf8"));

for (const item of cases) {
  const match = item.line.match(regex);
  const actual = match ? (match[1] ?? match[0]) : null;
  if (actual !== item.expected) {
    throw new Error(`${item.name}: expected ${item.expected}, received ${actual}`);
  }
}

console.log(`verified ${cases.length} regex cases`);

