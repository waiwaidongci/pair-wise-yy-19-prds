import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORAGE_KEY = "wxyy-2-thin-section-index";

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${message}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${message}`);
  }
}

function makeElement() {
  return {
    value: "",
    files: [],
    innerHTML: "",
    textContent: "",
    hidden: false,
    dataset: {},
    style: {},
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    removeEventListener() {},
    click() {},
    reset() {
      this.value = "";
      this.files = [];
    }
  };
}

function makeContext(seed) {
  const store = seed || {};
  const elements = {};
  const document = {
    querySelector(selector) {
      return (elements[selector] ||= makeElement());
    },
    createElement() {
      return makeElement();
    },
    addEventListener() {},
    body: makeElement()
  };
  const localStorage = {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => {
      store[key] = String(value);
    },
    removeItem: (key) => {
      delete store[key];
    },
    _store: store
  };
  class FileReader {
    addEventListener(type, fn) {
      this["on" + type] = fn;
    }
    readAsDataURL(file) {
      this.result = file.dataUrl || `data:image/jpeg;base64,${file.name}`;
      queueMicrotask(() => this.onload && this.onload({ target: this }));
    }
  }
  const context = {
    localStorage,
    document,
    FileReader,
    crypto: crypto.webcrypto,
    BroadcastChannel: class {
      postMessage() {}
      close() {}
    },
    navigator: { storage: { estimate: async () => ({ quota: 5_000_000, usage: 0 }) } },
    FormData: class {
      get() {
        return "";
      }
    },
    Blob: class {
      constructor(parts) {
        this.parts = parts;
      }
    },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Date,
    console,
    Buffer,
    fetch: async (url) => {
      const buf = Buffer.from(url.split(",")[1] || "", "base64");
      return {
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      };
    }
  };
  if (!context.crypto.randomUUID) {
    let counter = 0;
    context.crypto.randomUUID = () =>
      `00000000-0000-4000-8000-${String((counter += 1)).padStart(12, "0")}`;
  }
  context.window = context;
  context.addEventListener = () => {};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "app.js"), "utf8"), context);
  return { app: context.__app, store, elements, localStorage };
}

function makeFile(name, bytes, type = "image/jpeg") {
  const buffer = Buffer.from(bytes);
  return {
    name,
    type,
    dataUrl: `data:${type};base64,${buffer.toString("base64")}`,
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 60));

// ---------- 1. 旧数据升级：补算哈希、保留批注 ----------
{
  console.log("1. 旧数据升级");
  const { app, store } = makeContext({
    [STORAGE_KEY]: JSON.stringify({
      samples: [
        {
          id: "legacy-1",
          photo: "data:image/jpeg;base64,AAAA",
          code: "BX-01",
          location: "剖面东侧",
          polarization: "单偏光",
          comment: "保留的批注：疑似钾长石"
        }
      ],
      compare: ["legacy-1"]
    })
  });
  await tick();
  const state = app.getState();
  assert(state.version === 2, "升级到版本 2");
  assert(state.samples.length === 1, "旧样本保留");
  assert(state.samples[0].comment === "保留的批注：疑似钾长石", "批注保留");
  assert(state.samples[0].photoHash, "旧照片补算哈希");
  assert(state.photos[state.samples[0].photoHash], "照片入库到照片库");
  assert(state.photos[state.samples[0].photoHash].refs.includes("legacy-1"), "引用关系记录");
  assert(state.compare.includes("legacy-1"), "对比状态保留");
}

// ---------- 2. 哈希稳定性 + 去重 ----------
{
  console.log("2. 内容哈希去重");
  const { app } = makeContext();
  const a = await app.hashFile(makeFile("a.jpg", [1, 2, 3]));
  const b = await app.hashFile(makeFile("a.jpg", [1, 2, 3]));
  const c = await app.hashFile(makeFile("b.jpg", [1, 2, 4]));
  assert(a.hash === b.hash, "同内容哈希一致");
  assert(a.hash !== c.hash, "不同内容哈希不同");
  assert(a.hash.length === 64, "SHA-256 长度 64");

  await app.importFiles([makeFile("BX-01.jpg", [1, 2, 3])]);
  await app.importFiles([makeFile("BX-01.jpg", [1, 2, 3])]);
  const state = app.getState();
  assert(state.samples.length === 1, "重复导入不新增样本（沿用首次结果）");
  assert(Object.keys(state.photos).length === 1, "同一哈希只入库一次");
}

// ---------- 3. 批次续作：从最后完成样本恢复 ----------
{
  console.log("3. 失败后续作");
  const { app } = makeContext();
  const files = [makeFile("a.jpg", [1]), makeFile("b.jpg", [2]), makeFile("c.jpg", [3])];
  await app.importFiles(files);
  let state = app.getState();
  assert(state.samples.length === 3, "批次导入 3 张");
  const batch = Object.values(state.batches)[0];
  assert(batch.status === "done", "批次标记完成");

  // 模拟崩溃：最后一张未持久化，批次回退为 error
  const last = state.samples.find((sample) => sample.code === "c");
  state.samples = state.samples.filter((sample) => sample.id !== last.id);
  state.photos[last.photoHash].refs = state.photos[last.photoHash].refs.filter((id) => id !== last.id);
  batch.completed = batch.completed.filter((id) => id !== last.id);
  batch.status = "error";
  app.saveQuiet();

  await app.importFiles(files);
  state = app.getState();
  assert(state.samples.length === 3, "恢复后样本数回到 3");
  assert(state.batches[batch.id].status === "done", "原批次续作完成");
  assert(batch.completed.length === 3, "完成列表包含全部样本");
}

// ---------- 4. 容量不足：排队回收无对比引用的旧图 ----------
{
  console.log("4. 容量回收");
  const { app, localStorage } = makeContext();
  await app.importFiles([
    makeFile("a.jpg", [1]),
    makeFile("b.jpg", [2]),
    makeFile("c.jpg", [3])
  ]);
  let state = app.getState();
  const [a, b, c] = ["a", "b", "c"].map((code) => state.samples.find((s) => s.code === code));
  state.compare = [a.id]; // a 在对比中，受保护
  app.saveQuiet();

  // 第一次写入抛配额错误
  const original = localStorage.setItem.bind(localStorage);
  let failNext = true;
  localStorage.setItem = (key, value) => {
    if (failNext) {
      failNext = false;
      const err = new Error("quota");
      err.name = "QuotaExceededError";
      throw err;
    }
    original(key, value);
  };
  app.save();
  state = app.getState();
  const photoB = state.photos[b.photoHash];
  const photoC = state.photos[c.photoHash];
  assert(photoB.dataUrl === null && photoB.evicted === true, "最旧的无引用图 b 被回收");
  assert(photoC.dataUrl !== null, "较新的 c 保留");
  assert(state.photos[a.photoHash].dataUrl !== null, "对比中的 a 受保护");
  assert(photoB.refs.includes(b.id), "回收后引用关系仍记录");
  assert(photoB.hash.length === 64, "回收后校验和仍在");

  // 手动全部回收
  const freed = app.evictAll();
  assert(freed === 1, "手动回收剩余 1 张（c）");
  assert(state.photos[a.photoHash].dataUrl !== null, "对比中的 a 仍受保护");
}

// ---------- 5. 跨标签页：同哈希只入库一次，冲突保留较新照片和旧记录 ----------
{
  console.log("5. 跨标签页合并");
  const ctxA = makeContext();
  await ctxA.app.importFiles([makeFile("BX-01.jpg", [1]), makeFile("BX-02.jpg", [2])]);
  const raw = ctxA.store[STORAGE_KEY];

  const ctxB = makeContext();
  ctxB.app.mergeRemote(JSON.parse(raw));
  let state = ctxB.app.getState();
  assert(state.samples.length === 2, "样本合并");
  assert(Object.keys(state.photos).length === 2, "照片库合并");
  assert(state.samples.every((s) => s.photoHash), "合并后照片引用完整");

  // 冲突：同编号不同 id（两个标签页各提交一次）
  const newer = {
    id: "s-new",
    photoHash: "newhash",
    code: "BX-01",
    location: "新地点",
    createdAt: new Date(Date.now() + 100000).toISOString()
  };
  state.samples.push(newer);
  state.photos.newhash = {
    hash: "newhash",
    dataUrl: "data:image/jpeg;base64,NEW",
    bytes: 3,
    createdAt: Date.now(),
    refs: ["s-new"]
  };
  ctxB.app.reconcileByCode();
  state = ctxB.app.getState();
  const conflicts = state.samples.filter((s) => s.code === "BX-01");
  assert(conflicts.length === 1, "冲突样本合并为一条");
  assert(conflicts[0].photoHash === "newhash", "保留较新照片");
  assert(conflicts[0].id !== "s-new", "保留旧记录（id 未变）");
  assert(state.photos.newhash.refs.includes(conflicts[0].id), "新照片引用指向保留样本");
}

// ---------- 6. 导出：按当前筛选带出照片校验和 ----------
{
  console.log("6. 导出校验和");
  const { app, elements } = makeContext();
  await app.importFiles([makeFile("a.jpg", [9]), makeFile("b.jpg", [8])]);
  const state = app.getState();
  state.samples[0].minerals = "石英";
  state.samples[1].minerals = "长石";
  app.saveQuiet();
  elements["#mineralFilter"].value = "石英";
  const rows = app.filteredSamples().map((sample) => ({
    样本编号: sample.code,
    照片校验和: sample.photoHash
  }));
  assert(rows.length === 1, "导出跟随当前筛选");
  assert(rows[0].照片校验和 && rows[0].照片校验和.length === 64, "导出带照片校验和");
}

// ---------- 7. 回收后渲染占位 ----------
{
  console.log("7. 回收后界面");
  const { app, elements } = makeContext();
  await app.importFiles([makeFile("a.jpg", [1])]);
  const state = app.getState();
  const photo = Object.values(state.photos)[0];
  photo.dataUrl = null;
  photo.evicted = true;
  app.render();
  const html = elements["#sampleGrid"].innerHTML;
  assert(html.includes("原图已回收"), "回收样本显示占位与校验和");
  assert(html.includes("照片校验和"), "卡片显示校验和");
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
