/*
 * 数据落盘层：读写 localStorage。
 * 所有写操作统一走 commit：先过规则校验（拒绝即不写入），
 * 再查重提交令牌（同一提交只留首条，后续静默忽略）。
 */
(function (global) {
  "use strict";

  const R = global.SlideRules;
  const storageKey = "wxyy-2-thin-section-index";

  function blankState() {
    return { samples: [], loans: [], repairs: [], compare: [], tokens: [] };
  }

  function loadState() {
    let raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(storageKey) || "null");
    } catch (error) {
      raw = null;
    }
    const state = Object.assign(blankState(), raw || {});
    // 旧版本（索引台）数据迁移：补齐借还值守台所需字段
    if (!Array.isArray(state.loans)) state.loans = [];
    if (!Array.isArray(state.tokens)) state.tokens = [];
    if (!Array.isArray(state.compare)) state.compare = [];
    state.samples.forEach((sample) => {
      if (!Array.isArray(sample.repairs)) sample.repairs = [];
      sample.frozen = !!sample.frozen;
    });
    reconcileCompare(state);
    return state;
  }

  function persist() {
    localStorage.setItem(storageKey, JSON.stringify(state));
  }

  let state = loadState();

  function getState() {
    return state;
  }

  // 逾期薄片自动从对比名单剔除
  function reconcileCompare(scope, now) {
    const allowed = R.eligibleSamples(scope, now).map((sample) => sample.id);
    scope.compare = scope.compare.filter((id) => allowed.includes(id)).slice(0, 2);
  }

  // 统一提交通道：ruleResult.ok 为假则拒绝且不写入；重复令牌只保留首条
  function commit(token, validation, apply) {
    if (!validation.ok) return validation;
    if (token) {
      if (state.tokens.includes(token)) {
        return { ok: true, duplicate: true };
      }
      state.tokens.push(token);
    }
    const result = apply() || {};
    reconcileCompare(state);
    persist();
    return Object.assign({ ok: true }, result);
  }

  function newToken() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }
    return `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  // 建档
  function submitSample(token, data) {
    const sample = {
      id: newToken(),
      photo: data.photo || "",
      code: String(data.code || "").trim(),
      location: String(data.location || "").trim(),
      magnification: String(data.magnification || "").trim(),
      polarization: data.polarization || "",
      minerals: String(data.minerals || "").trim(),
      texture: String(data.texture || "").trim(),
      comment: String(data.comment || "").trim(),
      frozen: false,
      repairs: [],
      createdAt: new Date().toISOString()
    };
    return commit(token, { ok: true }, () => {
      state.samples.unshift(sample);
      return { sample };
    });
  }

  // 借出
  function borrow(token, sampleId, input, now) {
    const check = R.validateBorrow(state, sampleId, input, now);
    return commit(token, check, () => {
      const loan = {
        id: newToken(),
        sampleId,
        borrower: input.borrower.trim(),
        borrowedAt: R.toTime(now),
        dueAt: check.dueAt,
        returnedAt: null
      };
      state.loans.push(loan);
      return { loan };
    });
  }

  // 归还：破损未修复只能进入待修
  function returnLoan(token, loanId, input, now) {
    const loan = state.loans.find((item) => item.id === loanId);
    const check = R.validateReturn(loan, input);
    return commit(token, check, () => {
      const t = R.toTime(now);
      loan.returnedAt = t;
      loan.custodian = input.custodian.trim();
      loan.scratches = check.scratches;
      loan.chips = check.chips;
      loan.damageNote = String(input.note || "").trim();

      let repair = null;
      if (check.damaged) {
        const sample = state.samples.find((item) => item.id === loan.sampleId);
        repair = {
          id: newToken(),
          sampleId: sample.id,
          loanId: loan.id,
          scratches: check.scratches,
          chips: check.chips,
          note: loan.damageNote,
          reportedBy: loan.custodian,
          reportedAt: t,
          repairedAt: null,
          repairedBy: "",
          repairNote: "",
          reviewedAt: null,
          reviewedBy: ""
        };
        sample.repairs.push(repair);
      }
      return { loan, repair };
    });
  }

  // 登记修复
  function markRepaired(token, sampleId, input, now) {
    const sample = state.samples.find((item) => item.id === sampleId);
    const check = R.validateRepair(sample, input);
    return commit(token, check, () => {
      check.repair.repairedAt = R.toTime(now);
      check.repair.repairedBy = input.repairer.trim();
      check.repair.repairNote = String(input.repairNote || "").trim();
      return { repair: check.repair };
    });
  }

  // 另一人复核后恢复可借
  function reviewRepair(token, sampleId, input, now) {
    const sample = state.samples.find((item) => item.id === sampleId);
    const check = R.validateReview(sample, input);
    return commit(token, check, () => {
      check.repair.reviewedAt = R.toTime(now);
      check.repair.reviewedBy = check.reviewer;
      check.repair.reviewNote = String(input.reviewNote || "").trim();
      return { repair: check.repair };
    });
  }

  function toggleCompare(id, checked) {
    if (checked) {
      if (!R.eligibleSamples(state).some((sample) => sample.id === id)) return state;
      state.compare = [id, ...state.compare.filter((item) => item !== id)].slice(0, 2);
    } else {
      state.compare = state.compare.filter((item) => item !== id);
    }
    persist();
    return state;
  }

  function deleteSample(id) {
    state.samples = state.samples.filter((sample) => sample.id !== id);
    state.compare = state.compare.filter((item) => item !== id);
    persist();
    return state;
  }

  function setFrozen(id, frozen) {
    const sample = state.samples.find((item) => item.id === id);
    if (sample) {
      sample.frozen = !!frozen;
      persist();
    }
    return state;
  }

  global.SlideStore = {
    getState,
    persist,
    reconcileCompare: () => {
      reconcileCompare(state);
      persist();
    },
    newToken,
    submitSample,
    borrow,
    returnLoan,
    markRepaired,
    reviewRepair,
    toggleCompare,
    deleteSample,
    setFrozen
  };
})(window);
