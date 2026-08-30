import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const IMMUTABLE_IMAGE_PATTERN = /^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/;

export function requiredImmutableSandboxImage(value) {
  const image = value?.trim();
  if (!image || !IMMUTABLE_IMAGE_PATTERN.test(image)) {
    throw new Error(
      "PLATFORM_SANDBOX_IMAGE_URI must be an immutable OCI image reference ending in @sha256:<64 lowercase hex characters>.",
    );
  }
  return image;
}

export async function patchTrueForgeSandboxImage({ image, sourcePath }) {
  const immutableImage = requiredImmutableSandboxImage(image);
  const manifest = JSON.parse(await readFile(sourcePath, "utf8"));
  if (
    !manifest ||
    typeof manifest !== "object" ||
    typeof manifest.uri !== "string"
  ) {
    throw new Error("TrueForge sandboxImage.json is malformed.");
  }
  await writeFile(
    sourcePath,
    `${JSON.stringify({ ...manifest, uri: immutableImage }, null, 2)}\n`,
    "utf8",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [, , image, sourcePath] = process.argv;
  if (!sourcePath) {
    throw new Error(
      "Usage: node platform-sandbox-image-contract.mjs <immutable-image-uri> <sandboxImage.json>",
    );
  }
  await patchTrueForgeSandboxImage({ image, sourcePath });
}
