"use strict";

(function () {
  const STORAGE_KEY = "wxyy-2-thin-section-index";
  const LOCK_KEY = "wxyy-2-thin-section-lock";
  const VERSION = 2;
  const MAX_COMPARE = 2;
  const LOCK_TTL = 8000;

  const $ = (selector) => document.querySelector(selector);

  const form = $("#sampleForm");
  const photoInput = $("#photoInput");
  const sampleGrid = $("#sampleGrid");
  const comparePane = $("#comparePane");
  const mineralFilter = $("#mineralFilter");
  const polarFilter = $("#polarFilter");
  const batchBar = $("#batchBar");
  const batchProgress = $("#batchProgress");
  const storageMeter = $("#storageMeter");
  const evictBtn = $("#evictBtn");

  const emptyState = () => ({
    version: VERSION,
    photos: {},
    samples: [],
    compare: [],
    batches: {}
  });

  let state = loadState();

  // ---------------- 持久化：容量不足时回收旧图后重试 ----------------

  function isQuotaError(err) {
    return !!err && (err.name === "QuotaExceededError" || err.code === 22 || err.code === 1014);
  }

  function evictionCandidates() {
    const pinned = new Set(state.compare || []);
    return Object.values(state.photos)
      .filter((photo) => photo.dataUrl && !photo.refs.some((id) => pinned.has(id)))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  // 排队回收：最旧的、且不在对比中的照片先清，校验和与引用关系保留
  function evictOnce() {
    const victim = evictionCandidates()[0];
    if (!victim) return false;
    victim.dataUrl = null;
    victim.evicted = true;
    victim.evictedAt = Date.now();
    return true;
  }

  function evictAll() {
    let freed = 0;
    while (evictOnce()) freed += 1;
    return freed;
  }

  function persist(notify) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      state.lastSaved = Date.now();
      if (notify) notifyTabs();
      updateStorageMeter();
      return true;
    } catch (err) {
      if (isQuotaError(err) && evictOnce()) return persist(notify);
      throw err;
    }
  }

  function save() {
    return persist(true);
  }

  function saveQuiet() {
    return persist(false);
  }

  // ---------------- 跨标签页：锁 + 变更合并 ----------------

  function readLock() {
    try {
      return JSON.parse(localStorage.getItem(LOCK_KEY) || "null");
    } catch {
      return null;
    }
  }

  function withLock(fn) {
    const token = crypto.randomUUID();
    const started = Date.now();
    const wait = (resolve) => setTimeout(resolve, 120);
    const acquire = () => {
      const lock = readLock();
      if (!lock || lock.token === token || Date.now() - lock.ts > LOCK_TTL) return;
      if (Date.now() - started > 15000) return; // 等太久就不再等
      return new Promise(wait).then(acquire);
    };
    return Promise.resolve(acquire()).then(() => {
      localStorage.setItem(LOCK_KEY, JSON.stringify({ token, ts: Date.now() }));
      try {
        mergeRemote(readRemote());
        return fn();
      } finally {
        const current = readLock();
        if (current && current.token === token) localStorage.removeItem(LOCK_KEY);
      }
    });
  }

  function readRemote() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function notifyTabs() {
    try {
      if (channel) channel.postMessage({ type: "change", ts: Date.now() });
    } catch {
      /* 通知失败不影响本地 */
    }
  }

  function reloadFromStorage() {
    const remote = readRemote();
    if (!remote || remote.version !== VERSION) return;
    mergeRemote(remote);
    reconcileByCode();
    saveQuiet();
    render();
  }

  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("wxyy-thin-section") : null;
  if (channel) channel.onmessage = (event) => {
    if (event.data && event.data.type === "change") reloadFromStorage();
  };
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) reloadFromStorage();
  });

  // 合并另一个标签页写入的数据：照片按哈希并集，样本按 id 并集，
  // 同编号冲突时保留旧记录、引用较新照片（见 reconcileByCode）
  function mergeRemote(remote) {
    if (!remote || remote.version !== VERSION) return;

    for (const [hash, remotePhoto] of Object.entries(remote.photos || {})) {
      const localPhoto = state.photos[hash];
      if (!localPhoto) {
        state.photos[hash] = {
          hash,
          dataUrl: remotePhoto.dataUrl || null,
          bytes: remotePhoto.bytes || 0,
          createdAt: remotePhoto.createdAt || Date.now(),
          refs: [...(remotePhoto.refs || [])],
          evicted: !remotePhoto.dataUrl
        };
      } else {
        if (!localPhoto.dataUrl && remotePhoto.dataUrl) {
          localPhoto.dataUrl = remotePhoto.dataUrl;
          localPhoto.evicted = false;
        }
        localPhoto.refs = [...new Set([...localPhoto.refs, ...(remotePhoto.refs || [])])];
        localPhoto.createdAt = Math.min(localPhoto.createdAt, remotePhoto.createdAt || localPhoto.createdAt);
      }
    }

    for (const remoteSample of remote.samples || []) {
      const localSample = state.samples.find((sample) => sample.id === remoteSample.id);
      if (!localSample) {
        state.samples.push({ ...remoteSample });
      } else if (remoteSample.photoHash && remoteSample.photoHash !== localSample.photoHash) {
        const localTime = Date.parse(localSample.createdAt) || 0;
        const remoteTime = Date.parse(remoteSample.createdAt) || 0;
        if (remoteTime > localTime) {
          const oldPhoto = state.photos[localSample.photoHash];
          if (oldPhoto) oldPhoto.refs = oldPhoto.refs.filter((id) => id !== localSample.id);
          localSample.photoHash = remoteSample.photoHash;
          const newPhoto = state.photos[remoteSample.photoHash];
          if (newPhoto && !newPhoto.refs.includes(localSample.id)) newPhoto.refs.push(localSample.id);
        }
      }
    }

    state.compare = [...new Set([...state.compare, ...(remote.compare || [])])].slice(0, MAX_COMPARE);

    for (const [batchId, remoteBatch] of Object.entries(remote.batches || {})) {
      const localBatch = state.batches[batchId];
      if (!localBatch) {
        state.batches[batchId] = { ...remoteBatch, completed: [...(remoteBatch.completed || [])] };
      } else {
        localBatch.completed = [...new Set([...(localBatch.completed || []), ...(remoteBatch.completed || [])])];
        if (remoteBatch.status === "done") localBatch.status = "done";
        localBatch.total = Math.max(localBatch.total || 0, remoteBatch.total || 0);
      }
    }
  }

  // 同一批重复导入 / 两个标签页各提交一次：同编号样本只留一条记录，
  // 照片引用较新的，其余字段保留首次（旧）结果
  function reconcileByCode() {
    const groups = new Map();
    for (const sample of state.samples) {
      const key = (sample.code || "").trim().toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(sample);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const keep = group[0];
      const newest = group[group.length - 1];
      if (newest.photoHash && newest.photoHash !== keep.photoHash) {
        const oldPhoto = state.photos[keep.photoHash];
        if (oldPhoto) oldPhoto.refs = oldPhoto.refs.filter((id) => id !== keep.id);
        const newPhoto = state.photos[newest.photoHash];
        if (newPhoto && !newPhoto.refs.includes(keep.id)) newPhoto.refs.push(keep.id);
        keep.photoHash = newest.photoHash;
      }
      for (const duplicate of group.slice(1)) {
        const photo = state.photos[duplicate.photoHash];
        if (photo) photo.refs = photo.refs.filter((id) => id !== duplicate.id);
        state.samples = state.samples.filter((sample) => sample.id !== duplicate.id);
        state.compare = state.compare.filter((id) => id !== duplicate.id);
      }
    }
  }

  // ---------------- 旧数据升级：补算哈希、保留批注 ----------------

  function loadState() {
    const raw = readRemote();
    if (!raw) return emptyState();
    if (raw.version === VERSION && raw.photos) return normalize(raw);
    return migrate(raw);
  }

  function normalize(raw) {
    const next = emptyState();
    next.photos = raw.photos && typeof raw.photos === "object" ? raw.photos : {};
    next.samples = Array.isArray(raw.samples) ? raw.samples : [];
    next.compare = Array.isArray(raw.compare) ? raw.compare : [];
    next.batches = raw.batches && typeof raw.batches === "object" ? raw.batches : {};
    return next;
  }

  function migrate(oldState) {
    const next = emptyState();
    next.compare = Array.isArray(oldState.compare)
      ? oldState.compare.filter((id) => typeof id === "string")
      : [];
    const legacySamples = Array.isArray(oldState.samples) ? oldState.samples : [];
    const pending = [];

    for (const legacy of legacySamples) {
      const id = legacy.id || crypto.randomUUID();
      const sample = {
        id,
        photoHash: null,
        code: legacy.code || "",
        location: legacy.location || "",
        magnification: legacy.magnification || "",
        polarization: legacy.polarization || "单偏光",
        minerals: legacy.minerals || "",
        texture: legacy.texture || "",
        comment: legacy.comment || "",
        createdAt: legacy.createdAt || new Date().toISOString()
      };
      next.samples.push(sample);

      const photo = typeof legacy.photo === "string" ? legacy.photo : "";
      if (photo.startsWith("data:image")) {
        pending.push(
          hashDataUrl(photo)
            .then(({ hash, bytes }) => addPhoto(hash, photo, bytes, id))
            .then((hash) => {
              sample.photoHash = hash;
            })
            .catch(() => {})
        );
      }
    }

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* 升级时空间不足则先落库样本，照片待哈希完成后再尝试 */
    }
    Promise.all(pending).then(() => {
      reconcileByCode();
      save();
      render();
      updateStorageMeter();
    });
    return next;
  }
  // ---------------- 照片库：按内容哈希去重，记录引用 ----------------

  async function hashBuffer(buffer) {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  async function hashFile(file) {
    const buffer = await file.arrayBuffer();
    return { hash: await hashBuffer(buffer), bytes: buffer.byteLength };
  }

  async function hashDataUrl(dataUrl) {
    const response = await fetch(dataUrl);
    const buffer = await response.arrayBuffer();
    return { hash: await hashBuffer(buffer), bytes: buffer.byteLength };
  }

  function addPhoto(hash, dataUrl, bytes, sampleId) {
    let photo = state.photos[hash];
    if (!photo) {
      photo = state.photos[hash] = {
        hash,
        dataUrl: dataUrl || null,
        bytes: bytes || 0,
        createdAt: Date.now(),
        refs: []
      };
    } else {
      if (dataUrl && !photo.dataUrl) {
        photo.dataUrl = dataUrl;
        photo.evicted = false;
      }
      if (bytes) photo.bytes = Math.max(photo.bytes || 0, bytes);
    }
    if (sampleId && !photo.refs.includes(sampleId)) photo.refs.push(sampleId);
    return hash;
  }

  function removeSample(sampleId) {
    const sample = state.samples.find((item) => item.id === sampleId);
    if (sample) {
      const photo = sample.photoHash && state.photos[sample.photoHash];
      if (photo) photo.refs = photo.refs.filter((id) => id !== sampleId);
      state.samples = state.samples.filter((item) => item.id !== sampleId);
      state.compare = state.compare.filter((id) => id !== sampleId);
    }
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve) => {
      if (!file) return resolve("");
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(reader.result));
      reader.readAsDataURL(file);
    });
  }

  // ---------------- 导入：可续作批次，失败从最后完成样本恢复 ----------------

  function batchDefaults() {
    const data = new FormData(form);
    return {
      location: (data.get("location") || "").toString().trim(),
      magnification: (data.get("magnification") || "").toString().trim(),
      polarization: data.get("polarization") || "单偏光"
    };
  }

  function setBatchBar(message, isError) {
    if (!batchBar || !batchProgress) return;
    batchBar.hidden = false;
    batchProgress.textContent = message;
    batchProgress.dataset.error = isError ? "1" : "";
  }

  async function importSingle(file) {
    await withLock(async () => {
      const data = new FormData(form);
      const { hash, bytes } = await hashFile(file);
      const dataUrl = await readFileAsDataUrl(file);
      const sample = {
        id: crypto.randomUUID(),
        photoHash: hash,
        code: (data.get("code") || file.name.replace(/\.[^.]+$/, "")).toString().trim(),
        location: (data.get("location") || "").toString().trim(),
        magnification: (data.get("magnification") || "").toString().trim(),
        polarization: data.get("polarization") || "单偏光",
        minerals: (data.get("minerals") || "").toString().trim(),
        texture: (data.get("texture") || "").toString().trim(),
        comment: (data.get("comment") || "").toString().trim(),
        createdAt: new Date().toISOString()
      };
      state.samples.unshift(sample);
      addPhoto(hash, dataUrl, bytes, sample.id);
      reconcileByCode();
      save();
      render();
    });
  }

  async function importFiles(fileList) {
    const files = Array.from(fileList || []).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;

    await withLock(async () => {
      const hashed = [];
      for (const file of files) {
        try {
          const { hash, bytes } = await hashFile(file);
          hashed.push({ file, hash, bytes });
        } catch {
          /* 跳过无法读取的文件 */
        }
      }
      if (!hashed.length) return;

      // 有未完成批次且本次文件包含已完成样本 → 续作；否则开新批次
      const openBatch = Object.values(state.batches)
        .filter((batch) => batch.status !== "done")
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
      const completedHashes = new Set(
        openBatch
          ? openBatch.completed
              .map((sampleId) => state.samples.find((sample) => sample.id === sampleId))
              .filter((sample) => sample && sample.photoHash)
              .map((sample) => sample.photoHash)
          : []
      );
      const isResume = !!openBatch && hashed.some((item) => completedHashes.has(item.hash));
      const batch = isResume
        ? openBatch
        : { id: crypto.randomUUID(), total: 0, completed: [], status: "in-progress", createdAt: Date.now() };
      if (!isResume) state.batches[batch.id] = batch;

      const defaults = batchDefaults();
      for (let i = 0; i < hashed.length; i += 1) {
        const { file, hash, bytes } = hashed[i];
        setBatchBar(`批次 ${batch.id.slice(0, 8)}：${isResume ? "续作" : "处理中"} ${i + 1}/${hashed.length} …`);
        try {
          if (completedHashes.has(hash)) continue; // 已完成样本沿用首次结果
          const dataUrl = await readFileAsDataUrl(file);
          const sample = {
            id: crypto.randomUUID(),
            photoHash: hash,
            code: file.name.replace(/\.[^.]+$/, ""),
            location: defaults.location,
            magnification: defaults.magnification,
            polarization: defaults.polarization,
            minerals: "",
            texture: "",
            comment: "",
            createdAt: new Date().toISOString()
          };
          state.samples.unshift(sample);
          addPhoto(hash, dataUrl, bytes, sample.id);
          batch.completed.push(sample.id);
          completedHashes.add(hash);
          save();
          render();
        } catch (err) {
          batch.status = "error";
          batch.failedIndex = i;
          batch.error = String((err && err.message) || err);
          save();
          setBatchBar(
            `批次 ${batch.id.slice(0, 8)} 在第 ${i + 1} 张中断（${batch.error}）。重新选择本批照片将从最后完成的样本继续。`,
            true
          );
          render();
          return;
        }
      }

      batch.status = "done";
      batch.total = Math.max(batch.total || 0, batch.completed.length);
      reconcileByCode();
      save();
      setBatchBar(
        isResume
          ? `批次 ${batch.id.slice(0, 8)} 已续作完成，共 ${batch.completed.length} 张。`
          : `批次 ${batch.id.slice(0, 8)} 已完成，共 ${batch.completed.length} 张。`
      );
      render();
    });
  }

  // ---------------- 筛选 / 渲染 / 导出 ----------------

  function filteredSamples() {
    const mineral = mineralFilter.value.trim();
    const polarization = polarFilter.value;
    return state.samples.filter((sample) => {
      const mineralMatch = !mineral || sample.minerals.includes(mineral);
      const polarMatch = !polarization || sample.polarization === polarization;
      return mineralMatch && polarMatch;
    });
  }

  function shortHash(hash) {
    return (hash || "").slice(0, 12);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function photoMarkup(sample) {
    const photo = sample.photoHash && state.photos[sample.photoHash];
    if (photo && photo.dataUrl) {
      return `<img src="${photo.dataUrl}" alt="${escapeHtml(sample.code)}显微照片" loading="lazy">`;
    }
    const tag = photo && photo.evicted ? `原图已回收 · ${shortHash(photo.hash)}` : "暂无照片";
    return `<div class="photo-placeholder"><span>${tag}</span></div>`;
  }

  function render() {
    const rows = filteredSamples();
    sampleGrid.innerHTML = rows.length
      ? rows
          .map(
            (sample) => `
    <article class="sample-card">
      ${photoMarkup(sample)}
      <div class="sample-body">
        <h3>${escapeHtml(sample.code)}</h3>
        <p>${escapeHtml(sample.location || "未记录地点")} · ${escapeHtml(sample.magnification || "未记录倍数")} · ${escapeHtml(sample.polarization)}</p>
        <p>矿物：${escapeHtml(sample.minerals || "未记录")}</p>
        <p>结构：${escapeHtml(sample.texture || "未记录")}</p>
        <p>${escapeHtml(sample.comment || "未填写批注")}</p>
        <p class="hash-line">照片校验和 <code>${sample.photoHash ? shortHash(sample.photoHash) : "—"}</code></p>
        <div class="card-actions">
          <label><input type="checkbox" data-compare="${sample.id}" ${state.compare.includes(sample.id) ? "checked" : ""}>对比</label>
          <button type="button" data-delete="${sample.id}">删除</button>
        </div>
      </div>
    </article>`
          )
          .join("")
      : "<p>还没有样本，先从左侧录入一张薄片照片。</p>";

    const compareSamples = state.compare
      .map((id) => state.samples.find((sample) => sample.id === id))
      .filter(Boolean)
      .slice(0, MAX_COMPARE);

    comparePane.innerHTML = compareSamples.length
      ? compareSamples
          .map(
            (sample) => `
    <article class="compare-item">
      ${photoMarkup(sample)}
      <h3>${escapeHtml(sample.code)}</h3>
      <p>${escapeHtml(sample.polarization)} · ${escapeHtml(sample.minerals || "未记录矿物")}</p>
      <p>${escapeHtml(sample.texture || "未记录结构")}</p>
      <p class="hash-line">校验和 <code>${sample.photoHash ? shortHash(sample.photoHash) : "—"}</code></p>
    </article>`
          )
          .join("")
      : "<p>勾选两张样本卡片后可并排对比。</p>";
  }

  async function updateStorageMeter() {
    if (!storageMeter) return;
    let used = 0;
    try {
      used = new Blob([localStorage.getItem(STORAGE_KEY) || ""]).size;
    } catch {
      /* 估算失败时仅不显示 */
    }
    let quota = 0;
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        quota = estimate.quota || 0;
      }
    } catch {
      quota = 0;
    }
    const mb = (bytes) => (bytes / 1048576).toFixed(1);
    storageMeter.textContent = quota
      ? `本地存储 ${mb(used)} / 约 ${mb(quota)} MB`
      : `本地存储已用 ${mb(used)} MB`;
  }

  // ---------------- 事件绑定 ----------------

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const files = photoInput.files;
    if (!files || !files.length) {
      setBatchBar("请先选择照片文件。");
      return;
    }
    try {
      if (files.length === 1) await importSingle(files[0]);
      else await importFiles(files);
    } catch (err) {
      setBatchBar(`导入失败：${String((err && err.message) || err)}`, true);
    }
    photoInput.value = "";
    form.reset();
  });

  sampleGrid.addEventListener("click", (event) => {
    const deleteId = event.target.dataset.delete;
    if (deleteId) {
      removeSample(deleteId);
      save();
      render();
    }
  });

  sampleGrid.addEventListener("change", (event) => {
    const id = event.target.dataset.compare;
    if (!id) return;
    if (event.target.checked) {
      state.compare = [id, ...state.compare.filter((item) => item !== id)].slice(0, MAX_COMPARE);
    } else {
      state.compare = state.compare.filter((item) => item !== id);
    }
    save();
    render();
  });

  [mineralFilter, polarFilter].forEach((field) => field.addEventListener("input", render));

  if (evictBtn) {
    evictBtn.addEventListener("click", () => {
      const freed = evictAll();
      reconcileByCode();
      save();
      render();
      setBatchBar(
        freed
          ? `已回收 ${freed} 张无对比引用的旧图（校验和仍保留，导出可核对）。`
          : "没有可回收的旧图（对比中的照片受保护）。"
      );
    });
  }

  document.querySelector("#exportBtn").addEventListener("click", () => {
    const checklist = filteredSamples().map((sample) => ({
      样本编号: sample.code,
      采样地点: sample.location,
      放大倍数: sample.magnification,
      偏光类型: sample.polarization,
      主要矿物: sample.minerals,
      颗粒结构: sample.texture,
      老师批注: sample.comment,
      照片校验和: sample.photoHash || ""
    }));
    const blob = new Blob([JSON.stringify(checklist, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "thin-section-checklist.json";
    link.click();
    URL.revokeObjectURL(link.href);
  });

  // 暴露给调试 / 自动化测试
  window.__app = {
    VERSION,
    getState: () => state,
    save,
    saveQuiet,
    importFiles,
    importSingle,
    mergeRemote,
    reconcileByCode,
    evictAll,
    evictOnce,
    hashFile,
    hashDataUrl,
    readFileAsDataUrl,
    filteredSamples,
    render,
    setBatchBar
  };

  render();
  updateStorageMeter();
})();
