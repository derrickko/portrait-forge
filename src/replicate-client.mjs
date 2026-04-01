const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_BASE_MS = 2000;
const DEFAULT_BG_MODEL = "bria/remove-background";
const RETRYABLE_CODES = new Set([429, 500, 502, 503, 504]);

function buildImageInput(imageInput) {
  if (Buffer.isBuffer(imageInput)) {
    return `data:image/png;base64,${imageInput.toString("base64")}`;
  }
  if (typeof imageInput === "string") {
    return imageInput;
  }
  throw new Error("Unsupported image input for Replicate.");
}

export class ReplicateClient {
  constructor(config = {}) {
    const token = config.apiToken || config.env?.REPLICATE_API_TOKEN || process.env.REPLICATE_API_TOKEN;
    if (!token && !config.replicate) {
      throw new Error("REPLICATE_API_TOKEN is required");
    }

    const fileConfig = config.fileConfig || {};
    this.apiToken = token;
    this.replicate = config.replicate || null;
    this.model = config.model || fileConfig.models?.backgroundRemoval || process.env.REPLICATE_BG_MODEL || DEFAULT_BG_MODEL;
    this.version = config.version || fileConfig.models?.backgroundRemovalVersion || process.env.REPLICATE_BG_VERSION || null;
    this.maxRetries = Number(config.maxRetries || fileConfig.replicate?.maxRetries || process.env.REPLICATE_MAX_RETRIES || DEFAULT_MAX_RETRIES);
    this.backoffBaseMs = Number(config.backoffBaseMs || fileConfig.replicate?.backoffMs || process.env.REPLICATE_BACKOFF_MS || DEFAULT_BACKOFF_BASE_MS);
    this.replicatePromise = null;
  }

  async getReplicate() {
    if (this.replicate) {
      return this.replicate;
    }

    if (!this.replicatePromise) {
      this.replicatePromise = import("replicate").then(({ default: Replicate }) => (
        new Replicate({ auth: this.apiToken })
      ));
    }

    this.replicate = await this.replicatePromise;
    return this.replicate;
  }

  async removeBackground(imageInput) {
    const model = this.version
      ? `${this.model}:${this.version}`
      : this.model;
    const image = buildImageInput(imageInput);

    let lastError;
    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      try {
        const replicate = await this.getReplicate();
        return await replicate.run(model, { input: { image } });
      } catch (error) {
        lastError = error;
        const status = error?.response?.status || error?.status;
        if (attempt >= this.maxRetries || !RETRYABLE_CODES.has(status)) {
          throw error;
        }
        const delay = this.backoffBaseMs * Math.pow(2, attempt - 1);
        const jitter = delay * Math.random() * 0.5;
        await new Promise((resolve) => setTimeout(resolve, delay + jitter));
      }
    }

    throw lastError;
  }
}
