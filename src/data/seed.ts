import type { ArchiveRecord, ArchiveState, MergeResult, ScanRef } from '../types';
import { computeMatches } from '../utils/matching';
import { buildBaselines, combineScanRefs, emptyScanHandoff } from '../utils/scanHandoff';

const now = new Date().toISOString();
const tick = (minutes: number) => new Date(Date.parse(now) + minutes * 60000).toISOString();

/** 本机登记的扫描件指纹（模拟移交档案室时的本地基线） */
const FP = {
  a002: 'sha256:7c41e0a2d9b84f31',
  a006: 'sha256:3f92ab7106dc5e2c',
  b006: 'sha256:51e8d4069bc72fa1',
  a008: 'sha256:8a0d6f13ce57b904',
  b008: 'sha256:d24c7f98e310ab56'
} as const;

const scan = (scanId: string, pages: number | null, fingerprint: string): ScanRef[] => [{ scanId, pages, fingerprint }];

const makeRecord = (
  id: string,
  group: 'A' | 'B',
  title: string,
  date: string,
  people: string[],
  places: string[],
  identifier: string,
  medium: string,
  extent: string,
  rights: string,
  notes: string
): ArchiveRecord => ({
  id, group, title, date, people, places, identifier, medium, extent, rights, notes,
  updatedAt: now,
  status: 'unreviewed'
});

export const seedRecords = (): ArchiveRecord[] => [
  makeRecord('a-001', 'A', '李秀珍口述史访谈', '2019-04-12', ['李秀珍', '周明远'], ['临河县', '河口村'], 'OH-LXZ-2019-01', '数字录音', '02:14:38', '研究者授权', '访谈共三个音频文件'),
  makeRecord('b-001', 'B', '李秀珍女士口述访谈记录', '2019-04-12', ['李秀珍', '周明远'], ['临河县', '河口村'], 'OH-2019-001', '数字音频', '2小时14分', '仅限研究使用', '附件含访谈提纲和照片'),
  {
    ...makeRecord('a-002', 'A', '渡口船工王德海回忆', '2017-09-03', ['王德海'], ['白沙镇', '老渡口'], 'MS-WDH-2017-17', '手稿扫描', '18页', '家属授权', '第三页有手写补记'),
    // 本机编号在移交后被修改过，但扫描件仍按稳定编号 SCAN-MS-0017 挂回，不会错配
    sentIdentifier: 'MS-WDH-17',
    identifierHistory: [{ from: 'MS-WDH-17', to: 'MS-WDH-2017-17', at: tick(2), reason: '编号规则调整，补全年份段' }],
    scanRefs: scan('SCAN-MS-0017', 18, FP.a002),
    scanFlag: 'ok'
  },
  makeRecord('b-002', 'B', '王德海口述：渡口与船工生活', '2017-09-03', ['王德海'], ['白沙镇'], 'OH-2017-088', '录音', '01:42:10', '家属授权', '原编号与手稿组共用一个采访批次'),
  makeRecord('a-003', 'A', '张惠兰与县立女子中学', '2020-11-08', ['张惠兰'], ['临河县'], 'OH-ZHL-2020-04', '数字录音', '56分钟', '未签授权文件', '需补充授权确认'),
  makeRecord('b-003', 'B', '张惠兰访谈', '2020-11-08', ['张惠兰'], ['临河县', '县立女子中学'], 'OH-2020-004', '数字录音', '00:56:22', '待补授权', '内容涉及女子中学创建'),
  makeRecord('a-004', 'A', '木版年画艺人陈桂生', '2015-06-21', ['陈桂生'], ['桃花乡'], 'CRAFT-CGS-2015', 'DV录像', '86分钟', 'CC BY-NC 4.0', '记录了套色过程'),
  makeRecord('b-004', 'B', '陈桂生师傅年画工艺访谈', '2015-06-22', ['陈桂生', '许小琴'], ['桃花乡'], 'CRAFT-2015-06', '视频', '01:26:04', 'CC BY-NC 4.0', '拍摄日期可能相差一天'),
  makeRecord('a-005', 'A', '赤水河盐运档案访谈（上）', '2018-02-15', ['杨启富'], ['赤水镇'], 'OH-YQF-2018-A', '数字录音', '01:10:00', '研究者授权', ''),
  makeRecord('b-005', 'B', '杨启富谈赤水河盐运', '2018-02-15', ['杨启富'], ['赤水镇', '盐仓'], 'OH-2018-050', '数字录音', '01:10:18', '研究者授权', '元数据人员补充了地点“盐仓”'),
  {
    ...makeRecord('a-006', 'A', '民间中医刘绍安手稿', '1998-12-01', ['刘绍安'], ['安平村'], 'MS-LSA-1998', '纸质手稿', '34页', '公版', '作者去世已满五十年'),
    sentIdentifier: 'MS-LSA-1998',
    scanRefs: scan('SCAN-MS-0034', 34, FP.a006),
    scanFlag: 'ok'
  },
  {
    ...makeRecord('b-006', 'B', '刘绍安医案抄本', '1998-11-30', ['刘绍安'], ['安平村'], 'MANU-LSA-98', '扫描件', '33页', '公版', '日期按抄本落款录为11月30日'),
    sentIdentifier: 'MANU-LSA-98',
    scanRefs: scan('SCAN-MANU-0033', 33, FP.b006),
    scanFlag: 'ok'
  },
  makeRecord('a-007', 'A', '铁路建设者赵春生采访', '2021-07-09', ['赵春生'], ['北岭市'], 'OH-ZCS-2021', '数字录音', '01:03:42', '研究者授权', ''),
  makeRecord('b-007', 'B', '赵春生同志口述', '2021-07-09', ['赵春生'], ['北岭市', '青石岭'], 'OH-2021-071', '数字录音', '01:04:01', '研究者授权', '包含铁路工地地点'),
  {
    ...makeRecord('a-008', 'A', '女书传人何玉莲唱本', '2013-05-18', ['何玉莲'], ['上江乡'], 'MS-HYL-2013', '手稿影像', '42页', '需联系后人', '缺第12页'),
    sentIdentifier: 'MS-HYL-2013',
    scanRefs: scan('SCAN-MS-0042', 42, FP.a008),
    scanFlag: 'ok'
  },
  {
    ...makeRecord('b-008', 'B', '何玉莲女书唱本扫描件', '2013-05-18', ['何玉莲'], ['上江乡'], 'MANU-HYL-13', '扫描件', '41页', '联系人待定', '扫描时第12页缺失'),
    sentIdentifier: 'MANU-HYL-13',
    scanRefs: scan('SCAN-MANU-0041', 41, FP.b008),
    scanFlag: 'ok'
  }
];

export const seedState = (): ArchiveState => {
  const all = seedRecords();
  const matches = computeMatches(all);
  const left = all.find((record) => record.id === 'a-006')!;
  const right = all.find((record) => record.id === 'b-006')!;

  // 预置一条已完成的字段合并：刘绍安手稿 / 医案抄本
  const chosen = {
    title: 'A', date: 'A', people: 'A', places: 'A', identifier: 'A',
    medium: 'B', extent: 'B', rights: 'A', notes: 'combine'
  } as MergeResult['chosen'];
  const values: MergeResult['values'] = {
    title: '民间中医刘绍安手稿',
    date: '1998-12-01',
    people: '刘绍安',
    places: '安平村',
    identifier: 'MS-LSA-1998',
    medium: '扫描件',
    extent: '33页',
    rights: '公版',
    notes: '作者去世已满五十年；日期按抄本落款录为11月30日'
  };
  const merged: ArchiveRecord = {
    ...left,
    ...values,
    id: 'm-006',
    people: ['刘绍安'],
    places: ['安平村'],
    sentIdentifier: 'MS-LSA-1998',
    scanRefs: combineScanRefs(left, right),
    status: 'merged',
    updatedAt: tick(3)
  };
  const records = [...all.filter((record) => record.id !== left.id && record.id !== right.id), merged];

  matches.forEach((item) => {
    if (item.id === `match-${left.id}-${right.id}`) item.status = 'merged';
    else if ([item.leftId, item.rightId].includes(left.id) || [item.leftId, item.rightId].includes(right.id)) item.status = 'rejected';
  });

  const merges: MergeResult[] = [{
    id: 'merge-seed-m006',
    matchId: `match-${left.id}-${right.id}`,
    leftId: left.id,
    rightId: right.id,
    chosen,
    values,
    mergedAt: tick(3),
    mergedRecordId: merged.id,
    scanRefs: combineScanRefs(left, right)
  }];

  const register = buildBaselines([
    { scanId: 'SCAN-MS-0017', pages: 18, fingerprint: FP.a002, record: all.find((record) => record.id === 'a-002')! },
    { scanId: 'SCAN-MS-0034', pages: 34, fingerprint: FP.a006, record: left },
    { scanId: 'SCAN-MANU-0033', pages: 33, fingerprint: FP.b006, record: right },
    { scanId: 'SCAN-MS-0042', pages: 42, fingerprint: FP.a008, record: all.find((record) => record.id === 'a-008')! },
    { scanId: 'SCAN-MANU-0041', pages: 41, fingerprint: FP.b008, record: all.find((record) => record.id === 'b-008')! }
  ]);

  const audit = [
    { id: 'seed', at: tick(0), action: '初始化数据', detail: '导入两组示例口述史与手稿记录并完成首轮匹配', recordIds: [] },
    { id: 'scan-register', at: tick(1), action: '登记扫描移交基线', detail: `将 ${register.length} 件扫描件按稳定编号移交扫描组，保存送出时编号、页数与文件指纹`, recordIds: register.map((item) => item.recordId) },
    { id: 'id-rewrite-a002', at: tick(2), action: '修改本机编号', detail: '编号规则调整，补全年份段；扫描件仍按稳定编号挂回', recordIds: ['a-002'], before: 'MS-WDH-17', after: 'MS-WDH-2017-17' },
    { id: 'merge-seed-audit', at: tick(3), action: '合并两条记录', detail: '刘绍安手稿与医案抄本逐字段合并，扫描件 SCAN-MS-0034 / SCAN-MANU-0033 一并挂到合并记录', recordIds: [left.id, right.id, merged.id] }
  ].reverse();

  return {
    revision: 1,
    records,
    matches,
    merges,
    audit,
    activeMatchId: '',
    selectedRecordIds: [],
    hydrated: false,
    scanHandoff: { ...emptyScanHandoff(), register }
  };
};
