// 借还值守台规则/落盘冒烟测试（Node 模拟浏览器环境）
const assert = require("assert");

const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};
global.crypto = { randomUUID: () => "u" + (++uid) };
let uid = 0;
global.window = global;

const now = new Date("2026-09-21T09:00:00.000Z").getTime();
const RealDate = Date;
class MockDate extends RealDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(now);
  }
  static now() { return now; }
}
MockDate.UTC = RealDate.UTC;
global.Date = MockDate;

require("./rules.js");
require("./store.js");
const R = global.window.SlideRules;
const S = global.window.SlideStore;

let pass = 0;
function ok(name, cond) { assert.ok(cond, name); console.log("  ✓", name); pass++; }
function eq(name, a, b) { assert.strictEqual(a, b, `${name}: ${a} !== ${b}`); console.log("  ✓", name); pass++; }

// 1. 建档：资料完整与资料缺项
let r = S.addSample({
  code: "BX-001", location: "东侧第二层", magnification: "40x",
  polarization: "单偏光", minerals: "石英", texture: "粒状"
});
ok("完整样本建档成功", r.ok);
const completeId = r.data.sample.id;

r = S.addSample({ code: "BX-002" });
ok("缺项样本也可建档", r.ok);
const incompleteId = r.data.sample.id;
eq("缺项样本状态为 incomplete", R.statusOf(S.findSample(incompleteId), S.getState().loans, now).key, "incomplete");

// 2. 资料缺项拒绝借出，且不写入
const beforeBorrowCount = S.getState().loans.length;
r = S.borrow({ sampleId: incompleteId, borrower: "张三", dueAt: R.parseDueAt(R.defaultDueDate(), now) }, "t-incomplete");
ok("资料缺项借出被拒", !r.ok);
eq("拒绝原因包含资料缺项", /资料缺项/.test(r.reason), true);
eq("被拒不产生借阅记录", S.getState().loans.length, beforeBorrowCount);

// 3. 正常借出
const futureDue = R.parseDueAt(R.defaultDueDate(), now);
r = S.borrow({ sampleId: completeId, borrower: "张三", dueAt: futureDue }, "t-borrow-1");
ok("可借样本借出成功", r.ok);
eq("借出后状态 out", R.statusOf(S.findSample(completeId), S.getState().loans, now).key, "out");

// 4. 同一时刻仅一人：再次借出拒绝
r = S.borrow({ sampleId: completeId, borrower: "李四", dueAt: futureDue }, "t-borrow-2");
ok("未归还时再次借出被拒", !r.ok);
eq("再次借出拒绝原因", /尚未归还/.test(r.reason), true);

// 5. 冻结拒绝（需先无活动借阅）
r = S.toggleFreeze(incompleteId, "t-freeze");
ok("无活动借阅可冻结", r.ok);
r = S.borrow({ sampleId: incompleteId, borrower: "王五", dueAt: futureDue }, "t-borrow-frozen");
ok("冻结样本借出被拒", !r.ok && /冻结/.test(r.reason));
r = S.toggleFreeze(incompleteId, "t-unfreeze");
ok("解冻成功", r.ok && r.data.frozen === false);

// 6. 重复提交只留首条（同一 token）
r = S.borrow({ sampleId: completeId, borrower: "李四", dueAt: futureDue }, "t-borrow-1");
ok("同 token 重复提交返回 duplicate", r.ok && r.duplicate === true);

// 7. 归还无保管人拒绝
r = S.returnLoan({ sampleId: completeId, custodian: "  ", scratches: false, cornerMissing: false }, "t-ret-nocust");
ok("无保管人归还被拒", !r.ok && /保管人/.test(r.reason));

// 8. 完好归还
r = S.returnLoan({ sampleId: completeId, custodian: "赵保管", scratches: false, cornerMissing: false }, "t-ret-ok");
ok("登记保管人归还成功", r.ok && r.data.damaged === false);
eq("完好归还后恢复 available", R.statusOf(S.findSample(completeId), S.getState().loans, now).key, "available");

// 9. 破损归还 → 待修
r = S.borrow({ sampleId: completeId, borrower: "张三", dueAt: futureDue }, "t-borrow-3");
r = S.returnLoan({ sampleId: completeId, custodian: "赵保管", scratches: true, cornerMissing: false, damageNote: "中部划痕" }, "t-ret-damaged");
ok("划痕归还标记 damaged", r.ok && r.data.damaged === true);
eq("破损后状态 repair", R.statusOf(S.findSample(completeId), S.getState().loans, now).key, "repair");
r = S.borrow({ sampleId: completeId, borrower: "李四", dueAt: futureDue }, "t-borrow-repair");
ok("待修状态借出被拒", !r.ok && /待修|复核/.test(r.reason));

// 10. 修复须另一人复核
r = S.registerRepair({ sampleId: completeId, repairedBy: "钱修复" }, "t-repair");
ok("登记修复成功", r.ok);
eq("登记后状态 review", R.statusOf(S.findSample(completeId), S.getState().loans, now).key, "review");
r = S.reviewRepair({ sampleId: completeId, reviewedBy: "钱修复" }, "t-review-self");
ok("复核人=修复人被拒", !r.ok && /另一人/.test(r.reason));
r = S.reviewRepair({ sampleId: completeId, reviewedBy: "孙复核" }, "t-review-ok");
ok("另一人复核通过", r.ok);
eq("复核后恢复 available", R.statusOf(S.findSample(completeId), S.getState().loans, now).key, "available");

// 11. 逾期置顶 + 排除对比/导出
r = S.addSample({ code: "BX-003", location: "西", magnification: "10x", polarization: "反射光", minerals: "长石" });
const overdueId = r.data.sample.id;
const pastDue = new RealDate("2026-09-20T23:59:59+08:00").toISOString(); // 昨天到期
r = S.borrow({ sampleId: overdueId, borrower: "周七", dueAt: pastDue }, "t-borrow-overdue");
ok("历史借阅登记成功(模拟过去到期)", r.ok);
const later = now + 2 * 24 * 3600 * 1000;
eq("到期未还判定逾期", R.statusOf(S.findSample(overdueId), S.getState().loans, later).key, "overdue");
ok("逾期样本不可进入对比", R.compareEligible(S.findSample(overdueId), S.getState().loans, later) === false);
ok("逾期样本不可加入对比集合", S.setCompare(overdueId, true).ok === false);

// 建一个正常借出样本验证排序
r = S.addSample({ code: "BX-004", location: "北", magnification: "10x", polarization: "单偏光", minerals: "云母" });
const outId = r.data.sample.id;
S.borrow({ sampleId: outId, borrower: "吴八", dueAt: R.parseDueAt("2026-10-01", now) }, "t-borrow-out");

const sorted = R.sortLoans(S.getState().loans, later);
eq("排序首位为逾期记录", sorted[0].sampleId, overdueId);
ok("逾期记录排在普通借出前", sorted.findIndex((l) => l.sampleId === overdueId) < sorted.findIndex((l) => l.sampleId === outId));

const exportIds = S.exportableSamples(later).map((s) => s.id);
ok("导出排除逾期样本", !exportIds.includes(overdueId));
ok("导出含正常样本", exportIds.includes(completeId));

// 逾期归还后重新可对比
const overdueLoan = S.getState().loans.find((l) => l.sampleId === overdueId && l.returnedAt === null);
S.returnLoan({ sampleId: overdueId, custodian: "赵保管", scratches: false, cornerMissing: false }, "t-ret-overdue");
ok("逾期归还后恢复对比资格", R.compareEligible(S.findSample(overdueId), S.getState().loans, later) === true);

// 12. 重载一致性：落盘内容重新加载
const raw = JSON.parse(localStorage.getItem("wxyy-2-thin-section-index"));
ok("状态已落盘(loans)", Array.isArray(raw.loans) && raw.loans.length === sorted.length);
ok("幂等 token 已落盘", raw.commandTokens.includes("t-borrow-1"));

console.log(`\n${pass} 项断言全部通过`);
