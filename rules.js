/*
 * 借还值守台 —— 借阅规则层
 * 纯函数：只负责判定，不访问 DOM，也不读写 localStorage。
 */
(function (global) {
  "use strict";

  const LOAN_PERIOD_DAYS = 14;

  // 借出时必须齐全的建档资料（资料缺项即拒绝借出）
  const REQUIRED_FIELDS = [
    ["code", "样本编号"],
    ["location", "采样地点"],
    ["magnification", "放大倍数"],
    ["polarization", "偏光类型"],
    ["minerals", "主要矿物"]
  ];

  const STATUS_LABELS = {
    available: "可借",
    incomplete: "资料缺项",
    frozen: "原片冻结",
    out: "借出中",
    overdue: "逾期未还",
    repair: "待修",
    review: "待复核"
  };

  function missingFields(sample) {
    return REQUIRED_FIELDS
      .filter(([key]) => sample[key] === undefined || String(sample[key]).trim() === "")
      .map(([, label]) => label);
  }

  // 当前仍未归还的那一条借阅记录（同一时刻至多一条）
  function activeLoan(loans, sampleId) {
    return loans.find((loan) => loan.sampleId === sampleId && loan.returnedAt === null) || null;
  }

  function latestLoan(loans, sampleId) {
    let hit = null;
    for (const loan of loans) {
      if (loan.sampleId === sampleId && (!hit || loan.borrowedAt > hit.borrowedAt)) {
        hit = loan;
      }
    }
    return hit;
  }

  function isOverdue(loan, now) {
    return loan.returnedAt === null
      && !!loan.dueAt
      && new Date(loan.dueAt).getTime() < now;
  }

  // 由样本档案 + 借阅历史推导当前状态
  function statusOf(sample, loans, now) {
    const at = now || Date.now();
    const active = activeLoan(loans, sample.id);
    if (active) {
      return isOverdue(active, at)
        ? { key: "overdue", label: STATUS_LABELS.overdue, loan: active }
        : { key: "out", label: STATUS_LABELS.out, loan: active };
    }

    const latest = latestLoan(loans, sample.id);
    if (latest && latest.status === "repair") {
      if (!latest.repair) {
        return { key: "repair", label: STATUS_LABELS.repair, loan: latest };
      }
      if (!latest.repair.reviewedBy) {
        return { key: "review", label: STATUS_LABELS.review, loan: latest };
      }
      // 已复核通过，落到下方常规判定
    }

    if (sample.frozen) {
      return { key: "frozen", label: STATUS_LABELS.frozen };
    }

    const missing = missingFields(sample);
    if (missing.length) {
      return { key: "incomplete", label: STATUS_LABELS.incomplete, missing };
    }

    return { key: "available", label: STATUS_LABELS.available };
  }

  // <input type="date"> 的 YYYY-MM-DD 按当天 23:59:59 本地时间解释
  function parseDueAt(value, now) {
    const at = now || Date.now();
    if (typeof value !== "string" || !value.trim()) return null;
    let date;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (match) {
      date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59);
    } else {
      date = new Date(value);
    }
    if (Number.isNaN(date.getTime())) return null;
    if (date.getTime() <= at) return null;
    return date.toISOString();
  }

  function defaultDueDate(now) {
    const d = new Date((now || Date.now()) + LOAN_PERIOD_DAYS * 24 * 60 * 60 * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // 借出判定：未归还 / 资料缺项 / 冻结 / 待修待复核 全部拒绝
  function canBorrow(sample, loans, input, now) {
    const at = now || Date.now();
    const borrower = (input && input.borrower || "").trim();
    if (!borrower) return { allowed: false, reason: "借阅人不能为空" };

    const dueAt = input && input.dueAt;
    if (!dueAt) return { allowed: false, reason: "缺少有效的应还日期" };

    const status = statusOf(sample, loans, at);
    switch (status.key) {
      case "out":
      case "overdue":
        return { allowed: false, reason: "该薄片尚未归还，同一时刻只能一人借阅" };
      case "frozen":
        return { allowed: false, reason: "原片已冻结，暂停借出" };
      case "repair":
        return { allowed: false, reason: "薄片破损待修，修复并经另一人复核前不能借出" };
      case "review":
        return { allowed: false, reason: "修复尚待另一人复核，暂不能借出" };
      case "incomplete":
        return { allowed: false, reason: `资料缺项（${status.missing.join("、")}），补齐后才能借出` };
      default:
        return { allowed: true };
    }
  }

  // 归还判定：必须存在未还记录，且必须登记保管人
  function canReturn(loans, sampleId, input) {
    const loan = activeLoan(loans, sampleId);
    if (!loan) return { allowed: false, reason: "该薄片当前没有未归还的借阅记录" };
    const custodian = (input && input.custodian || "").trim();
    if (!custodian) return { allowed: false, reason: "归还必须登记保管人" };
    return { allowed: true, loan };
  }

  function canRepair(loans, sampleId, input) {
    const status = latestLoan(loans, sampleId);
    if (!status || status.status !== "repair" || status.repair) {
      return { allowed: false, reason: "只有待修且尚未登记修复的薄片需要修复登记" };
    }
    const repairedBy = (input && input.repairedBy || "").trim();
    if (!repairedBy) return { allowed: false, reason: "修复人不能为空" };
    return { allowed: true, loan: status };
  }

  // 复核人必须是修复人之外的另一人
  function canReview(loans, sampleId, input) {
    const loan = latestLoan(loans, sampleId);
    if (!loan || loan.status !== "repair" || !loan.repair || loan.repair.reviewedBy) {
      return { allowed: false, reason: "该薄片没有待复核的修复登记" };
    }
    const reviewedBy = (input && input.reviewedBy || "").trim();
    if (!reviewedBy) return { allowed: false, reason: "复核人不能为空" };
    if (reviewedBy === loan.repair.repairedBy) {
      return { allowed: false, reason: "复核人必须是修复人之外的另一人" };
    }
    return { allowed: true, loan };
  }

  // 逾期未还置顶：逾期在借出中之前，其余按最近事件时间倒序
  function sortLoans(loans, now) {
    const at = now || Date.now();
    return loans
      .map((loan, index) => ({ loan, index }))
      .sort((a, b) => {
        const rankOf = (entry) => {
          if (entry.loan.returnedAt === null) {
            return isOverdue(entry.loan, at) ? 0 : 1;
          }
          return 2;
        };
        const rankDiff = rankOf(a) - rankOf(b);
        if (rankDiff !== 0) return rankDiff;
        const timeOf = (entry) => {
          const repair = entry.loan.repair;
          const t = repair && repair.reviewedAt || entry.loan.returnedAt || entry.loan.borrowedAt;
          return new Date(t).getTime();
        };
        const timeDiff = timeOf(b) - timeOf(a);
        return timeDiff !== 0 ? timeDiff : a.index - b.index;
      })
      .map((entry) => entry.loan);
  }

  // 逾期未还的样本从对比与导出中排除
  function compareEligible(sample, loans, now) {
    return statusOf(sample, loans, now || Date.now()).key !== "overdue";
  }

  global.SlideRules = {
    LOAN_PERIOD_DAYS,
    REQUIRED_FIELDS,
    STATUS_LABELS,
    missingFields,
    activeLoan,
    latestLoan,
    isOverdue,
    statusOf,
    parseDueAt,
    defaultDueDate,
    canBorrow,
    canReturn,
    canRepair,
    canReview,
    sortLoans,
    compareEligible
  };
})(window);
