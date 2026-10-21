// Index a directory in-process and report timings, counts and memory.
//   node dist/bench.js <project-root> [symbol-to-look-up]
import { Indexer } from "./indexer.js";
import { calleesOf, callersOf, estTokens, findSymbols, fmtCallees, fmtCallers, fmtOutline } from "./queries.js";

const root = process.argv[2] ?? process.cwd();
const probe = process.argv[3];

const t0 = Date.now();
const ix = await Indexer.open(root);
const r1 = await ix.refresh({ force: true, minIntervalMs: 0 });
const t1 = Date.now();
const r2 = await ix.refresh({ force: false, minIntervalMs: 0 });
const t2 = Date.now();

const files = Object.values(ix.index.files);
let symbols = 0;
let refs = 0;
let bytes = 0;
for (const f of files) (symbols += f.symbols.length), (refs += f.refs.length), (bytes += f.size);
const mem = process.memoryUsage();

console.log(`root: ${ix.root}`);
console.log(`full build: ${t1 - t0} ms  (${r1.reparsed} files parsed, ${r1.errors.length} errors)`);
console.log(`no-op refresh: ${t2 - t1} ms  (${r2.scanned} stat'd, ${r2.reparsed} parsed)`);
console.log(`files ${files.length}  symbols ${symbols}  refs ${refs}  source ~${estTokens(bytes)} tokens`);
console.log(`rss ${(mem.rss / 1e6).toFixed(0)} MB  heap ${(mem.heapUsed / 1e6).toFixed(0)} MB`);
if (r1.errors.length) console.log("errors:", r1.errors.slice(0, 5));

// Outline savings across the repo: outline tokens vs full-read tokens.
let outlineTokens = 0;
for (const f of files) outlineTokens += estTokens(fmtOutline(f).length);
console.log(`sum of all outlines ~${outlineTokens} tokens = ${((outlineTokens / estTokens(bytes)) * 100).toFixed(1)}% of full source`);

if (probe) {
  const m = findSymbols(ix.index, probe, { limit: 5 });
  console.log(`\nfind_symbol ${probe}: ${m.length} matches`);
  for (const x of m) console.log(`  ${x.score}  ${x.symbol.kind} ${x.symbol.qualified}  ${x.symbol.file}:${x.symbol.startLine}  ${x.symbol.signature.slice(0, 80)}`);
  if (m[0]) {
    const s = m[0].symbol;
    const t3 = Date.now();
    const { hits, total } = await callersOf(ix, s.name, { excludeSymbolId: s.id, limit: 10 });
    const callees = calleesOf(ix.index, s);
    const slice = (s.endLine - s.startLine + 1) * 12; // rough chars/line
    const full = ix.index.files[s.file].size;
    console.log(`\nget_symbol ${s.qualified} in ${Date.now() - t3} ms: body ${s.endLine - s.startLine + 1} lines (~${estTokens(slice)} tok) vs file ${ix.index.files[s.file].lines} lines (~${estTokens(full)} tok)`);
    console.log(`callers (${total}):\n${fmtCallers(hits, total)}`);
    console.log(`callees:\n${fmtCallees(callees, 10)}`);
  }
}
