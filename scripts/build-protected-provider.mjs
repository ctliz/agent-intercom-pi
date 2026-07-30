import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(repositoryRoot, "provider/entry.ts");
const outputPath = resolve(repositoryRoot, "provider/provider.mjs");

export function buildProtectedProvider() {
  const source = readFileSync(sourcePath, "utf8");
  const result = ts.transpileModule(source, {
    fileName: "provider/entry.ts",
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
      newLine: ts.NewLineKind.LineFeed,
      removeComments: false,
      sourceMap: false,
      inlineSourceMap: false,
      inlineSources: false,
    },
  });

  const errors = (result.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    throw new Error(ts.formatDiagnostics(errors, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => ".",
      getNewLine: () => "\n",
    }));
  }

  const generated = [
    "// Generated from provider/entry.ts by scripts/build-protected-provider.mjs.",
    "// Do not edit this artifact directly.",
    result.outputText.replace(/\r\n/g, "\n").trimEnd(),
    "",
  ].join("\n");

  mkdirSync(dirname(outputPath), { recursive: true });
  let previous;
  try {
    previous = readFileSync(outputPath, "utf8");
  } catch {
    previous = undefined;
  }
  if (previous !== generated) writeFileSync(outputPath, generated, "utf8");
  return generated;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildProtectedProvider();
}
