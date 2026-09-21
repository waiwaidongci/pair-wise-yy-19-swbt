/*
 * 借阅规则层：纯逻辑，不碰 DOM、不碰 localStorage。
 * store 在任何写入前必须先过这里的校验，校验失败一律拒绝。
 */
(function (global) {
  "use strict";

  const LOAN_PERIOD_MS = 14 * 24 * 60 * 60 * 1000;

  // 薄片建档时必须齐备的资料项；缺项不得借出
  const REQUIRED_FIELDS = [
    ["code", "样本编号"],
    ["location", "采样地点"],
    ["magnification", "放大倍数"],
    ["polarization", "偏光类型"],
    ["minerals", "主要矿物"],
    ["texture", "颗粒结构"]
  ];

  function toTime(now) {
    if (now instanceof Date) return now.getTime();
    return typeof now === "number" ? now : Date.now();
  }

  function fail(reason) {
    return { ok: false, reason };
  }

  function missingFields(sample) {
    return REQUIRED_FIELDS
      .filter(([key]) => !String(sample[key] == null ? "" : sample[key]).trim())
      .map(([, label]) => label);
  }

  // 同一薄片同一时刻至多一条未归还记录
  function activeLoanOf(state, sampleId) {
    return state.loans.find(
      (loan) => loan.sampleId === sampleId && loan.returnedAt == null
    ) || null;
  }

  function isOverdueLoan(loan, now) {
    return !!loan && loan.returnedAt == null && loan.dueAt < toTime(now);
  }

  // 未走完“修复 -> 另一人复核”的破损单
  function activeRepairOf(sample) {
    return (sample.repairs || []).find((item) => item.reviewedAt == null) || null;
  }

  // 派生薄片当前状态：available / borrowed / overdue / repair
  function describe(sample, state, now) {
    const t = toTime(now);
    const loan = activeLoanOf(state, sample.id);
    return {
      status: activeRepairOf(sample)
        ? "repair"
        : loan
          ? isOverdueLoan(loan, t) ? "overdue" : "borrowed"
          : "available",
      frozen: !!sample.frozen,
      loan,
      overdue: isOverdueLoan(loan, t),
      repair: activeRepairOf(sample),
      missing: missingFields(sample)
    };
  }

  // 借出校验：资料缺项 / 原片冻结 / 待修未复核 / 未归还，任一命中即拒绝
  function validateBorrow(state, sampleId, input, now) {
    const t = toTime(now);
    const sample = state.samples.find((item) => item.id === sampleId);
    if (!sample) return fail("找不到该薄片记录");
    if (!String((input && input.borrower) || "").trim()) return fail("借阅人必须填写");

    const missing = missingFields(sample);
    if (missing.length) return fail(`资料缺项，不能借出：${missing.join("、")}`);
    if (sample.frozen) return fail("原片已冻结，禁止借出");

    const repair = activeRepairOf(sample);
    if (repair) {
      return repair.repairedAt == null
        ? fail("薄片破损待修，修复并经另一人复核后才能借出")
        : fail("修复已登记，等待修复人之外的另一人复核");
    }

    const loan = activeLoanOf(state, sampleId);
    if (loan) {
      return isOverdueLoan(loan, t)
        ? fail(`逾期未还，当前借阅人：${loan.borrower}`)
        : fail(`该薄片尚未归还，当前借阅人：${loan.borrower}`);
    }

    return { ok: true, dueAt: t + LOAN_PERIOD_MS };
  }

  // 归还验收：必须登记保管人，并如实登记划痕、缺角
  function validateReturn(loan, input) {
    if (!loan) return fail("找不到借出记录");
    if (loan.returnedAt != null) return fail("该记录已归还，不能重复验收");
    if (!String((input && input.custodian) || "").trim()) return fail("归还是否接收，必须登记保管人");

    const scratches = !!(input && input.scratches);
    const chips = !!(input && input.chips);
    return { ok: true, scratches, chips, damaged: scratches || chips };
  }

  // 登记修复：仅待修中的薄片、修复人必填
  function validateRepair(sample, input) {
    if (!sample) return fail("找不到该薄片记录");
    const repair = activeRepairOf(sample);
    if (!repair) return fail("该薄片没有待处理的破损登记");
    if (repair.repairedAt != null) return fail("已登记修复，等待另一人复核");
    if (!String((input && input.repairer) || "").trim()) return fail("修复人必须填写");
    return { ok: true, repair };
  }

  // 复核恢复：复核人必须存在，且不能是修复本人
  function validateReview(sample, input) {
    if (!sample) return fail("找不到该薄片记录");
    const repair = activeRepairOf(sample);
    if (!repair) return fail("该薄片没有待复核的修复单");
    if (repair.repairedAt == null) return fail("尚未登记修复，不能复核");
    const reviewer = String((input && input.reviewer) || "").trim();
    if (!reviewer) return fail("复核人必须填写");
    if (reviewer === repair.repairedBy) return fail("复核必须由修复人之外的另一人完成");
    return { ok: true, repair, reviewer };
  }

  // 逾期薄片从对比与导出中排除
  function eligibleSamples(state, now) {
    const t = toTime(now);
    return state.samples.filter(
      (sample) => !isOverdueLoan(activeLoanOf(state, sample.id), t)
    );
  }

  // 看板排序：逾期未还者自动置顶，其余保持原序
  function boardOrder(state, samples, now) {
    const t = toTime(now);
    const rank = (sample) => (isOverdueLoan(activeLoanOf(state, sample.id), t) ? 0 : 1);
    return samples.slice().sort((a, b) => rank(a) - rank(b));
  }

  // 借阅历史排序：逾期未还置顶，其余按最近借/还时间倒序，重载后保持一致
  function pinLoans(state, now) {
    const t = toTime(now);
    const eventTime = (loan) => (loan.returnedAt != null ? loan.returnedAt : loan.borrowedAt);
    return state.loans.slice().sort((a, b) => {
      const ra = isOverdueLoan(a, t) ? 0 : 1;
      const rb = isOverdueLoan(b, t) ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return eventTime(b) - eventTime(a);
    });
  }

  global.SlideRules = {
    LOAN_PERIOD_MS,
    toTime,
    missingFields,
    activeLoanOf,
    activeRepairOf,
    isOverdueLoan,
    describe,
    validateBorrow,
    validateReturn,
    validateRepair,
    validateReview,
    eligibleSamples,
    boardOrder,
    pinLoans
  };
})(window);
