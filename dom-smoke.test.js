// 用极简 DOM 桩加载 app.js，验证渲染路径不抛异常并覆盖各状态模板
const fs = require("fs");

const listeners = {};
function makeEl() {
  const el = {
    innerHTML: "", textContent: "", value: "", checked: false, hidden: true,
    files: [], dataset: {}, classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    closest: () => null,
    reset() {}, showModal() {}, close() {}
  };
  return el;
}
const els = {};
global.document = {
  querySelector(sel) {
    const key = sel.replace(/[^a-zA-Z]/g, "").toLowerCase();
    return els[key] || (els[key] = makeEl());
  }
};
global.window = global;
global.URL = { createObjectURL: () => "blob:x", revokeObjectURL() {} };
global.Blob = class {};

const store0 = new Map();
global.localStorage = {
  getItem: (k) => (store0.has(k) ? store0.get(k) : null),
  setItem: (k, v) => store0.set(k, String(v))
};
let uid = 0;
global.crypto = { randomUUID: () => "u" + (++uid) };

// 预置覆盖全部状态的数据
const nowIso = new Date().toISOString();
const past = new Date(Date.now() - 86400000).toISOString();
const future = new Date(Date.now() + 14 * 86400000).toISOString();
function sample(id, extra) {
  return Object.assign({
    id, code: id, location: "loc", magnification: "40x", polarization: "单偏光",
    minerals: "石英", texture: "", comment: "", photo: "", frozen: false, createdAt: nowIso
  }, extra || {});
}
const loans = [
  { id: "l1", sampleId: "s1", borrower: "甲", borrowedAt: nowIso, dueAt: past, returnedAt: null, status: "open", custodian: "", damage: null, repair: null },
  { id: "l2", sampleId: "s2", borrower: "乙", borrowedAt: nowIso, dueAt: future, returnedAt: null, status: "open", custodian: "", damage: null, repair: null },
  { id: "l3", sampleId: "s3", borrower: "丙", borrowedAt: nowIso, dueAt: future, returnedAt: nowIso, status: "repair", custodian: "赵", damage: { scratches: true, cornerMissing: true, note: "缺角" }, repair: null },
  { id: "l4", sampleId: "s4", borrower: "丁", borrowedAt: nowIso, dueAt: future, returnedAt: nowIso, status: "repair", custodian: "赵", damage: { scratches: true, cornerMissing: false, note: "" }, repair: { repairedBy: "钱", repairedAt: nowIso, reviewedBy: "", reviewedAt: null, reviewNote: "" } },
  { id: "l5", sampleId: "s5", borrower: "戊", borrowedAt: nowIso, dueAt: future, returnedAt: nowIso, status: "repaired", custodian: "赵", damage: { scratches: false, cornerMissing: false, note: "" }, repair: { repairedBy: "钱", repairedAt: nowIso, reviewedBy: "孙", reviewedAt: nowIso, reviewNote: "ok" } },
  { id: "l6", sampleId: "s6", borrower: "己", borrowedAt: nowIso, dueAt: future, returnedAt: nowIso, status: "returned", custodian: "赵", damage: { scratches: false, cornerMissing: false, note: "" }, repair: null }
];
store0.set("wxyy-2-thin-section-index", JSON.stringify({
  samples: [
    sample("s1"), sample("s2"), sample("s3"), sample("s4"), sample("s5"), sample("s6"),
    sample("s7", { frozen: true }),
    sample("s8", { location: "", minerals: "" })
  ],
  loans,
  compare: ["s5"],
  commandTokens: []
}));

require("./rules.js");
require("./store.js");

// 捕获 app.js 末尾 render() 的执行
fs.readFileSync("./app.js", "utf8"); // 确认可读
require("./app.js");
console.log("app.js 初始 render 在所有状态模板下未抛异常");

// 检查卡片渲染产物包含逾期高亮与全部徽标
const grid = els.samplegrid;
if (!grid || !grid.innerHTML.includes("is-overdue")) throw new Error("逾期置顶高亮缺失");
for (const badge of ["badge-overdue", "badge-out", "badge-repair", "badge-review", "badge-available", "badge-frozen", "badge-incomplete"]) {
  if (!grid.innerHTML.includes(badge)) throw new Error("缺少徽标 " + badge);
}
const log = els.loanlog;
for (const text of ["逾期未还", "借出中", "待修", "修复待复核", "已修复归还", "已归还", "划痕", "缺角"]) {
  if (!log.innerHTML.includes(text)) throw new Error("值守记录缺少 " + text);
}
console.log("卡片徽标、逾期置顶、值守记录模板渲染完整");
