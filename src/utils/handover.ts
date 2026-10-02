import type {
  ArchiveRecord, ArchiveState, HandoverIssue, HandoverIssueKind,
  MergeResult, ScanReturnEntry, ScanReturnPackage
} from '../types';

/** 编号归一化：只保留字母数字，用于“本机编号改过”场景下的历史编号核对 */
export const normalizeCode = (value?: string) =>
  (value ?? '').toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');

/** 指纹短写，用于界面展示 */
export const shortFp = (value?: string) => (value ? `${value.slice(0, 8)}…` : '—');

/** 回传包内容稳定指纹：同一批重复导入（即使 batchId 被改动）也能识别 */
export const packageHash = (pkg: ScanReturnPackage): string => {
  const body = JSON.stringify({
    entries: [...pkg.entries]
      .map((entry) => ({ scanId: entry.scanId, pages: entry.pages, fingerprint: entry.fingerprint }))
      .sort((a, b) => a.scanId.localeCompare(b.scanId))
  });
  // 53 位确定性哈希（cyrb53 风格），不依赖 crypto，保证可重复
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(13, '0');
};

/** 解析扫描组回传包：仅接受 scanId / pages / fingerprint 三项核心字段 */
export function parseReturnPackage(raw: string): { pkg?: ScanReturnPackage; error?: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: '回传包不是合法 JSON，请使用扫描组导出的 JSON 文件' };
  }
  if (typeof data !== 'object' || data === null) return { error: '回传包结构为空' };
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.entries)) return { error: '回传包缺少 entries 数组' };
  const batchId = typeof obj.batchId === 'string' && obj.batchId.trim() ? obj.batchId.trim() : `batch-${packageHash({ entries: [], batchId: '' }).slice(0, 8)}`;
  const seen = new Set<string>();
  const entries: ScanReturnEntry[] = [];
  for (let i = 0; i < obj.entries.length; i += 1) {
    const row = obj.entries[i] as Record<string, unknown>;
    if (!row || typeof row !== 'object') return { error: `第 ${i + 1} 行不是对象` };
    const scanId = String(row.scanId ?? '').trim();
    if (!scanId) return { error: `第 ${i + 1} 行缺少扫描件编号 scanId` };
    if (seen.has(scanId)) return { error: `包内扫描件编号重复：${scanId}` };
    seen.add(scanId);
    const pages = typeof row.pages === 'number' ? row.pages : Number(row.pages);
    if (!Number.isFinite(pages) || pages < 0) return { error: `${scanId} 的页数不合法` };
    const fingerprint = String(row.fingerprint ?? '').trim();
    if (!fingerprint) return { error: `${scanId} 缺少文件指纹` };
    entries.push({ scanId, pages, fingerprint, ref: row.ref === undefined ? undefined : String(row.ref).trim() });
  }
  if (!entries.length) return { error: '回传包中没有任何扫描件条目' };
  return { pkg: { batchId, scannedAt: typeof obj.scannedAt === 'string' ? obj.scannedAt : undefined, entries } };
}

interface RecordIndex {
  byScanId: Map<string, ArchiveRecord>;
  byIdentifier: Map<string, ArchiveRecord>;
  /** 合并前记录 id -> 合并后现存记录 */
  byOrigin: Map<string, ArchiveRecord>;
  /** 合并前记录编号 -> 合并后现存记录 */
  byOriginIdentifier: Map<string, ArchiveRecord>;
}

const buildIndex = (state: ArchiveState): RecordIndex => {
  const index: RecordIndex = { byScanId: new Map(), byIdentifier: new Map(), byOrigin: new Map(), byOriginIdentifier: new Map() };
  state.records.forEach((record) => {
    if (record.scanId) index.byScanId.set(record.scanId, record);
    [record.identifier, ...(record.identifierHistory ?? [])].filter(Boolean).forEach((identifier) => {
      index.byIdentifier.set(normalizeCode(identifier), record);
    });
  });
  state.merges.forEach((merge) => {
    const survivor = state.records.find((record) => record.id === merge.id);
    if (!survivor) return;
    index.byOrigin.set(merge.leftId, survivor);
    index.byOrigin.set(merge.rightId, survivor);
    [survivor.identifier, ...(survivor.identifierHistory ?? [])].forEach((identifier) => {
      index.byOriginIdentifier.set(normalizeCode(identifier), survivor);
    });
  });
  return index;
};

export interface ResolvedEntry {
  record?: ArchiveRecord;
  /** 通过合并血脉挂回（原记录已不存在） */
  viaMerged: boolean;
  /** 100 = 稳定编号直接挂回；90 = 编号（含历史编号）匹配；0 = 无法挂回 */
  confidence: number;
  /** 回传包里抄写的 ref 与本机当前编号的关系 */
  refState: 'none' | 'current' | 'stale' | 'unknown';
}

/**
 * 按稳定编号把扫描件挂回原记录。
 * 只认送扫登记发放的稳定 scanId；编号仅在记录没有 scanId 时作为线索，
 * 且会同时检查编号历史，本机编号改过也不会错配。
 */
export function resolveEntry(entry: ScanReturnEntry, state: ArchiveState): ResolvedEntry {
  const index = buildIndex(state);
  const viaScan = index.byScanId.get(entry.scanId);
  if (viaScan) {
    let refState: ResolvedEntry['refState'] = 'none';
    if (entry.ref) {
      const current = normalizeCode(viaScan.identifier);
      const historical = new Set([...(viaScan.identifierHistory ?? []), viaScan.identifier].map(normalizeCode));
      refState = normalizeCode(entry.ref) === current ? 'current' : historical.has(normalizeCode(entry.ref)) ? 'stale' : 'unknown';
    }
    return { record: viaScan, viaMerged: viaScan.status === 'merged', confidence: 100, refState };
  }
  // 合并血脉：原记录编号在合并后记录的编号历史中
  if (entry.ref) {
    const key = normalizeCode(entry.ref);
    const direct = index.byIdentifier.get(key);
    if (direct && !direct.scanId) {
      return { record: direct, viaMerged: direct.status === 'merged', confidence: 90, refState: 'current' };
    }
    const viaOrigin = index.byOriginIdentifier.get(key);
    if (viaOrigin && !viaOrigin.scanId) {
      return { record: viaOrigin, viaMerged: true, confidence: 90, refState: 'stale' };
    }
  }
  return { viaMerged: false, confidence: 0, refState: entry.ref ? 'unknown' : 'none' };
}

/** 找到记录参与的合并结果（按现存合并记录 id 或左右原记录 id） */
export const findMergeFor = (state: ArchiveState, record: ArchiveRecord): MergeResult | undefined =>
  state.merges.find((merge) => merge.id === record.id || merge.leftId === record.id || merge.rightId === record.id);

export interface ReconcileResult {
  reused: boolean;
  reusedBatchId?: string;
  batchId: string;
  hash: string;
  total: number;
  attached: number;
  issues: HandoverIssue[];
  missing: HandoverIssue[];
}

const issueId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `iss-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const nowIso = () => new Date().toISOString();

const makeIssue = (
  kind: HandoverIssueKind, batchId: string, confidence: number,
  fields: Partial<HandoverIssue> & { scanId?: string }
): HandoverIssue => ({
  id: issueId(),
  kind,
  status: 'pending',
  batchId,
  confidence,
  createdAt: nowIso(),
  ...fields
});

const mergeContext = (state: ArchiveState, record: ArchiveRecord, viaMerged: boolean) => {
  if (!viaMerged && record.status !== 'merged') return {};
  const merge = findMergeFor(state, record);
  if (!merge || record.status !== 'merged') return {};
  return { mergedRecordId: record.id, mergedRecordTitle: record.title, mergeId: merge.id };
};

/** 把已对账一致的扫描件挂回记录 */
const attachScan = (record: ArchiveRecord, entry: ScanReturnEntry) => {
  record.scanAttached = true;
  record.scanPendingSupplement = false;
  // 回传确认页数与指纹；登记缺失时用回传值补齐
  record.scanPages = entry.pages;
  record.scanFingerprint = entry.fingerprint;
  record.updatedAt = nowIso();
};

/**
 * 移交对账主流程：
 * 1. 同一批重复导入沿用已有处理结果（按 batchId 或包内容指纹判定）；
 * 2. 扫描件按稳定编号挂回原记录，本机编号改过不影响绑定；
 * 3. 页数 / 指纹不一致 -> 待处理区，列出受影响的合并记录与匹配分数；
 * 4. 已送扫但回传缺失 -> 保留原结论并标记待补。
 */
export function reconcilePackage(state: ArchiveState, pkg: ScanReturnPackage): ReconcileResult {
  const hash = packageHash(pkg);
  const existing = state.handover.batches.find((batch) => batch.batchId === pkg.batchId || batch.hash === hash);
  if (existing) {
    return {
      reused: true,
      reusedBatchId: existing.batchId,
      batchId: pkg.batchId,
      hash,
      total: existing.entryCount,
      attached: existing.attachedCount,
      issues: state.handover.issues.filter((issue) => existing.issueIds.includes(issue.id)),
      missing: state.handover.issues.filter((issue) => existing.issueIds.includes(issue.id) && issue.kind === 'missing-return')
    };
  }

  const issueIds: string[] = [];
  const created: HandoverIssue[] = [];
  const coveredScanIds = new Set<string>();
  let attached = 0;

  pkg.entries.forEach((entry) => {
    const resolved = resolveEntry(entry, state);
    if (!resolved.record) {
      const issue = makeIssue('unmatched-scan', pkg.batchId, resolved.confidence, {
        scanId: entry.scanId,
        ref: entry.ref,
        localValue: '未找到对应记录',
        remoteValue: `${entry.pages} 页 · 指纹 ${shortFp(entry.fingerprint)}`,
        note: entry.ref ? `扫描组抄写的编号 ${entry.ref} 在本机无登记` : '回传包未提供编号线索'
      });
      state.handover.issues.unshift(issue);
      issueIds.push(issue.id);
      created.push(issue);
      return;
    }

    const record = resolved.record;
    coveredScanIds.add(record.scanId ?? entry.scanId);

    const context = mergeContext(state, record, resolved.viaMerged);
    const refNote = resolved.refState === 'stale'
      ? `回传仍写旧编号 ${entry.ref}，已按稳定编号 ${entry.scanId} 挂回`
      : resolved.refState === 'unknown'
        ? `回传编号 ${entry.ref} 与本机记录不符，以稳定编号挂回`
        : undefined;

    // 本机没有登记页数/指纹基准（0 或空）时，回传值直接补齐，不视为不一致
    const pageMismatch = typeof record.scanPages === 'number' && record.scanPages > 0 && record.scanPages !== entry.pages;
    const fpMismatch = !!record.scanFingerprint && record.scanFingerprint !== entry.fingerprint;

    // 回传到位：此前“回传缺失”的待补项（含已知悉待补）自动关闭
    state.handover.issues.forEach((issue) => {
      if ((issue.status === 'pending' || issue.status === 'acknowledged')
        && issue.kind === 'missing-return' && issue.recordId === record.id) {
        issue.status = 'superseded';
        issue.note = `已随批次 ${pkg.batchId} 回传，缺件待补项关闭`;
      }
    });

    const supersedeSameKind = (kind: HandoverIssueKind) => {
      // 同一扫描件同类型的旧待处理项被本批新回传取代，避免重复挂账
      state.handover.issues.forEach((issue) => {
        if (issue.status === 'pending' && issue.scanId === entry.scanId && issue.kind === kind) {
          issue.status = 'superseded';
          issue.note = `${issue.note ?? ''}（已被批次 ${pkg.batchId} 的新回传取代）`.trim();
        }
      });
    };

    if (pageMismatch) {
      supersedeSameKind('pages-mismatch');
      const issue = makeIssue('pages-mismatch', pkg.batchId, resolved.confidence, {
        scanId: entry.scanId,
        recordId: record.id,
        ...context,
        ref: entry.ref,
        localValue: `${record.scanPages} 页`,
        remoteValue: `${entry.pages} 页`,
        note: refNote
      });
      state.handover.issues.unshift(issue);
      issueIds.push(issue.id);
      created.push(issue);
    }
    if (fpMismatch) {
      supersedeSameKind('fingerprint-mismatch');
      const issue = makeIssue('fingerprint-mismatch', pkg.batchId, resolved.confidence, {
        scanId: entry.scanId,
        recordId: record.id,
        ...context,
        ref: entry.ref,
        localValue: `指纹 ${shortFp(record.scanFingerprint)}`,
        remoteValue: `指纹 ${shortFp(entry.fingerprint)}`,
        note: refNote
      });
      state.handover.issues.unshift(issue);
      issueIds.push(issue.id);
      created.push(issue);
    }
    if (!pageMismatch && !fpMismatch) {
      attachScan(record, entry);
      attached += 1;
    }
  });

  // 回传缺失：已送扫登记、但本批未出现的扫描件。保留原确认与字段选择，只标记待补
  const missing: HandoverIssue[] = [];
  state.records.filter((record) => record.scanSent && record.scanId).forEach((record) => {
    if (coveredScanIds.has(record.scanId!)) {
      record.scanPendingSupplement = false;
      return;
    }
    // 已经挂回（此前批次）的不再报缺；存在生效中（待处理或已知悉待补）的缺件项也不重复挂账
    if (record.scanAttached) return;
    const active = state.handover.issues.find((issue) =>
      (issue.status === 'pending' || issue.status === 'acknowledged')
      && issue.kind === 'missing-return' && issue.recordId === record.id);
    if (active) {
      // 已确认过的缺件：保证记录上的待补标记仍在，但不重复生成问题
      record.scanPendingSupplement = true;
      return;
    }
    record.scanPendingSupplement = true;
    const context = mergeContext(state, record, false);
    const issue = makeIssue('missing-return', pkg.batchId, 100, {
      scanId: record.scanId,
      recordId: record.id,
      ...context,
      localValue: '已登记送扫',
      remoteValue: '本批未回传',
      note: '原确认结论与字段选择保持不变，标记待补扫'
    });
    state.handover.issues.unshift(issue);
    issueIds.push(issue.id);
    created.push(issue);
    missing.push(issue);
  });

  state.handover.batches.unshift({
    batchId: pkg.batchId,
    importedAt: nowIso(),
    hash,
    entryCount: pkg.entries.length,
    attachedCount: attached,
    issueIds,
    entries: pkg.entries.map((entry) => ({ ...entry }))
  });

  return {
    reused: false,
    batchId: pkg.batchId,
    hash,
    total: pkg.entries.length,
    attached,
    issues: created.filter((issue) => issue.kind !== 'missing-return'),
    missing
  };
}

/** 处理人选定可信来源：采用扫描组回传值 */
export function trustScanReturn(state: ArchiveState, issue: HandoverIssue, entryArg?: ScanReturnEntry): void {
  if (!issue.recordId) return;
  const record = state.records.find((item) => item.id === issue.recordId);
  if (!record) return;
  const entry = entryArg ?? batchEntryForIssue(state, issue);
  const stamp = nowIso();
  if (issue.kind === 'pages-mismatch') {
    const from = record.extent;
    record.scanPages = entry?.pages ?? Number(String(issue.remoteValue).replace(/[^\d]/g, ''));
    // 页数属于“数量”字段：合并记录的字段选择与合并值一起更新
    if (record.status === 'merged') {
      const merge = state.merges.find((item) => item.id === record.id);
      if (merge) {
        const to = `${record.scanPages}页`;
        merge.values.extent = to;
        merge.scanOverrides = [...(merge.scanOverrides ?? []), { field: 'extent', from, to, reason: `移交对账采用扫描组回传页数（${issue.scanId}）`, at: stamp }];
      }
    }
    record.extent = `${record.scanPages}页`;
  }
  if (issue.kind === 'fingerprint-mismatch' && entry) {
    record.scanFingerprint = entry.fingerprint;
  }
  if (issue.kind === 'unmatched-scan' && entry) {
    record.scanId = entry.scanId;
    record.scanPages = entry.pages;
    record.scanFingerprint = entry.fingerprint;
    record.scanAttached = true;
  }
  record.scanAttached = true;
  record.scanPendingSupplement = false;
  record.updatedAt = stamp;
  issue.status = 'resolved';
  issue.resolvedAt = stamp;
  issue.resolution = '采用扫描组回传值';
}

/** 处理人选定可信来源：保留本机登记，回退扫描组重扫核对 */
export function trustLocalRecord(state: ArchiveState, issue: HandoverIssue): void {
  if (!issue.recordId) return;
  const record = state.records.find((item) => item.id === issue.recordId);
  if (!record) return;
  const stamp = nowIso();
  record.scanPendingSupplement = true;
  record.updatedAt = stamp;
  issue.status = 'dismissed';
  issue.resolvedAt = stamp;
  issue.resolution = '保留本机登记，已退回扫描组重扫核对';
}

/** 手工把无法挂回的扫描件绑定到原记录，绑定后按正常条目重新对账 */
export function bindScanToRecord(state: ArchiveState, issue: HandoverIssue, recordId: string, entryArg?: ScanReturnEntry): boolean {
  const record = state.records.find((item) => item.id === recordId);
  const entry = entryArg ?? batchEntryForIssue(state, issue);
  if (!record || !entry) return false;
  const stamp = nowIso();
  record.scanId = entry.scanId;
  record.scanPages = entry.pages;
  record.scanFingerprint = entry.fingerprint;
  record.scanAttached = true;
  record.updatedAt = stamp;
  issue.recordId = record.id;
  issue.status = 'resolved';
  issue.resolvedAt = stamp;
  issue.resolution = `手工绑定到记录 ${record.identifier}`;
  issue.confidence = 100;
  return true;
}

/** 确认回传缺失：原结论保留，维持待补扫标记 */
export function acknowledgeMissing(state: ArchiveState, issue: HandoverIssue): void {
  if (issue.recordId) {
    const record = state.records.find((item) => item.id === issue.recordId);
    if (record) {
      record.scanPendingSupplement = true;
      record.updatedAt = nowIso();
    }
  }
  issue.status = 'acknowledged';
  issue.resolvedAt = nowIso();
  issue.resolution = '已知悉缺件，保留原结论并继续标记待补';
}

/** 待处理项计数（供界面徽标使用） */
export const pendingIssueCount = (state: ArchiveState): number =>
  state.handover.issues.filter((issue) => issue.status === 'pending').length;

/** 从批次快照中找回待处理项对应的回传条目（旧批次也能处理） */
export const batchEntryForIssue = (state: ArchiveState, issue: HandoverIssue): ScanReturnEntry | undefined => {
  const batch = state.handover.batches.find((item) => item.batchId === issue.batchId);
  return batch?.entries.find((entry) => entry.scanId === issue.scanId);
};

export const issueKindLabel: Record<HandoverIssueKind, string> = {
  'pages-mismatch': '页数不一致',
  'fingerprint-mismatch': '指纹不一致',
  'unmatched-scan': '扫描件无主',
  'missing-return': '回传缺失待补'
};

export const issueStatusLabel: Record<HandoverIssue['status'], string> = {
  pending: '待处理',
  resolved: '已按回传更新',
  dismissed: '保留本机已退回',
  acknowledged: '已知悉待补',
  superseded: '已被新回传取代'
};
