// Review focus 1: an embedder compiles the contracts, the engine, the test
// host and the server kit with no transitive import of the run host's
// generated database code. Two checks on the one program `tsconfig.json`
// names: it compiles clean, and no file the compiler loaded (types included)
// is generated database code or a database client.
const path = require('path');
const ts = require(require.resolve('typescript', { paths: [path.join(__dirname, '..')] }));

const configPath = path.join(__dirname, 'tsconfig.json');
const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (d) => {
    throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  },
});
const program = ts.createProgram({ rootNames: config.fileNames, options: config.options });

const diagnostics = ts.getPreEmitDiagnostics(program);
const isDatabaseCode = (file) =>
  /\/apps\/api\/src\/generated\//.test(file) ||
  /\/apps\/api\/src\/prisma(\/|\.ts$)/.test(file) ||
  /\/apps\/api\/src\/lib\/kysely\.ts$/.test(file) ||
  /\/node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?(kysely|@prisma|\.prisma)\//.test(file);
const reached = program.getSourceFiles().map((f) => f.fileName).filter(isDatabaseCode);

let failed = false;
if (diagnostics.length > 0) {
  failed = true;
  console.error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getNewLine: () => ts.sys.newLine,
    }),
  );
}
if (reached.length > 0) {
  failed = true;
  const shown = reached.filter((f) => !f.includes('/node_modules/')).concat(reached.filter((f) => f.includes('/node_modules/'))).slice(0, 20);
  console.error(`The embedder compile loaded ${reached.length} files of the run host's database code, among them:`);
  for (const file of shown) console.error(`  ${path.relative(path.join(__dirname, '../../..'), file)}`);
}
if (failed) process.exit(1);
console.log(`embed smoke: ${program.getSourceFiles().length} files compiled, none of them database code`);
