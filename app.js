/*
 * 页面操作层：只负责渲染与交互。
 * 借阅判定在 rules.js，写入与去重在 store.js；本文件不直接改 state 后自行落盘。
 */
(function () {
  "use strict";

  const R = window.SlideRules;
  const Store = window.SlideStore;

  const form = document.querySelector("#sampleForm");
  const photoInput = document.querySelector("#photoInput");
  const formError = document.querySelector("#formError");
  const sampleGrid = document.querySelector("#sampleGrid");
  const comparePane = document.querySelector("#comparePane");
  const historyPane = document.querySelector("#historyPane");
  const mineralFilter = document.querySelector("#mineralFilter");
  const polarFilter = document.querySelector("#polarFilter");

  let pendingPhoto = "";
  let formToken = Store.newToken();

  const modal = document.querySelector("#actionModal");
  const modalTitle = modal.querySelector(".modal-title");
  const modalBody = modal.querySelector("#modalBody");
  const modalError = modal.querySelector("#modalError");
  const modalSubmit = modal.querySelector("#modalSubmit");
  const modalCancel = modal.querySelector("#modalCancel");
  let modalToken = "";
  let modalAction = null;

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
  }

  function fmt(ts) {
    if (ts == null) return "—";
    return new Date(ts).toLocaleString("zh-CN", { hour12: false });
  }

  function fmtDay(ts) {
    return new Date(ts).toLocaleDateString("zh-CN");
  }

  function statusBadge(info) {
    if (info.repair) {
      return info.repair.repairedAt == null
        ? '<span class="tag tag-danger">待修</span>'
        : '<span class="tag tag-warn">待复核</span>';
    }
    if (info.overdue) return '<span class="tag tag-danger">逾期未还</span>';
    if (info.loan) return '<span class="tag tag-borrow">借出中</span>';
    return '<span class="tag tag-ok">可借</span>';
  }

  function render() {
    const state = Store.getState();
    const now = Date.now();

    // 逾期判定随时间推进，先把逾期薄片从对比名单摘除
    Store.reconcileCompare();

    const mineral = mineralFilter.value.trim();
    const polarization = polarFilter.value;
    const filtered = state.samples.filter((sample) => {
      const mineralMatch = !mineral || sample.minerals.includes(mineral);
      const polarMatch = !polarization || sample.polarization === polarization;
      return mineralMatch && polarMatch;
    });
    const rows = R.boardOrder(state, filtered, now);

    const overdueCount = state.samples.filter(
      (sample) => R.describe(sample, state, now).overdue
    ).length;

    const banner = overdueCount
      ? `<div class="overdue-banner">有 <strong>${overdueCount}</strong> 张薄片逾期未还，已自动置顶并从对比、导出中排除</div>`
      : "";

    sampleGrid.innerHTML = banner + (rows.length ? rows.map((sample) => cardHtml(sample, now)).join("")
      : "<p>还没有样本，先从左侧录入一张薄片。</p>");

    renderCompare();
    renderHistory();
  }

  function cardHtml(sample, now) {
    const state = Store.getState();
    const info = R.describe(sample, state, now);
    const canCompare = !info.overdue;
    const checked = state.compare.includes(sample.id);
    const frozenTag = info.frozen ? '<span class="tag tag-frozen">原片冻结</span>' : "";

    const loanLine = info.loan
      ? `<p class="loan-line">借阅人：${esc(info.loan.borrower)} · 应还 ${fmtDay(info.loan.dueAt)}${
          info.overdue ? " · 已逾期" : ""
        }</p>`
      : "";

    const repairLine = info.repair
      ? info.repair.repairedAt == null
        ? `<p class="loan-line warn">破损待修${
            info.repair.scratches ? "（划痕）" : ""
          }${info.repair.chips ? "（缺角）" : ""}，登记人：${esc(info.repair.reportedBy)}</p>`
        : `<p class="loan-line warn">修复人 ${esc(info.repair.repairedBy)}，等待另一人复核</p>`
      : "";

    const missingLine = info.missing.length
      ? `<p class="loan-line warn">资料缺项：${info.missing.map(esc).join("、")}</p>`
      : "";

    let primaryBtn = "";
    if (info.repair) {
      primaryBtn = info.repair.repairedAt == null
        ? `<button type="button" data-repair="${sample.id}">登记修复</button>`
        : `<button type="button" data-review="${sample.id}">复核恢复</button>`;
    } else if (info.loan) {
      primaryBtn = `<button type="button" data-return="${info.loan.id}">归还验收</button>`;
    } else {
      primaryBtn = `<button type="button" data-borrow="${sample.id}"${
        info.frozen ? " disabled" : ""
      }>借出登记</button>`;
    }

    return `
      <article class="sample-card${info.overdue ? " is-overdue" : ""}">
        ${sample.photo ? `<img src="${sample.photo}" alt="${esc(sample.code)}显微照片">` : '<div class="photo-placeholder"></div>'}
        <div class="sample-body">
          <div class="card-head"><h3>${esc(sample.code)}</h3><div class="tags">${statusBadge(info)}${frozenTag}</div></div>
          <p>${esc(sample.location || "未记录地点")} · ${esc(sample.magnification || "未记录倍数")} · ${esc(sample.polarization || "未记录偏光")}</p>
          <p>矿物：${esc(sample.minerals || "未记录")}</p>
          <p>结构：${esc(sample.texture || "未记录")}</p>
          ${missingLine}
          ${loanLine}
          ${repairLine}
          <p>${esc(sample.comment || "未填写批注")}</p>
          <div class="card-actions">
            <label><input type="checkbox" data-compare="${sample.id}" ${checked ? "checked" : ""} ${
              canCompare ? "" : "disabled"
            }>对比</label>
            <div class="action-btns">
              ${primaryBtn}
              <button type="button" class="ghost" data-freeze="${sample.id}">${
                info.frozen ? "解冻" : "冻结"
              }</button>
              <button type="button" class="ghost danger" data-delete="${sample.id}">删除</button>
            </div>
          </div>
        </div>
      </article>`;
  }

  function renderCompare() {
    const state = Store.getState();
    const items = state.compare
      .map((id) => state.samples.find((sample) => sample.id === id))
      .filter(Boolean)
      .slice(0, 2);
    comparePane.innerHTML = items.length ? items.map((sample) => `
      <article class="compare-item">
        ${sample.photo ? `<img src="${sample.photo}" alt="${esc(sample.code)}对比图">` : ""}
        <h3>${esc(sample.code)}</h3>
        <p>${esc(sample.polarization)} · ${esc(sample.minerals || "未记录矿物")}</p>
        <p>${esc(sample.texture || "未记录结构")}</p>
      </article>
    `).join("") : "<p>勾选两张样本卡片后可并排对比；逾期薄片不可参与对比。</p>";
  }

  function renderHistory() {
    const state = Store.getState();
    const now = Date.now();
    const loans = R.pinLoans(state, now);
    historyPane.innerHTML = loans.length ? loans.map((loan) => {
      const sample = state.samples.find((item) => item.id === loan.sampleId);
      const code = sample ? sample.code : "已删除薄片";
      if (loan.returnedAt == null) {
        const overdue = R.isOverdueLoan(loan, now);
        return `
          <div class="history-item${overdue ? " is-overdue" : ""}">
            <p><span class="tag ${overdue ? "tag-danger" : "tag-borrow"}">${overdue ? "逾期未还" : "借出中"}</span> <strong>${esc(code)}</strong></p>
            <p>${esc(loan.borrower)} 借于 ${fmt(loan.borrowedAt)}</p>
            <p>应还 ${fmt(loan.dueAt)}</p>
          </div>`;
      }
      const damage = loan.scratches || loan.chips
        ? ` · 归还破损${loan.scratches ? "（划痕）" : ""}${loan.chips ? "（缺角）" : ""}`
        : "";
      return `
        <div class="history-item">
          <p><span class="tag tag-back">已归还</span> <strong>${esc(code)}</strong></p>
          <p>${esc(loan.borrower)} → 保管人 ${esc(loan.custodian)}</p>
          <p>${fmt(loan.returnedAt)}${damage}</p>
        </div>`;
    }).join("") : "<p>暂无借阅历史。</p>";
  }

  // ---------- 弹出操作：借出 / 归还 / 修复 / 复核 ----------

  function closeModal() {
    modal.classList.remove("open");
    modalAction = null;
  }

  function openModal(title, body, submitText, action) {
    modalTitle.textContent = title;
    modalBody.innerHTML = body;
    modalError.textContent = "";
    modalSubmit.textContent = submitText;
    modalAction = action;
    modalToken = Store.newToken();
    modal.classList.add("open");
  }

  function rejectModal(result) {
    modalError.textContent = result.reason || "操作被拒绝";
  }

  function openBorrow(sampleId) {
    const state = Store.getState();
    const sample = state.samples.find((item) => item.id === sampleId);
    openModal(`借出登记 · ${sample.code}`, `
      <p class="modal-hint">资料齐备且薄片在架、未冻结时方可借出；同一薄片未归还前拒绝再次借出。</p>
      <label>借阅人<input name="borrower" required placeholder="借阅人姓名 / 学号"></label>
    `, "确认借出", (data) => {
      const result = Store.borrow(modalToken, sampleId, data, Date.now());
      if (!result.ok) { rejectModal(result); return; }
      closeModal(); render();
    });
  }

  function openReturn(loanId) {
    const state = Store.getState();
    const loan = state.loans.find((item) => item.id === loanId);
    const sample = state.samples.find((item) => item.id === loan.sampleId);
    openModal(`归还验收 · ${sample.code}`, `
      <p class="modal-hint">归还必须登记保管人与外观状况；勾选划痕或缺角后，薄片只能进入待修。</p>
      <label class="check"><input type="checkbox" name="scratches"> 有划痕</label>
      <label class="check"><input type="checkbox" name="chips"> 有缺角</label>
      <label>破损说明（可选）<textarea name="note" rows="2" placeholder="划痕位置、缺角程度"></textarea></label>
      <label>保管人（接收人）<input name="custodian" required placeholder="验收并保管薄片的人员"></label>
    `, "确认归还", (data) => {
      const result = Store.returnLoan(modalToken, loanId, data, Date.now());
      if (!result.ok) { rejectModal(result); return; }
      closeModal(); render();
    });
  }

  function openRepair(sampleId) {
    const state = Store.getState();
    const sample = state.samples.find((item) => item.id === sampleId);
    openModal(`登记修复 · ${sample.code}`, `
      <p class="modal-hint">登记修复后仍不可借，须由修复人之外的另一人复核才恢复可借。</p>
      <label>修复人<input name="repairer" required placeholder="执行修复的人员"></label>
      <label>修复说明（可选）<textarea name="repairNote" rows="2" placeholder="修复方式与结果"></textarea></label>
    `, "登记修复", (data) => {
      const result = Store.markRepaired(modalToken, sampleId, data, Date.now());
      if (!result.ok) { rejectModal(result); return; }
      closeModal(); render();
    });
  }

  function openReview(sampleId) {
    const state = Store.getState();
    const sample = state.samples.find((item) => item.id === sampleId);
    const repair = R.activeRepairOf(sample);
    openModal(`复核恢复 · ${sample.code}`, `
      <p class="modal-hint">复核人不能是修复本人（${esc(repair.repairedBy)}）；复核通过后薄片恢复可借。</p>
      <label>复核人<input name="reviewer" required placeholder="修复人之外的另一人"></label>
      <label>复核意见（可选）<textarea name="reviewNote" rows="2" placeholder="确认修复结果"></textarea></label>
    `, "复核通过并恢复", (data) => {
      const result = Store.reviewRepair(modalToken, sampleId, data, Date.now());
      if (!result.ok) { rejectModal(result); return; }
      closeModal(); render();
    });
  }

  modalSubmit.addEventListener("click", () => {
    if (!modalAction) return;
    const data = {};
    modalBody.querySelectorAll("[name]").forEach((field) => {
      data[field.name] = field.type === "checkbox" ? field.checked : field.value.trim();
    });
    modalAction(data);
  });

  modalCancel.addEventListener("click", closeModal);
  modal.querySelector(".modal-close").addEventListener("click", closeModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeModal();
  });

  // ---------- 卡片操作 ----------

  sampleGrid.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-borrow], button[data-return], button[data-repair], button[data-review], button[data-freeze], button[data-delete]");
    if (!btn) return;
    const d = btn.dataset;
    if (d.borrow) openBorrow(d.borrow);
    else if (d.return) openReturn(d.return);
    else if (d.repair) openRepair(d.repair);
    else if (d.review) openReview(d.review);
    else if (d.freeze) {
      const st = Store.getState();
      const sample = st.samples.find((item) => item.id === d.freeze);
      Store.setFrozen(d.freeze, !R.describe(sample, st).frozen);
      render();
    } else if (d.delete) {
      Store.deleteSample(d.delete);
      render();
    }
  });

  sampleGrid.addEventListener("change", (event) => {
    const id = event.target.dataset.compare;
    if (!id) return;
    Store.toggleCompare(id, event.target.checked);
    render();
  });

  // ---------- 样本录入 ----------

  function readFileAsDataUrl(file) {
    return new Promise((resolve) => {
      if (!file) return resolve("");
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(reader.result));
      reader.readAsDataURL(file);
    });
  }

  photoInput.addEventListener("change", async () => {
    pendingPhoto = await readFileAsDataUrl(photoInput.files[0]);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    formError.textContent = "";
    const data = new FormData(form);
    if (!pendingPhoto && photoInput.files[0]) {
      pendingPhoto = await readFileAsDataUrl(photoInput.files[0]);
    }
    const payload = {
      photo: pendingPhoto,
      code: data.get("code"),
      location: data.get("location"),
      magnification: data.get("magnification"),
      polarization: data.get("polarization"),
      minerals: data.get("minerals"),
      texture: data.get("texture"),
      comment: data.get("comment")
    };
    // 必填项缺失：拒绝且不写入
    const missing = R.missingFields(payload);
    if (missing.length) {
      formError.textContent = `资料缺项，不能建档：${missing.join("、")}`;
      return;
    }
    const result = Store.submitSample(formToken, payload);
    if (result.duplicate) return; // 重复提交只留首条，静默忽略后续
    // 首条成功后即换令牌，重复提交不会再落盘
    formToken = Store.newToken();
    pendingPhoto = "";
    photoInput.value = "";
    form.reset();
    render();
  });

  [mineralFilter, polarFilter].forEach((field) => field.addEventListener("input", render));

  // 导出观察清单：逾期薄片自动排除
  document.querySelector("#exportBtn").addEventListener("click", () => {
    const checklist = R.eligibleSamples(Store.getState()).map((sample) => ({
      样本编号: sample.code,
      采样地点: sample.location,
      放大倍数: sample.magnification,
      偏光类型: sample.polarization,
      主要矿物: sample.minerals,
      颗粒结构: sample.texture,
      老师批注: sample.comment
    }));
    const blob = new Blob([JSON.stringify(checklist, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "thin-section-checklist.json";
    link.click();
    URL.revokeObjectURL(link.href);
  });

  // 逾期随时间推进：定时刷新，保证置顶/排除无需手动重载
  setInterval(render, 30000);

  render();
})();
