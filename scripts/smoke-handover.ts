import assert from 'node:assert';
import { seedState } from '../src/data/seed';
import type { ScanReturnPackage } from '../src/types';
import {
  batchEntryForIssue, packageHash, parseReturnPackage, pendingIssueCount,
  reconcilePackage, resolveEntry, trustLocalRecord, trustScanReturn, acknowledgeMissing, bindScanToRecord
} from '../src/utils/handover';

const state = seedState();
const issues0 = pendingIssueCount(state);
assert.equal(issues0, 0, '初始无待处理项');
assert.equal(state.records.find((r) => r.id === 'a-002')?.identifier, 'MS-WDH-2017-REV');

// 1) 稳定编号挂回：a-002 本机编号已改，回传仍写旧编号 MS-WDH-17
const entry1002 = { scanId: 'SM-1002', pages: 18, fingerprint: 'sha256:9f2c41a7e0b34d8c6f19a5d2e7c840b1', ref: 'MS-WDH-17' };
const resolved1002 = resolveEntry(entry1002, state);
assert.equal(resolved1002.record?.id, 'a-002', '稳定编号必须挂回 a-002（编号已改）');
assert.equal(resolved1002.confidence, 100);
assert.equal(resolved1002.refState, 'stale', '回传旧编号应识别为 stale');

// 2) 完整示例包对账
const pkg: ScanReturnPackage = {
  batchId: 'B-1',
  entries: [
    entry1002,
    { scanId: 'SM-1006', pages: 35, fingerprint: 'sha256:8c2f60d1e9a447bc7024f1d8a6e5b392', ref: 'MANU-LSA-98' },
    { scanId: 'SM-1008', pages: 41, fingerprint: 'sha256:4d910abf772b6e0ac3f15e892d0b4677', ref: 'MANU-HYL-13' },
    { scanId: 'SM-2099', pages: 12, fingerprint: 'sha256:1e7a33bc95f04d2e8d6c1f4a9b08e277', ref: 'OH-UNKNOWN-999' }
  ]
};
const result = reconcilePackage(state, pkg);
assert.equal(result.reused, false);
assert.equal(result.attached, 1, '仅 SM-1002 一致挂回');
const pending = state.handover.issues.filter((i) => i.status === 'pending');
const kinds = pending.map((i) => i.kind).sort();
assert.deepEqual(kinds, ['fingerprint-mismatch', 'missing-return', 'pages-mismatch', 'pages-mismatch', 'unmatched-scan']);

// 3) 合并记录受影响：SM-1006 的指纹问题指向合并记录
const fp1006 = pending.find((i) => i.scanId === 'SM-1006')!;
assert.equal(fp1006.mergedRecordId, 'm-liu-001');
assert.equal(fp1006.mergedRecordTitle, '民间中医刘绍安医案手稿（合并）');
assert.equal(fp1006.confidence, 100);

// SM-1008 页数问题挂到 a-008（未合并）
const pg1008 = pending.find((i) => i.scanId === 'SM-1008')!;
assert.equal(pg1008.recordId, 'a-008');
assert.equal(pg1008.kind, 'pages-mismatch');

// 4) 缺件待补：SM-1018 未回传，原结论保留
const missing = pending.find((i) => i.kind === 'missing-return' && i.scanId === 'SM-1018')!;
assert.ok(missing);
const a004 = state.records.find((r) => r.id === 'a-004')!;
assert.equal(a004.scanPendingSupplement, true);

// 5) 采用回传值：SM-1008 页数 -> 合并记录/普通记录同步更新（这里是普通记录）
trustScanReturn(state, pg1008, batchEntryForIssue(state, pg1008));
const a008 = state.records.find((r) => r.id === 'a-008')!;
assert.equal(a008.scanPages, 41);
assert.equal(a008.extent, '41页');
assert.equal(pg1008.status, 'resolved');

// 6) 采用回传值处理合并记录的指纹：scanFingerprint 更新，原合并字段选择不动
const chosenBefore = JSON.stringify(state.merges[0].chosen);
trustScanReturn(state, fp1006, batchEntryForIssue(state, fp1006));
const liu = state.records.find((r) => r.id === 'm-liu-001')!;
assert.equal(liu.scanFingerprint, 'sha256:8c2f60d1e9a447bc7024f1d8a6e5b392');
assert.equal(JSON.stringify(state.merges[0].chosen), chosenBefore, '字段选择不得被对账改动');

// 7) 页数若发生在合并记录上，合并 values 与 overrides 一起更新：构造新批次 SM-1006 页数 33
const pkg2: ScanReturnPackage = {
  batchId: 'B-2',
  entries: [{ scanId: 'SM-1006', pages: 33, fingerprint: 'sha256:8c2f60d1e9a447bc7024f1d8a6e5b392' }]
};
const r2 = reconcilePackage(state, pkg2);
const pagesLiu = r2.issues.find((i) => i.kind === 'pages-mismatch' && i.scanId === 'SM-1006')!;
trustScanReturn(state, pagesLiu, batchEntryForIssue(state, pagesLiu));
assert.equal(state.records.find((r) => r.id === 'm-liu-001')?.extent, '33页');
const merge = state.merges[0];
assert.equal(merge.values.extent, '33页');
assert.equal((merge.scanOverrides ?? []).length, 1);
assert.equal(merge.scanOverrides![0].field, 'extent');

// 8) 保留本机 -> 退回重扫
const orphan = state.handover.issues.find((i) => i.kind === 'unmatched-scan' && i.status === 'pending')!;
// 先给孤儿绑定到 a-001（无 scanId 的记录）
assert.ok(bindScanToRecord(state, orphan, 'a-001', batchEntryForIssue(state, orphan)));
assert.equal(state.records.find((r) => r.id === 'a-001')?.scanId, 'SM-2099');

// 缺件确认待补
acknowledgeMissing(state, missing);
assert.equal(missing.status, 'acknowledged');
assert.equal(state.records.find((r) => r.id === 'a-004')?.scanPendingSupplement, true);

// 9) 重复导入幂等：同 batchId
const beforeIssues = state.handover.issues.length;
const reused1 = reconcilePackage(state, pkg);
assert.equal(reused1.reused, true);
assert.equal(reused1.reusedBatchId, 'B-1');
assert.equal(state.handover.issues.length, beforeIssues, '重复批次不得新增待处理项');
// 改 batchId 但内容相同 -> 仍按内容指纹识别为重复
const pkgRenamed: ScanReturnPackage = { batchId: 'B-1-COPY', entries: pkg.entries.map((e) => ({ ...e })) };
const reused2 = reconcilePackage(state, pkgRenamed);
assert.equal(reused2.reused, true);
assert.equal(reused2.reusedBatchId, 'B-1');
assert.equal(packageHash(pkg), packageHash(pkgRenamed));
// 同一条扫描件新批次回传：旧 pending 被 superseded，不重复挂账（SM-1008 页数恢复一致 41）
const r3 = reconcilePackage(state, { batchId: 'B-3', entries: [{ scanId: 'SM-1008', pages: 41, fingerprint: 'sha256:4d910abf772b6e0ac3f15e892d0b4677' }] });
assert.equal(r3.attached, 1);
assert.equal(r3.issues.length, 0);

// 10) 解析校验
assert.ok(parseReturnPackage('{bad').error);
assert.ok(parseReturnPackage('{"entries":[]}').error);
assert.ok(parseReturnPackage('{"entries":[{"scanId":"X","pages":"abc","fingerprint":"f"}]}').error);
const parsed = parseReturnPackage('{"batchId":"z","entries":[{"scanId":"X","pages":3,"fingerprint":"f"}]}');
assert.equal(parsed.pkg?.batchId, 'z');

// 11) 本机登记可信路径
const trustLocalIssue = state.handover.issues.find((i) => i.kind === 'pages-mismatch' && i.status === 'resolved');
assert.ok(trustLocalIssue);
// 构造一个待处理的页数分歧验证 trustLocalRecord
reconcilePackage(state, { batchId: 'B-4', entries: [{ scanId: 'SM-1002', pages: 99, fingerprint: 'sha256:9f2c41a7e0b34d8c6f19a5d2e7c840b1' }] });
const localIssue = state.handover.issues.find((i) => i.kind === 'pages-mismatch' && i.scanId === 'SM-1002' && i.status === 'pending')!;
assert.ok(localIssue);
trustLocalRecord(state, localIssue);
assert.equal(localIssue.status, 'dismissed');
assert.equal(state.records.find((r) => r.id === 'a-002')?.scanPages, 18, '保留本机页数');
assert.equal(state.records.find((r) => r.id === 'a-002')?.scanPendingSupplement, true);

// 12) 同扫描件同类型 pending 问题被新批次同类回传取代：SM-1002 两次页数分歧
// localIssue 在第 11 步已被 dismissed；新建一个仍 pending 的同类问题验证取代
const freshState = seedState();
reconcilePackage(freshState, { batchId: 'F-1', entries: [{ ...entry1002, pages: 20 }] });
const freshPending = freshState.handover.issues.find((i) => i.kind === 'pages-mismatch' && i.scanId === 'SM-1002' && i.status === 'pending')!;
assert.ok(freshPending);
reconcilePackage(freshState, { batchId: 'F-2', entries: [{ ...entry1002, pages: 21 }] });
assert.equal(freshPending.status, 'superseded', '同类型旧待处理项应被新批次取代');
const freshNew = freshState.handover.issues.find(
  (i) => i.kind === 'pages-mismatch' && i.scanId === 'SM-1002' && i.status === 'pending' && i.batchId === 'F-2')!;
assert.ok(freshNew, '新批次应产生新待处理项');
// 一致值回传：挂回且不再产生待处理项
reconcilePackage(freshState, { batchId: 'F-3', entries: [entry1002] });
assert.equal(freshState.records.find((r) => r.id === 'a-002')?.scanAttached, true, '一致回传应挂回');

// 13) 缺件在后续批次回传后：旧缺件项关闭，且不再产生新缺件项
const sm1018Missing = state.handover.issues.filter((i) => i.kind === 'missing-return' && i.scanId === 'SM-1018');
const pending1018Before = sm1018Missing.filter((i) => i.status === 'pending' || i.status === 'acknowledged');
assert.equal(pending1018Before.length, 1, 'SM-1018 此前仅有一个生效中的缺件项');
reconcilePackage(state, {
  batchId: 'B-6',
  entries: [{ scanId: 'SM-1018', pages: 6, fingerprint: 'sha256:5d0b22f1a0c4e9a18d77c3f260ae9104' }]
});
assert.equal(pending1018Before[0].status, 'superseded', '回传到位后缺件项应关闭');
assert.equal(state.records.find((r) => r.id === 'a-004')?.scanAttached, true);
assert.equal(state.records.find((r) => r.id === 'a-004')?.scanPendingSupplement, false);
const stillMissing1018 = state.handover.issues.filter(
  (i) => i.kind === 'missing-return' && i.scanId === 'SM-1018' && i.status === 'pending').length;
assert.equal(stillMissing1018, 0, '不应重复产生缺件项');

console.log('ALL HANDSHAKE SMOKE TESTS PASSED');
console.log('issues:', state.handover.issues.length, 'batches:', state.handover.batches.map((b) => b.batchId).join(','));
