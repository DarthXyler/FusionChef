import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const OPENAI_URL = "https://api.openai.com/v1/images/generations";
const DEFAULT_CASE_COUNT = 4;

const legacyOutput = {
  size: 512,
  quality: 60,
};

const upgradedOutput = {
  size: 768,
  quality: 72,
};

const testCases = [
  {
    id: "case-01",
    title: "Italian Mojito",
    baseCuisine: "Cuban",
    fusionCuisine: "Italian",
    mealType: "beverage",
  },
  {
    id: "case-02",
    title: "Middle Eastern Spiced Pol Roti with Chickpea Filling",
    baseCuisine: "Sri Lankan",
    fusionCuisine: "Middle Eastern",
    mealType: "main",
  },
  {
    id: "case-03",
    title: "Japanese Teriyaki Salmon Rice Bowl",
    baseCuisine: "Japanese",
    fusionCuisine: "Sri Lankan",
    mealType: "main",
  },
  {
    id: "case-04",
    title: "French Coconut Lime Tart",
    baseCuisine: "Western",
    fusionCuisine: "French",
    mealType: "dessert",
  },
  {
    id: "case-05",
    title: "Greek-Inspired Lentil Soup",
    baseCuisine: "Sri Lankan",
    fusionCuisine: "Greek",
    mealType: "soup",
  },
  {
    id: "case-06",
    title: "Indian Chili Tofu Rice Bowl",
    baseCuisine: "Japanese",
    fusionCuisine: "Indian",
    mealType: "main",
  },
];

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    count: DEFAULT_CASE_COUNT,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--count") {
      const next = Number.parseInt(args[index + 1] ?? "", 10);
      if (Number.isFinite(next) && next > 0) {
        parsed.count = Math.min(next, testCases.length);
      }
      index += 1;
    }
  }

  return parsed;
}

async function readEnvFile(filePath) {
  const map = new Map();
  try {
    const raw = await fs.readFile(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const separator = trimmed.indexOf("=");
      if (separator <= 0) {
        continue;
      }
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      map.set(key, value);
    }
  } catch {
    // Optional .env.local loader.
  }
  return map;
}

function getEnv(name, envMap) {
  const processValue = process.env[name];
  if (typeof processValue === "string" && processValue.trim().length > 0) {
    return processValue.trim();
  }
  const fileValue = envMap.get(name);
  return typeof fileValue === "string" && fileValue.trim().length > 0 ? fileValue.trim() : "";
}

function buildLegacyPrompt(input) {
  if (input.mealType === "beverage") {
    return [
      "Create a clean, appetizing photo-style image of a realistic fusion beverage.",
      `Drink title: ${input.title}`,
      `Base cuisine: ${input.baseCuisine}`,
      `Fusion cuisine: ${input.fusionCuisine}`,
      "The subject must be a drink only, not food.",
      "Show the beverage served in a glass, cup, or cocktail vessel with visible liquid.",
      "Keep the image focused on the drink itself, using garnish, color, herbs, citrus, ice, foam, or glassware to express the fusion.",
      "If the title refers to a known drink such as mojito, cocktail, mocktail, soda, tea, coffee, juice, or smoothie, preserve that drink presentation.",
      "Do not show plated food, bowls, rice, noodles, dumplings, buns, bread, salad, soup, meat, seafood, dessert, or any solid entree.",
      "No plate, no bowl, no fork, no spoon, no table spread dominated by food.",
      "Neutral background, no text, no watermarks.",
    ].join("\n");
  }

  if (input.mealType === "dessert") {
    return [
      "Create a clean, appetizing photo-style image of a realistic fusion dessert.",
      `Dessert title: ${input.title}`,
      `Base cuisine: ${input.baseCuisine}`,
      `Fusion cuisine: ${input.fusionCuisine}`,
      "Show a plated dessert, pastry, cake, tart, ice cream, or sweet treat.",
      "No savory entree presentation, no rice bowl, no meat, no soup.",
      "Neutral background, no text, no watermarks.",
    ].join("\n");
  }

  return [
    "Create a clean, appetizing photo-style image of a fusion dish.",
    `Dish title: ${input.title}`,
    `Base cuisine: ${input.baseCuisine}`,
    `Fusion cuisine: ${input.fusionCuisine}`,
    "Single plate, neutral background, no text, no watermarks.",
  ].join("\n");
}

function buildPremiumStyleGuidance() {
  return [
    "Professional editorial food photography for a premium restaurant menu.",
    "Hyper-realistic and appetizing with natural textures and believable plating.",
    "Cinematic side lighting with soft fill and shallow depth of field.",
    "Keep the hero subject sharply focused with clean composition and minimal props.",
    "Rich natural color grading, subtle contrast, no surreal or cartoon look.",
    "No text, watermark, logos, labels, people, or hands.",
  ];
}

function buildUpgradedPrompt(input) {
  const style = buildPremiumStyleGuidance();

  if (input.mealType === "beverage") {
    return [
      "Create a realistic fusion beverage photo.",
      `Drink title: ${input.title}`,
      `Base cuisine: ${input.baseCuisine}`,
      `Fusion cuisine: ${input.fusionCuisine}`,
      "The subject must be a drink only, not food.",
      "Show the beverage served in a glass, cup, or cocktail vessel with visible liquid.",
      "Keep the image focused on the drink itself, using garnish, color, herbs, citrus, ice, foam, or glassware to express the fusion.",
      "If the title refers to a known drink such as mojito, cocktail, mocktail, soda, tea, coffee, juice, or smoothie, preserve that drink presentation.",
      "Do not show plated food, bowls, rice, noodles, dumplings, buns, bread, salad, soup, meat, seafood, dessert, or any solid entree.",
      "No plate, no bowl, no fork, no spoon, no table spread dominated by food.",
      "Neutral background.",
      ...style,
    ].join("\n");
  }

  if (input.mealType === "dessert") {
    return [
      "Create a realistic fusion dessert photo.",
      `Dessert title: ${input.title}`,
      `Base cuisine: ${input.baseCuisine}`,
      `Fusion cuisine: ${input.fusionCuisine}`,
      "Show a plated dessert, pastry, cake, tart, ice cream, or sweet treat.",
      "No savory entree presentation, no rice bowl, no meat, no soup.",
      "Neutral background.",
      ...style,
    ].join("\n");
  }

  return [
    "Create a realistic fusion dish photo.",
    `Dish title: ${input.title}`,
    `Base cuisine: ${input.baseCuisine}`,
    `Fusion cuisine: ${input.fusionCuisine}`,
    "Show one plated dish as the hero subject.",
    "Neutral background.",
    ...style,
  ].join("\n");
}

async function fetchWithTimeout(input, init, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function generateImage({ apiKey, model, prompt, quality }) {
  const startedAt = Date.now();
  const response = await fetchWithTimeout(
    OPENAI_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        prompt,
        size: "auto",
        quality,
        n: 1,
      }),
    },
    45_000,
  );

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Image API failed (${response.status}): ${bodyText.slice(0, 300)}`);
  }

  const payload = await response.json();
  const b64 = payload?.data?.[0]?.b64_json;
  const url = payload?.data?.[0]?.url;

  let imageBytes = null;
  if (typeof b64 === "string" && b64.length > 0) {
    imageBytes = Buffer.from(b64, "base64");
  } else if (typeof url === "string" && url.length > 0) {
    const imageResponse = await fetchWithTimeout(url, {}, 20_000);
    if (!imageResponse.ok) {
      throw new Error(`Could not download generated image (${imageResponse.status}).`);
    }
    imageBytes = Buffer.from(await imageResponse.arrayBuffer());
  }

  if (!imageBytes) {
    throw new Error("No image bytes returned.");
  }

  return {
    imageBytes,
    durationMs: Date.now() - startedAt,
  };
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function nowStamp() {
  const iso = new Date().toISOString();
  return iso.replace(/[:.]/g, "-");
}

async function saveVariantFiles(baseBytes, outputDir, prefix, variantOutput) {
  const pngPath = path.join(outputDir, `${prefix}-raw.png`);
  await sharp(baseBytes).png().toFile(pngPath);

  const appWebpPath = path.join(outputDir, `${prefix}-app.webp`);
  await sharp(baseBytes)
    .resize(variantOutput.size, variantOutput.size, { fit: "cover" })
    .webp({ quality: variantOutput.quality })
    .toFile(appWebpPath);

  const [pngStat, webpStat] = await Promise.all([fs.stat(pngPath), fs.stat(appWebpPath)]);
  return {
    pngPath,
    appWebpPath,
    rawPngBytes: pngStat.size,
    appWebpBytes: webpStat.size,
  };
}

function toKb(bytes) {
  return Math.round((bytes / 1024) * 10) / 10;
}

async function writeReport(runDir, rows) {
  const reportLines = [
    "# Fuse Image A/B Report",
    "",
    "Variants:",
    "- A (legacy): old prompt + `quality=low` + app format `512/webp60`",
    "- B (upgraded): new prompt + `quality=medium` + app format `768/webp72`",
    "",
    "| Case | Meal | Legacy Latency | Upgraded Latency | Legacy App Size | Upgraded App Size | Files |",
    "|---|---:|---:|---:|---:|---:|---|",
  ];

  for (const row of rows) {
    reportLines.push(
      `| ${row.caseId} | ${row.mealType} | ${row.legacy.durationMs}ms | ${row.upgraded.durationMs}ms | ${toKb(row.legacy.appWebpBytes)}KB | ${toKb(row.upgraded.appWebpBytes)}KB | [view](./${row.caseId}/index.html) |`,
    );
  }

  await fs.writeFile(path.join(runDir, "REPORT.md"), reportLines.join("\n"), "utf8");
}

async function writeCaseGallery(runDir, row) {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${row.caseId} - ${row.title}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; background: #f6f7f9; color: #0f172a; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .card { background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; }
    img { width: 100%; max-width: 420px; border-radius: 10px; border: 1px solid #e2e8f0; background: #fff; }
    pre { white-space: pre-wrap; background: #0b1220; color: #dbeafe; padding: 12px; border-radius: 8px; font-size: 12px; }
  </style>
</head>
<body>
  <h1>${row.title}</h1>
  <p><strong>Meal:</strong> ${row.mealType} | <strong>Pairing:</strong> ${row.baseCuisine} + ${row.fusionCuisine}</p>
  <div class="grid">
    <div class="card">
      <h2>Legacy</h2>
      <p>quality=low, output=512/webp60, latency=${row.legacy.durationMs}ms, file=${toKb(row.legacy.appWebpBytes)}KB</p>
      <img src="./legacy-app.webp" alt="legacy output" />
      <h3>Prompt</h3>
      <pre>${row.legacy.prompt}</pre>
    </div>
    <div class="card">
      <h2>Upgraded</h2>
      <p>quality=medium, output=768/webp72, latency=${row.upgraded.durationMs}ms, file=${toKb(row.upgraded.appWebpBytes)}KB</p>
      <img src="./upgraded-app.webp" alt="upgraded output" />
      <h3>Prompt</h3>
      <pre>${row.upgraded.prompt}</pre>
    </div>
  </div>
</body>
</html>`;

  await fs.writeFile(path.join(runDir, row.caseId, "index.html"), html, "utf8");
}

async function main() {
  const args = parseArgs();
  const envMap = await readEnvFile(path.join(process.cwd(), ".env.local"));
  const apiKey = getEnv("OPENAI_API_KEY", envMap);
  const model = getEnv("OPENAI_IMAGE_MODEL", envMap) || "gpt-image-1";
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing. Set it in env or .env.local");
  }

  const selectedCases = testCases.slice(0, args.count);
  const runDir = path.join(process.cwd(), "artifacts", "image-ab", nowStamp());
  await ensureDir(runDir);

  const rows = [];
  console.log(`Running A/B test for ${selectedCases.length} cases with model ${model}...`);

  for (const testCase of selectedCases) {
    const caseDir = path.join(runDir, testCase.id);
    await ensureDir(caseDir);
    console.log(`- ${testCase.id}: ${testCase.title}`);

    const legacyPrompt = buildLegacyPrompt(testCase);
    const upgradedPrompt = buildUpgradedPrompt(testCase);

    const legacyGenerated = await generateImage({
      apiKey,
      model,
      prompt: legacyPrompt,
      quality: "low",
    });
    const upgradedGenerated = await generateImage({
      apiKey,
      model,
      prompt: upgradedPrompt,
      quality: "medium",
    });

    const legacyFiles = await saveVariantFiles(
      legacyGenerated.imageBytes,
      caseDir,
      "legacy",
      legacyOutput,
    );
    const upgradedFiles = await saveVariantFiles(
      upgradedGenerated.imageBytes,
      caseDir,
      "upgraded",
      upgradedOutput,
    );

    const row = {
      caseId: testCase.id,
      title: testCase.title,
      mealType: testCase.mealType,
      baseCuisine: testCase.baseCuisine,
      fusionCuisine: testCase.fusionCuisine,
      legacy: {
        durationMs: legacyGenerated.durationMs,
        appWebpBytes: legacyFiles.appWebpBytes,
        prompt: legacyPrompt,
      },
      upgraded: {
        durationMs: upgradedGenerated.durationMs,
        appWebpBytes: upgradedFiles.appWebpBytes,
        prompt: upgradedPrompt,
      },
    };

    rows.push(row);
    await writeCaseGallery(runDir, row);
  }

  await writeReport(runDir, rows);
  await fs.writeFile(path.join(runDir, "raw-metrics.json"), JSON.stringify(rows, null, 2), "utf8");

  console.log(`A/B report generated: ${path.join(runDir, "REPORT.md")}`);
}

main().catch((error) => {
  console.error("[fuse-image-ab-test] Failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
