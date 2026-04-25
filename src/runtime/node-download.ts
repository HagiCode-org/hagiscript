import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes?: number;
}

export interface DownloadOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onProgress?: (progress: DownloadProgress) => void;
}

export class NodeRuntimeNetworkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NodeRuntimeNetworkError";
  }
}

export async function downloadNodeArchive(
  url: string,
  destinationPath: string,
  options: DownloadOptions = {}
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, { signal: abortController.signal });
    if (!response.ok) {
      throw new NodeRuntimeNetworkError(
        `Failed to download Node.js archive: HTTP ${response.status}`
      );
    }

    if (!response.body) {
      throw new NodeRuntimeNetworkError(
        "Failed to download Node.js archive: response body was empty."
      );
    }

    await mkdir(dirname(destinationPath), { recursive: true });
    const totalBytes = parseContentLength(
      response.headers.get("content-length")
    );
    let receivedBytes = 0;

    await writeResponseBody(response.body, destinationPath, (chunkLength) => {
      receivedBytes += chunkLength;
      options.onProgress?.({ receivedBytes, totalBytes });
    });
  } catch (error) {
    if (error instanceof NodeRuntimeNetworkError) {
      throw error;
    }

    const reason = error instanceof Error ? error.message : String(error);
    throw new NodeRuntimeNetworkError(
      `Failed to download Node.js archive: ${reason}`,
      error instanceof Error ? { cause: error } : undefined
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function writeResponseBody(
  body: ReadableStream<Uint8Array>,
  destinationPath: string,
  onChunk: (chunkLength: number) => void
): Promise<void> {
  const reader = body.getReader();
  const file = createWriteStream(destinationPath);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      onChunk(value.byteLength);
      if (!file.write(value)) {
        await new Promise<void>((resolve) => file.once("drain", resolve));
      }
    }

    await new Promise<void>((resolve, reject) => {
      file.end((error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  } finally {
    reader.releaseLock();
    file.close();
  }
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
