/*
 * 岩芯薄片显微照片索引台
 *
 * 照片库 / 样本索引 / 筛选对比共用同一份数据：
 *  - 照片按内容哈希(SHA-256)去重，样本只持有哈希；
 *  - 导入形成可续作批次，重复导入沿用首次结果；
 *  - 容量不足时按「未确认 + 最旧」顺序回收无对比引用的旧图（内容清空、哈希保留）；
 *  - 同编号冲突保留旧记录文字、更新为较新照片；
 *  - 旧版本数据升级时补算哈希、保留批注。
 *
 * createThinSectionStore() 是纯逻辑内核，浏览器 UI 与 Node 测试共用。
 */
(function (global) {
  "use strict";

  const META_KEY = "wxyy-2-thin-section-index-v2";
  const LEGACY_KEY = "wxyy-2-thin-section-index";
  const PHOTO_PREFIX = "wxyy-2-photo:";
  const SCHEMA_VERSION = 2;

  function emptyMeta() {
    return {
      version: SCHEMA_VERSION,
      photos: {}, // hash -> { hash, bytes, createdAt, present, refs: [sampleId] }
      samples: [],
      compare: [],
      batches: []
    };
  }

  // ---------- 基础工具 ----------

  function uuid() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function toHex(buffer) {
    const bytes = new Uint8Array(buffer);
    let out = "";
    for (let i = 0; i < bytes.length; i += 1) {
      out += bytes[i].toString(16).padStart(2, "0");
    }
    return out;
  }

  async function sha256Hex(buf) {
    if (!global.crypto || !global.crypto.subtle) {
      throw new Error("当前环境不支持 SubtleCrypto，无法计算内容哈希");
    }
    // 归一化：部分宿主（跨 realm/Node 校验）只接受本 realm 的 ArrayBuffer
    let source = buf;
    if (ArrayBuffer.isView(buf)) {
      const copy = new Uint8Array(buf.byteLength);
      copy.set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      source = copy.buffer;
    } else if (!(source instanceof ArrayBuffer)) {
      const view = new Uint8Array(buf);
      const copy = new Uint8Array(view.byteLength);
      copy.set(view);
      source = copy.buffer;
    }
    return toHex(await global.crypto.subtle.digest("SHA-256", source));
  }

  async function hashDataUrl(dataUrl) {
    const base64 = String(dataUrl).split(",", 2)[1] || "";
    const binary = global.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return sha256Hex(bytes.buffer);
  }

  function isQuotaError(err) {
    if (!err) return false;
    return (
      err.name === "QuotaExceededError" ||
      err.code === 22 ||
      err.code === 1014 ||
      /quota/i.test(String(err.message || ""))
    );
  }

  // ---------- 内核 ----------

  function createThinSectionStore(storage, opts) {
    const options = Object.assign({ locks: true }, opts || {});
    let meta = null;
    let localQueue = Promise.resolve();

    // 同一进程内的互斥回退；优先用 Web Locks 跨标签页串行化。
    function lockApi() {
      if (options.navigator && options.navigator.locks) return options.navigator.locks;
      if (global.navigator && global.navigator.locks) return global.navigator.locks;
      return null;
    }

    function withLock(task) {
      const locks = options.locks ? lockApi() : null;
      if (locks && typeof locks.request === "function") {
        return locks.request("wxyy-2-commit", () => task());
      }
      const run = localQueue.then(task, task);
      localQueue = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    }

    function rawGet(key) {
      return storage.getItem(key);
    }

    function rawSet(key, value) {
      storage.setItem(key, value);
    }

    function rawRemove(key) {
      storage.removeItem(key);
    }

    // 旧版本：{ samples:[{photo: dataURL, ...}], compare:[] }
    async function migrateLegacy() {
      const legacy = rawGet(LEGACY_KEY);
      if (legacy == null) return false;

      let oldData;
      try {
        oldData = JSON.parse(legacy);
      } catch (_err) {
        rawRemove(LEGACY_KEY);
        return false;
      }

      const next = emptyMeta();
      const oldSamples = Array.isArray(oldData.samples) ? oldData.samples : [];
      const oldCompare = Array.isArray(oldData.compare) ? oldData.compare : [];

      // 第一步：先换索引键，旧照片仍在原 JSON 里，任何中断都不丢批注。
      rawSet(META_KEY, JSON.stringify(next));
      rawRemove(LEGACY_KEY);

      const pending = [];
      next.samples = oldSamples.map((old) => {
        const id = old.id || uuid();
        const sample = {
          id,
          code: old.code || "",
          location: old.location || "",
          magnification: old.magnification || "",
          polarization: old.polarization || "",
          minerals: old.minerals || "",
          texture: old.texture || "",
          comment: old.comment || "", // 批注原样保留
          photoHash: "",
          confirmed: true, // 旧数据视为已确认，避免被容量回收误删
          createdAt: old.createdAt || new Date().toISOString(),
          updatedAt: old.createdAt || new Date().toISOString()
        };
        if (old.photo) {
          pending.push({ id, dataUrl: old.photo, createdAt: sample.createdAt });
        }
        return sample;
      });

      // 第二步：逐张补算哈希并写入独立照片库；失败（如容量不足）不阻塞升级，
      // 照片缺席时样本仍可显示与编辑，下次可重新挂接。
      for (const job of pending) {
        try {
          const hash = await hashDataUrl(job.dataUrl);
          if (!next.photos[hash]) {
            next.photos[hash] = {
              hash,
              bytes: job.dataUrl.length,
              createdAt: job.createdAt,
              present: false,
              refs: []
            };
            try {
              rawSet(PHOTO_PREFIX + hash, job.dataUrl);
              next.photos[hash].present = true;
            } catch (err) {
              if (!isQuotaError(err)) throw err;
            }
          } else if (rawGet(PHOTO_PREFIX + hash) != null) {
            next.photos[hash].present = true;
          }
          const sample = next.samples.find((item) => item.id === job.id);
          if (sample && next.photos[hash].present) sample.photoHash = hash;
        } catch (migErr) {
          if (global.console && console.warn) console.warn("照片补算哈希失败：", migErr);
          /* 跳过补算失败的单张，批注与记录仍保留 */
        }
      }

      next.compare = oldCompare.filter((id) => next.samples.some((s) => s.id === id));
      recomputeRefs(next);
      rawSet(META_KEY, JSON.stringify(next));
      return true;
    }

    async function init() {
      if (meta) return;
      if (rawGet(META_KEY) == null) {
        await migrateLegacy();
      }
      try {
        meta = JSON.parse(rawGet(META_KEY));
      } catch (_err) {
        meta = emptyMeta();
      }
      meta = normalizeMeta(meta);
      reconcile();
    }

    function normalizeMeta(value) {
      const base = emptyMeta();
      if (!value || typeof value !== "object") return base;
      meta = base;
      base.photos = value.photos && typeof value.photos === "object" ? value.photos : {};
      base.samples = Array.isArray(value.samples) ? value.samples : [];
      base.compare = Array.isArray(value.compare) ? value.compare : [];
      base.batches = Array.isArray(value.batches) ? value.batches : [];
      for (const sample of base.samples) {
        if (!sample.id) sample.id = uuid();
        if (typeof sample.confirmed !== "boolean") sample.confirmed = false;
        if (!sample.createdAt) sample.createdAt = new Date().toISOString();
        if (!sample.updatedAt) sample.updatedAt = sample.createdAt;
        if (typeof sample.photoHash !== "string") sample.photoHash = sample.photoHash || "";
      }
      return base;
    }

    function eachStorageKey() {
      const keys = [];
      const len = storage.length || 0;
      for (let i = 0; i < len; i += 1) {
        const key = storage.key(i);
        if (key) keys.push(key);
      }
      return keys;
    }

    // 让照片索引的 present 与真实存储一致，并清理写索引前的崩溃残留。
    function reconcile(target) {
      const m = target || meta;
      for (const hash of Object.keys(m.photos)) {
        m.photos[hash].refs = m.photos[hash].refs || [];
        m.photos[hash].present = rawGet(PHOTO_PREFIX + hash) != null;
      }
      for (const key of eachStorageKey()) {
        if (!key.startsWith(PHOTO_PREFIX)) continue;
        const hash = key.slice(PHOTO_PREFIX.length);
        if (!m.photos[hash]) rawRemove(key);
      }
    }

    function recomputeRefs(target) {
      const m = target || meta;
      for (const photo of Object.values(m.photos)) photo.refs = [];
      for (const sample of m.samples) {
        if (sample.photoHash && m.photos[sample.photoHash]) {
          m.photos[sample.photoHash].refs.push(sample.id);
        }
      }
    }

    function oldestSampleTimeFor(hash, m) {
      let oldest = "";
      for (const sample of m.samples) {
        if (sample.photoHash !== hash) continue;
        if (!oldest || sample.createdAt < oldest) oldest = sample.createdAt;
      }
      return oldest;
    }

    // 回收候选：
    //  1) 无引用孤图优先；
    //  2) 只被「未确认样本」引用、且不在对比栏的照片，按最旧优先。
    function selectVictim(m, forceHashes) {
      const force = new Set(forceHashes || []);
      const orphan = Object.values(m.photos)
        .filter((p) => p.present && (force.has(p.hash) || p.refs.length === 0))
        .map((p) => p.hash);
      if (orphan.length) return orphan.sort()[0];

      const compareSet = new Set(m.compare);
      const candidates = Object.values(m.photos)
        .filter((p) => p.present && !force.has(p.hash))
        .filter((p) => p.refs.length > 0)
        .filter((p) =>
          p.refs.every(
            (sid) =>
              !compareSet.has(sid) &&
              m.samples.some((s) => s.id === sid && !s.confirmed)
          )
        );
      candidates.sort((a, b) => {
        const ta = oldestSampleTimeFor(a.hash, m) || a.createdAt || "";
        const tb = oldestSampleTimeFor(b.hash, m) || b.createdAt || "";
        if (ta !== tb) return ta < tb ? -1 : 1;
        return a.hash < b.hash ? -1 : 1;
      });
      return candidates[0] ? candidates[0].hash : null;
    }

    function evictPhoto(hash, m) {
      rawRemove(PHOTO_PREFIX + hash);
      if (m.photos[hash]) m.photos[hash].present = false;
    }

    // 删除既无负载又无引用的照片索引条目（写入失败后回滚的残留），为索引瘦身。
    function pruneDeadPhotoEntries(m) {
      recomputeRefs(m);
      for (const hash of Object.keys(m.photos)) {
        const photo = m.photos[hash];
        if (!photo.present && photo.refs.length === 0) {
          delete m.photos[hash];
        }
      }
    }

    // 写照片负载；容量不足时先为「照片 + 索引」整体预留空间，再边回收边重试。
    // 返回无法写入的哈希（只剩受保护照片、无候选可回收时），不抛出，交由上层标记失败。
    function flushPuts(m, puts, forceHashes) {
      const pending = puts.filter((put) => {
        if (!m.photos[put.hash] || !m.photos[put.hash].present) return true;
        return rawGet(PHOTO_PREFIX + put.hash) == null;
      });
      const failedHashes = [];
      let guard = 0;
      while (pending.length) {
        const put = pending[0];
        try {
          // 先在影子状态上计算最终元数据大小，确保照片与索引一起放得下；
          // 放不下就回收未保护的旧图，绝不动当前新照片。
          const futureMeta = JSON.stringify(metaWithPhoto(m, put));
          ensureSpace(m, put.hash, put.dataUrl.length, futureMeta.length, forceHashes);
          rawSet(PHOTO_PREFIX + put.hash, put.dataUrl);
          m.photos[put.hash].present = true;
          pending.shift();
        } catch (err) {
          if (!isQuotaError(err)) throw err;
          const victim = selectVictim(m, forceHashes);
          if (!victim) {
            failedHashes.push(put.hash);
            pending.shift();
            if (m.photos[put.hash]) m.photos[put.hash].present = false;
            continue;
          }
          evictPhoto(victim, m);
        }
        guard += 1;
        if (guard > 1000) throw new Error("回收次数异常，已中止写入");
      }
      return failedHashes;
    }

    function metaWithPhoto(m, put) {
      const photos = Object.assign({}, m.photos);
      photos[put.hash] = photos[put.hash] || {
        hash: put.hash,
        bytes: put.dataUrl.length,
        createdAt: "",
        present: true,
        refs: []
      };
      return Object.assign({}, m, { photos });
    }

    function storageQuota() {
      // 浏览器无标准同步配额接口；由选项注入 estimate()（测试/宿主可用），
      // 取不到时返回 Infinity，此时靠写入抛 QuotaExceededError 兜底回收。
      if (typeof options.estimate === "function") {
        const info = options.estimate();
        if (info && isFinite(info.quota)) return info.quota;
      }
      return Infinity;
    }

    // 回收旧图直到「写完照片、覆盖完索引」后整体不超配额。
    // projected = 其它 key 占用 + 目标照片大小 + 目标索引大小。
    function ensureSpace(m, photoHash, photoLength, futureMetaLength, forceHashes) {
      const quota = storageQuota();
      if (!isFinite(quota)) return;
      const otherKeysSize = () => {
        let total = 0;
        for (const key of eachStorageKey()) {
          if (key === META_KEY || key === PHOTO_PREFIX + photoHash) continue;
          const value = rawGet(key);
          if (value != null) total += String(value).length;
        }
        return total;
      };
      let guard = 0;
      while (otherKeysSize() + photoLength + futureMetaLength > quota) {
        const victim = selectVictim(m, forceHashes);
        if (!victim || victim === photoHash) return; // 回收不动，交给写入判错
        evictPhoto(victim, m);
        guard += 1;
        if (guard > 1000) throw new Error("回收次数异常，已中止写入");
      }
    }

    function createContext(draft) {
      const ctx = {
        meta: draft,
        puts: [],
        putPhoto(hash, dataUrl, createdAt) {
          draft.photos[hash] = draft.photos[hash] || {
            hash,
            bytes: dataUrl.length,
            createdAt: createdAt || new Date().toISOString(),
            present: false,
            refs: []
          };
          draft.photos[hash].bytes = dataUrl.length;
          if (createdAt && !draft.photos[hash].createdAt) {
            draft.photos[hash].createdAt = createdAt;
          }
          // 同一事务内同哈希只排队一次（多样本共享一张照片）
          if (!this.puts.some((put) => put.hash === hash)) {
            this.puts.push({ hash, dataUrl });
          }
        },
        // 中途落盘：照片 + 索引一起持久化，成为可恢复点。
        // 返回本次因容量不足未能写入的哈希列表。
        checkpoint(forceHashes) {
          recomputeRefs(draft);
          pruneDeadPhotoEntries(draft);
          const pendingPuts = this.puts;
          this.puts = [];
          const failedHashes = flushPuts(draft, pendingPuts, forceHashes);
          writeMetaWithReclaim(draft, forceHashes);
          return failedHashes;
        },
        // 尽力落盘：容量彻底不足时保留旧版元数据（不覆盖），不抛异常。
        bestEffortCheckpoint() {
          try {
            this.checkpoint();
          } catch (err) {
            if (!isQuotaError(err)) throw err;
          }
        },
        // 回滚失败照片：丢弃其待写负载与索引条目（若已无引用）。
        forgetPhoto(hash) {
          this.puts = this.puts.filter((put) => put.hash !== hash);
          const photo = draft.photos[hash];
          recomputeRefs(draft);
          if (photo && photo.refs.length === 0) {
            delete draft.photos[hash];
          } else if (photo) {
            photo.present = rawGet(PHOTO_PREFIX + hash) != null;
          }
        }
      };
      return ctx;
    }

    // 写索引；若索引 JSON 把配额撑爆，回收未保护旧图后重试。
    // 注意此时本批照片已写入，候选回收不应破坏当次结果。
    function writeMetaWithReclaim(m, forceHashes) {
      let guard = 0;
      for (;;) {
        const payload = JSON.stringify(m);
        let otherKeysSize = 0;
        for (const key of eachStorageKey()) {
          if (key === META_KEY) continue;
          const value = rawGet(key);
          if (value != null) otherKeysSize += String(value).length;
        }
        const quota = storageQuota();
        if (isFinite(quota) && otherKeysSize + payload.length > quota) {
          const victim = selectVictim(m, forceHashes);
          if (!victim) {
            // 真的放不下：抛出，由 bestEffortCheckpoint 决定保留旧索引
            const err = new Error("QuotaExceededError");
            err.name = "QuotaExceededError";
            throw err;
          }
          evictPhoto(victim, m);
          guard += 1;
          if (guard > 1000) throw new Error("回收次数异常，已中止写入");
          continue;
        }
        try {
          rawSet(META_KEY, payload);
          return;
        } catch (err) {
          if (!isQuotaError(err)) throw err;
          const victim = selectVictim(m, forceHashes);
          if (!victim) throw err;
          evictPhoto(victim, m);
          guard += 1;
          if (guard > 1000) throw new Error("回收次数异常，已中止写入");
        }
      }
    }

    // 事务在锁内执行；mutator 可多次 checkpoint，未 checkpoint 的改动在最后统一落盘。
    // 进入锁后必须从存储重读索引：另一个标签页可能刚刚提交过。
    function transact(mutator) {
      return withLock(async () => {
        let draft;
        try {
          draft = JSON.parse(rawGet(META_KEY));
        } catch (_err) {
          draft = null;
        }
        if (!draft) draft = JSON.parse(JSON.stringify(meta));
        draft = normalizeMeta(draft);
        const ctx = createContext(draft);
        const result = await mutator(ctx);
        ctx.bestEffortCheckpoint();
        reconcile(draft);
        meta = draft;
        return result;
      });
    }

    function commit(mutator) {
      return transact((ctx) => mutator(ctx));
    }

    // ---------- 领域操作 ----------

    function findSampleByCode(m, code) {
      return m.samples.find((s) => s.code === code) || null;
    }

    // 同编号冲突：保留旧记录（地点/矿物/批注…），仅把照片更新为较新的一张。
    // 比较基准是照片拍摄时间（photo 记录的 createdAt，照片回收后仍保留）。
    function applyNewerPhoto(existing, incomingHash, incomingPhotoTime, m) {
      if (!incomingHash) return false;
      let existingPhotoTime = "";
      if (existing.photoHash && m.photos[existing.photoHash]) {
        existingPhotoTime = m.photos[existing.photoHash].createdAt || "";
      }
      const newer =
        !existing.photoHash ||
        !existingPhotoTime ||
        !incomingPhotoTime ||
        incomingPhotoTime >= existingPhotoTime;
      if (newer) {
        existing.photoHash = incomingHash;
        existing.updatedAt = new Date().toISOString();
      }
      return newer;
    }

    function upsertImportItem(ctx, item) {
      const m = ctx.meta;
      // 优先按编号匹配已有样本（跨批次的同编号冲突也能命中），其次按批次记录的 sampleId
      let sample = item.code ? findSampleByCode(m, item.code) : null;
      if (!sample && item.sampleId) {
        sample = m.samples.find((s) => s.id === item.sampleId) || null;
      }
      const existing = sample;
      let created = false;
      const previousHash = existing ? existing.photoHash : "";

      if (!sample) {
        sample = {
          id: uuid(),
          code: item.code || "",
          location: item.location || "",
          magnification: item.magnification || "",
          polarization: item.polarization || "",
          minerals: item.minerals || "",
          texture: item.texture || "",
          comment: item.comment || "",
          photoHash: item.hash || "",
          confirmed: false,
          createdAt: item.importedAt,
          updatedAt: item.importedAt
        };
        m.samples.unshift(sample);
        created = true;
      } else if (existing) {
        // 冲突：旧记录文字全部保留，只判断照片是否更新为较新的一张
        applyNewerPhoto(
          existing,
          item.hash,
          item.photoTakenAt || item.importedAt,
          m
        );
      } else {
        sample.photoHash = item.hash || sample.photoHash;
        sample.updatedAt = item.importedAt;
      }
      if (item.hash && item.dataUrl) {
        ctx.putPhoto(item.hash, item.dataUrl, item.photoTakenAt || item.importedAt);
      }
      return { sample, created, previousHash };
    }

    // 条目身份 = 哈希 + 编号：同一照片挂到不同编号是两个样本（共享照片负载）；
    // 而完全重复的文件（哈希+编号相同）在同批只保留一条。
    function lineIdOf(item) {
      return item.hash + "#" + (item.code || "");
    }

    function prepareBatch(items) {
      const byLine = new Map();
      const byHash = new Map();
      for (const item of items) {
        const lineId = lineIdOf(item);
        if (!byLine.has(lineId)) byLine.set(lineId, item);
        if (!byHash.has(item.hash)) byHash.set(item.hash, item);
      }
      const unique = Array.from(byLine.values());
      // 批次身份只取决于照片内容集合：重复提交同一批文件沿用首次结果
      const idSource = Array.from(byHash.keys()).sort().join("|");
      return { unique, idSource };
    }

    async function batchIdFor(items) {
      const { idSource } = prepareBatch(items);
      const buf = new TextEncoder().encode(idSource);
      return "B" + (await sha256Hex(buf)).slice(0, 16);
    }

    // 导入一批照片：同内容哈希只入库一次；每张完成即落盘可续作；
    // 整批重复提交沿用首次结果。
    async function importBatch(items, existingBatchId) {
      await init();
      // 规范化编号：文件名去掉扩展名，使 BX-07.png 与 BX-07 视为同一样本
      const normalized = items.map((raw) => {
        const item = Object.assign({}, raw);
        if (!item.code) item.code = deriveCode(item.name);
        item.code = normalizeCode(item.code);
        return item;
      });
      const prepared = prepareBatch(normalized);
      const unique = prepared.unique;
      const batchId = existingBatchId || (await batchIdFor(unique));
      const nowIso = () => new Date().toISOString();

      return transact(async (ctx) => {
        const m = ctx.meta;
        let batch = m.batches.find((b) => b.id === batchId);
        const toBatchItem = (item) => ({
          lineId: lineIdOf(item),
          hash: item.hash,
          code: item.code || deriveCode(item.name),
          status: "pending",
          sampleId: "",
          error: "",
          attempts: 0
        });
        if (!batch) {
          batch = {
            id: batchId,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            items: unique.map(toBatchItem)
          };
          m.batches.unshift(batch);
          ctx.checkpoint();
        } else {
          // 续作时按条目身份（哈希+编号）补齐新加入的条目
          let added = false;
          for (const item of unique) {
            if (!batch.items.some((bi) => bi.lineId === lineIdOf(item))) {
              batch.items.push(toBatchItem(item));
              added = true;
            }
          }
          if (added) ctx.checkpoint();
        }

        const byLine = new Map(unique.map((i) => [lineIdOf(i), i]));
        // 同批照片负载按哈希只写一次：记录本次已成功刷盘的哈希
        let skipped = 0;
        let failed = 0;
        let waiting = 0;
        const sampleIds = [];

        for (const bi of batch.items) {
          if (bi.status === "done" && m.samples.some((s) => s.id === bi.sampleId)) {
            // 重复导入沿用首次结果
            skipped += 1;
            sampleIds.push(bi.sampleId);
            continue;
          }
          const item = byLine.get(bi.lineId);
          if (!item) {
            // 续作时缺少该文件：不是失败，保持 pending 等待重新选择
            bi.status = "pending";
            bi.error = "等待重新选择该照片后续作";
            waiting += 1;
            ctx.checkpoint();
            continue;
          }
          bi.attempts += 1;
          try {
            if (!item.code) item.code = bi.code;
            item.importedAt = item.importedAt || nowIso();
            const upserted = upsertImportItem(ctx, item);
            const sample = upserted.sample;
            // 每张照片与样本在同一检查点落盘；失败后从最后完成样本恢复
            const failedHashes = ctx.checkpoint();
            if (failedHashes.includes(item.hash)) {
              // 容量彻底不足：回滚本次新建的样本或照片更换，该条留待续作
              if (upserted.created) {
                m.samples = m.samples.filter((s) => s.id !== sample.id);
              } else {
                sample.photoHash = upserted.previousHash;
              }
              ctx.forgetPhoto(item.hash);
              bi.status = "failed";
              bi.sampleId = "";
              bi.error = "本地存储容量不足且无旧图可回收，腾出空间后续作";
              failed += 1;
              ctx.bestEffortCheckpoint();
              continue;
            }
            bi.sampleId = sample.id;
            bi.status = "done";
            bi.error = "";
            sampleIds.push(sample.id);
            ctx.checkpoint();
          } catch (err) {
            bi.status = "failed";
            bi.error = String((err && err.message) || err);
            failed += 1;
            ctx.bestEffortCheckpoint();
          }
        }

        batch.updatedAt = nowIso();
        return {
          batchId,
          total: batch.items.length,
          done: batch.items.filter((i) => i.status === "done").length,
          reused: skipped,
          failed,
          waiting,
          sampleIds
        };
      });
    }

    function deriveCode(name) {
      return normalizeCode(name || "");
    }

    // 去掉图片扩展名并去除首尾空白；野外相机常以 编号.jpg 命名
    function normalizeCode(code) {
      return String(code || "")
        .trim()
        .replace(/\.[a-z0-9]{2,5}$/i, "");
    }

    // 单张录入 / 编辑表单走同一提交通道。
    async function upsertSampleForm(input) {
      await init();
      const now = new Date().toISOString();
      return commit((ctx) => {
        const m = ctx.meta;
        let sample = input.id ? m.samples.find((s) => s.id === input.id) : null;
        const existing = !sample && input.code ? findSampleByCode(m, input.code) : null;
        if (existing) sample = existing;

        const fields = [
          "code",
          "location",
          "magnification",
          "polarization",
          "minerals",
          "texture",
          "comment"
        ];

        if (!sample) {
          sample = {
            id: uuid(),
            code: input.code || "",
            location: "",
            magnification: "",
            polarization: input.polarization || "单偏光",
            minerals: "",
            texture: "",
            comment: "",
            photoHash: input.photoHash || "",
            confirmed: false,
            createdAt: now,
            updatedAt: now
          };
          m.samples.unshift(sample);
        }

        // 编辑：表单字段整体覆盖；同编号冲突的新建路径保留旧记录文字
        if (input.id) {
          for (const key of fields) {
            sample[key] = typeof input[key] === "string" ? input[key].trim() : sample[key];
          }
        } else if (!existing) {
          for (const key of fields) sample[key] = input[key] ? String(input[key]).trim() : sample[key];
        }

        if (input.photoHash) {
          const photoTime = input.photoTakenAt || now;
          if (!existing) {
            sample.photoHash = input.photoHash;
          } else {
            applyNewerPhoto(existing, input.photoHash, photoTime, m);
          }
          if (input.dataUrl) ctx.putPhoto(input.photoHash, input.dataUrl, photoTime);
        }
        if (input.id) sample.updatedAt = now;
        return sample;
      });
    }

    async function setConfirmed(sampleId, confirmed) {
      await init();
      return commit((ctx) => {
        const sample = ctx.meta.samples.find((s) => s.id === sampleId);
        if (sample) {
          sample.confirmed = !!confirmed;
          sample.updatedAt = new Date().toISOString();
        }
        return !!sample;
      });
    }

    async function setCompare(sampleId, on) {
      await init();
      return commit((ctx) => {
        const m = ctx.meta;
        if (on) {
          if (!m.samples.some((s) => s.id === sampleId)) return m.compare.slice();
          m.compare = [sampleId, ...m.compare.filter((id) => id !== sampleId)].slice(0, 2);
        } else {
          m.compare = m.compare.filter((id) => id !== sampleId);
        }
        return m.compare.slice();
      });
    }

    async function deleteSample(sampleId) {
      await init();
      return commit((ctx) => {
        const m = ctx.meta;
        const oldHash = (m.samples.find((s) => s.id === sampleId) || {}).photoHash;
        m.samples = m.samples.filter((s) => s.id !== sampleId);
        m.compare = m.compare.filter((id) => id !== sampleId);
        return { oldHash };
      });
    }

    async function snapshot() {
      await init();
      return JSON.parse(JSON.stringify(meta));
    }

    function getPhotoData(hash) {
      if (!hash) return "";
      const raw = rawGet(PHOTO_PREFIX + hash);
      return raw == null ? "" : raw;
    }

    function photoStatus(hash) {
      if (!hash || !meta || !meta.photos[hash]) return "missing";
      return meta.photos[hash].present ? "ready" : "reclaimed";
    }

    function usage() {
      let bytes = 0;
      let photos = 0;
      let present = 0;
      for (const key of eachStorageKey()) {
        const value = rawGet(key);
        if (value != null) bytes += String(value).length;
        if (key.startsWith(PHOTO_PREFIX)) {
          photos += 1;
          present += 1;
        }
      }
      return {
        bytes,
        photos,
        present,
        photosTotal: meta ? Object.keys(meta.photos).length : 0
      };
    }

    // 导出按当前筛选带出照片校验和（哈希），回收状态一并带出。
    function buildExport(filter) {
      const f = filter || {};
      const mineral = (f.mineral || "").trim();
      const polarization = f.polarization || "";
      const rows = meta.samples
        .filter((sample) => {
          const mineralMatch =
            !mineral || (sample.minerals || "").split(/[、,，\s]+/).includes(mineral);
          const polarMatch = !polarization || sample.polarization === polarization;
          return mineralMatch && polarMatch;
        })
        .map((sample) => ({
          样本编号: sample.code,
          采样地点: sample.location,
          放大倍数: sample.magnification,
          偏光类型: sample.polarization,
          主要矿物: sample.minerals,
          颗粒结构: sample.texture,
          老师批注: sample.comment,
          照片校验和: sample.photoHash || "",
          照片状态: sample.photoHash
            ? meta.photos[sample.photoHash] && meta.photos[sample.photoHash].present
              ? "在库"
              : "已回收"
            : "无照片",
          已确认: !!sample.confirmed
        }));
      return rows;
    }

    // 测试与恢复用：从外部重新加载（模拟另一个标签页写入后的状态）。
    async function reload() {
      meta = null;
      await init();
    }

    return {
      init,
      snapshot,
      reload,
      importBatch,
      batchIdFor,
      upsertSampleForm,
      setConfirmed,
      setCompare,
      deleteSample,
      getPhotoData,
      photoStatus,
      usage,
      buildExport,
      // 暴露给测试
      _internal: {
        commit,
        recomputeRefs,
        selectVictim,
        reconcile,
        hashDataUrl,
        META_KEY,
        LEGACY_KEY,
        PHOTO_PREFIX
      }
    };
  }

  global.createThinSectionStore = createThinSectionStore;

  // ---------- 浏览器 UI ----------

  if (typeof document !== "undefined" && typeof window !== "undefined") {
    document.addEventListener("DOMContentLoaded", boot);

    function boot() {
      const storage = window.localStorage;
      // 缓存配额估算，用于容量不足前的主动回收；取不到时靠写入异常兜底。
      let quotaInfo = { quota: Infinity, usage: 0 };
      async function refreshEstimate() {
        if (navigator.storage && navigator.storage.estimate) {
          try {
            quotaInfo = await navigator.storage.estimate();
          } catch (_err) {
            /* 忽略，沿用旧值 */
          }
        }
      }
      const store = createThinSectionStore(storage, {
        estimate: () => quotaInfo
      });
      refreshEstimate();
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) refreshEstimate();
      });

      const form = document.querySelector("#sampleForm");
      const photoInput = document.querySelector("#photoInput");
      const batchInput = document.querySelector("#batchInput");
      const importBtn = document.querySelector("#importBatchBtn");
      const sampleGrid = document.querySelector("#sampleGrid");
      const comparePane = document.querySelector("#comparePane");
      const mineralFilter = document.querySelector("#mineralFilter");
      const polarFilter = document.querySelector("#polarFilter");
      const batchList = document.querySelector("#batchList");
      const quotaLine = document.querySelector("#quotaLine");
      const exportBtn = document.querySelector("#exportBtn");
      const editIdField = document.querySelector("#editId");
      const cancelEditBtn = document.querySelector("#cancelEditBtn");
      const submitBtn = form.querySelector("button[type=submit]");

      let pendingPhoto = null; // { hash, dataUrl, name }
      let editId = "";

      function resetEditor() {
        editId = "";
        editIdField.value = "";
        pendingPhoto = null;
        photoInput.value = "";
        form.reset();
        submitBtn.textContent = "保存样本";
        if (cancelEditBtn) cancelEditBtn.hidden = true;
      }

      function enterEditMode(sample) {
        editId = sample.id;
        editIdField.value = sample.id;
        form.elements.code.value = sample.code;
        form.elements.location.value = sample.location;
        form.elements.magnification.value = sample.magnification;
        form.elements.polarization.value = sample.polarization;
        form.elements.minerals.value = sample.minerals;
        form.elements.texture.value = sample.texture;
        form.elements.comment.value = sample.comment;
        submitBtn.textContent = "更新样本";
        if (cancelEditBtn) cancelEditBtn.hidden = false;
      }

      function readFileAsArrayBuffer(file) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.addEventListener("load", () => resolve(reader.result));
          reader.addEventListener("error", () => reject(reader.error));
          reader.readAsArrayBuffer(file);
        });
      }

      function readFileAsDataUrl(file) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.addEventListener("load", () => resolve(reader.result));
          reader.addEventListener("error", () => reject(reader.error));
          reader.readAsDataURL(file);
        });
      }

      async function digestFile(file) {
        const buf = await readFileAsArrayBuffer(file);
        const hash = await sha256Hex(buf);
        const dataUrl = await readFileAsDataUrl(file);
        return {
          hash,
          dataUrl,
          name: file.name,
          photoTakenAt: file.lastModified ? new Date(file.lastModified).toISOString() : ""
        };
      }

      function escapeHtml(value) {
        return String(value == null ? "" : value).replace(
          /[&<>"']/g,
          (ch) =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
        );
      }

      function shortHash(hash) {
        return hash ? hash.slice(0, 8) : "";
      }

      function photoSrc(sample, cache) {
        if (!sample.photoHash) return "";
        if (cache.has(sample.photoHash)) return cache.get(sample.photoHash);
        const src = store.getPhotoData(sample.photoHash);
        cache.set(sample.photoHash, src);
        return src;
      }

      function filteredSamples(snap) {
        const mineral = mineralFilter.value.trim();
        const polarization = polarFilter.value;
        return snap.samples.filter((sample) => {
          const mineralMatch =
            !mineral || (sample.minerals || "").split(/[、,，\s]+/).includes(mineral);
          const polarMatch = !polarization || sample.polarization === polarization;
          return mineralMatch && polarMatch;
        });
      }

      function renderSampleCard(sample, snap, cache) {
        const src = photoSrc(sample, cache);
        const reclaimed = sample.photoHash && !src;
        const img = src
          ? `<img src="${src}" alt="${escapeHtml(sample.code)}显微照片">`
          : reclaimed
            ? '<div class="photo-placeholder reclaimed">照片已按容量策略回收</div>'
            : '<div class="photo-placeholder"></div>';
        const checked = snap.compare.includes(sample.id);
        return `
        <article class="sample-card ${sample.confirmed ? "confirmed" : ""}">
          ${img}
          <div class="sample-body">
            <h3>${escapeHtml(sample.code)}</h3>
            <p>${escapeHtml(sample.location || "未记录地点")} · ${escapeHtml(sample.magnification || "未记录倍数")} · ${escapeHtml(sample.polarization)}</p>
            <p>矿物：${escapeHtml(sample.minerals || "未记录")}</p>
            <p>结构：${escapeHtml(sample.texture || "未记录")}</p>
            <p>${escapeHtml(sample.comment || "未填写批注")}</p>
            ${sample.photoHash ? `<p class="hash-line">校验和 ${shortHash(sample.photoHash)}${reclaimed ? " · 已回收" : ""}</p>` : ""}
            <div class="card-actions">
              <label><input type="checkbox" data-compare="${sample.id}" ${checked ? "checked" : ""}>对比</label>
              <label class="confirm-line"><input type="checkbox" data-confirm="${sample.id}" ${sample.confirmed ? "checked" : ""}>已确认</label>
              <button type="button" data-edit="${sample.id}">编辑</button>
              <button type="button" data-delete="${sample.id}">删除</button>
            </div>
          </div>
        </article>`;
      }

      async function render() {
        const snap = await store.snapshot();
        const cache = new Map();
        const rows = filteredSamples(snap);
        sampleGrid.innerHTML = rows.length
          ? rows.map((sample) => renderSampleCard(sample, snap, cache)).join("")
          : "<p>还没有样本，先录入单张或批量导入照片。</p>";

        const compareSamples = snap.compare
          .map((id) => snap.samples.find((sample) => sample.id === id))
          .filter(Boolean)
          .slice(0, 2);
        comparePane.innerHTML = compareSamples.length
          ? compareSamples
              .map((sample) => {
                const src = photoSrc(sample, cache);
                return `
              <article class="compare-item">
                ${src ? `<img src="${src}" alt="${escapeHtml(sample.code)}对比图">` : '<div class="photo-placeholder reclaimed">照片已回收</div>'}
                <h3>${escapeHtml(sample.code)}</h3>
                <p>${escapeHtml(sample.polarization)} · ${escapeHtml(sample.minerals || "未记录矿物")}</p>
                <p>${escapeHtml(sample.texture || "未记录结构")}</p>
              </article>`;
              })
              .join("")
          : "<p>勾选两张样本卡片后可并排对比。</p>";

        renderBatches(snap);
        renderQuota();
      }

      function renderBatches(snap) {
        if (!batchList) return;
        batchList.innerHTML = snap.batches.length
          ? snap.batches
              .map((batch) => {
                const done = batch.items.filter((i) => i.status === "done").length;
                const pending = batch.items.filter((i) => i.status !== "done").length;
                return `
              <div class="batch-row">
                <span>批次 ${escapeHtml(batch.id.slice(0, 10))}：${done}/${batch.items.length} 完成${pending ? `，${pending} 张待续作` : ""}</span>
                ${pending ? `<label class="resume-label">续作<input type="file" accept="image/*" multiple data-resume-batch="${batch.id}"></label>` : ""}
              </div>`;
              })
              .join("")
          : "<p>尚无导入批次。多选照片即生成可续作批次。</p>";
      }

      function renderQuota() {
        if (!quotaLine) return;
        const info = store.usage();
        quotaLine.textContent = `本地存储约 ${(info.bytes / 1024 / 1024).toFixed(2)} MB · 在库照片 ${info.present}/${info.photosTotal} 张（容量不足时自动回收未确认旧图）`;
      }

      // ---- 单张表单 ----

      photoInput.addEventListener("change", async () => {
        const file = photoInput.files[0];
        pendingPhoto = file ? await digestFile(file) : null;
      });

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const data = new FormData(form);
        try {
          if (!pendingPhoto && photoInput.files[0]) {
            pendingPhoto = await digestFile(photoInput.files[0]);
          }
          const photo = pendingPhoto;
          await store.upsertSampleForm({
            id: editId,
            code: (data.get("code") || "").toString().trim(),
            location: (data.get("location") || "").toString().trim(),
            magnification: (data.get("magnification") || "").toString().trim(),
            polarization: data.get("polarization"),
            minerals: (data.get("minerals") || "").toString().trim(),
            texture: (data.get("texture") || "").toString().trim(),
            comment: (data.get("comment") || "").toString().trim(),
            photoHash: photo ? photo.hash : "",
            dataUrl: photo ? photo.dataUrl : "",
            photoTakenAt: photo ? photo.photoTakenAt : ""
          });
          resetEditor();
          await render();
        } catch (err) {
          window.alert("保存失败：" + ((err && err.message) || err));
        }
      });

      sampleGrid.addEventListener("click", async (event) => {
        const deleteId = event.target.dataset.delete;
        const editTarget = event.target.dataset.edit;
        if (deleteId) {
          await store.deleteSample(deleteId);
          await render();
          return;
        }
        if (editTarget) {
          const snap = await store.snapshot();
          const sample = snap.samples.find((s) => s.id === editTarget);
          if (!sample) return;
          enterEditMode(sample);
          form.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });

      if (cancelEditBtn) {
        cancelEditBtn.addEventListener("click", () => {
          resetEditor();
        });
      }

      sampleGrid.addEventListener("change", async (event) => {
        const compareId = event.target.dataset.compare;
        const confirmId = event.target.dataset.confirm;
        if (compareId) {
          await store.setCompare(compareId, event.target.checked);
          await render();
        } else if (confirmId) {
          await store.setConfirmed(confirmId, event.target.checked);
          await render();
        }
      });

      // ---- 批量导入 ----

      async function filesToItems(fileList) {
        const files = Array.from(fileList);
        const items = [];
        for (const file of files) {
          // eslint-disable-next-line no-await-in-loop
          const digested = await digestFile(file);
          items.push({
            hash: digested.hash,
            dataUrl: digested.dataUrl,
            name: digested.name,
            code: digested.name.replace(/\.[^.]+$/, ""),
            photoTakenAt: digested.photoTakenAt
          });
        }
        return items;
      }

      importBtn.addEventListener("click", () => batchInput.click());

      batchInput.addEventListener("change", async () => {
        if (!batchInput.files.length) return;
        try {
          const items = await filesToItems(batchInput.files);
          const result = await store.importBatch(items);
          if (result.failed) {
            window.alert(`本批 ${result.total} 张：完成 ${result.done}，${result.failed} 张失败，可在批次列表中续作。`);
          }
        } catch (err) {
          window.alert("导入失败：" + ((err && err.message) || err));
        } finally {
          batchInput.value = "";
          await render();
        }
      });

      // 续作入口在每次 render 后重建，事件委托到容器
      if (batchList) {
        batchList.addEventListener("change", async (event) => {
          const batchId = event.target.dataset.resumeBatch;
          if (!batchId || !event.target.files.length) return;
          try {
            const items = await filesToItems(event.target.files);
            const result = await store.importBatch(items, batchId);
            if (result.failed) {
              window.alert(`续作：仍有 ${result.failed} 张缺少照片，请重新选择。`);
            }
          } catch (err) {
            window.alert("续作失败：" + ((err && err.message) || err));
          }
          event.target.value = "";
          await render();
        });
      }

      // ---- 筛选与导出 ----

      [mineralFilter, polarFilter].forEach((field) => field.addEventListener("input", render));

      exportBtn.addEventListener("click", () => {
        const checklist = store.buildExport({
          mineral: mineralFilter.value,
          polarization: polarFilter.value
        });
        const blob = new Blob([JSON.stringify(checklist, null, 2)], {
          type: "application/json"
        });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = "thin-section-checklist.json";
        link.click();
        URL.revokeObjectURL(link.href);
      });

      // 另一个标签页提交后，本页跟着刷新（跨标签页提交由 Web Locks 串行化）
      window.addEventListener("storage", (event) => {
        if (event.key && (event.key === META_KEY || event.key.startsWith(PHOTO_PREFIX))) {
          store.reload().then(render);
        }
      });

      render();
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { createThinSectionStore };
  }
})(typeof window !== "undefined" ? window : globalThis);
