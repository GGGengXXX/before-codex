import fs from "node:fs/promises";
import path from "node:path";

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]+$/;

function safeRequestId(requestId) {
  const value = String(requestId ?? "");
  return SAFE_REQUEST_ID.test(value) ? value : null;
}

function rawFilePath(directory, requestId) {
  const safeId = safeRequestId(requestId);
  if (!safeId) {
    throw new Error("Invalid request id for raw response storage");
  }
  return path.join(directory, `${safeId}.json`);
}

export function createRawResponseStore(directory) {
  const root = path.resolve(directory);

  return {
    async save({ requestId, storageId = requestId, bodyText, contentType = "", stream = false } = {}) {
      const filePath = rawFilePath(root, storageId);
      const rawText = typeof bodyText === "string" ? bodyText : String(bodyText ?? "");
      const envelope = {
        version: 1,
        request_id: requestId,
        raw_id: storageId,
        captured_at: new Date().toISOString(),
        content_type: contentType || null,
        stream: Boolean(stream),
        raw_text: rawText
      };
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await fs.chmod(root, 0o700);
      const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temporaryPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
      await fs.chmod(temporaryPath, 0o600);
      await fs.rename(temporaryPath, filePath);
      return {
        path: filePath,
        id: storageId,
        bytes: Buffer.byteLength(rawText),
        content_type: envelope.content_type,
        stream: envelope.stream
      };
    },

    async load(requestId) {
      const filePath = rawFilePath(root, requestId);
      const raw = await fs.readFile(filePath, "utf8");
      const envelope = JSON.parse(raw);
      return {
        path: filePath,
        request_id: envelope.request_id ?? requestId,
        raw_id: envelope.raw_id ?? requestId,
        captured_at: envelope.captured_at ?? null,
        content_type: envelope.content_type ?? null,
        stream: envelope.stream === true,
        raw_text: typeof envelope.raw_text === "string" ? envelope.raw_text : ""
      };
    }
  };
}
