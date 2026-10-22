import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DesktopCommanderClient } from "../src/desktop-commander-client.js";

const outputPath = fileURLToPath(
  new URL("../../tool-contracts/src/manifest.generated.json", import.meta.url),
);

const client = await DesktopCommanderClient.start();
try {
  const tools = await client.listTools();
  const manifest = tools
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  await writeFile(
    outputPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
} finally {
  await client.close();
}
