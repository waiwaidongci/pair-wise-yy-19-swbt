/*
 * 借还值守台 —— 页面操作层
 * 只负责渲染与交互；规则判定在 SlideRules，落盘与幂等在 SlideStore。
 */
(function () {
  "use strict";

  const rules = window.SlideRules;
  const store = window.SlideStore;

  const form = document.querySelector("#sampleForm");
  const photoInput = document.querySelector("#photoInput");
  const sampleGrid = document.querySelector("#sampleGrid");
  const comparePane = document.querySelector("#comparePane");
  const loanLog = document.querySelector("#loanLog");
  const mineralFilter = document.querySelector("#mineralFilter");
  const polarFilter = document.querySelector("#polarFilter");

  const dialog = document.querySelector("#actionDialog");
  const actionForm = document.querySelector("#actionForm");
  const actionTitle = document.querySelector("#actionTitle");
  const actionTarget = document.querySelector("#actionTarget");
  const actionFields = document.querySelector("#actionFields");
  const actionMessage = document.querySelector("#actionMessage");
  const actionSubmit = document.querySelector("#actionSubmit");
  const actionCancel = document.querySelector("#actionCancel");

  let pendingPhoto = "";
  let currentAction = null;
  let toastTimer = null;

  /* ---------- 工具 ---------- */

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function pad2(num) {
    return String(num).padStart(2, "0");
  }

  // 2026-09-21 14:05
  function formatDateTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  // 09-21（应还日期只取日期部分）
  function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function showToast(message, isError) {
    const toast = document.querySelector("#toast");
    toast.textContent = message;
    toast.classList.toggle("error", !!isError);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 2600);
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve) => {
      if (!file) return resolve("");
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(reader.result));
      reader.readAsDataURL(file);
    });
  }

  /* ---------- 渲染：样本卡片 ---------- */

  function visibleSamples(now) {
    const mineral = mineralFilter.value.trim();
    const polarization = polarFilter.value;
    const { samples, loans } = store.getState();

    const rows = samples
      .map((sample) => ({ sample, status: rules.statusOf(sample, loans, now) }))
      .filter(({ sample }) => {
        const mineralMatch = !mineral || (sample.minerals || "").includes(mineral);
        const polarMatch = !polarization || sample.polarization === polarization;
        return mineralMatch && polarMatch;
      });

    // 逾期未还自动置顶，其次其余借出中，其余按建档时间
    const rank = (status) => (status.key === "overdue" ? 0 : status.key === "out" ? 1 : 2);
    return rows.sort((a, b) => {
      const diff = rank(a.status) - rank(b.status);
      if (diff !== 0) return diff;
      return b.sample.createdAt.localeCompare(a.sample.createdAt);
    });
  }

  function actionButton(action, label, tone) {
    return `<button type="button" class="act ${tone || ""}" data-action="${action}">${label}</button>`;
  }

  function cardActions(sample, status, eligible) {
    const btns = [];
    switch (status.key) {
      case "available":
        btns.push(actionButton("borrow", "借出", "primary"));
        break;
      case "out":
      case "overdue":
        btns.push(actionButton("return", "归还登记", "primary"));
        break;
      case "repair":
        btns.push(actionButton("repair", "登记修复", "primary"));
        break;
      case "review":
        btns.push(actionButton("review", "复核修复", "primary"));
        break;
      default:
        break;
    }
    btns.push(`<button type="button" class="act ghost" data-action="freeze">${sample.frozen ? "解冻" : "冻结"}</button>`);
    btns.push(`<button type="button" class="act ghost danger" data-action="delete">删除</button>`);

    const compare = eligible
      ? `<label class="compare-toggle"><input type="checkbox" data-compare="${sample.id}" ${store.getState().compare.includes(sample.id) ? "checked" : ""}>对比</label>`
      : `<label class="compare-toggle disabled" title="逾期未还，已从对比与导出中排除"><input type="checkbox" disabled>对比</label>`;

    return `<div class="card-actions"><div class="act-row">${btns.join("")}</div>${compare}</div>`;
  }

  function statusLine(status) {
    const loan = status.loan;
    if (status.key === "out" && loan) {
      return `<p class="loan-line">借用人：${escapeHtml(loan.borrower)} · 应还 ${formatDate(loan.dueAt)}</p>`;
    }
    if (status.key === "overdue" && loan) {
      return `<p class="loan-line alert">借用人：${escapeHtml(loan.borrower)} · 应还 ${formatDate(loan.dueAt)}（已逾期）</p>`;
    }
    if (status.key === "repair") {
      return `<p class="loan-line alert">破损未修复，待修中</p>`;
    }
    if (status.key === "review" && loan && loan.repair) {
      return `<p class="loan-line">修复人：${escapeHtml(loan.repair.repairedBy)} · 待另一人复核</p>`;
    }
    if (status.key === "frozen") {
      return `<p class="loan-line">原片冻结，暂停借出</p>`;
    }
    if (status.key === "incomplete") {
      return `<p class="loan-line alert">资料缺项：${escapeHtml(status.missing.join("、"))}</p>`;
    }
    return `<p class="loan-line">在架，可借出</p>`;
  }

  function renderSamples(now) {
    const rows = visibleSamples(now);
    sampleGrid.innerHTML = rows.length ? rows.map(({ sample, status }) => {
      const eligible = rules.compareEligible(sample, store.getState().loans, now);
      return `
      <article class="sample-card ${status.key === "overdue" ? "is-overdue" : ""}" data-id="${sample.id}">
        ${sample.photo ? `<img src="${sample.photo}" alt="${escapeHtml(sample.code)}显微照片">` : '<div class="photo-placeholder"></div>'}
        <div class="sample-body">
          <div class="card-head">
            <h3>${escapeHtml(sample.code)}</h3>
            <span class="badge badge-${status.key}">${status.label}</span>
          </div>
          <p>${escapeHtml(sample.location || "未记录地点")} · ${escapeHtml(sample.magnification || "未记录倍数")} · ${escapeHtml(sample.polarization)}</p>
          <p>矿物：${escapeHtml(sample.minerals || "未记录")}</p>
          <p>结构：${escapeHtml(sample.texture || "未记录")}</p>
          ${statusLine(status)}
          ${cardActions(sample, status, eligible)}
        </div>
      </article>`;
    }).join("") : "<p>还没有样本，先从左侧录入一张薄片档案。</p>";
  }

  /* ---------- 渲染：对比栏 ---------- */

  function renderCompare() {
    const { samples, compare, loans } = store.getState();
    const compareSamples = compare
      .map((id) => samples.find((sample) => sample.id === id))
      .filter(Boolean)
      .slice(0, 2);

    comparePane.innerHTML = compareSamples.length ? compareSamples.map((sample) => `
      <article class="compare-item">
        ${sample.photo ? `<img src="${sample.photo}" alt="${escapeHtml(sample.code)}对比图">` : ""}
        <h3>${escapeHtml(sample.code)}</h3>
        <p>${escapeHtml(sample.polarization)} · ${escapeHtml(sample.minerals || "未记录矿物")}</p>
        <p>${escapeHtml(sample.texture || "未记录结构")}</p>
      </article>
    `).join("") : "<p>勾选两张样本卡片后可并排对比。逾期未还样本自动排除。</p>";
  }

  /* ---------- 渲染：值守记录（逾期置顶） ---------- */

  function loanTag(loan, now) {
    if (loan.returnedAt === null) {
      return rules.isOverdue(loan, now)
        ? '<span class="badge badge-overdue">逾期未还</span>'
        : '<span class="badge badge-out">借出中</span>';
    }
    if (loan.status === "repair") {
      return loan.repair
        ? '<span class="badge badge-review">修复待复核</span>'
        : '<span class="badge badge-repair">待修</span>';
    }
    if (loan.status === "repaired") return '<span class="badge badge-available">已修复归还</span>';
    return '<span class="badge badge-returned">已归还</span>';
  }

  function damageText(loan) {
    if (!loan.damage) return "";
    const marks = [];
    if (loan.damage.scratches) marks.push("划痕");
    if (loan.damage.cornerMissing) marks.push("缺角");
    const parts = [`破损：${marks.length ? marks.join("、") : "无"}`];
    if (loan.damage.note) parts.push(escapeHtml(loan.damage.note));
    return `<p class="log-sub alert">${parts.join(" · ")}</p>`;
  }

  function renderLog(now) {
    const { samples, loans } = store.getState();
    const rows = rules.sortLoans(loans, now);

    loanLog.innerHTML = rows.length ? rows.map((loan) => {
      const sample = samples.find((item) => item.id === loan.sampleId);
      const code = sample ? sample.code : "样本已删除";
      const overdue = rules.isOverdue(loan, now);
      const detail = loan.returnedAt
        ? `${formatDateTime(loan.borrowedAt)} 借出 → ${formatDateTime(loan.returnedAt)} 归还 · 保管人 ${escapeHtml(loan.custodian)}`
        : `${formatDateTime(loan.borrowedAt)} 借出 · 应还 ${formatDateTime(loan.dueAt)} · 借阅人 ${escapeHtml(loan.borrower)}`;
      const repairLine = loan.repair
        ? `<p class="log-sub">修复 ${escapeHtml(loan.repair.repairedBy)}${loan.repair.reviewedBy ? ` · 复核 ${escapeHtml(loan.repair.reviewedBy)}` : " · 待另一人复核"}</p>`
        : "";
      return `
      <li class="loan-item ${overdue ? "is-overdue" : ""}">
        <div class="log-head"><strong>${escapeHtml(code)}</strong>${loanTag(loan, now)}</div>
        <p class="log-sub">${detail}</p>
        ${damageText(loan)}
        ${repairLine}
      </li>`;
    }).join("") : "<li class=\"log-empty\">暂无借阅记录。</li>";
  }

  function render() {
    const now = Date.now();
    renderSamples(now);
    renderCompare();
    renderLog(now);
  }

  /* ---------- 建档 ---------- */

  photoInput.addEventListener("change", async () => {
    pendingPhoto = await readFileAsDataUrl(photoInput.files[0]);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    if (!pendingPhoto && photoInput.files[0]) {
      pendingPhoto = await readFileAsDataUrl(photoInput.files[0]);
    }
    const submitter = event.submitter;
    const result = store.addSample({
      photo: pendingPhoto,
      code: data.get("code"),
      location: data.get("location"),
      magnification: data.get("magnification"),
      polarization: data.get("polarization"),
      minerals: data.get("minerals"),
      texture: data.get("texture"),
      comment: data.get("comment")
    }, `sample:${Date.now()}:${crypto.randomUUID()}`);

    if (result.ok) {
      pendingPhoto = "";
      photoInput.value = "";
      form.reset();
      showToast("样本档案已保存");
      render();
    } else {
      showToast(result.reason, true);
    }
  });

  /* ---------- 借 / 还 / 修 / 复核 弹窗 ---------- */

  const ACTIONS = {
    borrow: {
      title: "借出登记",
      submit: "确认借出",
      fields: (sample) => `
        <label>借阅人<input name="borrower" required placeholder="借用人姓名"></label>
        <label>应还日期<input name="dueAt" type="date" required value="${rules.defaultDueDate()}"></label>
        <label>借阅用途<input name="purpose" placeholder="镜下复核 / 教学展示"></label>
        <p class="field-hint">同一薄片同一时刻仅一人可借；未归还、资料缺项或原片冻结时拒绝借出。</p>`,
      token: (sampleId) => `borrow:${sampleId}:${crypto.randomUUID()}`,
      run: (sampleId, data, token) => store.borrow({
        sampleId,
        borrower: data.get("borrower"),
        dueAt: data.get("dueAt"),
        purpose: data.get("purpose")
      }, token)
    },
    return: {
      title: "归还登记",
      submit: "确认归还",
      fields: () => `
        <label class="check"><input type="checkbox" name="scratches"> 发现划痕</label>
        <label class="check"><input type="checkbox" name="cornerMissing"> 发现缺角</label>
        <label>破损说明<input name="damageNote" placeholder="划痕位置 / 缺角情况"></label>
        <label>保管人<input name="custodian" required placeholder="接收归还的保管人"></label>
        <p class="field-hint">必须登记保管人；存在划痕或缺角时，薄片只能进入待修，修复经另一人复核后才可再借。</p>`,
      token: (sampleId) => `return:${sampleId}:${crypto.randomUUID()}`,
      run: (sampleId, data, token) => store.returnLoan({
        sampleId,
        scratches: data.get("scratches") === "on",
        cornerMissing: data.get("cornerMissing") === "on",
        damageNote: data.get("damageNote"),
        custodian: data.get("custodian")
      }, token)
    },
    repair: {
      title: "修复登记",
      submit: "提交修复",
      fields: () => `
        <label>修复人<input name="repairedBy" required placeholder="实施修复的人员"></label>
        <label>修复说明<input name="repairNote" placeholder="封片树脂重固 / 边缘打磨"></label>
        <p class="field-hint">登记后进入待复核，须由修复人之外的另一人复核通过，薄片才恢复可借。</p>`,
      token: (sampleId) => `repair:${sampleId}:${crypto.randomUUID()}`,
      run: (sampleId, data, token) => store.registerRepair({
        sampleId,
        repairedBy: data.get("repairedBy"),
        repairNote: data.get("repairNote")
      }, token)
    },
    review: {
      title: "修复复核",
      submit: "复核通过",
      fields: (sample, status) => `
        <p class="field-hint">修复人：${escapeHtml(status.loan.repair.repairedBy)}。复核人必须是另一个人。</p>
        <label>复核人<input name="reviewedBy" required placeholder="与修复人不同的复核人"></label>
        <label>复核意见<input name="reviewNote" placeholder="封片牢固、透光正常"></label>`,
      token: (sampleId) => `review:${sampleId}:${crypto.randomUUID()}`,
      run: (sampleId, data, token) => store.reviewRepair({
        sampleId,
        reviewedBy: data.get("reviewedBy"),
        reviewNote: data.get("reviewNote")
      }, token)
    }
  };

  function openAction(actionKey, sample) {
    const action = ACTIONS[actionKey];
    const status = rules.statusOf(sample, store.getState().loans, Date.now());
    // token 在弹窗打开时生成一次：重复提交回放首条；被拒后 token 未落盘，可改正重试
    currentAction = { action, sampleId: sample.id, token: action.token(sample.id) };
    actionTitle.textContent = action.title;
    actionTarget.textContent = `薄片编号：${sample.code}`;
    actionFields.innerHTML = action.fields(sample, status);
    actionMessage.hidden = true;
    actionMessage.textContent = "";
    actionSubmit.textContent = action.submit;
    dialog.showModal();
  }

  function closeAction() {
    dialog.close();
    currentAction = null;
  }

  actionCancel.addEventListener("click", closeAction);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeAction();
  });

  actionForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!currentAction) return;
    const data = new FormData(actionForm);
    const result = currentAction.action.run(currentAction.sampleId, data, currentAction.token);
    if (result.ok) {
      closeAction();
      showToast(result.duplicate ? "重复提交已忽略，只保留首条记录" : "操作已登记");
      render();
    } else {
      actionMessage.textContent = result.reason;
      actionMessage.hidden = false;
    }
  });

  /* ---------- 卡片事件委托 ---------- */

  sampleGrid.addEventListener("click", (event) => {
    const actionKey = event.target.dataset && event.target.dataset.action;
    const card = event.target.closest(".sample-card");
    if (!card) return;
    const sampleId = card.dataset.id;
    const sample = store.findSample(sampleId);
    if (!sample) return;

    if (!actionKey) return;

    if (actionKey === "delete") {
      const result = store.deleteSample(sampleId, `delete:${sampleId}:${Date.now()}`);
      if (result.ok) {
        showToast("样本及借阅记录已删除");
        render();
      } else {
        showToast(result.reason, true);
      }
      return;
    }
    if (actionKey === "freeze") {
      // token 绑定起始状态：同一状态上的重复点击视为重复提交，不反向抵消
      const result = store.toggleFreeze(sampleId, `freeze:${sampleId}:${sample.frozen}`);
      if (result.ok) {
        showToast(result.data.frozen ? "原片已冻结" : "原片已解冻");
        render();
      } else {
        showToast(result.reason, true);
      }
      return;
    }
    if (ACTIONS[actionKey]) openAction(actionKey, sample);
  });

  sampleGrid.addEventListener("change", (event) => {
    const id = event.target.dataset.compare;
    if (!id) return;
    const result = store.setCompare(id, event.target.checked);
    if (!result.ok) {
      event.target.checked = false;
      showToast(result.reason || "该样本当前不能加入对比", true);
    }
    render();
  });

  [mineralFilter, polarFilter].forEach((field) => field.addEventListener("input", render));

  /* ---------- 导出（排除逾期未还） ---------- */

  document.querySelector("#exportBtn").addEventListener("click", () => {
    const checklist = store.exportableSamples(Date.now()).map((sample) => ({
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
    showToast(`已导出 ${checklist.length} 条在架样本（逾期未还已排除）`);
  });

  render();
})();
