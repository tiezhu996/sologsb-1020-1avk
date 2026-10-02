export type RecordGroup = 'A' | 'B';
export type MatchStatus = 'suggested' | 'confirmed' | 'rejected' | 'merged';
export type FieldKey = 'title' | 'date' | 'people' | 'places' | 'identifier' | 'medium' | 'extent' | 'rights' | 'notes';

/** 扫描件在本机侧的状态：ok 已对账 · awaiting-rescan 待补 · unresolved 待处理 */
export type ScanFlag = 'ok' | 'awaiting-rescan' | 'unresolved';
/** 回传不一致类型：pages 页数 · fingerprint 指纹 · missing 整包缺件 · unmatched 无主扫描件 */
export type ScanIssueKind = 'pages' | 'fingerprint' | 'missing' | 'unmatched';
export type ScanIssueStatus = 'pending' | 'trusted-local' | 'trusted-scan' | 'resolved';
/** 处理人选择的可信来源 */
export type TrustedSource = 'local' | 'scan';

export interface ScanRef {
  /** 扫描组与档案室约定的稳定编号，不随后台编号修改而变化 */
  scanId: string;
  pages: number | null;
  fingerprint: string;
}

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
  /** 移交扫描组时登记的编号（本机编号修改前的原值，用于展示“送出时编号”） */
  sentIdentifier?: string;
  /** 本机编号修改轨迹 */
  identifierHistory?: Array<{ from: string; to: string; at: string; reason?: string }>;
  /** 当前记录持有的扫描件（未合并记录通常只有一个） */
  scanRefs?: ScanRef[];
  scanFlag?: ScanFlag;
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
  /** 合并记录 id，便于在源记录已移除后回溯扫描对账结果 */
  mergedRecordId?: string;
  /** 合并时双方扫描件的编号与指纹/页数 */
  scanRefs?: ScanRef[];
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

/** 移交时送往扫描组的登记基线（以稳定编号为主键） */
export interface ScanBaseline {
  scanId: string;
  sentIdentifier: string;
  pages: number | null;
  fingerprint: string;
  recordId: string;
  title: string;
}

export interface ScanIssue {
  id: string;
  kind: ScanIssueKind;
  status: ScanIssueStatus;
  scanId: string;
  batchId: string;
  /** 发现时 / 最近一次补传回传的页数与指纹 */
  receivedPages?: number | null;
  receivedFingerprint?: string;
  /** 对账时本机保存的页数与指纹快照 */
  localPages?: number | null;
  localFingerprint?: string;
  affectedRecordIds: string[];
  affectedMergeIds: string[];
  matchScore: number | null;
  createdAt: string;
  resolvedAt?: string;
  trustedSource?: TrustedSource;
  note?: string;
}

export interface ScanBatch {
  batchId: string;
  receivedAt: string;
  /** full=全量回传 · partial=补传包 */
  type: 'full' | 'partial';
  entryCount: number;
  scanIds: string[];
  issuesRaised: number;
  autoResolved: number;
  /** 早先批次已处理过、本次按相同结论沿用而未重复立单的数量 */
  reusedDecisions: number;
  /** 重复导入同一批时沿用的处理结果 */
  reused: boolean;
}

export interface ScanHandoff {
  register: ScanBaseline[];
  batches: ScanBatch[];
  issues: ScanIssue[];
}

export interface ArchiveState {
  revision: number;
  records: ArchiveRecord[];
  matches: MatchCandidate[];
  merges: MergeResult[];
  audit: AuditEntry[];
  activeMatchId: string;
  selectedRecordIds: string[];
  hydrated: boolean;
  scanHandoff: ScanHandoff;
}
