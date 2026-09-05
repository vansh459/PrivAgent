/**
 * Generates the client's TypeScript types and Zod validators from the server's Pydantic
 * models, so the wire contract has exactly one source of truth.
 *
 *   node scripts/gen-schemas.mjs           regenerate
 *   node scripts/gen-schemas.mjs --check   fail if the checked-in output is stale (CI)
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serverPython } from "./server-python.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JSON_SCHEMA_PATH = join(root, "schemas", "privagent.schema.json");
const TS_PATH = join(root, "extension", "src", "schemas", "generated.ts");

function exportJsonSchema() {
  const result = spawnSync(
    serverPython(),
    [join(root, "scripts", "export_schemas.py")],
    {
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: join(root, "server") },
    },
  );
  if (result.status !== 0) {
    throw new Error(`Schema export failed:\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

/** Resolves a `$ref` into the name of an already-emitted declaration. */
function refName(node) {
  return node.$ref ? node.$ref.replace("#/$defs/", "") : undefined;
}

function tsType(node) {
  const ref = refName(node);
  if (ref) return ref;
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.enum)
    return node.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (node.anyOf) return node.anyOf.map(tsType).join(" | ");
  switch (node.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return node.prefixItems
        ? `[${node.prefixItems.map(tsType).join(", ")}]`
        : `${tsType(node.items)}[]`;
    case "object":
      return node.additionalProperties &&
        typeof node.additionalProperties === "object"
        ? `Record<string, ${tsType(node.additionalProperties)}>`
        : "Record<string, unknown>";
    default:
      return "unknown";
  }
}

function zodType(node) {
  const ref = refName(node);
  if (ref) return `${ref}Schema`;
  if (node.const !== undefined)
    return `z.literal(${JSON.stringify(node.const)})`;
  if (node.enum) {
    return node.enum.length === 1
      ? `z.literal(${JSON.stringify(node.enum[0])})`
      : `z.enum([${node.enum.map((value) => JSON.stringify(value)).join(", ")}])`;
  }
  if (node.anyOf) {
    const nonNull = node.anyOf.filter((entry) => entry.type !== "null");
    const inner =
      nonNull.length === 1
        ? zodType(nonNull[0])
        : `z.union([${nonNull.map(zodType).join(", ")}])`;
    return node.anyOf.length > nonNull.length ? `${inner}.nullable()` : inner;
  }
  switch (node.type) {
    case "string": {
      let out = "z.string()";
      if (node.minLength) out += `.min(${node.minLength})`;
      if (node.maxLength) out += `.max(${node.maxLength})`;
      if (node.pattern) out += `.regex(/${node.pattern}/)`;
      return out;
    }
    case "integer":
    case "number": {
      let out = node.type === "integer" ? "z.number().int()" : "z.number()";
      if (node.minimum !== undefined) out += `.min(${node.minimum})`;
      if (node.maximum !== undefined) out += `.max(${node.maximum})`;
      return out;
    }
    case "boolean":
      return "z.boolean()";
    case "null":
      return "z.null()";
    case "array":
      return node.prefixItems
        ? `z.tuple([${node.prefixItems.map(zodType).join(", ")}])`
        : `z.array(${zodType(node.items)})`;
    case "object":
      return node.additionalProperties &&
        typeof node.additionalProperties === "object"
        ? `z.record(z.string(), ${zodType(node.additionalProperties)})`
        : "z.record(z.string(), z.unknown())";
    default:
      return "z.unknown()";
  }
}

function declaration(name, node) {
  const required = new Set(node.required ?? []);
  const entries = Object.entries(node.properties ?? {});

  const fields = entries
    .map(
      ([key, value]) =>
        `  ${key}${required.has(key) ? "" : "?"}: ${tsType(value)};`,
    )
    .join("\n");

  const validators = entries
    .map(([key, value]) => {
      const schema = zodType(value);
      return `  ${key}: ${required.has(key) ? schema : `${schema}.optional()`},`;
    })
    .join("\n");

  const doc = node.description ? `/** ${node.description} */\n` : "";
  return [
    `${doc}export interface ${name} {`,
    fields,
    "}",
    "",
    `export const ${name}Schema: z.ZodType<${name}> = z.strictObject({`,
    validators,
    "});",
  ].join("\n");
}

function generate(bundle) {
  const declarations = [];
  const emitted = new Set();

  for (const [name, schema] of Object.entries(bundle)) {
    for (const [defName, defSchema] of Object.entries(schema.$defs ?? {})) {
      if (emitted.has(defName)) continue;
      emitted.add(defName);
      declarations.push(declaration(defName, defSchema));
    }
    if (emitted.has(name)) continue;
    emitted.add(name);
    declarations.push(declaration(name, schema));
  }

  return [
    "// GENERATED FILE - DO NOT EDIT.",
    "// Source of truth: server/app/schemas.py",
    "// Regenerate with: npm run gen:schemas",
    "",
    'import { z } from "zod";',
    "",
    declarations.join("\n\n"),
    "",
  ].join("\n");
}

const bundle = exportJsonSchema();
const jsonOut = `${JSON.stringify(bundle, null, 2)}\n`;
const tsOut = generate(bundle);

if (process.argv.includes("--check")) {
  const stale = [
    [JSON_SCHEMA_PATH, jsonOut],
    [TS_PATH, tsOut],
  ].filter(([path, expected]) => {
    try {
      return readFileSync(path, "utf8") !== expected;
    } catch {
      return true;
    }
  });

  if (stale.length > 0) {
    console.error(
      `Generated schema output is stale:\n${stale
        .map(([path]) => `  ${path}`)
        .join("\n")}\nRun \`npm run gen:schemas\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log("Generated schema output is up to date.");
} else {
  mkdirSync(dirname(JSON_SCHEMA_PATH), { recursive: true });
  writeFileSync(JSON_SCHEMA_PATH, jsonOut);
  writeFileSync(TS_PATH, tsOut);
  console.log(`Wrote ${JSON_SCHEMA_PATH}\nWrote ${TS_PATH}`);
}
