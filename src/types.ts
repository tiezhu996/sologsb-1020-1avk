export type RecordGroup = 'A' | 'B';
export type MatchStatus = 'suggested' | 'confirmed' | 'rejected' | 'merged';
export type FieldKey = 'title' | 'date' | 'people' | 'places' | 'identifier' | 'medium' | 'extent' | 'rights' | 'notes';

/** 移交待处理项的类型 */
export type HandoverIssueKind =
  | 'pages-mismatch'      // 回传页数与本机不符
  | 'fingerprint-mismatch' // 回传文件指纹与本机不符
  | 'unmatched-scan'      // 扫描件无法挂回任何原记录
  | 'missing-return';     // 已送扫记录在本批回传中缺失

/** 待处理项的处理状态 */
export type HandoverIssueStatus = 'pending' | 'resolved' | 'dismissed' | 'acknowledged' | 'superseded';

export interface ArchiveRecord {
  id: string;
  group: RecordGroup;
  title: string;
  date: string;
  people: string[];
  places: string[];
  identifier: string;
  medium: string;
  extent: string;
  rights: string;
  notes: string;
  updatedAt: string;
  status: 'unreviewed' | 'confirmed' | 'rejected' | 'merged';
  /** 档案室在送扫登记时发放的稳定扫描编号，不随本机编号修改而变化 */
  scanId?: string;
  /** 本机编号历次取值，用于回传仍写旧编号时的对账核对 */
  identifierHistory?: string[];
  /** 本机登记的扫描页数（数字页） */
  scanPages?: number;
  /** 本机登记的扫描件文件指纹 */
  scanFingerprint?: string;
  /** 送扫批次标记：已登记送扫 */
  scanSent?: boolean;
  /** 回传已挂回：扫描件已按稳定编号对账完成 */
  scanAttached?: boolean;
  /** 回传缺少本记录，标记待补扫 */
  scanPendingSupplement?: boolean;
}

export interface MatchCandidate {
  id: string;
  leftId: string;
  rightId: string;
  score: number;
  fieldScores: Record<FieldKey, number>;
  status: MatchStatus;
  reasons: string[];
  reviewedAt?: string;
}

export interface MergeResult {
  id: string;
  matchId: string;
  leftId: string;
  rightId: string;
  chosen: Partial<Record<FieldKey, RecordGroup | 'combine'>>;
  values: Partial<Record<FieldKey, string>>;
  mergedAt: string;
  /** 移交对账后采用扫描组回传值对合并值的覆盖记录 */
  scanOverrides?: Array<{ field: FieldKey; from: string; to: string; reason: string; at: string }>;
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  detail: string;
  recordIds: string[];
  before?: string;
  after?: string;
}

/** 扫描组回传包里的一条扫描件元数据（包中只有这三项） */
export interface ScanReturnEntry {
  scanId: string;
  pages: number;
  fingerprint: string;
  /** 扫描组抄写的原记录编号，可能已被本机修改而失效；仅作核对线索，不作绑定依据 */
  ref?: string;
}

/** 扫描组移交的元数据回传包 */
export interface ScanReturnPackage {
  batchId: string;
  scannedAt?: string;
  entries: ScanReturnEntry[];
}

/** 移交对账产生的待处理项 */
export interface HandoverIssue {
  id: string;
  kind: HandoverIssueKind;
  status: HandoverIssueStatus;
  batchId: string;
  scanId?: string;
  recordId?: string;
  /** 若记录已合并，记录合并后的现存记录 id */
  mergedRecordId?: string;
  /** 受影响的合并记录标题（冗余存档，即使合并记录后续变化也能展示） */
  mergedRecordTitle?: string;
  /** 挂回时对应的匹配置信分数（0-100，稳定编号直接挂回为 100） */
  confidence: number;
  localValue?: string;
  remoteValue?: string;
  ref?: string;
  createdAt: string;
  resolvedAt?: string;
  resolution?: string;
  note?: string;
}

/** 一次回传批次的处理结果，用于重复导入幂等 */
export interface ScanBatch {
  batchId: string;
  importedAt: string;
  hash: string;
  entryCount: number;
  attachedCount: number;
  issueIds: string[];
  /** 批次条目快照，待处理项处理时仍可拿到回传的页数与指纹 */
  entries: ScanReturnEntry[];
}

export interface HandoverState {
  issues: HandoverIssue[];
  batches: ScanBatch[];
}

export interface ArchiveState {
  revision: number;
  records: ArchiveRecord[];
  matches: MatchCandidate[];
  merges: MergeResult[];
  audit: AuditEntry[];
  handover: HandoverState;
  activeMatchId: string;
  selectedRecordIds: string[];
  hydrated: boolean;
}
