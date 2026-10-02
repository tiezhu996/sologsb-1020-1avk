import {
  $, component$, useComputed$, useSignal, useStore, useVisibleTask$
} from '@builder.io/qwik';
import { Checkbox, Modal, Tabs } from '@qwik-ui/headless';
import type { ArchiveRecord, ArchiveState, FieldKey, HandoverIssue, MatchCandidate, RecordGroup } from './types';
import { computeMatches, fieldValue, scorePair } from './utils/matching';
import {
  acknowledgeMissing, bindScanToRecord, issueKindLabel, issueStatusLabel, packageHash,
  parseReturnPackage, pendingIssueCount, reconcilePackage, trustLocalRecord, trustScanReturn
} from './utils/handover';
import { seedState } from './data/seed';
import { sampleReturnJson } from './data/sampleHandover';

const STORAGE_KEY = 'sologsb-1020-archive-state-v2';
const LEGACY_STORAGE_KEY = 'sologsb-1020-archive-state-v1';
const fieldLabels: Array<[FieldKey, string]> = [
  ['title', '标题'], ['date', '日期'], ['people', '人物'], ['places', '地点'], ['identifier', '编号'],
  ['medium', '载体'], ['extent', '数量'], ['rights', '权利'], ['notes', '备注']
];

const parseDate = (value: string) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split('-').reverse().join('/');
  if (/^\d{4}$/.test(value)) return `${value}年`;
  return value || '未知';
};

const recordById = (state: ArchiveState, id: string) => state.records.find((record) => record.id === id);
const matchLabel = (state: ArchiveState, match: MatchCandidate) => {
  const left = recordById(state, match.leftId);
  const right = recordById(state, match.rightId);
  return `${left?.title ?? '未知记录'} ↔ ${right?.title ?? '未知记录'}`;
};

export default component$(() => {
  const state = useStore<ArchiveState>(seedState());
  const history = useSignal<string[]>([]);
  const future = useSignal<string[]>([]);
  const query = useSignal('');
  const groupFilter = useSignal<'all' | RecordGroup>('all');
  const statusFilter = useSignal<'all' | 'suggested' | 'confirmed' | 'rejected'>('all');
  const visibleCount = useSignal(80);
  const selectedMatchIds = useSignal<string[]>([]);
  const importOpen = useSignal(false);
  const mergeOpen = useSignal(false);
  const importGroup = useSignal<RecordGroup>('A');
  const importRaw = useSignal('');
  const importText = useSignal('');
  const toast = useSignal('');
  const panelTab = useSignal(0);
  const handoverOpen = useSignal(false);
  const handoverRaw = useSignal('');
  const handoverFileName = useSignal('');
  const handoverFilter = useSignal<'pending' | 'resolved' | 'all'>('pending');
  const bindTarget = useSignal<Record<string, string>>({});

  const snapshot = () => JSON.stringify({
    revision: state.revision,
    records: state.records,
    matches: state.matches,
    merges: state.merges,
    audit: state.audit,
    handover: state.handover
  });

  const capture = () => {
    history.value = [...history.value.slice(-49), snapshot()];
    future.value = [];
  };

  const restore = (raw: string) => {
    const next = JSON.parse(raw) as Partial<ArchiveState>;
    state.revision = next.revision ?? state.revision;
    state.records = next.records ?? state.records;
    state.matches = next.matches ?? state.matches;
    state.merges = next.merges ?? state.merges;
    state.audit = next.audit ?? state.audit;
    state.handover = next.handover ?? { issues: [], batches: [] };
  };

  const notify = (message: string) => {
    toast.value = message;
    window.setTimeout(() => { if (toast.value === message) toast.value = ''; }, 2800);
  };

  const commit = (action: string, detail: string, recordIds: string[] = []) => {
    state.revision += 1;
    state.audit.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), action, detail, recordIds });
    state.audit = state.audit.slice(0, 300);
  };

  const undo = $(() => {
    const raw = history.value.at(-1);
    if (!raw) return;
    future.value = [...future.value, snapshot()];
    history.value = history.value.slice(0, -1);
    restore(raw);
  });

  const redo = $(() => {
    const raw = future.value.at(-1);
    if (!raw) return;
    history.value = [...history.value, snapshot()];
    future.value = future.value.slice(0, -1);
    restore(raw);
  });

  const filteredRecords = useComputed$(() => {
    const term = query.value.trim().toLowerCase();
    return state.records
      .filter((record) => groupFilter.value === 'all' || record.group === groupFilter.value)
      .filter((record) => !term || [record.title, record.date, record.identifier, ...record.people, ...record.places].join(' ').toLowerCase().includes(term))
      .sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title, 'zh-CN'))
      .slice(0, visibleCount.value);
  });

  const filteredMatches = useComputed$(() => state.matches
    .filter((match) => statusFilter.value === 'all' || match.status === statusFilter.value)
    .sort((a, b) => b.score - a.score));

  const visibleMatches = useComputed$(() => filteredMatches.value.slice(0, 120));
  const activeMatch = useComputed$(() => state.matches.find((match) => match.id === state.activeMatchId) ?? filteredMatches.value[0]);
  const conflictCount = useComputed$(() => state.matches.filter((match) => match.status === 'suggested' && match.score < .68).length);

  const pendingCount = useComputed$(() => pendingIssueCount(state));
  const handoverStats = useComputed$(() => ({
    attached: state.records.filter((record) => record.scanAttached).length,
    pending: state.records.filter((record) => record.scanPendingSupplement).length,
    sent: state.records.filter((record) => record.scanSent).length,
    batches: state.handover.batches.length
  }));
  const filteredIssues = useComputed$(() => state.handover.issues
    .filter((issue) => handoverFilter.value === 'all' || handoverFilter.value === 'resolved'
      ? handoverFilter.value === 'all' || issue.status !== 'pending'
      : issue.status === 'pending')
    .slice(0, 100));

  const runHandoverImport = $((raw: string, fileName: string) => {
    const parsed = parseReturnPackage(raw);
    if (parsed.error || !parsed.pkg) {
      notify(parsed.error ?? '回传包无法解析');
      return;
    }
    const pkg = parsed.pkg;
    // 同一批重复导入先判定：沿用已有处理结果，不入撤销栈、不重复挂账
    const hash = packageHash(pkg);
    const existed = state.handover.batches.find((batch) => batch.batchId === pkg.batchId || batch.hash === hash);
    if (existed) {
      commit('重复导入回传包', `批次 ${existed.batchId} 已处理过，沿用原有处理结果（${existed.attachedCount} 件已挂回），未重复生成待处理项`, []);
      notify(`批次 ${existed.batchId} 已处理过，沿用已有处理结果`);
      return;
    }
    capture();
    const result = reconcilePackage(state, pkg);
    const mismatchCount = result.issues.length;
    commit('导入扫描回传包', `批次 ${result.batchId}：${result.total} 件，${result.attached} 件按稳定编号挂回；${mismatchCount} 项页数/指纹不一致进入待处理区；${result.missing.length} 件回传缺失标记待补`, []);
    handoverRaw.value = raw;
    handoverFileName.value = fileName;
    handoverFilter.value = 'pending';
    notify(`批次 ${result.batchId} 对账完成：${result.attached} 件挂回，${mismatchCount + result.missing.length} 项待处理`);
  });

  const handleHandoverFile = $(async (_event: Event, element: HTMLInputElement) => {
    const file = element.files?.[0];
    if (!file) return;
    const raw = await file.text();
    handoverRaw.value = raw;
    handoverFileName.value = file.name;
  });

  const submitHandover = $(() => {
    const raw = handoverRaw.value.trim();
    if (raw) runHandoverImport(raw, handoverFileName.value || '粘贴的回传包');
  });

  const loadSampleHandover = $(() => {
    handoverRaw.value = sampleReturnJson;
    handoverFileName.value = '扫描组示例回传包.json';
  });

  const resolveTrustScan = $((issue: HandoverIssue) => {
    capture();
    trustScanReturn(state, issue);
    commit('采用扫描组回传值', `${issueKindLabel[issue.kind]}（${issue.scanId}）：原确认与字段选择保留，记录、审计与导出包按回传更新`, issue.recordId ? [issue.recordId] : []);
    notify('已采用回传值，原确认与字段选择保留并同步更新');
  });

  const resolveTrustLocal = $((issue: HandoverIssue) => {
    capture();
    trustLocalRecord(state, issue);
    commit('保留本机登记', `${issueKindLabel[issue.kind]}（${issue.scanId}）：本机确认结论不变，退回扫描组重扫核对`, issue.recordId ? [issue.recordId] : []);
    notify('保留本机登记，已标记退回重扫');
  });

  const resolveBind = $((issue: HandoverIssue) => {
    const targetId = bindTarget.value[issue.id];
    if (!targetId) {
      notify('请先选择要绑定的原记录');
      return;
    }
    capture();
    bindScanToRecord(state, issue, targetId);
    commit('手工绑定扫描件', `${issue.scanId} 绑定到记录 ${targetId}，编号仅作线索、绑定后以稳定编号为准`, [targetId]);
    notify('扫描件已绑定到原记录');
  });

  const resolveAcknowledge = $((issue: HandoverIssue) => {
    capture();
    acknowledgeMissing(state, issue);
    commit('确认缺件待补', `${issue.scanId} 本批未回传，保留原确认结论，继续标记待补扫`, issue.recordId ? [issue.recordId] : []);
    notify('已知悉，原结论保留并标记待补');
  });

  const updateMatch = $((id: string, status: MatchCandidate['status']) => {
    capture();
    const match = state.matches.find((item) => item.id === id);
    if (!match) return;
    match.status = status;
    match.reviewedAt = new Date().toISOString();
    state.records.forEach((record) => {
      if ((record.id === match.leftId || record.id === match.rightId) && status === 'confirmed') record.status = 'confirmed';
    });
    commit(status === 'confirmed' ? '确认匹配' : '忽略可疑匹配', matchLabel(state, match), [match.leftId, match.rightId]);
    notify(status === 'confirmed' ? '已确认此项匹配' : '已忽略此项匹配');
  });

  const bulkMatch = $((status: MatchCandidate['status']) => {
    const ids = selectedMatchIds.value;
    if (!ids.length) return;
    capture();
    ids.forEach((id) => {
      const match = state.matches.find((item) => item.id === id);
      if (!match) return;
      match.status = status;
      match.reviewedAt = new Date().toISOString();
    });
    commit('批量复核', `${ids.length} 条匹配被标记为${status === 'confirmed' ? '确认' : '忽略'}`, ids.flatMap((id) => {
      const match = state.matches.find((item) => item.id === id);
      return match ? [match.leftId, match.rightId] : [];
    }));
    selectedMatchIds.value = [];
    notify(`已批量处理 ${ids.length} 条匹配`);
  });

  const openMerge = $(() => {
    const match = activeMatch.value;
    if (!match) return;
    state.activeMatchId = match.id;
    fieldLabels.forEach(([field]) => {
      const left = recordById(state, match.leftId);
      const right = recordById(state, match.rightId);
      if (left && right && fieldValue(left, field) === fieldValue(right, field)) choices[field] = 'A';
      else choices[field] = 'A';
    });
    mergeOpen.value = true;
  });

  const choices = useStore<Record<FieldKey, RecordGroup | 'combine'>>({
    title: 'A', date: 'A', people: 'A', places: 'A', identifier: 'A', medium: 'A', extent: 'A', rights: 'A', notes: 'A'
  });

  const mergeCurrent = $(() => {
    const match = activeMatch.value;
    if (!match) return;
    const left = recordById(state, match.leftId);
    const right = recordById(state, match.rightId);
    if (!left || !right) return;
    capture();
    const values: Partial<Record<FieldKey, string>> = {};
    fieldLabels.forEach(([field]) => {
      const source = choices[field];
      const pick = source === 'combine' ? `${fieldValue(left, field)}；${fieldValue(right, field)}` : fieldValue(source === 'A' ? left : right, field);
      values[field] = pick;
    });
    const merged: ArchiveRecord = {
      ...left,
      ...values,
      people: values.people?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.people,
      places: values.places?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.places,
      status: 'merged',
      // 扫描登记沿用：稳定编号与送扫标记不随合并丢失；两侧编号都进入历史，回传按旧编号仍可挂回
      scanId: left.scanId ?? right.scanId,
      scanPages: left.scanPages ?? right.scanPages,
      scanFingerprint: left.scanFingerprint ?? right.scanFingerprint,
      scanSent: left.scanSent || right.scanSent,
      scanAttached: left.scanAttached || right.scanAttached,
      scanPendingSupplement: left.scanPendingSupplement || right.scanPendingSupplement,
      identifierHistory: Array.from(new Set([
        ...(left.identifierHistory ?? []), left.identifier,
        ...(right.identifierHistory ?? []), right.identifier
      ].filter((identifier) => identifier !== values.identifier))),
      updatedAt: new Date().toISOString()
    };
    state.records = [...state.records.filter((record) => record.id !== left.id && record.id !== right.id), merged];
    state.matches.forEach((item) => {
      if (item.id === match.id) item.status = 'merged';
      else if (item.leftId === left.id || item.rightId === right.id || item.leftId === right.id || item.rightId === left.id) item.status = 'rejected';
    });
    state.merges.unshift({
      id: crypto.randomUUID(),
      matchId: match.id,
      leftId: left.id,
      rightId: right.id,
      chosen: { ...choices },
      values,
      mergedAt: new Date().toISOString()
    });
    commit('合并两条记录', `保留 ${Object.values(choices).filter((choice) => choice === 'A').length} 个 A 来源字段、${Object.values(choices).filter((choice) => choice === 'B').length} 个 B 来源字段`, [left.id, right.id, merged.id]);
    mergeOpen.value = false;
    notify('记录已合并，来源与字段选择已写入审计记录');
  });

  const parseImport = $(() => {
    const raw = importRaw.value.trim();
    if (!raw) return;
    let rows: Array<Partial<ArchiveRecord>> = [];
    try {
      if (raw.startsWith('[')) rows = JSON.parse(raw) as Array<Partial<ArchiveRecord>>;
      else {
        const lines = raw.split(/\r?\n/).filter(Boolean);
        rows = lines.map((line, index) => {
          const cells = line.split(/\t|\|/).map((cell) => cell.trim());
          return {
            title: cells[0] || `未命名记录 ${index + 1}`,
            date: cells[1] || '',
            people: (cells[2] || '').split(/[，,、]/).filter(Boolean),
            places: (cells[3] || '').split(/[，,、]/).filter(Boolean),
            identifier: cells[4] || '',
            medium: cells[5] || '',
            extent: cells[6] || '',
            rights: cells[7] || '',
            notes: cells[8] || ''
          };
        });
      }
    } catch {
      notify('导入内容格式不正确，请使用 JSON 数组或制表符分隔文本');
      return;
    }
    if (!rows.length) return;
    capture();
    rows.forEach((row) => {
      const record: ArchiveRecord = {
        id: crypto.randomUUID(),
        group: importGroup.value,
        title: row.title || '未命名记录',
        date: row.date || '',
        people: Array.isArray(row.people) ? row.people : String(row.people || '').split(/[，,、]/).filter(Boolean),
        places: Array.isArray(row.places) ? row.places : String(row.places || '').split(/[，,、]/).filter(Boolean),
        identifier: row.identifier || '',
        medium: row.medium || '',
        extent: row.extent || '',
        rights: row.rights || '',
        notes: row.notes || '',
        updatedAt: new Date().toISOString(),
        status: 'unreviewed'
      };
      state.records.push(record);
    });
    state.matches = computeMatches(state.records);
    commit('导入档案记录', `从 ${importGroup.value} 组导入 ${rows.length} 条记录`, []);
    importRaw.value = '';
    importText.value = '';
    importOpen.value = false;
    notify(`已导入 ${rows.length} 条记录并重新匹配`);
  });

  const importFile = $(async (_event: Event, element: HTMLInputElement) => {
    const file = element.files?.[0];
    if (!file) return;
    importRaw.value = await file.text();
    importText.value = file.name;
  });

  const exportAudit = $(() => {
    const blob = new Blob([JSON.stringify({
      exportedAt: new Date().toISOString(),
      records: state.records,
      matches: state.matches,
      merges: state.merges,
      handover: state.handover,
      audit: state.audit
    }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `档案元数据核对结果-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  });

  const moveReview = $((delta: number) => {
    const list = filteredMatches.value;
    const index = list.findIndex((match) => match.id === activeMatch.value?.id);
    const next = list[Math.max(0, Math.min(list.length - 1, index + delta))];
    if (next) {
      state.activeMatchId = next.id;
      document.querySelector(`[data-match-id="${next.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  useVisibleTask$(() => {
    try {
      let raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        // 首次打开 v2：迁移 v1 工作区，已有的确认结论与字段选择原样保留
        const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacy) {
          const migrated = JSON.parse(legacy) as Partial<ArchiveState>;
          migrated.handover = { issues: [], batches: [] };
          raw = JSON.stringify(migrated);
          localStorage.setItem(STORAGE_KEY, raw);
        }
      }
      if (raw) {
        const saved = JSON.parse(raw) as Partial<ArchiveState>;
        restore(JSON.stringify(saved));
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
    state.hydrated = true;
  });

  useVisibleTask$(({ track }) => {
    const payload = track(() => JSON.stringify({
      revision: state.revision, records: state.records, matches: state.matches,
      merges: state.merges, audit: state.audit, handover: state.handover
    }));
    if (state.hydrated) localStorage.setItem(STORAGE_KEY, payload);
  });

  useVisibleTask$(({ cleanup }) => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editing = /INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') { event.preventDefault(); importOpen.value = true; return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'h') { event.preventDefault(); handoverOpen.value = true; return; }
      if (editing) return;
      const key = event.key.toLowerCase();
      if (key === 'j') { event.preventDefault(); moveReview(1); }
      if (key === 'k') { event.preventDefault(); moveReview(-1); }
      if (event.key === 'Enter' && activeMatch.value) { event.preventDefault(); openMerge(); }
      if (key === 'c' && activeMatch.value) { event.preventDefault(); updateMatch(activeMatch.value.id, 'confirmed'); }
      if (key === 'r' && activeMatch.value) { event.preventDefault(); updateMatch(activeMatch.value.id, 'rejected'); }
      if (key === '?' || (event.shiftKey && event.key === '/')) { event.preventDefault(); panelTab.value = 2; }
    };
    window.addEventListener('keydown', handler);
    cleanup(() => window.removeEventListener('keydown', handler));
  });

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-seal">档</div>
          <div><h1>档案元数据核对台</h1><p>ARCHIVE RECONCILIATION DESK</p></div>
        </div>
        <div class="top-stat"><span class="online-dot" />{state.hydrated ? `离线保存 · r${state.revision}` : '正在恢复本地工作区'}</div>
        <div class="top-actions">
          <button class="icon-button" disabled={!history.value.length} onClick$={undo}>撤销</button>
          <button class="icon-button" disabled={!future.value.length} onClick$={redo}>重做</button>
          <button class="button handover-button" onClick$={() => handoverOpen.value = true}>
            移交对账{pendingCount.value > 0 && <span class="handover-badge">{pendingCount.value}</span>}
          </button>
          <button class="button ghost" onClick$={() => importOpen.value = true}>导入两组记录</button>
          <button class="button light" onClick$={exportAudit}>导出核对包</button>
        </div>
      </header>

      <div class="overview">
        <div><span class="eyebrow">RECONCILIATION PROJECT</span><h2>口述史与手稿元数据比对</h2><p>逐条确认可疑匹配，保留每个字段的来源选择，并留下可追溯的处理记录。</p></div>
        <div class="metrics">
          <div><strong>{state.records.filter((record) => record.group === 'A').length}</strong><span>A 组记录</span></div>
          <div><strong>{state.records.filter((record) => record.group === 'B').length}</strong><span>B 组记录</span></div>
          <div><strong>{state.matches.filter((match) => match.status === 'suggested').length}</strong><span>待复核匹配</span></div>
          <div class={pendingCount.value > 0 ? 'danger' : ''}><strong>{pendingCount.value}</strong><span>移交待处理</span></div>
          <div class="danger"><strong>{conflictCount.value}</strong><span>低分可疑项</span></div>
        </div>
      </div>

      <main class="desk-grid">
        <section class="panel match-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">01 / MATCH QUEUE</span><h3>匹配核对队列</h3></div>
            <span class="shortcut-hint">J / K 移动 · Enter 合并</span>
          </div>
          <div class="toolbar-row">
            <select class="input" value={statusFilter.value} onChange$={(event) => { statusFilter.value = (event.target as HTMLSelectElement).value as typeof statusFilter.value; }}>
              <option value="all">全部匹配</option><option value="suggested">待复核</option><option value="confirmed">已确认</option><option value="rejected">已忽略</option>
            </select>
            <button class="button small" disabled={!selectedMatchIds.value.length} onClick$={() => bulkMatch('confirmed')}>批量确认</button>
            <button class="button small ghost" disabled={!selectedMatchIds.value.length} onClick$={() => bulkMatch('rejected')}>批量忽略</button>
          </div>
          <div class="match-list">
            {visibleMatches.value.map((match) => {
              const left = recordById(state, match.leftId);
              const right = recordById(state, match.rightId);
              const isActive = () => state.activeMatchId === match.id;
              return (
                <article
                  data-match-id={match.id}
                  class={`match-card ${isActive() ? 'active' : ''}`}
                  onClick$={() => { state.activeMatchId = match.id; }}
                  tabIndex={0}
                >
                  <div class="match-topline">
                    <Checkbox.Root
                      class="qwik-check"
                      aria-label={`选择匹配 ${match.id}`}
                      initialValue={selectedMatchIds.value.includes(match.id)}
                      onClick$={(event: Event) => {
                        event.stopPropagation();
                        selectedMatchIds.value = selectedMatchIds.value.includes(match.id)
                          ? selectedMatchIds.value.filter((id) => id !== match.id)
                          : [...selectedMatchIds.value, match.id];
                      }}
                    ><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Root>
                    <span class={`score ${match.score < .68 ? 'low' : ''}`}>{Math.round(match.score * 100)}%</span>
                    <span class={`status ${match.status}`}>{match.status === 'suggested' ? '待复核' : match.status === 'confirmed' ? '已确认' : match.status === 'rejected' ? '已忽略' : '已合并'}</span>
                    <span class="record-id">{left?.identifier}</span>
                  </div>
                  <div class="pair-preview">
                    <div><small>A · {left?.group}</small><strong>{left?.title}</strong><span>{parseDate(left?.date ?? '')} · {left?.people.join('、')}</span></div>
                    <i>↔</i>
                    <div><small>B · {right?.group}</small><strong>{right?.title}</strong><span>{parseDate(right?.date ?? '')} · {right?.people.join('、')}</span></div>
                  </div>
                  <div class="reason-line">{match.reasons.join(' · ')}</div>
                </article>
              );
            })}
            {!visibleMatches.value.length && <div class="empty-state">没有符合当前筛选条件的匹配。</div>}
          </div>
        </section>

        <section class="panel records-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">02 / RECORD INDEX</span><h3>档案记录索引</h3></div>
            <span class="shortcut-hint">分页渲染 · 当前 {filteredRecords.value.length} 条</span>
          </div>
          <div class="toolbar-row">
            <input class="input search" placeholder="搜索标题、日期、人物、地点或编号" value={query.value} onInput$={(event) => { query.value = (event.target as HTMLInputElement).value; visibleCount.value = 80; }} />
            <select class="input compact" value={groupFilter.value} onChange$={(event) => { groupFilter.value = (event.target as HTMLSelectElement).value as typeof groupFilter.value; visibleCount.value = 80; }}>
              <option value="all">A + B</option><option value="A">A 组</option><option value="B">B 组</option>
            </select>
          </div>
          <div class="record-table">
            <div class="table-head"><span>来源</span><span>标题</span><span>日期 / 人物 / 地点</span><span>编号</span><span>状态</span></div>
            {filteredRecords.value.map((record) => (
              <div class="table-row" key={record.id}>
                <span class={`group-badge ${record.group.toLowerCase()}`}>{record.group}</span>
                <strong>{record.title}</strong>
                <span>{parseDate(record.date)}<small>{record.people.join('、')} · {record.places.join('、')}</small></span>
                <code>
                  {record.identifier}
                  {(record.identifierHistory ?? []).length > 0 && <em class="old-id" title={`曾用编号：${record.identifierHistory!.join('、')}`}>曾用 {record.identifierHistory![0]}</em>}
                  {record.scanId && <em class={`scan-chip ${record.scanPendingSupplement ? 'missing' : record.scanAttached ? 'attached' : 'sent'}`} title={`文件指纹 ${record.scanFingerprint || '未登记'}`}>
                    扫 {record.scanId}{record.scanAttached ? ' · 已回传' : record.scanPendingSupplement ? ' · 待补' : ' · 送扫中'}
                  </em>}
                </code>
                <span class={`record-status ${record.status}`}>{record.status === 'unreviewed' ? '未核对' : record.status === 'confirmed' ? '已确认' : record.status === 'rejected' ? '已忽略' : '已合并'}</span>
              </div>
            ))}
          </div>
          {filteredRecords.value.length >= visibleCount.value && <button class="load-more" onClick$={() => visibleCount.value += 80}>加载下 80 条记录</button>}
        </section>

        <section class="panel review-panel">
          <Tabs.Root bind:selectedIndex={panelTab} class="review-tabs">
            <Tabs.List class="tab-list"><Tabs.Tab>复核详情</Tabs.Tab><Tabs.Tab>合并追溯</Tabs.Tab><Tabs.Tab>键盘帮助</Tabs.Tab></Tabs.List>
            <Tabs.Panel class="tab-panel">
              {activeMatch.value ? (() => {
                const left = recordById(state, activeMatch.value!.leftId)!;
                const right = recordById(state, activeMatch.value!.rightId)!;
                return <>
                  <div class="active-score"><span>{Math.round(activeMatch.value!.score * 100)}</span><div><strong>综合匹配分</strong><small>{activeMatch.value!.reasons.join(' · ')}</small></div></div>
                  <div class="field-compare compact"><div class="field-label">字段</div><div>A 来源</div><div>B 来源</div>
                    {fieldLabels.map(([field, label]) => <><div class="field-label">{label}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(left, field) || '—'}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(right, field) || '—'}</div></>)}
                  </div>
                  <div class="action-stack"><button class="button primary wide" onClick$={openMerge}>逐字段合并</button><div class="split-actions"><button class="button confirm" onClick$={() => updateMatch(activeMatch.value!.id, 'confirmed')}>确认匹配</button><button class="button ghost" onClick$={() => updateMatch(activeMatch.value!.id, 'rejected')}>忽略</button></div></div>
                </>;
              })() : <div class="empty-state">从左侧选择一条匹配查看字段来源。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel">
              {state.merges.length ? state.merges.map((merge) => {
                const left = recordById(state, merge.leftId);
                const right = recordById(state, merge.rightId);
                const survivor = recordById(state, merge.id);
                return <details class="merge-log" key={merge.id}><summary>{survivor?.title ?? left?.title ?? merge.leftId} ↔ {right?.title ?? merge.rightId}</summary><p>{new Date(merge.mergedAt).toLocaleString('zh-CN')}{survivor?.scanId ? ` · 扫描件 ${survivor.scanId}` : ''}</p><ul>{Object.entries(merge.chosen).map(([field, choice]) => <li key={field}><strong>{fieldLabels.find(([key]) => key === field)?.[1]}</strong><span>保留 {choice === 'A' ? 'A 来源' : choice === 'B' ? 'B 来源' : '双来源拼接'}：{merge.values[field as FieldKey]}</span></li>)}</ul>{(merge.scanOverrides ?? []).length > 0 && <div class="scan-overrides"><strong>移交对账更新</strong>{merge.scanOverrides!.map((override, index) => <p key={index}><span>{fieldLabels.find(([key]) => key === override.field)?.[1] ?? override.field}</span>{override.from} → <b>{override.to}</b><small>{new Date(override.at).toLocaleString('zh-CN')} · {override.reason}</small></p>)}</div>}</details>;
              }) : <div class="empty-state">还没有合并记录。完成一次字段合并后，来源选择会出现在这里。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel shortcut-panel">
              <div><kbd>J / K</kbd><span>下一条 / 上一条可疑匹配</span></div><div><kbd>Enter</kbd><span>打开逐字段合并窗口</span></div><div><kbd>C / R</kbd><span>确认 / 忽略当前匹配</span></div><div><kbd>Ctrl + Z / Y</kbd><span>撤销 / 重做</span></div><div><kbd>Ctrl + I</kbd><span>打开导入窗口</span></div><div><kbd>Ctrl + H</kbd><span>打开扫描组移交对账</span></div><div><kbd>Ctrl/⌘ + Enter</kbd><span>在导入框中提交记录</span></div>
            </Tabs.Panel>
          </Tabs.Root>
        </section>
      </main>

      <section class="bottom-grid">
        <article class="panel audit-panel">
          <div class="panel-heading"><div><span class="eyebrow">03 / TRACE</span><h3>最新处理记录</h3></div><span>{state.audit.length} 条</span></div>
          <div class="audit-list">
            {state.audit.slice(0, 8).map((entry) => <div class="audit-entry" key={entry.id}><time>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><div><strong>{entry.action}</strong><p>{entry.detail}</p></div><span>{entry.recordIds.length ? `${entry.recordIds.length} 条记录` : '系统'}</span></div>)}
          </div>
        </article>
        <article class="panel explanation-panel">
          <div class="panel-heading"><div><span class="eyebrow">METHOD</span><h3>匹配与保护规则</h3></div></div>
          <p>标题、日期、人物、地点和编号按权重综合评分。低于 68% 的候选会以红色标记，但系统不会替研究者自动决定。</p>
          <div class="rule-row"><span>1</span><p>每个字段保留 A / B 来源，可在合并窗口中单独选择或拼接。</p></div>
          <div class="rule-row"><span>2</span><p>原始记录、合并结果和忽略理由都进入本地审计轨迹。</p></div>
          <div class="rule-row"><span>3</span><p>记录列表使用分批窗口渲染，导入大量数据时仍只挂载当前窗口。</p></div>
          <div class="rule-row"><span>4</span><p>扫描组回传只含编号、页数与指纹：扫描件按送扫稳定编号挂回，页数或指纹不符先进待处理区；本机原确认与字段选择始终保留。</p></div>
        </article>
      </section>

      {toast.value && <div class="toast">{toast.value}</div>}

      <Modal.Root bind:show={importOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel import-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">IMPORT</span><Modal.Title>导入一组档案记录</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">支持 JSON 数组或制表符 / 竖线分隔文本。字段顺序：标题、日期、人物、地点、编号、载体、数量、权利、备注。</Modal.Description>
          <div class="import-controls">
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'A'} onChange$={() => importGroup.value = 'A'} /><span><strong>A 组</strong><small>口述史 / 主要记录</small></span></label>
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'B'} onChange$={() => importGroup.value = 'B'} /><span><strong>B 组</strong><small>手稿 / 待合并记录</small></span></label>
            <label class="file-button">选择文件<input type="file" accept=".json,.txt,.csv,.tsv" onChange$={(event, element) => importFile(event, element)} /></label>
          </div>
          <textarea class="modal-textarea" value={importRaw.value} onInput$={(event) => importRaw.value = (event.target as HTMLTextAreaElement).value} placeholder="李秀珍口述史访谈 | 2019-04-12 | 李秀珍、周明远 | 临河县 | OH-LXZ-2019-01 | 数字录音 | 02:14:38 | 研究者授权 | ..." />
          {importText.value && <div class="file-name">已读取：{importText.value}</div>}
          <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" disabled={!importRaw.value.trim()} onClick$={parseImport}>导入并重新匹配</button></Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      <Modal.Root bind:show={mergeOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel merge-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">FIELD MERGE</span><Modal.Title>逐字段选择保留来源</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          {activeMatch.value && (() => {
            const left = recordById(state, activeMatch.value!.leftId)!;
            const right = recordById(state, activeMatch.value!.rightId)!;
            return <>
              <Modal.Description class="modal-description">每个字段都显示两条记录的原始来源。选择后，生成一条新合并记录，原记录编号与选择依据仍保留在审计轨迹中。</Modal.Description>
              <div class="field-picker-head"><span>字段</span><span>A 组来源</span><span>B 组来源</span></div>
              <div class="field-picker">
                {fieldLabels.map(([field, label]) => {
                  const leftValue = fieldValue(left, field) || '—';
                  const rightValue = fieldValue(right, field) || '—';
                  const same = leftValue === rightValue;
                  return <div class={`field-picker-row ${same ? 'same' : 'conflict'}`} key={field}><div class="picker-label"><strong>{label}</strong>{same ? <small>一致</small> : <small>冲突</small>}</div><label class={`source-option ${choices[field] === 'A' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={choices[field] === 'A'} onChange$={() => choices[field] = 'A'} /><span><b>A</b>{leftValue}</span></label><label class={`source-option ${choices[field] === 'B' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={choices[field] === 'B'} onChange$={() => choices[field] = 'B'} /><span><b>B</b>{rightValue}</span></label><button class={`combine-button ${choices[field] === 'combine' ? 'selected' : ''}`} onClick$={() => choices[field] = 'combine'} title="拼接两侧内容">拼接</button></div>;
                })}
              </div>
              <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" onClick$={mergeCurrent}>生成合并记录</button></Modal.Footer>
            </>;
          })()}
        </Modal.Panel>
      </Modal.Root>

      <Modal.Root bind:show={handoverOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel handover-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">SCAN HANDOVER</span><Modal.Title>扫描组移交对账</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">回传包只含扫描件编号、页数和文件指纹。扫描件按送扫时发放的稳定编号挂回原记录（本机编号改过也不错配）；页数或指纹不一致先进入待处理区，由处理人选定可信来源后，原确认、字段选择、审计与导出包一起更新。</Modal.Description>

          <div class="handover-summary">
            <div><strong>{handoverStats.value.sent}</strong><span>已登记送扫</span></div>
            <div><strong>{handoverStats.value.attached}</strong><span>已挂回</span></div>
            <div class={handoverStats.value.pending ? 'danger' : ''}><strong>{handoverStats.value.pending}</strong><span>待补扫</span></div>
            <div><strong>{handoverStats.value.batches}</strong><span>回传批次</span></div>
            <div class={pendingCount.value ? 'danger' : ''}><strong>{pendingCount.value}</strong><span>待处理项</span></div>
          </div>

          <div class="handover-import">
            <label class="file-button">选择回传包<input type="file" accept=".json" onChange$={(event, element) => handleHandoverFile(event, element)} /></label>
            <button class="button small ghost" onClick$={loadSampleHandover}>载入示例回传包</button>
            {handoverFileName.value && <span class="file-name inline">已读取：{handoverFileName.value}</span>}
            <button class="button small primary" disabled={!handoverRaw.value.trim()} onClick$={submitHandover}>开始对账</button>
          </div>
          <textarea class="modal-textarea handover-textarea" value={handoverRaw.value} onInput$={(event) => { handoverRaw.value = (event.target as HTMLTextAreaElement).value; handoverFileName.value = ''; }} placeholder='{"batchId":"SCAN-2026-09-30-A","entries":[{"scanId":"SM-1006","pages":35,"fingerprint":"sha256:…","ref":"MANU-LSA-98"}]}' />

          <div class="handover-queue-head">
            <span class="eyebrow">PENDING QUEUE · 待处理区</span>
            <div class="issue-filter">
              <button class={handoverFilter.value === 'pending' ? 'active' : ''} onClick$={() => handoverFilter.value = 'pending'}>待处理</button>
              <button class={handoverFilter.value === 'resolved' ? 'active' : ''} onClick$={() => handoverFilter.value = 'resolved'}>已处理</button>
              <button class={handoverFilter.value === 'all' ? 'active' : ''} onClick$={() => handoverFilter.value = 'all'}>全部</button>
            </div>
          </div>

          <div class="issue-list">
            {filteredIssues.value.map((issue) => {
              const record = issue.recordId ? recordById(state, issue.recordId) : undefined;
              const matchScore = issue.mergedRecordId
                ? state.matches.find((match) => match.id === state.merges.find((merge) => merge.id === issue.mergedRecordId)?.matchId)?.score
                : issue.recordId
                  ? state.matches.filter((match) => match.status !== 'rejected' && (match.leftId === issue.recordId || match.rightId === issue.recordId)).sort((a, b) => b.score - a.score)[0]?.score
                  : undefined;
              return (
                <article class={`issue-card kind-${issue.kind} status-${issue.status}`} key={issue.id}>
                  <div class="issue-head">
                    <span class={`issue-kind kind-${issue.kind}`}>{issueKindLabel[issue.kind]}</span>
                    <code class="issue-scan">{issue.scanId ?? '—'}</code>
                    <span class="issue-confidence" title="挂匹配置信：稳定编号直接挂回为 100">挂回 {issue.confidence}%</span>
                    {matchScore !== undefined && <span class="issue-match-score" title={issue.mergedRecordId ? '受影响合并记录对应的核对匹配分数' : '该记录当前最强候选匹配的分数'}>{issue.mergedRecordId ? '合并匹配' : '核对匹配'} {Math.round(matchScore * 100)}%</span>}
                    <span class={`issue-status ${issue.status}`}>{issueStatusLabel[issue.status]}</span>
                    <span class="issue-batch">{issue.batchId}</span>
                  </div>
                  {issue.mergedRecordId && <div class="issue-merge">受影响的合并记录：<strong>{issue.mergedRecordTitle ?? record?.title ?? issue.mergedRecordId}</strong></div>}
                  <div class="issue-body">
                    <div class="issue-record">{record ? record.title : '未挂回记录'}{record && <small>{record.identifier} · {record.group} 组</small>}</div>
                    <div class="issue-values"><span class="local">本机：{issue.localValue ?? '—'}</span><i>→</i><span class="remote">回传：{issue.remoteValue ?? '—'}</span></div>
                    {issue.note && <p class="issue-note">{issue.note}</p>}
                    {issue.resolution && <p class="issue-resolution">处理：{issue.resolution}{issue.resolvedAt ? ` · ${new Date(issue.resolvedAt).toLocaleString('zh-CN')}` : ''}</p>}
                  </div>
                  {issue.status === 'pending' && (
                    <div class="issue-actions">
                      {issue.kind === 'unmatched-scan' ? (
                        <>
                          <select class="input compact" value={bindTarget.value[issue.id] ?? ''} onChange$={(event) => { bindTarget.value = { ...bindTarget.value, [issue.id]: (event.target as HTMLSelectElement).value }; }}>
                            <option value="" disabled>选择原记录绑定…</option>
                            {state.records.filter((item) => !item.scanId).map((item) => <option value={item.id} key={item.id}>{`${item.identifier} · ${item.title}`}</option>)}
                          </select>
                          <button class="button small primary" onClick$={() => resolveBind(issue)}>绑定并挂回</button>
                          <span class="action-hint">编号仅作线索，绑定后以稳定编号为准</span>
                        </>
                      ) : issue.kind === 'missing-return' ? (
                        <>
                          <button class="button small confirm" onClick$={() => resolveAcknowledge(issue)}>知悉，标记待补</button>
                          <span class="action-hint">原确认与字段选择保留不变</span>
                        </>
                      ) : (
                        <>
                          <button class="button small primary" onClick$={() => resolveTrustScan(issue)}>可信来源：扫描回传</button>
                          <button class="button small ghost" onClick$={() => resolveTrustLocal(issue)}>可信来源：本机登记（退回重扫）</button>
                        </>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
            {!filteredIssues.value.length && <div class="empty-state">没有符合当前筛选的对账项。导入扫描组回传包后，页数或指纹不一致的扫描件会列在这里。</div>}
          </div>

          <div class="handover-batches">
            <span class="eyebrow">BATCH LEDGER</span>
            {state.handover.batches.length === 0 && <p class="empty-inline">尚无回传批次；同一批重复导入会自动沿用已有处理结果。</p>}
            {state.handover.batches.slice(0, 6).map((batch) => (
              <div class="batch-row" key={batch.batchId}>
                <code>{batch.batchId}</code>
                <span>{batch.entryCount} 件</span>
                <span>{batch.attachedCount} 件挂回</span>
                <span>{batch.issueIds.length} 项对账记录</span>
                <small>{new Date(batch.importedAt).toLocaleString('zh-CN')} · fp {batch.hash.slice(0, 8)}</small>
              </div>
            ))}
          </div>
        </Modal.Panel>
      </Modal.Root>
    </div>
  );
});
