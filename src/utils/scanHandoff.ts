import type {
  ArchiveRecord, ArchiveState, MatchCandidate, MergeResult, ScanBaseline,
  ScanBatch, ScanFlag, ScanHandoff, ScanIssue, ScanIssueKind, ScanRef, TrustedSource
} from '../types';

export interface ScanReturnEntry {
  scanId: string;
  pages: number | null;
  fingerprint: string;
}

export interface ScanReturnPacket {
  /** full=全量回传（登记册中未出现即缺件）；partial=补传包，只处理包内条目。缺省：首个批次视为全量，之后视为补传 */
  type?: 'full' | 'partial';
  batchId?: string;
  entries: ScanReturnEntry[];
}

export interface ScanIngestPlan {
  handoff: ScanHandoff;
  batch: ScanBatch;
  /** 复用早先“采信扫描组”决策时，已同步好扫描件页数/指纹的记录与合并 */
  records: ArchiveRecord[];
  merges: MergeResult[];
  /** 需要按回传值更新页数/指纹的扫描件（处理人采纳扫描组来源时复用同一份更新表） */
  acceptedUpdates: Array<{ scanId: string; pages: number | null; fingerprint: string }>;
  missingScanIds: string[];
  /** 回传包里查无登记的扫描件编号 */
  orphanScanIds: string[];
  matched: number;
  reused: boolean;
}

const normalizeId = (value: string) => value.trim().toUpperCase().replace(/\s+/g, '');

export const issueKey = (kind: ScanIssueKind, scanId: string, batchId: string) => `${kind}:${normalizeId(scanId)}@${batchId}`;
export const issueIdOf = (kind: ScanIssueKind, scanId: string, batchId: string) =>
  `scan-issue-${normalizeId(scanId).replace(/[^A-Z0-9]/g, '')}-${kind}-${normalizeId(batchId).replace(/[^A-Z0-9]/g, '')}`;

const findBaseline = (handoff: ScanHandoff, scanId: string) =>
  handoff.register.find((item) => normalizeId(item.scanId) === normalizeId(scanId));

/** 合并记录之外，稳定编号当前挂载在哪条记录上 */
export const recordsHoldingScan = (records: ArchiveRecord[], scanId: string): ArchiveRecord[] =>
  records.filter((record) => record.scanRefs?.some((ref) => normalizeId(ref.scanId) === normalizeId(scanId)));

/** 含该扫描件的合并记录（源记录已合并移除时仍可挂回） */
export const mergesHoldingScan = (merges: MergeResult[], scanId: string): MergeResult[] =>
  merges.filter((merge) => merge.scanRefs?.some((ref) => normalizeId(ref.scanId) === normalizeId(scanId)));

export const scoreForScan = (
  scanId: string,
  records: ArchiveRecord[],
  matches: MatchCandidate[],
  merges: MergeResult[]
): number | null => {
  const recordIds = new Set(recordsHoldingScan(records, scanId).map((record) => record.id));
  mergesHoldingScan(merges, scanId).forEach((merge) => {
    recordIds.add(merge.leftId);
    recordIds.add(merge.rightId);
    if (merge.mergedRecordId) recordIds.add(merge.mergedRecordId);
  });
  let best: number | null = null;
  matches.forEach((match) => {
    if (recordIds.has(match.leftId) || recordIds.has(match.rightId)) {
      if (best === null || match.score > best) best = match.score;
    }
  });
  return best;
};

export const affectedRecordIdsForScan = (records: ArchiveRecord[], merges: MergeResult[], scanId: string): string[] => {
  const ids = new Set<string>();
  recordsHoldingScan(records, scanId).forEach((record) => ids.add(record.id));
  mergesHoldingScan(merges, scanId).forEach((merge) => {
    ids.add(merge.leftId);
    ids.add(merge.rightId);
    if (merge.mergedRecordId) ids.add(merge.mergedRecordId);
  });
  return [...ids];
};

const pagesEqual = (a: number | null | undefined, b: number | null | undefined) => (a ?? null) === (b ?? null);

/** 把采信的回传值写到记录/合并追溯中对应稳定编号的扫描件上 */
const applyScanValue = (
  records: ArchiveRecord[],
  merges: MergeResult[],
  scanId: string,
  value: { pages?: number | null; fingerprint?: string }
) => {
  const touch = (refs?: ScanRef[]) => refs?.forEach((ref) => {
    if (normalizeId(ref.scanId) !== normalizeId(scanId)) return;
    if (value.pages !== undefined) ref.pages = value.pages;
    if (value.fingerprint !== undefined) ref.fingerprint = value.fingerprint;
  });
  records.forEach((record) => touch(record.scanRefs));
  merges.forEach((merge) => touch(merge.scanRefs));
};

/**
 * 规划一次扫描回传导入。纯函数：不修改入参，重复导入同一批次时直接沿用已有处理结果。
 * 不一致（页数/指纹）只立待处理单，绝不自动改写本机结论；缺件保留原结论并标记待补。
 */
export function planScanIngest(
  handoff: ScanHandoff,
  packet: ScanReturnPacket,
  records: ArchiveRecord[],
  matches: MatchCandidate[],
  merges: MergeResult[],
  receivedAt: string,
  fallbackBatchId: string
): ScanIngestPlan {
  const batchId = (packet.batchId || fallbackBatchId).trim();

  const previous = handoff.batches.find((batch) => batch.batchId === batchId);
  if (previous) {
    return {
      handoff,
      batch: previous,
      records,
      merges,
      acceptedUpdates: [],
      missingScanIds: [],
      orphanScanIds: [],
      matched: previous.entryCount,
      reused: true
    };
  }

  const nextRegister = handoff.register.map((item) => ({ ...item }));
  const nextIssues = handoff.issues.map((issue) => ({ ...issue }));
  // 复用早先“采信扫描组”的决策时，需要直接把回传值写到记录与合并追溯的扫描件上
  const nextRecords = records.map((record) => ({ ...record, scanRefs: record.scanRefs?.map((ref) => ({ ...ref })) }));
  const nextMerges = merges.map((merge) => ({ ...merge, scanRefs: merge.scanRefs?.map((ref) => ({ ...ref })) }));
  const acceptedUpdates: ScanIngestPlan['acceptedUpdates'] = [];
  const missingScanIds: string[] = [];
  const orphanScanIds: string[] = [];
  let issuesRaised = 0;
  let autoResolved = 0;
  let reusedDecisions = 0;
  let matched = 0;

  // 只有全量批次才判定缺件；缺件只针对历次从未到件的登记扫描件
  const isFull = packet.type === 'full' || (!packet.type && handoff.batches.length === 0);
  const everReceived = new Set<string>();
  handoff.batches.forEach((batch) => batch.scanIds.forEach((id) => everReceived.add(normalizeId(id))));
  // 已闭环的旧缺件单也说明该件曾到件过（兼容早期数据）
  nextIssues.forEach((issue) => {
    if (issue.kind === 'missing' && issue.status !== 'pending') everReceived.add(normalizeId(issue.scanId));
  });

  const seen = new Set<string>();
  packet.entries.forEach((entry) => {
    const key = normalizeId(entry.scanId);
    if (!key || seen.has(key)) return;
    seen.add(key);
    everReceived.add(key);
    const baseline = findBaseline(handoff, entry.scanId);
    if (!baseline) {
      orphanScanIds.push(entry.scanId);
      const issue: ScanIssue = {
        id: issueIdOf('unmatched', entry.scanId, batchId),
        kind: 'unmatched',
        status: 'pending',
        scanId: entry.scanId,
        batchId,
        receivedPages: entry.pages,
        receivedFingerprint: entry.fingerprint,
        affectedRecordIds: [],
        affectedMergeIds: [],
        matchScore: null,
        createdAt: receivedAt
      };
      if (!nextIssues.some((item) => item.id === issue.id)) {
        nextIssues.unshift(issue);
        issuesRaised += 1;
      }
      return;
    }
    matched += 1;
    const affectedRecordIds = affectedRecordIdsForScan(records, merges, baseline.scanId);
    const affectedMergeIds = mergesHoldingScan(merges, baseline.scanId).map((merge) => merge.id);
    const matchScore = scoreForScan(baseline.scanId, records, matches, merges);

    const raise = (kind: ScanIssueKind, localPages: number | null, localFingerprint: string): ScanIssue => ({
      id: issueIdOf(kind, baseline.scanId, batchId),
      kind,
      status: 'pending',
      scanId: baseline.scanId,
      batchId,
      receivedPages: entry.pages,
      receivedFingerprint: entry.fingerprint,
      localPages,
      localFingerprint,
      affectedRecordIds,
      affectedMergeIds,
      matchScore,
      createdAt: receivedAt
    });

    // 同一扫描件早先批次的缺件待补：补传到件自动关闭，原结论保持不变
    const priorMissing = nextIssues.find(
      (issue) => issue.kind === 'missing' && issue.status === 'pending'
        && normalizeId(issue.scanId) === key
    );
    if (priorMissing) {
      priorMissing.status = 'resolved';
      priorMissing.resolvedAt = receivedAt;
      priorMissing.note = `补传批次 ${batchId} 已收到扫描件`;
      autoResolved += 1;
    }

    const pagesConflict = !pagesEqual(baseline.pages, entry.pages);
    const fingerprintConflict = baseline.fingerprint !== entry.fingerprint;

    // 早先批次已处理过同一字段、且回传值与上次相同：沿用已有结论，不重复立单
    const reusePriorDecision = (kind: ScanIssueKind, receivedPages: number | null, receivedFingerprint: string): boolean => {
      const prior = nextIssues.find(
        (item) => (item.status === 'trusted-local' || item.status === 'trusted-scan')
          && item.kind === kind && normalizeId(item.scanId) === key
      );
      if (!prior) return false;
      if (kind === 'pages' && pagesEqual(prior.receivedPages ?? null, receivedPages)) {
        reusedDecisions += 1;
        if (prior.status === 'trusted-scan') applyScanValue(nextRecords, nextMerges, baseline.scanId, { pages: receivedPages });
        return true;
      }
      if (kind === 'fingerprint' && prior.receivedFingerprint === receivedFingerprint) {
        reusedDecisions += 1;
        if (prior.status === 'trusted-scan') applyScanValue(nextRecords, nextMerges, baseline.scanId, { fingerprint: receivedFingerprint });
        return true;
      }
      return false;
    };

    if (pagesConflict && !reusePriorDecision('pages', entry.pages, entry.fingerprint)) {
      const issue = raise('pages', baseline.pages, baseline.fingerprint);
      if (!nextIssues.some((item) => item.id === issue.id)) { nextIssues.unshift(issue); issuesRaised += 1; }
    }
    if (fingerprintConflict && !reusePriorDecision('fingerprint', entry.pages, entry.fingerprint)) {
      const issue = raise('fingerprint', baseline.pages, baseline.fingerprint);
      if (!nextIssues.some((item) => item.id === issue.id)) { nextIssues.unshift(issue); issuesRaised += 1; }
    }
    if (!pagesConflict && !fingerprintConflict) {
      // 一致项：扫描件确认挂回，无需改动本机数值
    } else {
      acceptedUpdates.push({ scanId: baseline.scanId, pages: entry.pages, fingerprint: entry.fingerprint });
    }
  });

  // 全量批次中仍未出现、且历次从未到件的登记扫描件：保留原确认/字段选择/合并，只立待补单并标记待补
  if (isFull) nextRegister.forEach((baseline) => {
    const key = normalizeId(baseline.scanId);
    if (seen.has(key) || everReceived.has(key)) return;
    const alreadyPending = nextIssues.some(
      (issue) => issue.kind === 'missing' && issue.status === 'pending' && normalizeId(issue.scanId) === key
    );
    if (alreadyPending) return;
    missingScanIds.push(baseline.scanId);
    const affectedRecordIds = affectedRecordIdsForScan(records, merges, baseline.scanId);
    const affectedMergeIds = mergesHoldingScan(merges, baseline.scanId).map((merge) => merge.id);
    const issue: ScanIssue = {
      id: issueIdOf('missing', baseline.scanId, batchId),
      kind: 'missing',
      status: 'pending',
      scanId: baseline.scanId,
      batchId,
      localPages: baseline.pages,
      localFingerprint: baseline.fingerprint,
      affectedRecordIds,
      affectedMergeIds,
      matchScore: scoreForScan(baseline.scanId, records, matches, merges),
      createdAt: receivedAt
    };
    if (!nextIssues.some((item) => item.id === issue.id)) { nextIssues.unshift(issue); issuesRaised += 1; }
  });

  const batch: ScanBatch = {
    batchId,
    receivedAt,
    type: isFull ? 'full' : 'partial',
    entryCount: packet.entries.length,
    scanIds: packet.entries.map((entry) => entry.scanId),
    issuesRaised,
    autoResolved,
    reusedDecisions,
    reused: false
  };
  const nextHandoff: ScanHandoff = {
    register: nextRegister,
    batches: [batch, ...handoff.batches],
    issues: nextIssues
  };
  return { handoff: nextHandoff, batch, records: nextRecords, merges: nextMerges, acceptedUpdates, missingScanIds, orphanScanIds, matched, reused: false };
}

/** 应用“缺件待补”标记：不动任何既有结论，只给受影响记录挂旗标 */
export function applyMissingFlags(records: ArchiveRecord[], missingScanIds: string[]): ArchiveRecord[] {
  const keys = new Set(missingScanIds.map(normalizeId));
  if (!keys.size) return records;
  return records.map((record) => {
    const touched = record.scanRefs?.some((ref) => keys.has(normalizeId(ref.scanId)));
    if (!touched) return record;
    const flag: ScanFlag = 'awaiting-rescan';
    return { ...record, scanFlag: flag };
  });
}

export interface ResolveIssuePlan {
  handoff: ScanHandoff;
  records: ArchiveRecord[];
  merges: MergeResult[];
  updates: Array<{ scanId: string; pages: number | null; fingerprint: string }>;
  /** 受影响记录的旗标终态 */
  flagClearScanIds: string[];
}

/** 处理人在待处理区选定可信来源后生成更新计划（确认、字段选择、审计、导出包随提交一并更新） */
export function planResolveIssue(
  handoff: ScanHandoff,
  records: ArchiveRecord[],
  merges: MergeResult[],
  issueId: string,
  trusted: TrustedSource,
  resolvedAt: string
): ResolveIssuePlan | null {
  const issue = handoff.issues.find((item) => item.id === issueId);
  if (!issue || issue.status !== 'pending') return null;

  const nextRegister = handoff.register.map((item) => ({ ...item }));
  const resolvedStatus: ScanIssue['status'] = trusted === 'scan' ? 'trusted-scan' : 'trusted-local';
  const nextIssues = handoff.issues.map((item): ScanIssue =>
    item.id === issueId
      ? { ...item, status: resolvedStatus, trustedSource: trusted, resolvedAt }
      : item
  );
  const nextRecords = records.map((record) => ({ ...record, scanRefs: record.scanRefs?.map((ref) => ({ ...ref })) }));
  const nextMerges = merges.map((merge) => ({ ...merge, scanRefs: merge.scanRefs?.map((ref) => ({ ...ref })) }));

  const updates: ResolveIssuePlan['updates'] = [];
  const flagClearScanIds: string[] = [];

  if (trusted === 'scan' && issue.kind !== 'missing' && issue.receivedFingerprint !== undefined) {
    // 同一扫描件的页数/指纹兄弟单采用同一可信来源，回传值一并应用
    const companions = [issue, ...nextIssues.filter(
      (item) => item.id !== issue.id && item.status === 'pending'
        && (item.kind === 'pages' || item.kind === 'fingerprint')
        && normalizeId(item.scanId) === normalizeId(issue.scanId)
    )];
    const pagesCompanion = companions.find((item) => item.kind === 'pages');
    const fingerprintCompanion = companions.find((item) => item.kind === 'fingerprint');
    const nextPages = pagesCompanion?.receivedPages ?? null;
    const nextFingerprint = fingerprintCompanion?.receivedFingerprint ?? issue.receivedFingerprint ?? '';

    const applyToRef = (ref: ScanRef) => {
      if (normalizeId(ref.scanId) !== normalizeId(issue.scanId)) return;
      if (pagesCompanion) ref.pages = nextPages;
      if (fingerprintCompanion) ref.fingerprint = nextFingerprint;
    };
    nextRecords.forEach((record) => record.scanRefs?.forEach(applyToRef));
    nextMerges.forEach((merge) => merge.scanRefs?.forEach(applyToRef));

    updates.push({
      scanId: issue.scanId,
      pages: pagesCompanion ? nextPages : (issue.receivedPages ?? null),
      fingerprint: fingerprintCompanion ? nextFingerprint : (issue.receivedFingerprint ?? '')
    });

    // 登记基线同步为处理人确认的扫描组数值
    const baseline = nextRegister.find((item) => normalizeId(item.scanId) === normalizeId(issue.scanId));
    if (baseline) {
      if (pagesCompanion) baseline.pages = nextPages;
      if (fingerprintCompanion) baseline.fingerprint = nextFingerprint;
    }
    flagClearScanIds.push(issue.scanId);
  }

  if (trusted === 'local') {
    // 本机可信：原确认、字段选择、合并值一律不动；缺件继续待补
    if (issue.kind !== 'missing') flagClearScanIds.push(issue.scanId);
  }

  // 同一扫描件页数与指纹两条不一致单：处理一条时另一条采用同一可信来源一并闭环
  const siblingKinds: ScanIssueKind[] = issue.kind === 'pages' ? ['fingerprint'] : issue.kind === 'fingerprint' ? ['pages'] : [];
  siblingKinds.forEach((kind) => {
    const sibling = nextIssues.find(
      (item) => item.status === 'pending' && item.kind === kind && normalizeId(item.scanId) === normalizeId(issue.scanId)
    );
    if (sibling) {
      sibling.status = resolvedStatus;
      sibling.trustedSource = trusted;
      sibling.resolvedAt = resolvedAt;
    }
  });

  // 受影响记录旗标：只要该扫描件仍有未决单就保持待处理/待补
  const pendingByScan = new Map<string, ScanIssue[]>();
  nextIssues.forEach((item) => {
    if (item.status !== 'pending') return;
    const key = normalizeId(item.scanId);
    pendingByScan.set(key, [...(pendingByScan.get(key) ?? []), item]);
  });
  const cleared = new Set(flagClearScanIds.map(normalizeId));
  nextRecords.forEach((record) => {
    const refs = record.scanRefs ?? [];
    if (!refs.length) return;
    const pending = refs.some((ref) => (pendingByScan.get(normalizeId(ref.scanId)) ?? []).length > 0);
    if (pending) {
      record.scanFlag = refs.some((ref) =>
        (pendingByScan.get(normalizeId(ref.scanId)) ?? []).some((item) => item.kind === 'missing')
      ) ? 'awaiting-rescan' : 'unresolved';
    } else if (refs.some((ref) => cleared.has(normalizeId(ref.scanId)))) {
      record.scanFlag = 'ok';
    }
  });

  return {
    handoff: { ...handoff, register: nextRegister, issues: nextIssues },
    records: nextRecords,
    merges: nextMerges,
    updates,
    flagClearScanIds
  };
}

/** 补传到件并关闭缺件单后，清除对应记录的待补旗标（仍有其它未决单则保留待处理） */
export function refreshFlags(state: ArchiveState): ArchiveRecord[] {
  const pendingByScan = new Map<string, ScanIssue[]>();
  state.scanHandoff.issues.forEach((item) => {
    if (item.status !== 'pending') return;
    const key = normalizeId(item.scanId);
    pendingByScan.set(key, [...(pendingByScan.get(key) ?? []), item]);
  });
  return state.records.map((record) => {
    const refs = record.scanRefs ?? [];
    if (!refs.length) return record.scanFlag ? { ...record, scanFlag: undefined } : record;
    const hasPending = refs.some((ref) => (pendingByScan.get(normalizeId(ref.scanId)) ?? []).length > 0);
    if (!hasPending) return record.scanFlag ? { ...record, scanFlag: 'ok' as ScanFlag } : record;
    const awaiting = refs.some((ref) =>
      (pendingByScan.get(normalizeId(ref.scanId)) ?? []).some((item) => item.kind === 'missing')
    );
    const flag: ScanFlag = awaiting ? 'awaiting-rescan' : 'unresolved';
    return record.scanFlag === flag ? record : { ...record, scanFlag: flag };
  });
}

/** 合并记录时汇总双方扫描件 */
export const combineScanRefs = (left: ArchiveRecord, right: ArchiveRecord): ScanRef[] => {
  const refs = [...(left.scanRefs ?? []), ...(right.scanRefs ?? [])];
  const seenKeys = new Set<string>();
  return refs.filter((ref) => {
    const key = normalizeId(ref.scanId);
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
};

const parsePages = (raw: unknown): number | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = typeof raw === 'number' ? raw : Number(String(raw).replace(/[^\d]/g, ''));
  return Number.isFinite(value) ? value : null;
};

/** 解析扫描组回传包：JSON（对象或数组）或“编号,页数,指纹”的制表符/竖线/逗号文本 */
export function parseScanPacket(raw: string): ScanReturnPacket {
  const text = raw.trim();
  if (text.startsWith('{')) {
    const parsed = JSON.parse(text) as { batchId?: string; batch?: string; type?: string; full?: boolean; entries?: Array<Record<string, unknown>>; scans?: Array<Record<string, unknown>> };
    const rows = parsed.entries ?? parsed.scans ?? [];
    return {
      batchId: parsed.batchId ?? parsed.batch,
      type: (parsed.type === 'partial' || parsed.full === false) ? 'partial' : (parsed.type === 'full' || parsed.full === true) ? 'full' : undefined,
      entries: rows.map((row) => ({
        scanId: String(row.scanId ?? row.id ?? row.code ?? '').trim(),
        pages: parsePages(row.pages ?? row.pageCount),
        fingerprint: String(row.fingerprint ?? row.hash ?? row.checksum ?? '').trim()
      })).filter((entry) => entry.scanId)
    };
  }
  if (text.startsWith('[')) {
    const parsed = JSON.parse(text) as Array<Record<string, unknown>>;
    return {
      entries: parsed.map((row) => ({
        scanId: String(row.scanId ?? row.id ?? row.code ?? '').trim(),
        pages: parsePages(row.pages ?? row.pageCount),
        fingerprint: String(row.fingerprint ?? row.hash ?? row.checksum ?? '').trim()
      })).filter((entry) => entry.scanId)
    };
  }
  let batchId: string | undefined;
  let type: 'full' | 'partial' | undefined;
  const entries: ScanReturnEntry[] = [];
  text.split(/\r?\n/).filter(Boolean).forEach((line) => {
    if (/^batch\s*[:=]/i.test(line.trim())) {
      batchId = line.trim().split(/[:=]/)[1]?.trim();
      return;
    }
    if (/^type\s*[:=]/i.test(line.trim())) {
      const value = line.trim().split(/[:=]/)[1]?.trim().toLowerCase();
      type = value === 'partial' || value === '补传' ? 'partial' : value === 'full' || value === '全量' ? 'full' : type;
      return;
    }
    const cells = line.split(/\t|\||,/).map((cell) => cell.trim());
    const scanId = cells[0];
    if (!scanId || scanId.startsWith('#')) return;
    entries.push({ scanId, pages: parsePages(cells[1]), fingerprint: cells[2] ?? '' });
  });
  return { batchId, type, entries };
}

export const scanIssueKindLabel: Record<ScanIssueKind, string> = {
  pages: '页数不一致',
  fingerprint: '指纹不一致',
  missing: '回传缺件待补',
  unmatched: '无主扫描件'
};

export const scanIssueStatusLabel: Record<ScanIssue['status'], string> = {
  pending: '待处理',
  'trusted-local': '已按本机闭环',
  'trusted-scan': '已按扫描组闭环',
  resolved: '补传到件已闭环'
};

export const emptyScanHandoff = (): ScanHandoff => ({ register: [], batches: [], issues: [] });

/** 本机为一批记录登记移交基线（以稳定编号为主键） */
export function buildBaselines(rows: Array<{ scanId: string; pages: number | null; fingerprint: string; record: ArchiveRecord }>): ScanBaseline[] {
  return rows.map(({ scanId, pages, fingerprint, record }) => ({
    scanId,
    sentIdentifier: record.sentIdentifier ?? record.identifier,
    pages,
    fingerprint,
    recordId: record.id,
    title: record.title
  }));
}
