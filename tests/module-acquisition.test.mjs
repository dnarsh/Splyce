// TD-28 cases for packages/splyce-pi/src/module-acquisition.ts (I1_selected_closure, I1_pin_integrity, I1_interrupt,
// I1_explicit_execution, I1_custom_plugin_source, C4_provision_offline). Real files in a temp directory and a real
// HTTP fixture server on 127.0.0.1; nothing leaves the machine. Names remain proposals pending TD-11/15/26 contracts.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  acquire,
  verifyCatalog,
  verifyInstalled,
} from "@splyce/pi/module-acquisition";
import { planInstall } from "@splyce/pi/module-plan";

const enc = (text) => new TextEncoder().encode(text);
const digestOf = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const COMMIT = "a".repeat(40);

const artifacts = {
  lsp: enc("lsp package bytes"),
  "ls-ts": enc("typescript language server bytes"),
  embedder: enc("embedder weights"),
  setupy: enc("#!/bin/sh\ntouch RAN_SETUP\n"),
  tool: enc("tool bytes"),
};
const entry = (id, over = {}) => ({
  id,
  commit: COMMIT,
  path: `packages/${id}`,
  digest: digestOf(artifacts[id]),
  license: "AGPL-3.0-only",
  sizeBytes: artifacts[id].length,
  requires: [],
  ...over,
});
const TRUST = generateKeyPairSync("ed25519");
const TRUST_PEM = TRUST.publicKey.export({ type: "spki", format: "pem" });
const verified = (cat) => {
  const bytes = enc(JSON.stringify({ entries: cat }));
  return verifyCatalog(
    { bytes, signature: new Uint8Array(sign(null, bytes, TRUST.privateKey)) },
    TRUST_PEM,
  );
};
const catalog = () => [
  entry("lsp", { requires: ["ls-ts"] }),
  entry("ls-ts"),
  entry("embedder"),
  entry("setupy", { setup: { executes: true } }),
  entry("tool", { requires: ["ls-ts"] }),
];

async function fixtureServer(served = artifacts, commits = {}) {
  const hits = [];
  const server = createServer((req, res) => {
    const id = decodeURIComponent(req.url.slice("/artifact/".length));
    hits.push(id);
    if (!(id in served)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("x-commit", commits[id] ?? COMMIT);
    res.end(served[id]);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const source = {
    async fetch(planEntry, signal) {
      let response;
      try {
        response = await fetch(
          `http://127.0.0.1:${port}/artifact/${planEntry.id}`,
          { signal },
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        throw Object.assign(new Error("connect failed"), { offline: true });
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return {
        commit: response.headers.get("x-commit"),
        bytes: new Uint8Array(await response.arrayBuffer()),
      };
    },
  };
  let closed = null;
  return {
    source,
    hits,
    close: () => (closed ??= new Promise((r) => server.close(r))),
  };
}

async function fileStore(root, faults = {}) {
  const at = (p) => join(root, p);
  return {
    async stage(path, bytes) {
      if (faults.stage) throw new Error("disk full");
      await mkdir(dirname(at(path)), { recursive: true });
      await writeFile(at(path), bytes);
    },
    async promote(from, to) {
      if (faults.promote === to) throw new Error("rename failed");
      await mkdir(dirname(at(to)), { recursive: true });
      if (
        await readFile(at(to)).then(
          () => true,
          () => false,
        )
      ) {
        await rm(at(from), { recursive: true, force: true });
        return "exists";
      }
      await rename(at(from), at(to));
    },
    async remove(path) {
      if (
        faults.remove === path ||
        (faults.remove === "*" && path.startsWith("staging"))
      ) {
        throw new Error("remove failed");
      }
      await rm(at(path), { recursive: true, force: true });
    },
    async read(path) {
      try {
        return new Uint8Array(await readFile(at(path)));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    async loadRecords() {
      try {
        return await readFile(at("installed.json"), "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    async saveRecords(json, expectedPrevious) {
      if (faults.records) throw new Error("records write failed");
      if (faults.slowSave) await faults.slowSave();
      let current = null;
      try {
        current = await readFile(at("installed.json"), "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (current !== expectedPrevious) {
        throw Object.assign(new Error("records changed"), { conflict: true });
      }
      await writeFile(at("installed.json.tmp"), json);
      await rename(at("installed.json.tmp"), at("installed.json"));
    },
  };
}

async function tree(root) {
  const out = [];
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(full.slice(root.length + 1).replaceAll("\\", "/"));
    }
  };
  await walk(root);
  return out.sort();
}

async function withEnv(fn, { served, commits, faults } = {}) {
  const root = await mkdtemp(join(tmpdir(), "splyce-acq-"));
  const server = await fixtureServer(served, commits);
  try {
    return await fn({ root, store: await fileStore(root, faults), ...server });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

const planFor = (selected, cat = catalog()) =>
  planInstall({ catalog: cat, selected });

test("I1_selected_closure: only the selected closure is fetched, verified and recorded, disabled", async () => {
  await withEnv(async ({ root, store, source, hits }) => {
    const { added } = await acquire({
      plan: planFor(["lsp"]),
      catalog: verified(catalog()),
      source,
      store,
    });
    assert.deepEqual(added.map((r) => r.id).sort(), ["ls-ts", "lsp"]);
    assert.deepEqual(hits.sort(), ["ls-ts", "lsp"]);
    assert.ok(
      added.every((r) => r.enabled === false && r.origin === "official"),
    );
    const files = await tree(root);
    assert.ok(files.includes("installed.json"));
    assert.equal(
      files.some((f) => f.startsWith("staging/")),
      false,
    );
    assert.equal(
      files.some((f) => f.includes("embedder")),
      false,
    );
    assert.ok((await verifyInstalled(store)).every((r) => r.ok));
  });
});

test("I1_selected_closure: a second acquisition reuses what is installed and fetches nothing", async () => {
  await withEnv(async ({ store, source, hits }) => {
    await acquire({
      plan: planFor(["lsp"]),
      catalog: verified(catalog()),
      source,
      store,
    });
    hits.length = 0;
    const again = await acquire({
      plan: planFor(["lsp"]),
      catalog: verified(catalog()),
      source,
      store,
    });
    assert.deepEqual(again.added, []);
    assert.deepEqual(again.reused.sort(), ["ls-ts", "lsp"]);
    assert.deepEqual(hits, []);
  });
});

test("I1_pin_integrity: a byte change fails the digest and nothing is promoted or recorded", async () => {
  const tampered = {
    ...artifacts,
    "ls-ts": enc("typescript language server bytes!"),
  };
  await withEnv(
    async ({ root, store, source }) => {
      await assert.rejects(
        acquire({
          plan: planFor(["lsp"]),
          catalog: verified(catalog()),
          source,
          store,
        }),
        (e) =>
          e.code === "ERR_ACQ_DIGEST_MISMATCH" ||
          e.code === "ERR_ACQ_SIZE_MISMATCH",
      );
      assert.deepEqual(await tree(root), []);
    },
    { served: tampered },
  );
});

test("I1_pin_integrity: same-size tampered bytes are caught by the digest, with the good dependency not promoted", async () => {
  const sameSize = { ...artifacts, lsp: enc("lsp package bytez") };
  assert.equal(sameSize.lsp.length, artifacts.lsp.length);
  await withEnv(
    async ({ root, store, source }) => {
      await assert.rejects(
        acquire({
          plan: planFor(["lsp"]),
          catalog: verified(catalog()),
          source,
          store,
        }),
        (e) => e.code === "ERR_ACQ_DIGEST_MISMATCH",
      );
      assert.deepEqual(await tree(root), []);
    },
    { served: sameSize },
  );
});

test("I1_pin_integrity: bytes built from another commit are refused", async () => {
  await withEnv(
    async ({ root, store, source }) => {
      await assert.rejects(
        acquire({
          plan: planFor(["ls-ts"]),
          catalog: verified(catalog()),
          source,
          store,
        }),
        (e) => e.code === "ERR_ACQ_COMMIT_MISMATCH",
      );
      assert.deepEqual(await tree(root), []);
    },
    { commits: { "ls-ts": "b".repeat(40) } },
  );
});

test("I1_pin_integrity: a plan made stale by a catalog change acquires nothing", async () => {
  await withEnv(async ({ root, store, source, hits }) => {
    const plan = planFor(["ls-ts"]);
    const moved = catalog().map((e) =>
      e.id === "ls-ts" ? { ...e, commit: "c".repeat(40) } : e,
    );
    await assert.rejects(
      acquire({ plan, catalog: verified(moved), source, store }),
      (e) => e.code === "ERR_ACQ_STALE_PLAN",
    );
    assert.deepEqual(hits, []);
    assert.deepEqual(await tree(root), []);
  });
});

test("I1_interrupt: an interrupt mid-closure leaves no record, no promoted bytes and no staging", async () => {
  await withEnv(async ({ root, store, source }) => {
    const controller = new AbortController();
    let calls = 0;
    const interrupting = {
      async fetch(planEntry, signal) {
        calls += 1;
        const got = await source.fetch(planEntry, signal);
        if (calls === 1) controller.abort();
        return got;
      },
    };
    await assert.rejects(
      acquire({
        plan: planFor(["lsp"]),
        catalog: verified(catalog()),
        source: interrupting,
        store,
        signal: controller.signal,
      }),
      (e) => e.code === "ERR_ACQ_INTERRUPTED",
    );
    assert.deepEqual(await tree(root), []);
  });
});

test("I1_interrupt: a store failure after promotion removes what was promoted and keeps records untouched", async () => {
  await withEnv(
    async ({ root, store, source }) => {
      await assert.rejects(
        acquire({
          plan: planFor(["lsp"]),
          catalog: verified(catalog()),
          source,
          store,
        }),
        (e) => e.code === "ERR_ACQ_STORE",
      );
      assert.deepEqual(await tree(root), []);
    },
    { faults: { records: true } },
  );
  await withEnv(async ({ root, source }) => {
    const plan = planFor(["lsp"]);
    const last = plan.closure[plan.closure.length - 1];
    const faulty = await fileStore(root, {
      promote: `modules/${last.id}/${last.digest.slice(7)}`,
    });
    await assert.rejects(
      acquire({ plan, catalog: verified(catalog()), source, store: faulty }),
      (e) => e.code === "ERR_ACQ_STORE",
    );
    assert.deepEqual(await tree(root), []);
  });
});

test("I1_explicit_execution: a setup request is recorded as pending, never run and never enabled", async () => {
  await withEnv(async ({ root, store, source }) => {
    const { added } = await acquire({
      plan: planFor(["setupy"]),
      catalog: verified(catalog()),
      source,
      store,
    });
    assert.equal(added[0].setupRequested, true);
    assert.equal(added[0].setupExecuted, false);
    assert.equal(added[0].enabled, false);
    const files = await tree(root);
    assert.equal(
      files.some((f) => f.includes("RAN_SETUP")),
      false,
    );
  });
});

test("I1_custom_plugin_source: a custom source is refused until acknowledged, then recorded as custom", async () => {
  await withEnv(async ({ root, store, source, hits }) => {
    await assert.rejects(
      acquire({
        plan: planFor(["ls-ts"]),
        catalog: verified(catalog()),
        source,
        store,
        origin: "custom",
      }),
      (e) => e.code === "ERR_ACQ_CUSTOM_UNACKNOWLEDGED",
    );
    assert.deepEqual(hits, []);
    assert.deepEqual(await tree(root), []);
    const { added } = await acquire({
      plan: planFor(["ls-ts"]),
      catalog: verified(catalog()),
      source,
      store,
      origin: "custom",
      customAcknowledged: true,
    });
    assert.equal(added[0].origin, "custom");
  });
});

test("C4_provision_offline: with no network the failure is explicit and nothing is left behind", async () => {
  await withEnv(async ({ root, store, source, close }) => {
    await close();
    await assert.rejects(
      acquire({
        plan: planFor(["lsp"]),
        catalog: verified(catalog()),
        source,
        store,
      }),
      (e) => e.code === "ERR_ACQ_OFFLINE",
    );
    assert.deepEqual(await tree(root), []);
  });
});

test("startup read is read-only: it reports changed or missing bytes and an unrecorded directory is not an install", async () => {
  await withEnv(async ({ root, store, source, hits }) => {
    await acquire({
      plan: planFor(["lsp"]),
      catalog: verified(catalog()),
      source,
      store,
    });
    hits.length = 0;
    const records = JSON.parse(await store.loadRecords());
    const lsp = records.find((r) => r.id === "lsp");
    await writeFile(join(root, lsp.installDir), enc("swapped"));
    const ls = records.find((r) => r.id === "ls-ts");
    await rm(join(root, ls.installDir));
    await mkdir(join(root, "modules/orphan/deadbeef"), { recursive: true });
    await writeFile(join(root, "modules/orphan/deadbeef/x"), enc("orphan"));
    const reports = await verifyInstalled(store);
    assert.equal(reports.find((r) => r.id === "lsp").ok, false);
    assert.equal(
      reports.find((r) => r.id === "ls-ts").problem,
      "bytes are missing",
    );
    assert.equal(
      reports.some((r) => r.id === "orphan"),
      false,
    );
    assert.deepEqual(hits, []);
  });
});

test("trust root: only a catalog signed by the compiled-in key is accepted", () => {
  const good = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  const pem = (k) => k.publicKey.export({ type: "spki", format: "pem" });
  const bytes = enc(JSON.stringify({ entries: catalog() }));
  const signature = new Uint8Array(sign(null, bytes, good.privateKey));
  assert.equal(verifyCatalog({ bytes, signature }, pem(good)).length, 5);
  const tampered = enc(
    JSON.stringify({
      entries: catalog().map((e) => ({ ...e, digest: digestOf(enc("evil")) })),
    }),
  );
  assert.throws(
    () => verifyCatalog({ bytes: tampered, signature }, pem(good)),
    (e) => e.code === "ERR_ACQ_CATALOG_UNTRUSTED",
  );
  assert.throws(
    () => verifyCatalog({ bytes, signature }, pem(other)),
    (e) => e.code === "ERR_ACQ_CATALOG_UNTRUSTED",
  );
  assert.throws(
    () => verifyCatalog({ bytes, signature }, "not a key"),
    (e) => e.code === "ERR_ACQ_CATALOG_UNTRUSTED",
  );
});

test("module ids that could escape the store are refused before anything is fetched or written", async () => {
  for (const id of [
    "../evil",
    "a/b",
    "a\b",
    ".hidden",
    "C:x",
    "UPPER",
    "",
    "a".repeat(65),
  ]) {
    const cat = [entry("ls-ts", { id })];
    await withEnv(async ({ root, store, source, hits }) => {
      await assert.rejects(
        acquire({
          plan: planFor([id], cat),
          catalog: verified(cat),
          source,
          store,
        }),
        (e) => e.code === "ERR_ACQ_BAD_ID",
        id,
      );
      assert.deepEqual(hits, []);
      assert.deepEqual(await tree(root), []);
    });
  }
});

test("official acquisition refuses a catalog that did not come from verifyCatalog", async () => {
  await withEnv(async ({ root, store, source, hits }) => {
    await assert.rejects(
      acquire({ plan: planFor(["ls-ts"]), catalog: catalog(), source, store }),
      (e) => e.code === "ERR_ACQ_CATALOG_UNTRUSTED",
    );
    assert.deepEqual(hits, []);
    assert.deepEqual(await tree(root), []);
    const forged = Object.freeze([...verified(catalog())]);
    await assert.rejects(
      acquire({ plan: planFor(["ls-ts"]), catalog: forged, source, store }),
      (e) => e.code === "ERR_ACQ_CATALOG_UNTRUSTED",
    );
    const { added } = await acquire({
      plan: planFor(["ls-ts"]),
      catalog: catalog(),
      source,
      store,
      origin: "custom",
      customAcknowledged: true,
    });
    assert.equal(added[0].origin, "custom");
  });
});

test("a supplied closure that differs from the reviewed roots installs nothing", async () => {
  await withEnv(async ({ root, store, source, hits }) => {
    const plan = planFor(["ls-ts"]);
    const extra = planFor(["embedder"]).closure[0];
    const forged = { ...plan, closure: [...plan.closure, extra] };
    await assert.rejects(
      acquire({ plan: forged, catalog: verified(catalog()), source, store }),
      (e) => e.code === "ERR_ACQ_STALE_PLAN",
    );
    assert.deepEqual(hits, []);
    assert.deepEqual(await tree(root), []);
  });
});

test("an interrupt during promotion is reported as interrupted, never as success", async () => {
  await withEnv(async ({ root, source }) => {
    const controller = new AbortController();
    const inner = await fileStore(root);
    const store = {
      ...inner,
      promote: async (from, to) => {
        await inner.promote(from, to);
        controller.abort();
      },
    };
    await assert.rejects(
      acquire({
        plan: planFor(["lsp"]),
        catalog: verified(catalog()),
        source,
        store,
        signal: controller.signal,
      }),
      (e) => e.code === "ERR_ACQ_INTERRUPTED",
    );
    assert.deepEqual(await tree(root), []);
  });
});

test("two acquisitions on one store are serialized and both records survive", async () => {
  await withEnv(async ({ store, source }) => {
    const cat = verified(catalog());
    const [a, b] = await Promise.all([
      acquire({ plan: planFor(["lsp"]), catalog: cat, source, store }),
      acquire({ plan: planFor(["embedder"]), catalog: cat, source, store }),
    ]);
    assert.equal(a.added.length + b.added.length, 3);
    const ids = JSON.parse(await store.loadRecords())
      .map((r) => r.id)
      .sort();
    assert.deepEqual(ids, ["embedder", "ls-ts", "lsp"]);
  });
});

test("independent writers on the same files cannot overwrite each other: the loser conflicts and cleans up", async () => {
  await withEnv(async ({ root, source }) => {
    const gate = { release: null };
    const slow = new Promise((r) => (gate.release = r));
    const a = await fileStore(root, { slowSave: () => slow });
    const b = await fileStore(root);
    const cat = verified(catalog());
    const first = acquire({
      plan: planFor(["lsp"]),
      catalog: cat,
      source,
      store: a,
    });
    const second = await acquire({
      plan: planFor(["embedder"]),
      catalog: cat,
      source,
      store: b,
    });
    assert.equal(second.added.length, 1);
    gate.release();
    await assert.rejects(first, (e) => e.code === "ERR_ACQ_CONFLICT");
    const ids = JSON.parse(await b.loadRecords()).map((r) => r.id);
    assert.deepEqual(ids, ["embedder"]);
    const files = await tree(root);
    assert.equal(
      files.some(
        (f) => f.includes("modules/lsp") || f.includes("modules/ls-ts"),
      ),
      false,
    );
  });
});

test("a cleanup that cannot remove staged bytes says so instead of claiming nothing was installed", async () => {
  await withEnv(async ({ root, source }) => {
    const store = await fileStore(root, { records: true, remove: "*" });
    await assert.rejects(
      acquire({
        plan: planFor(["lsp"]),
        catalog: verified(catalog()),
        source,
        store,
      }),
      (e) =>
        e.code === "ERR_ACQ_STORE" &&
        /cleanup incomplete/.test(e.message) &&
        /staging/.test(e.message),
    );
  });
});

test("records carry owner refs and a reused dependency gains the new owner", async () => {
  await withEnv(async ({ store, source, hits }) => {
    const cat = verified(catalog());
    await acquire({ plan: planFor(["lsp"]), catalog: cat, source, store });
    let records = JSON.parse(await store.loadRecords());
    assert.deepEqual(records.find((r) => r.id === "ls-ts").ownerRefs, ["lsp"]);
    assert.deepEqual(records.find((r) => r.id === "lsp").ownerRefs, []);
    hits.length = 0;
    const second = await acquire({
      plan: planFor(["tool"]),
      catalog: cat,
      source,
      store,
    });
    assert.deepEqual(hits, ["tool"]);
    assert.deepEqual(second.reused, ["ls-ts"]);
    records = JSON.parse(await store.loadRecords());
    assert.deepEqual(records.find((r) => r.id === "ls-ts").ownerRefs, [
      "lsp",
      "tool",
    ]);
  });
});

test("an interrupt stops further promotions, and one after the last promotion still blocks the record", async () => {
  for (const abortAt of [1, 2]) {
    await withEnv(async ({ root, source }) => {
      const controller = new AbortController();
      const inner = await fileStore(root);
      let promotes = 0;
      const store = {
        ...inner,
        promote: async (from, to) => {
          promotes += 1;
          await inner.promote(from, to);
          if (promotes === abortAt) controller.abort();
        },
      };
      await assert.rejects(
        acquire({
          plan: planFor(["lsp"]),
          catalog: verified(catalog()),
          source,
          store,
          signal: controller.signal,
        }),
        (e) => e.code === "ERR_ACQ_INTERRUPTED",
      );
      assert.equal(promotes, abortAt);
      assert.equal(await store.loadRecords(), null);
      assert.deepEqual(await tree(root), []);
    });
  }
});

test("a typed failure with a cleanup that cannot finish also names the leftover bytes", async () => {
  const tampered = { ...artifacts, lsp: enc("lsp package bytez") };
  await withEnv(
    async ({ root, source }) => {
      const store = await fileStore(root, { remove: "*" });
      await assert.rejects(
        acquire({
          plan: planFor(["lsp"]),
          catalog: verified(catalog()),
          source,
          store,
        }),
        (e) =>
          e.code === "ERR_ACQ_DIGEST_MISMATCH" &&
          /cleanup incomplete/.test(e.message),
      );
    },
    { served: tampered },
  );
});

test("a conflict loser sharing a dependency with the winner never removes the winner's committed bytes", async () => {
  await withEnv(async ({ root, source }) => {
    const gate = { release: null };
    const slow = new Promise((r) => (gate.release = r));
    const loser = await fileStore(root, { slowSave: () => slow });
    const winner = await fileStore(root);
    const cat = verified(catalog());
    const first = acquire({
      plan: planFor(["lsp"]),
      catalog: cat,
      source,
      store: loser,
    });
    // let the loser stage and promote ls-ts + lsp before the winner commits the same closure
    await new Promise((r) => setTimeout(r, 150));
    const second = await acquire({
      plan: planFor(["lsp"]),
      catalog: cat,
      source,
      store: winner,
    });
    assert.equal(second.added.length, 2);
    gate.release();
    await assert.rejects(first, (e) => e.code === "ERR_ACQ_CONFLICT");
    const reports = await verifyInstalled(winner);
    assert.deepEqual(reports.map((r) => [r.id, r.ok]).sort(), [
      ["ls-ts", true],
      ["lsp", true],
    ]);
  });
});

test("a verified catalog cannot be altered afterwards", () => {
  const cat = verified(catalog());
  assert.throws(() => {
    cat[0].digest = "sha256:" + "0".repeat(64);
  }, TypeError);
  assert.throws(() => cat[0].requires.push("evil"), TypeError);
  assert.throws(() => cat.push(cat[0]), TypeError);
});

test("a failing acquisition that found the bytes already promoted by another writer leaves them for that writer", async () => {
  await withEnv(async ({ root, source }) => {
    const gate = { release: null };
    const slow = new Promise((r) => (gate.release = r));
    const slowWriter = await fileStore(root, { slowSave: () => slow });
    const failing = await fileStore(root, { records: true });
    const cat = verified(catalog());
    const first = acquire({
      plan: planFor(["lsp"]),
      catalog: cat,
      source,
      store: slowWriter,
    });
    await new Promise((r) => setTimeout(r, 150));
    await assert.rejects(
      acquire({ plan: planFor(["lsp"]), catalog: cat, source, store: failing }),
      (e) => e.code === "ERR_ACQ_STORE",
    );
    gate.release();
    await first;
    const reports = await verifyInstalled(slowWriter);
    assert.deepEqual(reports.map((r) => [r.id, r.ok]).sort(), [
      ["ls-ts", true],
      ["lsp", true],
    ]);
  });
});
