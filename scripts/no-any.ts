import ts from "typescript";

const roots = ["apps", "packages", "scripts"] as const;
const violations: string[] = [];

for (const root of roots) {
  const glob = new Bun.Glob(`${root}/**/*.ts`);
  for await (const path of glob.scan({ cwd: ".", absolute: false, onlyFiles: true })) {
    const sourceText = await Bun.file(path).text();
    const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const inspect = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        const location = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push(`${path}:${String(location.line + 1)}:${String(location.character + 1)}: forbidden TSAnyKeyword`);
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
    if (sourceText.includes(["@ts", "ignore"].join("-"))) violations.push(`${path}: forbidden compiler suppression`);
  }
}

if (violations.length > 0) {
  for (const violation of violations) console.error(violation);
  process.exit(1);
}

console.log("zero-any policy: passed");
