import type { ArchiveRecord, ArchiveState, MatchCandidate, MergeResult } from '../types';
import { computeMatches } from '../utils/matching';

const now = new Date().toISOString();

interface ScanSeed {
  scanId: string;
  scanPages: number;
  scanFingerprint: string;
  scanSent: boolean;
}

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
  notes: string,
  scan?: ScanSeed,
  identifierHistory?: string[]
): ArchiveRecord => ({
  id, group, title, date, people, places, identifier, medium, extent, rights, notes,
  updatedAt: now,
  status: 'unreviewed',
  identifierHistory: identifierHistory ?? [],
  ...(scan ? { ...scan } : {})
});

export const seedRecords = (): ArchiveRecord[] => [
  makeRecord('a-001', 'A', '李秀珍口述史访谈', '2019-04-12', ['李秀珍', '周明远'], ['临河县', '河口村'], 'OH-LXZ-2019-01', '数字录音', '02:14:38', '研究者授权', '访谈共三个音频文件'),
  makeRecord('b-001', 'B', '李秀珍女士口述访谈记录', '2019-04-12', ['李秀珍', '周明远'], ['临河县', '河口村'], 'OH-2019-001', '数字音频', '2小时14分', '仅限研究使用', '附件含访谈提纲和照片'),
  // a-002：已登记送扫，本机编号之后被修改（旧编号保留在 identifierHistory），演示“本机编号改过也不能错配”
  makeRecord('a-002', 'A', '渡口船工王德海回忆', '2017-09-03', ['王德海'], ['白沙镇', '老渡口'], 'MS-WDH-2017-REV', '手稿扫描', '18页', '家属授权', '第三页有手写补记；本机编号已于核对后修订', {
    scanId: 'SM-1002', scanPages: 18, scanFingerprint: 'sha256:9f2c41a7e0b34d8c6f19a5d2e7c840b1', scanSent: true
  }, ['MS-WDH-17']),
  makeRecord('b-002', 'B', '王德海口述：渡口与船工生活', '2017-09-03', ['王德海'], ['白沙镇'], 'OH-2017-088', '录音', '01:42:10', '家属授权', '原编号与手稿组共用一个采访批次'),
  makeRecord('a-003', 'A', '张惠兰与县立女子中学', '2020-11-08', ['张惠兰'], ['临河县'], 'OH-ZHL-2020-04', '数字录音', '56分钟', '未签授权文件', '需补充授权确认'),
  makeRecord('b-003', 'B', '张惠兰访谈', '2020-11-08', ['张惠兰'], ['临河县', '县立女子中学'], 'OH-2020-004', '数字录音', '00:56:22', '待补授权', '内容涉及女子中学创建'),
  // a-004：DV 录像的封面与场记单已送扫登记，本批回传缺失 -> 待补
  makeRecord('a-004', 'A', '木版年画艺人陈桂生', '2015-06-21', ['陈桂生'], ['桃花乡'], 'CRAFT-CGS-2015', 'DV录像', '86分钟', 'CC BY-NC 4.0', '记录了套色过程；封面与场记单已送扫', {
    scanId: 'SM-1018', scanPages: 0, scanFingerprint: '', scanSent: true
  }),
  makeRecord('b-004', 'B', '陈桂生师傅年画工艺访谈', '2015-06-22', ['陈桂生', '许小琴'], ['桃花乡'], 'CRAFT-2015-06', '视频', '01:26:04', 'CC BY-NC 4.0', '拍摄日期可能相差一天'),
  makeRecord('a-005', 'A', '赤水河盐运档案访谈（上）', '2018-02-15', ['杨启富'], ['赤水镇'], 'OH-YQF-2018-A', '数字录音', '01:10:00', '研究者授权', ''),
  makeRecord('b-005', 'B', '杨启富谈赤水河盐运', '2018-02-15', ['杨启富'], ['赤水镇', '盐仓'], 'OH-2017-050', '数字录音', '01:10:18', '研究者授权', '元数据人员补充了地点“盐仓”'),
  // a-006 / b-006：已在核对台逐字段合并，合并记录承接扫描登记 SM-1006
  makeRecord('a-006', 'A', '民间中医刘绍安手稿', '1998-12-01', ['刘绍安'], ['安平村'], 'MS-LSA-1998', '纸质手稿', '34页', '公版', '作者去世已满五十年'),
  makeRecord('b-006', 'B', '刘绍安医案抄本', '1998-11-30', ['刘绍安'], ['安平村'], 'MANU-LSA-98', '扫描件', '33页', '公版', '日期按抄本落款录为11月30日'),
  makeRecord('a-007', 'A', '铁路建设者赵春生采访', '2021-07-09', ['赵春生'], ['北岭市'], 'OH-ZCS-2021', '数字录音', '01:03:42', '研究者授权', ''),
  makeRecord('b-007', 'B', '赵春生同志口述', '2021-07-09', ['赵春生'], ['北岭市', '青石岭'], 'OH-2021-071', '数字录音', '01:04:01', '研究者授权', '包含铁路工地地点'),
  makeRecord('a-008', 'A', '女书传人何玉莲唱本', '2013-05-18', ['何玉莲'], ['上江乡'], 'MS-HYL-2013', '手稿影像', '42页', '需联系后人', '缺第12页', {
    scanId: 'SM-1008', scanPages: 42, scanFingerprint: 'sha256:4d910abf772b6e0ac3f15e892d0b4677', scanSent: true
  }),
  makeRecord('b-008', 'B', '何玉莲女书唱本扫描件', '2013-05-18', ['何玉莲'], ['上江乡'], 'MANU-HYL-13', '扫描件', '41页', '联系人待定', '扫描时第12页缺失')
];

/** 预置的合并记录：刘绍安医案（a-006 + b-006 已在核对台逐字段合并，原件已送扫 SM-1006） */
const mergedLiuRecord = (): ArchiveRecord => ({
  id: 'm-liu-001',
  group: 'A',
  title: '民间中医刘绍安医案手稿（合并）',
  date: '1998-12-01',
  people: ['刘绍安'],
  places: ['安平村'],
  identifier: 'MS-LSA-1998',
  medium: '纸质手稿扫描',
  extent: '34页',
  rights: '公版',
  notes: '作者去世已满五十年；日期按抄本落款录为11月30日',
  updatedAt: now,
  status: 'merged',
  scanId: 'SM-1006',
  scanPages: 34,
  scanFingerprint: 'sha256:7b1e55c0a2d34f88b916e0c7d4a3f281',
  scanSent: true,
  identifierHistory: ['MS-LSA-1998', 'MANU-LSA-98']
});

export const seedState = (): ArchiveState => {
  const baseRecords = seedRecords();
  const liu = mergedLiuRecord();

  const merge: MergeResult = {
    id: liu.id,
    matchId: 'match-a-006-b-006',
    leftId: 'a-006',
    rightId: 'b-006',
    chosen: {
      title: 'A', date: 'A', people: 'A', places: 'A', identifier: 'A',
      medium: 'combine', extent: 'A', rights: 'A', notes: 'combine'
    },
    values: {
      title: liu.title,
      date: liu.date,
      people: '刘绍安',
      places: '安平村',
      identifier: liu.identifier,
      medium: '纸质手稿扫描',
      extent: '34页',
      rights: '公版',
      notes: liu.notes
    },
    mergedAt: now
  };

  // 在包含 a-006 / b-006 的完整集合上算分，再模拟合并后的状态迁移：
  // a-006 ↔ b-006 为已合并，与源记录相关的其它候选随合并作废
  const scored = computeMatches([...baseRecords, liu]);
  const matches: MatchCandidate[] = scored.map((candidate) => {
    if (candidate.id === 'match-a-006-b-006') {
      return { ...candidate, id: merge.matchId, status: 'merged' as const, reviewedAt: now };
    }
    if ([candidate.leftId, candidate.rightId].some((id) => id === 'a-006' || id === 'b-006')) {
      return { ...candidate, status: 'rejected' as const, reviewedAt: now };
    }
    return candidate;
  });

  return {
    revision: 1,
    records: [...baseRecords.filter((record) => record.id !== 'a-006' && record.id !== 'b-006'), liu],
    matches,
    merges: [merge],
    audit: [
      { id: 'seed', at: now, action: '初始化数据', detail: '导入两组示例口述史与手稿记录并完成首轮匹配', recordIds: [] },
      { id: 'seed-merge', at: now, action: '合并两条记录', detail: '刘绍安医案：保留 7 个 A 来源字段、2 个字段双来源拼接，扫描登记 SM-1006 沿用合并记录', recordIds: ['a-006', 'b-006', liu.id] }
    ],
    handover: { issues: [], batches: [] },
    activeMatchId: '',
    selectedRecordIds: [],
    hydrated: false
  };
};
