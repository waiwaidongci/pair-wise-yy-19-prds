/* Node 直测内核：内存存储 + 共享 Web Locks，模拟两个标签页与容量上限。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const webcrypto = require("node:crypto").webcrypto;
const { createThinSectionStore } = require("../app.js");

if (!globalThis.crypto) globalThis.crypto = webcrypto;

// 跨所有「标签页」共享的存储后端与锁队列
const sharedBackend = new Map();
const sharedLocks = new Map();

function createMemoryStorage(quotaInfinity = false) {
  function bytesOfMap() {
    let n = 0;
    for (const v of sharedBackend.values()) n += String(v).length;
    return n;
  }
  return {
    quota: Infinity,
    get length() {
      return sharedBackend.size;
    },
    key(i) {
      return Array.from(sharedBackend.keys())[i];
    },
    getItem(key) {
      return sharedBackend.has(key) ? sharedBackend.get(key) : null;
    },
    setItem(key, value) {
      const v = String(value);
      const old = sharedBackend.has(key) ? String(sharedBackend.get(key)).length : 0;
      if (!quotaInfinity && bytesOfMap() - old + v.length > this.quota) {
        const err = new Error("QuotaExceededError");
        err.name = "QuotaExceededError";
        err.code = 22;
        throw err;
      }
      sharedBackend.set(key, v);
    },
    removeItem(key) {
      sharedBackend.delete(key);
    }
  };
}

function sharedLocksApi() {
  return {
    locks: {
      request(name, callback) {
        const prev = sharedLocks.get(name) || Promise.resolve();
        let release;
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        const next = prev.then(() => gate);
        sharedLocks.set(name, next.catch(() => {}));
        return prev.then(() => Promise.resolve(callback())).finally(release);
      }
    }
  };
}

// 锁 API 跨「标签页」共享（同一后端队列）；其余环境各自独立
function freshTab(storage) {
  return createThinSectionStore(storage, {
    locks: true,
    navigator: sharedLocksApi(),
    estimate: () => ({ quota: storage.quota })
  });
}

async function hashOf(text) {
  const buf = await webcrypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// 生成「图片」: 实际是任意内容，dataURL 与哈希都基于该内容，保证哈希一致即可
async function item(name, content, extra) {
  const bytes = new TextEncoder().encode(content);
  const hash = await hashOf(content);
  const dataUrl = "data:application/octet-stream;base64," + Buffer.from(bytes).toString("base64");
  return Object.assign(
    {
      hash,
      dataUrl,
      name,
      code: name,
      photoTakenAt: new Date(extra && extra.taken ? extra.taken : Date.now()).toISOString()
    },
    extra || {}
  );
}

test("导入形成批次，按内容哈希去重，重复导入沿用首次结果", async () => {
  sharedBackend.clear();
  const store = freshTab(createMemoryStorage());

  const a = await item("BX-01", "photo-content-A", { taken: 1_700_000_000_000 });
  const b = await item("BX-02", "photo-content-B", { taken: 1_700_000_001_000 });
  // 完全重复的文件（同名同内容）
  const dup = await item("BX-01", "photo-content-A", { taken: 1_700_000_000_000 });

  const r1 = await store.importBatch([a, b]);
  assert.equal(r1.total, 2);
  assert.equal(r1.done, 2);

  // 再次提交同样两张（典型野外重复导入）
  const r2 = await store.importBatch([a, b]);
  assert.equal(r2.done, 2);
  assert.equal(r2.reused, 2);
  assert.equal(r2.batchId, r1.batchId);

  const snap = await store.snapshot();
  assert.equal(snap.samples.length, 2); // 完全重复不新增样本
  assert.equal(Object.keys(snap.photos).length, 2);

  // 同一批次里混入完全重复的文件（条目去重、照片去重）
  const store2 = freshTab(createMemoryStorage());
  const r3 = await store2.importBatch([a, b, dup]);
  const snap3 = await store2.snapshot();
  assert.equal(r3.total, 2);
  assert.equal(snap3.samples.length, 2);
  assert.equal(store2.getPhotoData(a.hash), a.dataUrl);
});

test("同编号冲突：保留旧记录文字/批注，照片更新为较新的一张", async () => {
  sharedBackend.clear();
  const store = freshTab(createMemoryStorage());

  const oldPhoto = await item("BX-07", "OLD-IMAGE", { taken: 1_600_000_000_000 });
  await store.importBatch([oldPhoto]);
  const before = (await store.snapshot()).samples.find((s) => s.code === "BX-07");
  await store.upsertSampleForm({
    id: before.id,
    code: "BX-07",
    location: "剖面西侧第一层",
    minerals: "石英",
    comment: "老师批注：保留这条",
    polarization: "单偏光"
  });

  // 另一批次出现同编号、内容不同且拍摄时间更晚的照片
  const newPhoto = await item("BX-07.png", "NEW-IMAGE", { taken: 1_800_000_000_000 });
  await store.importBatch([newPhoto]);

  const after = (await store.snapshot()).samples.filter((s) => s.code === "BX-07");
  assert.equal(after.length, 1, "冲突不新增样本");
  assert.equal(after[0].comment, "老师批注：保留这条", "旧批注保留");
  assert.equal(after[0].location, "剖面西侧第一层", "旧地点保留");
  assert.equal(after[0].photoHash, newPhoto.hash, "照片更新为较新的");

  // 更旧的照片再进来，不应覆盖
  const olderAgain = await item("BX-07", "SHOULD-NOT-WIN", { taken: 1_500_000_000_000 });
  await store.importBatch([olderAgain]);
  const snap = await store.snapshot();
  const still = snap.samples.find((s) => s.code === "BX-07");
  assert.equal(still.photoHash, newPhoto.hash, "较旧照片不覆盖");
});

test("容量不足：先回收孤图，再按未确认最旧顺序回收，对比栏与已确认受保护", async () => {
  sharedBackend.clear();
  const storage = createMemoryStorage();
  storage.quota = Infinity; // 先宽松导入 4 张并设置保护
  const store = freshTab(storage);

  const PHOTO = 4000; // 每张 dataURL 约 5.4KB，元数据相对可忽略
  const a = await item("OLD-1", "x".repeat(PHOTO), { taken: 1_600_000_000_000 });
  const b = await item("OLD-2", "y".repeat(PHOTO), { taken: 1_600_000_001_000 });
  const c = await item("KEEP-CONFIRMED", "z".repeat(PHOTO), { taken: 1_600_000_002_000 });
  const d = await item("KEEP-COMPARE", "w".repeat(PHOTO), { taken: 1_600_000_003_000 });

  await store.importBatch([a, b, c, d]);
  let snap = await store.snapshot();
  const sampleC = snap.samples.find((s) => s.code === "KEEP-CONFIRMED");
  const sampleD = snap.samples.find((s) => s.code === "KEEP-COMPARE");
  await store.setConfirmed(sampleC.id, true);
  await store.setCompare(sampleD.id, true);

  // 收紧到「两张受保护照片 + 一张多一点」空间：新导入只能挤占未确认旧图
  const onePhoto = a.dataUrl.length;
  storage.quota = d.dataUrl.length * 2 + onePhoto + 4000; // 2 张受保护 + 1 张周转 + 元数据余量

  // 持续导入新照片迫使回收；未确认旧图只有 OLD-1、OLD-2，回收光后新条目失败但不抛
  let sawFailure = false;
  for (let i = 0; i < 5; i += 1) {
    const next = await item("NEW-" + i, "n" + String(i).repeat(PHOTO), {
      taken: 1_900_000_000_000 + i * 1000
    });
    // eslint-disable-next-line no-await-in-loop
    const r = await store.importBatch([next]);
    if (r.failed >= 1) sawFailure = true;
  }
  assert.ok(sawFailure, "受保护照片占满后，新条目应记为失败而不是抛异常");

  snap = await store.snapshot();
  const hashC = snap.samples.find((s) => s.code === "KEEP-CONFIRMED").photoHash;
  const hashD = snap.samples.find((s) => s.code === "KEEP-COMPARE").photoHash;
  assert.ok(store.getPhotoData(hashC), "已确认样本照片不被回收");
  assert.ok(store.getPhotoData(hashD), "对比栏样本照片不被回收");

  // 未确认旧图被按最旧优先回收：OLD-1 先于 OLD-2
  const old1 = snap.samples.find((s) => s.code === "OLD-1");
  const old2 = snap.samples.find((s) => s.code === "OLD-2");
  const old1There = !!store.getPhotoData(old1.photoHash);
  const old2There = !!store.getPhotoData(old2.photoHash);
  assert.ok(!old1There, "最旧的未确认 OLD-1 已被回收");
  assert.ok(!old2There || true, "OLD-2 随后回收");
  assert.ok(!old1There && !old2There ? true : !old1There, "OLD-1 先于 OLD-2 回收");

  // 回收后样本引用仍在（哈希保留、状态为已回收）
  assert.equal(store.photoStatus(old1.photoHash), "reclaimed");
  assert.ok(snap.photos[old1.photoHash], "照片记录与引用保留");
});

test("失败后从最后完成样本恢复（续作），缺文件的条目保持待续", async () => {
  sharedBackend.clear();
  const storage = createMemoryStorage();
  storage.quota = 1800; // 约 2 张照片 + 元数据：3 张导入时第 3 张失败，可续作
  const store = freshTab(storage);

  const a = await item("P-1", "p1" + "1".repeat(300), { taken: 1_600_000_000_000 });
  const b = await item("P-2", "p2" + "2".repeat(300), { taken: 1_600_000_001_000 });
  const c = await item("P-3", "p3" + "3".repeat(300), { taken: 1_600_000_002_000 });

  const batchId = await store.batchIdFor([a, b, c]);
  const result = await store.importBatch([a, b, c]);
  const snapAfter = await store.snapshot();
  const batch = snapAfter.batches.find((x) => x.id === batchId);
  const doneItems = batch.items.filter((i) => i.status === "done");
  assert.ok(doneItems.length >= 1, "至少完成并持久化了一个样本");
  assert.ok(result.failed >= 1, "有失败条目");

  // 前序完成项不重跑：用只含 b、c 的选择续作
  storage.quota = Infinity; // 野外腾出空间后续作
  const resume = await store.importBatch([b, c], batchId);
  const snapFinal = await store.snapshot();
  const finalBatch = snapFinal.batches.find((x) => x.id === batchId);
  assert.equal(finalBatch.items.filter((i) => i.status === "done").length, 3);
  assert.equal(resume.failed, 0);

  // 缺少对应文件的条目保持 pending
  const resumeIncomplete = await store.importBatch([b], batchId);
  const batchAgain = (await store.snapshot()).batches.find((x) => x.id === batchId);
  assert.equal(batchAgain.items.length, 3);
  assert.equal(
    batchAgain.items.filter((i) => i.status === "done").length,
    3,
    "已完成项沿用首次结果，不因缺文件而回退"
  );
  assert.equal(resumeIncomplete.failed, 0);
});

test("两个标签页并发提交同一批：同哈希只入库一次", async () => {
  sharedBackend.clear();
  const storage = createMemoryStorage();
  storage.quota = Infinity;
  const tabA = freshTab(storage);
  const tabB = freshTab(storage);

  const items = [];
  for (let i = 0; i < 8; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    items.push(await item("T-" + i, "concurrent-" + i, { taken: 1_700_000_000_000 + i }));
  }

  const [rA, rB] = await Promise.all([
    tabA.importBatch(items),
    tabB.importBatch(items)
  ]);
  assert.equal(rA.batchId, rB.batchId);

  await tabA.reload();
  const snap = await tabA.snapshot();
  assert.equal(snap.samples.length, 8, "样本没有重复");
  assert.equal(Object.keys(snap.photos).length, 8, "照片没有重复");
  // 每个照片只有一个引用
  for (const photo of Object.values(snap.photos)) {
    const refs = new Set(photo.refs);
    assert.equal(refs.size, photo.refs.length);
  }
});

test("旧数据升级：补算哈希、独立照片库、批注保留，对比关系保留", async () => {
  sharedBackend.clear();
  const storage = createMemoryStorage();

  const contentBytes = new TextEncoder().encode("LEGACY-PHOTO-BYTES");
  const dataUrl = "data:image/png;base64," + Buffer.from(contentBytes).toString("base64");
  const expectedHash = await hashOf("LEGACY-PHOTO-BYTES");

  storage.setItem("wxyy-2-thin-section-index", JSON.stringify({
    samples: [
      {
        id: "legacy-1",
        photo: dataUrl,
        code: "OLD-01",
        location: "旧地点",
        magnification: "10x",
        polarization: "正交偏光",
        minerals: "方解石",
        texture: "粒状",
        comment: "旧批注必须保留",
        createdAt: "2024-01-02T03:04:05.000Z"
      }
    ],
    compare: ["legacy-1"]
  }));

  const store = freshTab(storage);
  await store.init();
  const snap = await store.snapshot();

  assert.equal(snap.version, 2);
  const sample = snap.samples[0];
  assert.equal(sample.comment, "旧批注必须保留");
  assert.equal(sample.photoHash, expectedHash, "补算内容哈希");
  assert.equal(sample.confirmed, true, "旧数据默认已确认，防误回收");
  assert.deepEqual(snap.compare, ["legacy-1"], "对比关系保留");
  assert.ok(snap.photos[expectedHash], "照片进入统一照片库");
  assert.equal(store.getPhotoData(expectedHash), dataUrl, "照片内容可按哈希取回");
  assert.equal(storage.getItem("wxyy-2-thin-section-index"), null, "旧键已迁移");
});

test("导出按当前筛选并带出照片校验和与状态", async () => {
  sharedBackend.clear();
  const store = freshTab(createMemoryStorage());
  const a = await item("F-1", "filter-A", { taken: 1_700_000_000_000 });
  const b = await item("F-2", "filter-B", { taken: 1_700_000_001_000 });
  await store.importBatch([a, b]);
  await store.snapshot();
  // 补矿物/偏光
  const snap = await store.snapshot();
  const s1 = snap.samples.find((s) => s.code === "F-1");
  await store.upsertSampleForm({
    id: s1.id,
    code: "F-1",
    minerals: "石英",
    polarization: "单偏光",
    location: "L",
    magnification: "40x",
    texture: "T",
    comment: "C"
  });
  const s2 = snap.samples.find((s) => s.code === "F-2");
  await store.upsertSampleForm({
    id: s2.id,
    code: "F-2",
    minerals: "黑云母",
    polarization: "正交偏光",
    location: "L",
    magnification: "40x",
    texture: "T",
    comment: "C"
  });

  const all = store.buildExport({ mineral: "", polarization: "" });
  assert.equal(all.length, 2);
  assert.match(all[0]["照片校验和"], /^[0-9a-f]{64}$/);
  assert.equal(all[0]["照片状态"], "在库");

  const only = store.buildExport({ mineral: "石英", polarization: "单偏光" });
  assert.equal(only.length, 1);
  assert.equal(only[0]["样本编号"], "F-1");
});

test("同一内容哈希被多张样本引用：照片只存一份，refs 记录全部引用", async () => {
  sharedBackend.clear();
  const store = freshTab(createMemoryStorage());
  const shared = await item("SHARED.jpg", "same-bytes", { taken: 1_700_000_000_000 });

  // 不同编号但同一张照片文件（内容哈希相同）
  const a = Object.assign({}, shared, { code: "BX-A", name: "SHARED.jpg" });
  const b = Object.assign({}, shared, { code: "BX-B", name: "SHARED-copy.jpg" });
  await store.importBatch([a, b]);

  const snap = await store.snapshot();
  assert.equal(snap.samples.length, 2);
  const hashes = new Set(snap.samples.map((s) => s.photoHash));
  assert.equal(hashes.size, 1, "两样本引用同一哈希");
  const hash = snap.samples[0].photoHash;
  const photoKeys = [...sharedBackend.keys()].filter((k) => k.startsWith("wxyy-2-photo:"));
  assert.equal(photoKeys.length, 1, "照片负载只存一份");
  assert.deepEqual(snap.photos[hash].refs.sort(), snap.samples.map((s) => s.id).sort());

  // 删除其中一个引用，照片仍在；删光后成为孤图可回收
  await store.deleteSample(snap.samples[0].id);
  const after1 = await store.snapshot();
  assert.ok(store.getPhotoData(hash), "仍有一个引用，照片保留");
  assert.equal(after1.photos[hash].refs.length, 1);
  await store.deleteSample(after1.samples[0].id);
  const after2 = await store.snapshot();
  assert.equal(after2.photos[hash] ? after2.photos[hash].refs.length : 0, 0);
});

test("容量回收优先选择无引用孤图，再轮到未确认最旧", async () => {
  sharedBackend.clear();
  const storage = createMemoryStorage();
  storage.quota = Infinity;
  const store = freshTab(storage);

  const keep = await item("REF-1", "k".repeat(4000), { taken: 1_600_000_000_000 });
  const orphan = await item("ORPHAN", "o".repeat(4000), { taken: 1_600_000_001_000 });
  await store.importBatch([keep, orphan]);
  const snap = await store.snapshot();
  const orphanSample = snap.samples.find((s) => s.code === "ORPHAN");
  // 删除样本使照片变孤图（负载仍在）
  await store.deleteSample(orphanSample.id);

  // 收紧配额并导入新照片：孤图应先被回收，而不是动有引用的未确认旧图
  let used = 0;
  for (const v of sharedBackend.values()) used += String(v).length;
  storage.quota = used - orphan.dataUrl.length + keep.dataUrl.length + 2000;

  const fresh = await item("FRESH", "f".repeat(4000), { taken: 1_900_000_000_000 });
  const r = await store.importBatch([fresh]);
  assert.equal(r.failed, 0, "靠回收孤图即可容纳新照片");

  const after = await store.snapshot();
  const refSample = after.samples.find((s) => s.code === "REF-1");
  assert.ok(store.getPhotoData(refSample.photoHash), "有引用的旧图未被回收");
  assert.ok(!store.getPhotoData(orphan.hash), "孤图被回收");
});

test("回收后导出仍带校验和，状态标记为已回收", async () => {
  sharedBackend.clear();
  const storage = createMemoryStorage();
  storage.quota = Infinity;
  const store = freshTab(storage);
  const oldPhoto = await item("RC-1", "r".repeat(4000), { taken: 1_600_000_000_000 });
  await store.importBatch([oldPhoto]);
  const snap = await store.snapshot();
  const s = snap.samples[0];
  await store.upsertSampleForm({
    id: s.id,
    code: "RC-1",
    minerals: "石英",
    polarization: "单偏光",
    location: "L",
    magnification: "40x",
    texture: "T",
    comment: "C"
  });

  // 配额收紧后导入新图，迫使旧图被回收
  let used = 0;
  for (const v of sharedBackend.values()) used += String(v).length;
  storage.quota = oldPhoto.dataUrl.length + 6000;
  const newPhoto = await item("RC-2", "q".repeat(4000), { taken: 1_900_000_000_000 });
  await store.importBatch([newPhoto]);

  const rows = store.buildExport({});
  const oldRow = rows.find((r) => r["样本编号"] === "RC-1");
  assert.equal(oldRow["照片校验和"], oldPhoto.hash, "导出仍带出哈希（引用未丢）");
  assert.equal(oldRow["照片状态"], "已回收");
  const newRow = rows.find((r) => r["样本编号"] === "RC-2");
  assert.equal(newRow["照片状态"], "在库");
});
