import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import {
  encodeFrame,
  readFrames,
  runHost,
} from "../packages/splyce-pi/src/engine-host.mjs";
import { createNativeHost } from "../packages/splyce-pi/src/native-host.mjs";

const binding = {
  scopeId: "native-request",
  actionId: "action",
  profileRevision: "p1",
  connectionRevision: "c1",
  target: `splyce-credential:v1:${"a".repeat(64)}`,
};
const request = (id, method, params = {}) => ({ id, method, params });
const prompt = {
  protocolVersion: 2,
  correlationId: "send",
  sessionId: "session",
  scopeId: "scope",
  expectedConfigRevision: "cfg",
  expectedProfileRevision: "profile",
  expectedPolicyRevision: "policy",
  op: "session.prompt",
  payload: { text: "hello" },
};

test("actual host pump reads private replies while an ordinary operation waits", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "splyce-native-pump-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = new PassThrough();
  const output = new PassThrough();
  const timer = setTimeout(() => {
    input.destroy(new Error("test deadline"));
    output.destroy();
  }, 5000);
  t.after(() => {
    clearTimeout(timer);
    input.destroy();
    output.destroy();
  });
  const observed = [];
  let read = false;
  const running = runHost(input, output, (path, native) => {
    const host = createNativeHost(path);
    return {
      ...host,
      async assertCurrent() {
        const scope = await native.open(binding);
        try {
          assert.equal(await scope.read(), "private-fixture");
          read = true;
        } finally {
          await scope.close();
        }
      },
    };
  }).finally(() => output.end());
  input.write(
    encodeFrame(
      request("native-bootstrap", "native.bootstrap", {
        appDataDir: directory,
      }),
    ),
  );
  for await (const frame of readFrames(output)) {
    if (frame.native) {
      if (frame.native.method === "credential.scope.open") {
        // This ordinary request must wait; the private reply must not wait behind it.
        input.write(
          encodeFrame(request("status", "handshake", { protocolVersion: 2 })),
        );
      }
      input.write(
        encodeFrame({
          native: {
            id: frame.native.id,
            ok: true,
            value:
              frame.native.method === "credential.read"
                ? { secret: "private-fixture" }
                : {},
          },
        }),
      );
      continue;
    }
    observed.push(frame);
    if (frame.id === "native-bootstrap")
      input.write(encodeFrame(request("send", "send", prompt)));
    if (frame.id === "status")
      input.write(encodeFrame(request("stop", "shutdown")));
  }
  await running;
  assert.equal(read, true);
  assert.deepEqual(
    observed.map(({ id }) => id),
    ["native-bootstrap", "send", "status", "stop"],
  );
  assert.equal(JSON.stringify(observed).includes("private-fixture"), false);
});

test("EOF during a private call revokes the host and closes the real Store", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "splyce-native-eof-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = new PassThrough();
  const output = new PassThrough();
  const timer = setTimeout(() => {
    input.destroy(new Error("test deadline"));
    output.destroy();
  }, 5000);
  t.after(() => {
    clearTimeout(timer);
    input.destroy();
    output.destroy();
  });
  let host;
  const running = runHost(input, output, (path, native) => {
    host = createNativeHost(path);
    return { ...host, assertCurrent: () => native.open(binding) };
  });
  // Attach before causing EOF so rejection is never unhandled.
  const rejected = assert.rejects(running, { code: "CREDENTIAL_UNAVAILABLE" });
  input.write(
    encodeFrame(
      request("native-bootstrap", "native.bootstrap", {
        appDataDir: directory,
      }),
    ),
  );
  for await (const frame of readFrames(output)) {
    if (frame.native) {
      input.end();
      break;
    }
    input.write(encodeFrame(request("send", "send", prompt)));
  }
  await rejected;
  assert.throws(() => host.current("scope"), { code: "STORE_CLOSED" });
});

test("closed output releases a backpressured write and closes the Store", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "splyce-native-closed-output-"));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const input = new PassThrough();
  let host;
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, _done) {
      setImmediate(() => this.destroy());
    },
  });
  const running = runHost(input, output, (path) => {
    host = createNativeHost(path);
    return host;
  });
  let settled = false;
  const rejected = assert.rejects(running, { name: "FrameError" }).then(() => {
    settled = true;
  });
  t.after(async () => {
    t.mock.timers.tick(10_001);
    await rejected;
    rmSync(directory, { recursive: true, force: true });
  });
  input.end(
    encodeFrame(
      request("native-bootstrap", "native.bootstrap", {
        appDataDir: directory,
      }),
    ),
  );
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(
    settled,
    true,
    "output close must settle without waiting for the write deadline",
  );
  await rejected;
  assert.throws(() => host.current("scope"), { code: "STORE_CLOSED" });
});

test("shutdown keeps private replies flowing until scope cleanup completes", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "splyce-native-stop-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = new PassThrough();
  const output = new PassThrough();
  const timer = setTimeout(() => {
    input.destroy(new Error("test deadline"));
    output.destroy();
  }, 5000);
  t.after(() => {
    clearTimeout(timer);
    input.destroy();
    output.destroy();
  });
  let scope;
  let host;
  const observed = [];
  const running = runHost(input, output, (path, native) => {
    host = createNativeHost(path);
    return {
      ...host,
      assertCurrent: async () => {
        scope = await native.open(binding);
      },
      async shutdown() {
        try {
          await scope.close();
        } finally {
          await host.shutdown();
        }
      },
    };
  }).finally(() => output.end());
  input.write(
    encodeFrame(
      request("native-bootstrap", "native.bootstrap", {
        appDataDir: directory,
      }),
    ),
  );
  for await (const frame of readFrames(output)) {
    if (frame.native) {
      observed.push(frame.native.method);
      input.write(
        encodeFrame({ native: { id: frame.native.id, ok: true, value: {} } }),
      );
    } else if (frame.id === "native-bootstrap")
      input.write(encodeFrame(request("send", "send", prompt)));
    else if (frame.id === "send")
      input.write(encodeFrame(request("stop", "shutdown")));
    else observed.push(frame.id);
  }
  await running;
  assert.deepEqual(observed, [
    "credential.scope.open",
    "credential.scope.close",
    "stop",
  ]);
  assert.throws(() => host.current("scope"), { code: "STORE_CLOSED" });
});

test("shutdown rejection terminates without a stopped acknowledgement or double close", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "splyce-native-stop-error-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = new PassThrough();
  const output = new PassThrough();
  const timer = setTimeout(() => {
    input.destroy(new Error("test deadline"));
    output.destroy();
  }, 5000);
  t.after(() => {
    clearTimeout(timer);
    input.destroy();
    output.destroy();
  });
  let calls = 0;
  let host;
  const running = runHost(input, output, (path) => {
    host = createNativeHost(path);
    return {
      ...host,
      async shutdown() {
        calls++;
        await host.shutdown();
        throw new Error("cleanup failed");
      },
    };
  }).finally(() => output.end());
  const rejected = assert.rejects(running, /cleanup failed/);
  input.write(
    encodeFrame(
      request("native-bootstrap", "native.bootstrap", {
        appDataDir: directory,
      }),
    ),
  );
  const replies = [];
  for await (const frame of readFrames(output)) {
    replies.push(frame.id);
    if (frame.id === "native-bootstrap")
      input.write(encodeFrame(request("stop", "shutdown")));
  }
  await rejected;
  assert.deepEqual(replies, ["native-bootstrap"]);
  assert.equal(calls, 1);
  assert.throws(() => host.current("scope"), { code: "STORE_CLOSED" });
});
