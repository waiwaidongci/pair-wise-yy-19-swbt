/*
 * 借还值守台 —— 数据落盘层
 * 负责 localStorage 读写、业务动作的状态变更与幂等；不访问 DOM。
 * 被拒绝的动作不写入任何状态；重复提交（同一 token）只保留首条结果。
 */
(function (global) {
  "use strict";

  const storageKey = "wxyy-2-thin-section-index";
  const { SlideRules: rules } = global;

  const state = loadState();

  function loadState() {
    let parsed;
    try {
      parsed = JSON.parse(localStorage.getItem(storageKey) || "null");
    } catch (error) {
      parsed = null;
    }
    return {
      samples: (parsed && Array.isArray(parsed.samples) && parsed.samples) || [],
      loans: (parsed && Array.isArray(parsed.loans) && parsed.loans) || [],
      compare: (parsed && Array.isArray(parsed.compare) && parsed.compare) || [],
      commandTokens: (parsed && Array.isArray(parsed.commandTokens) && parsed.commandTokens) || []
    };
  }

  function save() {
    localStorage.setItem(storageKey, JSON.stringify(state));
  }

  function findSample(sampleId) {
    return state.samples.find((sample) => sample.id === sampleId) || null;
  }

  function getState() {
    return state;
  }

  /*
   * 所有写操作走 runOnce：
   * - 同一 token 的重复提交直接回放首次结果，不重复写入
   * - mutator 返回 reject 时不触碰状态
   */
  function runOnce(token, mutator) {
    if (token && state.commandTokens.includes(token)) {
      return { ok: true, duplicate: true };
    }
    const result = mutator();
    if (result && result.reject) {
      return { ok: false, reason: result.reject };
    }
    if (token) state.commandTokens.push(token);
    save();
    return { ok: true, duplicate: false, data: result || null };
  }

  function addSample(input, token) {
    return runOnce(token, () => {
      const code = (input.code || "").trim();
      if (!code) return { reject: "样本编号不能为空" };
      if (state.samples.some((sample) => sample.code === code)) {
        return { reject: `样本编号 ${code} 已存在` };
      }
      const sample = {
        id: input.id || crypto.randomUUID(),
        photo: input.photo || "",
        code,
        location: (input.location || "").trim(),
        magnification: (input.magnification || "").trim(),
        polarization: input.polarization || "",
        minerals: (input.minerals || "").trim(),
        texture: (input.texture || "").trim(),
        comment: (input.comment || "").trim(),
        frozen: false,
        createdAt: new Date().toISOString()
      };
      state.samples.unshift(sample);
      return { sample };
    });
  }

  function deleteSample(sampleId, token) {
    return runOnce(token, () => {
      const sample = findSample(sampleId);
      if (!sample) return { reject: "样本不存在" };
      state.samples = state.samples.filter((item) => item.id !== sampleId);
      state.loans = state.loans.filter((loan) => loan.sampleId !== sampleId);
      state.compare = state.compare.filter((id) => id !== sampleId);
      return { sampleId };
    });
  }

  function toggleFreeze(sampleId, token) {
    return runOnce(token, () => {
      const sample = findSample(sampleId);
      if (!sample) return { reject: "样本不存在" };
      if (rules.activeLoan(state.loans, sampleId)) {
        return { reject: "薄片尚未归还，不能改变冻结状态" };
      }
      sample.frozen = !sample.frozen;
      return { sampleId, frozen: sample.frozen };
    });
  }

  function borrow(input, token) {
    return runOnce(token, () => {
      const sample = findSample(input.sampleId);
      if (!sample) return { reject: "样本不存在" };

      // YYYY-MM-DD 表单输入按当日末尾解析并要求晚于现在；已是 ISO 串直接采信
      const isDateInput = typeof input.dueAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.dueAt.trim());
      const dueAt = isDateInput ? rules.parseDueAt(input.dueAt, Date.now()) : input.dueAt;
      const decision = rules.canBorrow(
        sample,
        state.loans,
        { borrower: input.borrower, dueAt },
        Date.now()
      );
      if (!decision.allowed) return { reject: decision.reason };

      const loan = {
        id: crypto.randomUUID(),
        sampleId: sample.id,
        borrower: input.borrower.trim(),
        purpose: (input.purpose || "").trim(),
        borrowedAt: new Date().toISOString(),
        dueAt,
        returnedAt: null,
        status: "open",
        custodian: "",
        damage: null,
        repair: null
      };
      state.loans.unshift(loan);
      return { loan };
    });
  }

  function returnLoan(input, token) {
    return runOnce(token, () => {
      const sample = findSample(input.sampleId);
      if (!sample) return { reject: "样本不存在" };

      const decision = rules.canReturn(state.loans, input.sampleId, input);
      if (!decision.allowed) return { reject: decision.reason };

      const loan = decision.loan;
      const damage = {
        scratches: !!input.scratches,
        cornerMissing: !!input.cornerMissing,
        note: (input.damageNote || "").trim()
      };
      const damaged = damage.scratches || damage.cornerMissing;

      loan.returnedAt = new Date().toISOString();
      loan.custodian = input.custodian.trim();
      loan.damage = damage;
      loan.status = damaged ? "repair" : "returned";
      if (damaged) {
        loan.repair = null; // 破损未修复 → 待修
      }

      // 已逾期的样本在归还后可重新进入对比
      pruneCompare();
      return { loan, damaged };
    });
  }

  function registerRepair(input, token) {
    return runOnce(token, () => {
      const sample = findSample(input.sampleId);
      if (!sample) return { reject: "样本不存在" };

      const decision = rules.canRepair(state.loans, input.sampleId, input);
      if (!decision.allowed) return { reject: decision.reason };

      decision.loan.repair = {
        repairedBy: input.repairedBy.trim(),
        repairedAt: new Date().toISOString(),
        note: (input.repairNote || "").trim(),
        reviewedBy: "",
        reviewedAt: null,
        reviewNote: ""
      };
      // status 维持 "repair"，待另一人复核后才恢复可借
      return { loan: decision.loan };
    });
  }

  function reviewRepair(input, token) {
    return runOnce(token, () => {
      const sample = findSample(input.sampleId);
      if (!sample) return { reject: "样本不存在" };

      const decision = rules.canReview(state.loans, input.sampleId, input);
      if (!decision.allowed) return { reject: decision.reason };

      const { loan } = decision;
      loan.repair.reviewedBy = input.reviewedBy.trim();
      loan.repair.reviewedAt = new Date().toISOString();
      loan.repair.reviewNote = (input.reviewNote || "").trim();
      loan.status = "repaired"; // 复核通过 → 恢复可借
      pruneCompare();
      return { loan };
    });
  }

  // 对比清单中出现不再合规（当前为逾期未还）的样本时剔除
  function pruneCompare(now) {
    state.compare = state.compare.filter((id) => {
      const sample = findSample(id);
      return sample && rules.compareEligible(sample, state.loans, now || Date.now());
    });
  }

  function setCompare(sampleId, checked) {
    if (checked) {
      if (!findSample(sampleId)) return { ok: false };
      if (!rules.compareEligible(findSample(sampleId), state.loans, Date.now())) {
        return { ok: false, reason: "逾期未还的样本已从对比中排除" };
      }
      state.compare = [sampleId, ...state.compare.filter((id) => id !== sampleId)].slice(0, 2);
    } else {
      state.compare = state.compare.filter((id) => id !== sampleId);
    }
    save();
    return { ok: true };
  }

  function exportableSamples(now) {
    return state.samples.filter((sample) => rules.compareEligible(sample, state.loans, now || Date.now()));
  }

  // 页面加载时先清理一次，保证重载后状态一致
  pruneCompare();
  save();

  global.SlideStore = {
    getState,
    findSample,
    addSample,
    deleteSample,
    toggleFreeze,
    borrow,
    returnLoan,
    registerRepair,
    reviewRepair,
    setCompare,
    pruneCompare,
    exportableSamples
  };
})(window);
