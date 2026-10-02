import { seedState } from '../src/data/seed';
import { planScanIngest, planResolveIssue, refreshFlags, parseScanPacket, recordsHoldingScan, mergesHoldingScan } from '../src/utils/scanHandoff';
import { sampleScanPacket, sampleRescanPacket } from '../src/data/samplePackets';

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
};

const state = seedState();
console.log('初始状态:');
check('登记了 5 件扫描基线', state.scanHandoff.register.length === 5);
check('合并记录 m-006 挂有 2 个扫描件', recordsHoldingScan(state.records, 'SCAN-MS-0034')[0]?.id === 'm-006');
check('合并追溯含 2 个扫描件', mergesHoldingScan(state.merges, 'SCAN-MANU-0033').length === 1);
const a002 = state.records.find((r) => r.id === 'a-002')!;
check('a-002 本机编号已改', a002.identifier === 'MS-WDH-2017-17' && a002.sentIdentifier === 'MS-WDH-17');

const packet = parseScanPacket(sampleScanPacket);
const at = '2026-09-30T10:00:00.000Z';
const plan = planScanIngest(state.scanHandoff, packet, state.records, state.matches, state.merges, at, 'BATCH-X');
console.log('首次导入批次:');
check('未命中重复批次', !plan.reused);
check('挂回 4 件已登记扫描件', plan.matched === 4);
check('SCAN-X-9999 无主', plan.orphanScanIds[0] === 'SCAN-X-9999');
check('SCAN-MS-0042 缺件', plan.missingScanIds[0] === 'SCAN-MS-0042');
const issues = plan.handoff.issues;
check('页数不一致单（SCAN-MS-0034 34→35）', issues.some((i) => i.kind === 'pages' && i.scanId === 'SCAN-MS-0034' && i.localPages === 34 && i.receivedPages === 35));
check('SCAN-MANU-0033 页数单', issues.some((i) => i.kind === 'pages' && i.scanId === 'SCAN-MANU-0033' && i.localPages === 33 && i.receivedPages === 34));
check('SCAN-MANU-0033 指纹单（兄弟单）', issues.some((i) => i.kind === 'fingerprint' && i.scanId === 'SCAN-MANU-0033'));
check('指纹不一致单（SCAN-MANU-0041）', issues.some((i) => i.kind === 'fingerprint' && i.scanId === 'SCAN-MANU-0041'));
check('缺件待补单（SCAN-MS-0042）', issues.some((i) => i.kind === 'missing' && i.scanId === 'SCAN-MS-0042'));
check('无主件单（SCAN-X-9999）', issues.some((i) => i.kind === 'unmatched' && i.scanId === 'SCAN-X-9999'));
check('页数单列出受影响合并记录', issues.find((i) => i.kind === 'pages' && i.scanId === 'SCAN-MS-0034')!.affectedMergeIds[0] === 'merge-seed-m006');
const pagesIssue = issues.find((i) => i.kind === 'pages' && i.scanId === 'SCAN-MS-0034')!;
check('页数单带匹配分数', pagesIssue.matchScore !== null && pagesIssue.matchScore! > 0);

state.scanHandoff = plan.handoff;
state.records = refreshFlags(state);
const m006 = state.records.find((r) => r.id === 'm-006')!;
const a008 = state.records.find((r) => r.id === 'a-008')!;
check('缺件记录 a-008 标记待补', a008.scanFlag === 'awaiting-rescan');
check('合并记录 m-006 标记待处理（结论未动）', m006.scanFlag === 'unresolved' && m006.extent === '33页');
check('原合并字段选择仍保留', state.merges[0].chosen.extent === 'B');

console.log('重复导入同一批次:');
const replan = planScanIngest(state.scanHandoff, packet, state.records, state.matches, state.merges, at, 'BATCH-X');
check('识别为重复并沿用', replan.reused && replan.handoff === state.scanHandoff);
check('未重复立单', replan.handoff.issues.filter((i) => i.batchId === 'BATCH-2026-09-30-01').length === issues.filter((i) => i.batchId === 'BATCH-2026-09-30-01').length);

console.log('处理人对页数单采信扫描组:');
const resolveAt = '2026-09-30T11:00:00.000Z';
const r1 = planResolveIssue(state.scanHandoff, state.records, state.merges, pagesIssue.id, 'scan', resolveAt)!;
check('页数单闭环', r1.handoff.issues.find((i) => i.id === pagesIssue.id)!.status === 'trusted-scan');
state.scanHandoff = r1.handoff; state.records = r1.records; state.merges = r1.merges;
state.records = refreshFlags(state);
const m006b = state.records.find((r) => r.id === 'm-006')!;
check('合并记录上的 SCAN-MS-0034 页数更新为 35', m006b.scanRefs!.find((s) => s.scanId === 'SCAN-MS-0034')!.pages === 35);
check('合并追溯同步更新', state.merges[0].scanRefs!.find((s) => s.scanId === 'SCAN-MS-0034')!.pages === 35);
check('登记基线同步为 35', state.scanHandoff.register.find((s) => s.scanId === 'SCAN-MS-0034')!.pages === 35);
check('字段选择 extent 仍为 B（确认结论不变）', state.merges[0].chosen.extent === 'B' && m006b.extent === '33页');

console.log('兄弟单一并闭环（SCAN-MANU-0033 页数单采信扫描组，指纹单同源闭环）:');
const p33 = state.scanHandoff.issues.find((i) => i.kind === 'pages' && i.scanId === 'SCAN-MANU-0033')!;
const fp33 = state.scanHandoff.issues.find((i) => i.kind === 'fingerprint' && i.scanId === 'SCAN-MANU-0033')!;
const r1b = planResolveIssue(state.scanHandoff, state.records, state.merges, p33.id, 'scan', resolveAt)!;
state.scanHandoff = r1b.handoff; state.records = r1b.records; state.merges = r1b.merges;
check('指纹兄弟单一并按扫描组闭环', r1b.handoff.issues.find((i) => i.id === fp33.id)!.status === 'trusted-scan');
const ref33 = state.records.find((r) => r.id === 'm-006')!.scanRefs!.find((s) => s.scanId === 'SCAN-MANU-0033')!;
check('合并记录上页数与指纹都已同步', ref33.pages === 34 && ref33.fingerprint === 'sha256:62f9e517070ac83b');
check('基线页数与指纹都已同步', state.scanHandoff.register.find((s) => s.scanId === 'SCAN-MANU-0033')!.pages === 34
  && state.scanHandoff.register.find((s) => s.scanId === 'SCAN-MANU-0033')!.fingerprint === 'sha256:62f9e517070ac83b');

console.log('指纹单维持本机:');
const fpIssue = state.scanHandoff.issues.find((i) => i.kind === 'fingerprint' && i.scanId === 'SCAN-MANU-0041')!;
const r2 = planResolveIssue(state.scanHandoff, state.records, state.merges, fpIssue.id, 'local', resolveAt)!;
state.scanHandoff = r2.handoff; state.records = r2.records;
check('指纹单按本机闭环', r2.handoff.issues.find((i) => i.id === fpIssue.id)!.status === 'trusted-local');
check('本机指纹未被改写', state.scanHandoff.register.find((s) => s.scanId === 'SCAN-MANU-0041')!.fingerprint === 'sha256:d24c7f98e310ab56');

console.log('后续全量批次沿用既有处理结果:');
const laterPacket = { batchId: 'BATCH-2026-10-01-FULL', type: 'full' as const, entries: packet.entries };
const p3 = planScanIngest(state.scanHandoff, laterPacket, state.records, state.matches, state.merges, '2026-10-01T10:00:00.000Z', 'BATCH-Y');
const newForKnown = p3.handoff.issues.filter((i) => i.batchId === 'BATCH-2026-10-01-FULL'
  && ['pages', 'fingerprint'].includes(i.kind) && ['SCAN-MS-0034', 'SCAN-MANU-0033', 'SCAN-MANU-0041'].includes(i.scanId));
check('已处理过的同值冲突不重复立单', newForKnown.length === 0);
check('采信扫描组的字段已与基线一致（无需再处理）', state.scanHandoff.register.find((s) => s.scanId === 'SCAN-MS-0034')!.pages === 35
  && state.scanHandoff.register.find((s) => s.scanId === 'SCAN-MANU-0033')!.fingerprint === 'sha256:62f9e517070ac83b');
check('维持本机的同值冲突按旧决策沿用 1 项', p3.batch.reusedDecisions === 1);
state.scanHandoff = p3.handoff; state.records = p3.records; state.merges = p3.merges;

console.log('缺件补传到件:');
const rescan = parseScanPacket(sampleRescanPacket);
const p2 = planScanIngest(state.scanHandoff, rescan, state.records, state.matches, state.merges, '2026-10-02T09:00:00.000Z', 'BATCH-R');
check('补传不重复立缺件单', !p2.handoff.issues.some((i) => i.kind === 'missing' && i.batchId === 'BATCH-2026-10-02-RESCAN'));
const oldMissing = p2.handoff.issues.find((i) => i.kind === 'missing' && i.scanId === 'SCAN-MS-0042')!;
check('旧缺件单自动闭环', oldMissing.status === 'resolved' && /补传/.test(oldMissing.note ?? ''));
state.scanHandoff = p2.handoff; state.records = refreshFlags(state);
check('a-008 待补旗标恢复为已对账', state.records.find((r) => r.id === 'a-008')!.scanFlag === 'ok');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail) process.exit(1);
