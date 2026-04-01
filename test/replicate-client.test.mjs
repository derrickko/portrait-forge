import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReplicateClient } from "../src/replicate-client.mjs";

function createStub() {
  const calls = [];
  return {
    calls,
    replicate: {
      run: async (model, payload) => {
        calls.push({ model, payload });
        return "https://example.com/output.png";
      }
    }
  };
}

describe("ReplicateClient", () => {
  it("requires a token when no stub is provided", () => {
    const previous = process.env.REPLICATE_API_TOKEN;
    delete process.env.REPLICATE_API_TOKEN;
    try {
      assert.throws(() => new ReplicateClient(), /REPLICATE_API_TOKEN is required/);
    } finally {
      if (previous) process.env.REPLICATE_API_TOKEN = previous;
    }
  });

  it("builds data URI input for buffers and uses version pin", async () => {
    const stub = createStub();
    const client = new ReplicateClient({
      apiToken: "test-token",
      version: "test-version",
      replicate: stub.replicate
    });

    const buffer = Buffer.from("hello");
    await client.removeBackground(buffer);

    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].model, "bria/remove-background:test-version");
    assert.match(stub.calls[0].payload.input.image, /^data:image\/png;base64,/);
  });

  it("passes through string inputs and default model", async () => {
    const stub = createStub();
    const client = new ReplicateClient({
      apiToken: "test-token",
      replicate: stub.replicate
    });

    await client.removeBackground("https://example.com/input.png");

    assert.equal(stub.calls[0].model, "bria/remove-background");
    assert.equal(stub.calls[0].payload.input.image, "https://example.com/input.png");
  });

  it("retries on retryable errors", async () => {
    let attempt = 0;
    const replicate = {
      run: async () => {
        attempt += 1;
        if (attempt === 1) {
          const error = new Error("rate limited");
          error.status = 429;
          throw error;
        }
        return "https://example.com/output.png";
      }
    };

    const originalSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => {
      fn();
      return 0;
    };

    try {
      const client = new ReplicateClient({ apiToken: "token", replicate });
      await client.removeBackground("https://example.com/input.png");
    } finally {
      global.setTimeout = originalSetTimeout;
    }

    assert.equal(attempt, 2);
  });

  it("accepts a custom model name", async () => {
    const stub = createStub();
    const client = new ReplicateClient({
      apiToken: "test-token",
      model: "cjwbw/rembg",
      replicate: stub.replicate
    });

    await client.removeBackground("https://example.com/input.png");
    assert.equal(stub.calls[0].model, "cjwbw/rembg");
  });

  it("combines custom model with version pin", async () => {
    const stub = createStub();
    const client = new ReplicateClient({
      apiToken: "test-token",
      model: "cjwbw/rembg",
      version: "abc123",
      replicate: stub.replicate
    });

    await client.removeBackground("https://example.com/input.png");
    assert.equal(stub.calls[0].model, "cjwbw/rembg:abc123");
  });

  it("does not retry on non-retryable errors", async () => {
    const replicate = {
      run: async () => {
        const error = new Error("bad request");
        error.status = 400;
        throw error;
      }
    };

    const client = new ReplicateClient({ apiToken: "token", replicate });
    await assert.rejects(() => client.removeBackground("https://example.com/input.png"), /bad request/i);
  });
});
