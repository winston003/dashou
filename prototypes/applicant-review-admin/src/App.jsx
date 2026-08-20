import { useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  CalendarBlank,
  CaretDown,
  CaretLeft,
  CaretRight,
  Check,
  CheckCircle,
  Clock,
  CloudCheck,
  FunnelSimple,
  LockSimple,
  MagnifyingGlass,
  Question,
  ShieldCheck,
  UserCircle,
  WarningCircle,
  X,
  XCircle,
} from "@phosphor-icons/react";

const statusMeta = {
  pending: { label: "待审核", icon: Clock },
  provisioning: { label: "开通中", icon: ArrowClockwise },
  approved: { label: "待领取", icon: CheckCircle },
  activated: { label: "已开通", icon: CheckCircle },
  expired: { label: "已到期", icon: Clock },
  rejected: { label: "未通过", icon: XCircle },
  revoked: { label: "已撤销", icon: XCircle },
};

const filterOptions = [
  ["all", "全部"],
  ["pending", "待审核"],
  ["processing", "开通中"],
  ["activated", "已开通"],
  ["rejected", "未通过"],
  ["expired", "已到期"],
  ["revoked", "已撤销"],
];

const periodOptions = [
  ["week", "周", "1 周"],
  ["month", "月", "1 个月"],
  ["quarter", "季", "1 个季度"],
  ["year", "年", "1 年"],
];

const eventLabels = {
  app_opened: "打开客户端",
  first_seen: "首次被分析版本观测到",
  first_launch: "首次启动（旧版事件）",
  application_submit_started: "点击申请",
  application_submitted: "申请发送成功",
  application_submit_failed: "申请发送失败",
  application_status_failed: "状态查询失败",
  activation_completed: "领取配置完成",
  folders_selected: "已选择文件夹",
  runtime_start_started: "开始启动服务",
  runtime_started: "本地服务可用",
  runtime_start_failed: "本地服务启动失败",
  chatgpt_opened: "前往 ChatGPT",
  connection_password_copied: "复制授权密码",
  notification_enabled: "已开启准备完成提醒",
  first_mcp_connection: "首次 MCP 连接",
  first_tool_call_attempt: "首次工具调用尝试",
  first_tool_call_success: "首次工具调用成功",
  first_tool_call_failure: "首次工具调用失败",
  first_mcp_use: "首次 MCP 工具调用（旧版事件）",
};

const auditLabels = {
  approved: "管理员批准申请",
  rejected: "管理员标记未通过",
  reopened: "申请重新进入审核",
  period_changed: "管理员调整授权期限",
  authorization_extended: "管理员延长授权",
  authorization_changed: "管理员修改授权日期",
  revoked: "管理员撤销权限",
  restored: "管理员恢复权限",
  profile_updated: "管理员更新基本信息",
  note_added: "管理员添加内部备注",
};

function StatusBadge({ status }) {
  const meta = statusMeta[status] ?? { label: status || "未知", icon: Clock };
  const Icon = meta.icon;
  return (
    <span className={`status-badge status-${status}`}>
      <Icon size={15} weight="bold" aria-hidden="true" />
      {meta.label}
    </span>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2 id="modal-title">{title}</h2>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭弹窗" title="关闭">
            <X size={20} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

export function App() {
  const [applications, setApplications] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedDetail, setSelectedDetail] = useState(null);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [period, setPeriod] = useState("month");
  const [modal, setModal] = useState(null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [profileNickname, setProfileNickname] = useState("");
  const [profileNote, setProfileNote] = useState("");
  const [expiresAtInput, setExpiresAtInput] = useState("");
  const [toast, setToast] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [listError, setListError] = useState("");
  const [actionError, setActionError] = useState("");
  const [lastUpdated, setLastUpdated] = useState(null);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [analytics, setAnalytics] = useState(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState("");

  useEffect(() => {
    void loadApplications();
    void loadAnalytics();
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setSelectedDetail(null);
      return;
    }
    setTimelineExpanded(false);
    const controller = new AbortController();
    setDetailLoading(true);
    setSelectedDetail(null);
    apiRequest(`/api/admin/applications/${encodeURIComponent(selectedId)}`, { signal: controller.signal })
      .then((payload) => setSelectedDetail(payload))
      .catch((error) => {
        if (error.name !== "AbortError") setSelectedDetail({ error: error.message });
      })
      .finally(() => setDetailLoading(false));
    return () => controller.abort();
  }, [selectedId]);

  const counts = useMemo(() => {
    const next = { all: applications.length, processing: 0 };
    for (const application of applications) {
      next[application.status] = (next[application.status] ?? 0) + 1;
      if (["provisioning", "approved"].includes(application.status)) next.processing += 1;
    }
    return next;
  }, [applications]);

  const visibleApplications = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return applications.filter((application) => {
      const matchesStatus = filter === "all"
        || application.status === filter
        || (filter === "processing" && ["provisioning", "approved"].includes(application.status));
      const haystack = [
        application.applicationId,
        application.contact,
        application.deviceName,
        application.nickname,
        application.profileNote,
        application.platform,
      ].filter(Boolean).join(" ").toLowerCase();
      return matchesStatus && (!normalized || haystack.includes(normalized));
    });
  }, [applications, filter, query]);

  const selected = selectedDetail?.application
    ?? applications.find((application) => application.applicationId === selectedId)
    ?? null;
  const periodLabel = periodOptions.find(([value]) => value === period)?.[2] ?? "1 个月";
  const timeline = useMemo(() => buildTimeline(selected, selectedDetail?.events ?? [], selectedDetail?.auditEvents ?? []), [selected, selectedDetail]);
  const visibleTimeline = timelineExpanded ? timeline : timeline.slice(-3);

  async function loadApplications({ keepSelection = true } = {}) {
    setListLoading(true);
    setListError("");
    try {
      const payload = await apiRequest("/api/admin/applications");
      const next = [...(payload.applications ?? [])].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
      setApplications(next);
      setLastUpdated(new Date());
      setSelectedId((current) => {
        if (keepSelection && current && next.some((application) => application.applicationId === current)) return current;
        return next.find((application) => application.status === "pending")?.applicationId ?? next[0]?.applicationId ?? null;
      });
    } catch (error) {
      setListError(error.message);
    } finally {
      setListLoading(false);
    }
  }

  async function loadAnalytics() {
    setAnalyticsLoading(true);
    setAnalyticsError("");
    try {
      setAnalytics(await apiRequest("/api/admin/analytics"));
    } catch (error) {
      setAnalyticsError(error.message);
    } finally {
      setAnalyticsLoading(false);
    }
  }

  async function refreshData() {
    await Promise.all([loadApplications(), loadAnalytics()]);
  }

  function selectApplication(id) {
    setSelectedId(id);
    setDrawerOpen(true);
    setModal(null);
    setActionError("");
  }

  function notify(message) {
    setToast(message);
    window.setTimeout(() => setToast(""), 3200);
  }

  async function approveSelected() {
    if (!selected) return;
    setSubmitting(true);
    setActionError("");
    try {
      await apiRequest(`/api/admin/applications/${encodeURIComponent(selected.applicationId)}/approve`, {
        method: "POST",
        body: JSON.stringify({ period }),
      });
      setModal(null);
      notify(`已批准 ${applicationTitle(selected)}，系统正在准备连接`);
      await loadApplications();
      await reloadSelectedDetail();
    } catch (error) {
      setActionError(error.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function rejectSelected() {
    if (!selected || !reason.trim()) return;
    setSubmitting(true);
    setActionError("");
    try {
      await apiRequest(`/api/admin/applications/${encodeURIComponent(selected.applicationId)}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() }),
      });
      setModal(null);
      setReason("");
      notify(`已记录 ${applicationTitle(selected)} 的审核结果`);
      await loadApplications();
      await reloadSelectedDetail();
    } catch (error) {
      setActionError(error.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function reopenSelected() {
    if (!selected || !reason.trim()) return;
    await submitAction(`/api/admin/applications/${encodeURIComponent(selected.applicationId)}/reopen`, { reason: reason.trim() }, "已重新打开申请，等待再次审核");
  }

  async function changePeriodSelected() {
    if (!selected || !reason.trim()) return;
    await submitAction(`/api/admin/applications/${encodeURIComponent(selected.applicationId)}/period`, { period, reason: reason.trim() }, `授权期限已改为${periodLabel}`);
  }

  async function extendSelected() {
    if (!selected || !reason.trim()) return;
    await submitAction(`/api/admin/applications/${encodeURIComponent(selected.applicationId)}/extend`, { period, reason: reason.trim() }, `授权已延长${periodLabel}`);
  }

  async function revokeSelected() {
    if (!selected || !reason.trim()) return;
    await submitAction(`/api/admin/applications/${encodeURIComponent(selected.applicationId)}/revoke`, { reason: reason.trim() }, "设备权限已撤销");
  }

  async function restoreSelected() {
    if (!selected || !reason.trim()) return;
    await submitAction(`/api/admin/applications/${encodeURIComponent(selected.applicationId)}/restore`, { reason: reason.trim() }, "设备权限已恢复");
  }

  async function editAuthorizationSelected() {
    if (!selected || !expiresAtInput || !reason.trim()) return;
    const expiresAt = new Date(expiresAtInput);
    if (!Number.isFinite(expiresAt.getTime())) {
      setActionError("请输入有效的授权到期时间");
      return;
    }
    await submitAction(`/api/admin/applications/${encodeURIComponent(selected.applicationId)}/authorization`, { expiresAt: expiresAt.toISOString(), reason: reason.trim() }, "授权到期时间已更新");
  }

  async function editProfileSelected() {
    if (!selected) return;
    setSubmitting(true);
    setActionError("");
    try {
      await apiRequest(`/api/admin/applications/${encodeURIComponent(selected.applicationId)}/profile`, {
        method: "POST",
        body: JSON.stringify({ nickname: profileNickname.trim() || null, profileNote: profileNote.trim() || null }),
      });
      setModal(null);
      notify("基本信息已更新");
      await loadApplications();
      await reloadSelectedDetail();
    } catch (error) {
      setActionError(error.message);
    } finally {
      setSubmitting(false);
    }
  }

  function openProfileEditor() {
    setProfileNickname(selected?.nickname || "");
    setProfileNote(selected?.profileNote || "");
    setActionError("");
    setModal("profile");
  }

  function openAuthorizationEditor() {
    setExpiresAtInput(toDateTimeLocal(selected?.expiresAt));
    setReason("");
    setActionError("");
    setModal("authorization");
  }

  async function addNoteSelected() {
    if (!selected || !note.trim()) return;
    setSubmitting(true);
    setActionError("");
    try {
      await apiRequest(`/api/admin/applications/${encodeURIComponent(selected.applicationId)}/notes`, {
        method: "POST",
        body: JSON.stringify({ note: note.trim() }),
      });
      setModal(null);
      setNote("");
      notify("内部备注已记录");
      await loadApplications();
      await reloadSelectedDetail();
    } catch (error) {
      setActionError(error.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function submitAction(path, body, message) {
    setSubmitting(true);
    setActionError("");
    try {
      await apiRequest(path, { method: "POST", body: JSON.stringify(body) });
      setModal(null);
      setReason("");
      notify(message);
      await loadApplications();
      await reloadSelectedDetail();
    } catch (error) {
      setActionError(error.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function reloadSelectedDetail() {
    if (!selectedId) return;
    try {
      const payload = await apiRequest(`/api/admin/applications/${encodeURIComponent(selectedId)}`);
      setSelectedDetail(payload);
    } catch (error) {
      setSelectedDetail({ error: error.message });
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <strong>搭手 Dashou</strong>
          <span>在线申请审核</span>
        </div>
        <div className="topbar-actions">
          <span className="live-state"><CloudCheck size={18} weight="fill" />线上控制面</span>
          <button className="help-button" type="button" onClick={() => notify("审核数据来自 Dashou 线上控制面")}><Question size={19} />帮助</button>
          <div className="profile-wrap">
            <button className="profile-button" type="button" onClick={() => setProfileOpen((value) => !value)} aria-expanded={profileOpen}>
              <UserCircle size={25} weight="duotone" /><span>管理员</span><CaretDown size={15} />
            </button>
            {profileOpen && (
              <div className="profile-menu">
                <strong>本机管理员会话</strong>
                <span>凭据只由本地代理读取，不会发送到浏览器。</span>
                <button type="button" onClick={() => setProfileOpen(false)}>收起菜单</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className={`workspace ${drawerOpen && selectedId ? "with-drawer" : ""}`}>
        <section className="review-list" aria-label="申请列表">
          <div className="list-heading">
            <div>
              <h1>申请审核</h1>
              <p>线上数据实时读取。批准或拒绝前，请核对联系方式、设备和当前状态。</p>
            </div>
            <div className="refresh-cluster">
              {lastUpdated && <span>更新于 {formatTime(lastUpdated)}</span>}
              <button className="refresh-button" type="button" onClick={() => void refreshData()} disabled={listLoading || analyticsLoading}>
                <ArrowClockwise className={listLoading ? "spin" : ""} size={17} />{listLoading ? "读取中" : "刷新"}
              </button>
            </div>
          </div>

          <AnalyticsPanel analytics={analytics} loading={analyticsLoading} error={analyticsError} />

          <div className="filter-row" aria-label="按状态筛选">
            <div className="status-filters">
              {filterOptions.map(([value, label]) => (
                <button className={filter === value ? "active" : ""} key={value} type="button" onClick={() => setFilter(value)}>
                  {label}<span>{counts[value] ?? 0}</span>
                </button>
              ))}
            </div>
            <div className="query-tools">
              <button className="date-button" type="button" onClick={() => notify("当前显示线上控制面的全部申请记录")}><CalendarBlank size={17} />全部时间<CaretDown size={14} /></button>
              <label className="search-field">
                <MagnifyingGlass size={18} aria-hidden="true" />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索联系方式、设备或申请编号" aria-label="搜索申请" />
                {query && <button type="button" onClick={() => setQuery("")} aria-label="清除搜索" title="清除搜索"><X size={16} /></button>}
              </label>
              <button className="icon-button filter-button" type="button" title="更多筛选" aria-label="更多筛选" onClick={() => notify("状态和搜索条件可以组合使用")}><FunnelSimple size={19} /></button>
            </div>
          </div>

          <div className="table-wrap">
            {listError ? (
              <div className="load-state error-state">
                <WarningCircle size={30} weight="fill" />
                <strong>无法读取线上申请</strong>
                <span>{listError}</span>
                <button type="button" onClick={() => void loadApplications()}>重新连接</button>
              </div>
            ) : listLoading && applications.length === 0 ? (
              <div className="load-state"><ArrowClockwise className="spin" size={28} /><strong>正在读取线上申请</strong><span>管理员凭据只在本机使用。</span></div>
            ) : (
              <>
                <table>
                  <thead><tr><th>申请</th><th>联系方式</th><th>设备</th><th>提交时间</th><th>授权信息</th><th>状态</th></tr></thead>
                  <tbody>
                    {visibleApplications.map((application) => (
                      <tr
                        className={selectedId === application.applicationId && drawerOpen ? "selected" : ""}
                        key={application.applicationId}
                        onClick={() => selectApplication(application.applicationId)}
                        tabIndex={0}
                        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") selectApplication(application.applicationId); }}
                        aria-label={`查看 ${applicationTitle(application)} 的申请`}
                      >
                        <td><strong>{applicationTitle(application)}</strong><span className="mono">{application.applicationId}</span></td>
                        <td><span>{application.contact || "未填写联系方式"}</span><span>设备申请</span></td>
                        <td><strong>{application.deviceName}</strong><span>{application.platform}</span></td>
                        <td><strong>{formatDate(application.createdAt)}</strong><span>{relativeTime(application.createdAt)}</span></td>
                        <td><strong>{formatPeriod(application.period) || "尚未授权"}</strong><span>{application.expiresAt ? `到期 ${formatDate(application.expiresAt)}` : "—"}</span></td>
                        <td><StatusBadge status={application.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {visibleApplications.length === 0 && (
                  <div className="empty-state"><MagnifyingGlass size={28} /><strong>没有找到匹配的申请</strong><button type="button" onClick={() => { setQuery(""); setFilter("all"); }}>清除筛选</button></div>
                )}
                <footer className="table-footer">
                  <span>线上共 {applications.length} 条 · 当前显示 {visibleApplications.length} 条</span>
                  <div className="pagination" aria-label="分页"><button type="button" aria-label="上一页" disabled><CaretLeft size={16} /></button><button className="current" type="button">1</button><button type="button" aria-label="下一页" disabled><CaretRight size={16} /></button></div>
                </footer>
              </>
            )}
          </div>
        </section>

        {drawerOpen && selectedId && (
          <aside className="detail-drawer" aria-label="申请详情">
            <div className="drawer-header"><h2>申请详情</h2><button className="icon-button" type="button" onClick={() => setDrawerOpen(false)} aria-label="关闭申请详情" title="关闭"><X size={22} /></button></div>
            {detailLoading || !selected ? (
              <div className="drawer-loading"><ArrowClockwise className="spin" size={25} /><span>正在读取详情</span></div>
            ) : selectedDetail?.error ? (
              <div className="drawer-loading drawer-error"><WarningCircle size={25} /><span>{selectedDetail.error}</span><button type="button" onClick={() => setSelectedId((value) => `${value}`)}>重新读取</button></div>
            ) : (
              <>
                <div className="applicant-summary"><UserCircle size={54} weight="duotone" aria-hidden="true" /><div><strong>{applicationTitle(selected)}</strong><span>{selected.deviceName}</span><code>{selected.applicationId}</code></div><button className="secondary-button" type="button" onClick={openProfileEditor}>编辑基本信息</button></div>
                <section className="detail-section">
                  <h3>申请信息</h3>
                  <dl>
                    <div><dt>联系方式</dt><dd>{selected.contact || "未填写联系方式"}</dd></div>
                    <div><dt>设备</dt><dd>{selected.deviceName} · {selected.platform}</dd></div>
                    <div><dt>提交时间</dt><dd>{formatDateTime(selected.createdAt)}</dd></div>
                    <div><dt>最近更新</dt><dd>{formatDateTime(selected.updatedAt)}</dd></div>
                    {selected.expiresAt && <div><dt>授权到期</dt><dd>{formatDateTime(selected.expiresAt)}</dd></div>}
                    {selected.reason && <div><dt>处理原因</dt><dd>{selected.reason}</dd></div>}
                    <div><dt>基本信息备注</dt><dd>{selected.profileNote || "暂无"}</dd></div>
                  </dl>
                </section>

                <section className="detail-section timeline-section">
                  <h3>事件时间线</h3>
                  <ol className="timeline">
                    {visibleTimeline.map((item, index) => (
                      <li key={`${item.at}-${item.title}-${index}`}>
                        {item.error ? <WarningCircle size={18} weight="fill" /> : <CheckCircle size={18} weight={index === 0 ? "fill" : "regular"} />}
                        <div><strong>{item.title}</strong><time>{formatEventTime(item.at)}</time><span>{item.detail}</span></div>
                      </li>
                    ))}
                  </ol>
                  {timeline.length > 3 && (
                    <button className="timeline-toggle" type="button" onClick={() => setTimelineExpanded((value) => !value)}>
                      {timelineExpanded ? "收起较早事件" : `查看全部 ${timeline.length} 条事件`}
                    </button>
                  )}
                </section>

                {selected.status === "pending" ? (
                  <>
                    <div className={`safety-check ${selected.contact ? "safe" : "needs-attention"}`}>
                      {selected.contact ? <ShieldCheck size={23} weight="fill" /> : <WarningCircle size={23} weight="fill" />}
                      <div><strong>{selected.contact ? "线上申请已同步" : "申请人未填写联系方式"}</strong><span>{selected.contact ? "请核对设备和联系方式后再处理。" : "批准前建议先核对设备归属。"}</span></div>
                    </div>
                    <section className="decision-section">
                      <label>授予访问权限时长</label>
                      <div className="period-control">{periodOptions.map(([value, shortLabel]) => <button className={period === value ? "active" : ""} key={value} type="button" onClick={() => setPeriod(value)}>{shortLabel}</button>)}</div>
                      <span className="decision-hint">确认后会立即调用线上控制面，到期自动失效。</span>
                      <button className="approve-button" type="button" onClick={() => { setActionError(""); setModal("approve"); }}><Check size={20} weight="bold" />批准 {periodLabel}</button>
                      <button className="reject-button" type="button" onClick={() => { setActionError(""); setModal("reject"); setReason(""); }}>填写原因并拒绝</button>
                    </section>
                  </>
                ) : selected.status === "rejected" ? (
                  <>
                    <div className={`result-panel result-${selected.status}`}><StatusBadge status={selected.status} /><strong>{resultSummary(selected)}</strong><span>如需纠正，请重新进入审核，不直接跳过审核状态。</span></div>
                    <section className="decision-section status-actions">
                      <button className="approve-button" type="button" onClick={() => { setActionError(""); setModal("reopen"); setReason(""); }}>重新进入审核</button>
                      <button className="secondary-button" type="button" onClick={() => { setActionError(""); setModal("note"); setNote(""); }}>添加内部备注</button>
                    </section>
                  </>
                ) : selected.status === "approved" ? (
                  <>
                    <div className={`result-panel result-${selected.status}`}><StatusBadge status={selected.status} /><strong>{resultSummary(selected)}</strong><span>设备尚未领取配置，可安全调整授权期限。</span></div>
                    <section className="decision-section status-actions">
                      <label>调整授权期限</label>
                      <div className="period-control">{periodOptions.map(([value, shortLabel]) => <button className={period === value ? "active" : ""} key={value} type="button" onClick={() => setPeriod(value)}>{shortLabel}</button>)}</div>
                      <span className="decision-hint">调整会重新生成待领取配置，并写入审计记录。</span>
                      <button className="approve-button" type="button" onClick={() => { setActionError(""); setModal("period"); setReason(""); }}>改为 {periodLabel}</button>
                      <button className="secondary-button" type="button" onClick={openAuthorizationEditor}>编辑授权到期时间</button>
                      <button className="secondary-button" type="button" onClick={() => { setActionError(""); setModal("note"); setNote(""); }}>添加内部备注</button>
                      <button className="danger-outline-button" type="button" onClick={() => { setActionError(""); setModal("revoke"); setReason(""); }}>撤销设备权限</button>
                    </section>
                  </>
                ) : selected.status === "activated" ? (
                  <>
                    <div className={`result-panel result-${selected.status}`}><StatusBadge status={selected.status} /><strong>{resultSummary(selected)}</strong><span>延长授权会保留原授权历史，并追加一条审计记录。</span></div>
                    <section className="decision-section status-actions">
                      <label>延长授权期限</label>
                      <div className="period-control">{periodOptions.map(([value, shortLabel]) => <button className={period === value ? "active" : ""} key={value} type="button" onClick={() => setPeriod(value)}>{shortLabel}</button>)}</div>
                      <span className="decision-hint">延长从当前到期时间开始计算，不覆盖原始授权周期。</span>
                      <button className="approve-button" type="button" onClick={() => { setActionError(""); setModal("extend"); setReason(""); }}>延长 {periodLabel}</button>
                      <button className="secondary-button" type="button" onClick={openAuthorizationEditor}>编辑授权到期时间</button>
                      <button className="secondary-button" type="button" onClick={() => { setActionError(""); setModal("note"); setNote(""); }}>添加内部备注</button>
                      <button className="danger-outline-button" type="button" onClick={() => { setActionError(""); setModal("revoke"); setReason(""); }}>撤销设备权限</button>
                    </section>
                  </>
                ) : (
                  <>
                    <div className={`result-panel result-${selected.status}`}><StatusBadge status={selected.status} /><strong>{resultSummary(selected)}</strong><span>该状态来自线上控制面，可在事件时间线中追溯。</span></div>
                    <section className="decision-section status-actions">
                      {selected.status === "revoked" && <button className="approve-button" type="button" onClick={() => { setActionError(""); setModal("restore"); setReason(""); }}>恢复到撤销前状态</button>}
                      {selected.expiresAt && <button className="secondary-button" type="button" onClick={openAuthorizationEditor}>编辑授权到期时间</button>}
                      <button className="secondary-button" type="button" onClick={() => { setActionError(""); setModal("note"); setNote(""); }}>添加内部备注</button>
                    </section>
                  </>
                )}
                <section className="detail-section notes-section">
                  <div className="section-title-row"><h3>管理员备注</h3><span>{(selectedDetail?.auditEvents ?? []).filter((event) => event.action === "note_added").length} 条</span></div>
                  {(selectedDetail?.auditEvents ?? []).filter((event) => event.action === "note_added").slice(-3).map((event) => (
                    <article className="note-card" key={event.auditId}><p>{event.note}</p><time>{event.actor} · {formatDateTime(event.createdAt)}</time></article>
                  ))}
                  {!(selectedDetail?.auditEvents ?? []).some((event) => event.action === "note_added") && <p className="empty-note">还没有内部备注。</p>}
                </section>
                <p className="audit-note"><LockSimple size={16} />批准与拒绝会直接写入线上控制面；管理员 Token 不会进入浏览器。</p>
              </>
            )}
          </aside>
        )}
      </main>

      {modal === "approve" && selected && (
        <Modal title="确认线上批准" onClose={() => !submitting && setModal(null)}>
          <div className="confirm-person"><ShieldCheck size={34} weight="duotone" /><div><strong>为 {applicationTitle(selected)} 开通 {periodLabel}</strong><span>{selected.deviceName} · {selected.platform}</span></div></div>
          <div className="live-action-warning"><CloudCheck size={20} weight="fill" /><span>这是线上操作。确认后会立即准备专属连接，并写入审核记录。</span></div>
          {actionError && <p className="action-error" role="alert">{actionError}</p>}
          <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setModal(null)} disabled={submitting}>返回检查</button><button className="approve-button" type="button" onClick={() => void approveSelected()} disabled={submitting}>{submitting ? <ArrowClockwise className="spin" size={19} /> : <Check size={19} weight="bold" />}{submitting ? "正在开通" : "确认线上批准"}</button></div>
        </Modal>
      )}

      {modal === "reject" && selected && (
        <Modal title="填写线上不通过原因" onClose={() => !submitting && setModal(null)}>
          <p className="modal-copy">原因会通过线上控制面反馈给申请人，请写清楚下一步怎么处理。</p>
          <div className="reason-options">{["请先完成客户端安装", "请联系管理员核对设备", "当前试用名额已满"].map((option) => <button key={option} type="button" onClick={() => setReason(option)}>{option}</button>)}</div>
          <label className="reason-label" htmlFor="reject-reason">不通过原因</label>
          <textarea id="reject-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：请先完成客户端安装，再重新提交申请。" maxLength={200} autoFocus />
          <div className="textarea-meta"><span>{reason.length}/200</span></div>
          {actionError && <p className="action-error" role="alert">{actionError}</p>}
          <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setModal(null)} disabled={submitting}>取消</button><button className="danger-button" type="button" onClick={() => void rejectSelected()} disabled={!reason.trim() || submitting}>{submitting ? "正在提交" : "确认线上不通过"}</button></div>
        </Modal>
      )}

      {modal === "reopen" && selected && (
        <Modal title="重新进入审核" onClose={() => !submitting && setModal(null)}>
          <p className="modal-copy">这会清除当前的未通过状态，并把申请放回待审核队列。请写明纠正原因。</p>
          <label className="reason-label" htmlFor="reopen-reason">纠正原因</label>
          <textarea id="reopen-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：补充核对后确认设备属于申请人。" maxLength={300} autoFocus />
          <div className="textarea-meta"><span>{reason.length}/300</span></div>
          {actionError && <p className="action-error" role="alert">{actionError}</p>}
          <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setModal(null)} disabled={submitting}>取消</button><button className="approve-button" type="button" onClick={() => void reopenSelected()} disabled={!reason.trim() || submitting}>{submitting ? "正在重新打开" : "确认重新审核"}</button></div>
        </Modal>
      )}

      {(modal === "period" || modal === "extend") && selected && (
        <Modal title={modal === "period" ? "调整授权期限" : "延长授权期限"} onClose={() => !submitting && setModal(null)}>
          <div className="confirm-person"><ShieldCheck size={34} weight="duotone" /><div><strong>{modal === "period" ? `将授权改为 ${periodLabel}` : `将授权延长 ${periodLabel}`}</strong><span>{selected.deviceName} · {selected.platform}</span></div></div>
          <p className="modal-copy">{modal === "period" ? "设备尚未领取配置，系统会重新生成待领取配置。" : "原授权记录会保留，只新增一条延长记录。"}</p>
          <label className="reason-label" htmlFor="period-reason">操作原因</label>
          <textarea id="period-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：根据申请人确认，授权期限调整为一个月。" maxLength={300} autoFocus />
          <div className="textarea-meta"><span>{reason.length}/300</span></div>
          {actionError && <p className="action-error" role="alert">{actionError}</p>}
          <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setModal(null)} disabled={submitting}>取消</button><button className="approve-button" type="button" onClick={() => void (modal === "period" ? changePeriodSelected() : extendSelected())} disabled={!reason.trim() || submitting}>{submitting ? "正在保存" : "确认记录变更"}</button></div>
        </Modal>
      )}

      {modal === "revoke" && selected && (
        <Modal title="撤销设备权限" onClose={() => !submitting && setModal(null)}>
          <div className="live-action-warning"><WarningCircle size={20} weight="fill" /><span>这会暂时禁用试用账号，并保留授权历史。之后可以恢复到撤销前状态。</span></div>
          <label className="reason-label" htmlFor="revoke-reason">撤销原因</label>
          <textarea id="revoke-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：申请人要求停止使用。" maxLength={300} autoFocus />
          <div className="textarea-meta"><span>{reason.length}/300</span></div>
          {actionError && <p className="action-error" role="alert">{actionError}</p>}
          <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setModal(null)} disabled={submitting}>取消</button><button className="danger-button" type="button" onClick={() => void revokeSelected()} disabled={!reason.trim() || submitting}>{submitting ? "正在撤销" : "确认撤销权限"}</button></div>
        </Modal>
      )}

      {modal === "restore" && selected && (
        <Modal title="恢复设备权限" onClose={() => !submitting && setModal(null)}>
          <div className="live-action-warning"><ShieldCheck size={20} weight="fill" /><span>恢复会重新启用账号，并返回撤销前的状态。请确认这是测试账号或已完成复核。</span></div>
          <label className="reason-label" htmlFor="restore-reason">恢复原因</label>
          <textarea id="restore-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：测试误操作，恢复原授权。" maxLength={300} autoFocus />
          <div className="textarea-meta"><span>{reason.length}/300</span></div>
          {actionError && <p className="action-error" role="alert">{actionError}</p>}
          <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setModal(null)} disabled={submitting}>取消</button><button className="approve-button" type="button" onClick={() => void restoreSelected()} disabled={!reason.trim() || submitting}>{submitting ? "正在恢复" : "确认恢复权限"}</button></div>
        </Modal>
      )}

      {modal === "authorization" && selected && (
        <Modal title="编辑授权到期时间" onClose={() => !submitting && setModal(null)}>
          <p className="modal-copy">这是直接修改到期时间，不是追加时长。原日期和本次修改都会留在审计时间线中。</p>
          <label className="reason-label" htmlFor="authorization-expires-at">新的到期时间</label>
          <input className="modal-input" id="authorization-expires-at" type="datetime-local" value={expiresAtInput} onChange={(event) => setExpiresAtInput(event.target.value)} autoFocus />
          <label className="reason-label" htmlFor="authorization-reason">修改原因</label>
          <textarea id="authorization-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：测试账号统一调整有效期。" maxLength={300} />
          <div className="textarea-meta"><span>{reason.length}/300</span></div>
          {actionError && <p className="action-error" role="alert">{actionError}</p>}
          <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setModal(null)} disabled={submitting}>取消</button><button className="approve-button" type="button" onClick={() => void editAuthorizationSelected()} disabled={!expiresAtInput || !reason.trim() || submitting}>{submitting ? "正在保存" : "保存授权日期"}</button></div>
        </Modal>
      )}

      {modal === "profile" && selected && (
        <Modal title="编辑基本信息" onClose={() => !submitting && setModal(null)}>
          <p className="modal-copy">昵称和基本信息备注只用于管理员识别，不会替代申请人的审批备注，也不会发送给申请人。</p>
          <label className="reason-label" htmlFor="profile-nickname">昵称</label>
          <input className="modal-input" id="profile-nickname" value={profileNickname} onChange={(event) => setProfileNickname(event.target.value)} placeholder="例如：搭手·小麦-3211" maxLength={100} autoFocus />
          <label className="reason-label" htmlFor="profile-note">基本信息备注</label>
          <textarea id="profile-note" value={profileNote} onChange={(event) => setProfileNote(event.target.value)} placeholder="记录设备归属、测试批次或联系人备注。" maxLength={1000} />
          <div className="textarea-meta"><span>{profileNote.length}/1000</span></div>
          {actionError && <p className="action-error" role="alert">{actionError}</p>}
          <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setModal(null)} disabled={submitting}>取消</button><button className="approve-button" type="button" onClick={() => void editProfileSelected()} disabled={submitting}>{submitting ? "正在保存" : "保存基本信息"}</button></div>
        </Modal>
      )}

      {modal === "note" && selected && (
        <Modal title="添加内部备注" onClose={() => !submitting && setModal(null)}>
          <p className="modal-copy">备注只对管理员可见，不会发送给申请人。保存后会追加到审核记录。</p>
          <label className="reason-label" htmlFor="admin-note">内部备注</label>
          <textarea id="admin-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="记录核对结果、沟通内容或后续动作。" maxLength={1000} autoFocus />
          <div className="textarea-meta"><span>{note.length}/1000</span></div>
          {actionError && <p className="action-error" role="alert">{actionError}</p>}
          <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setModal(null)} disabled={submitting}>取消</button><button className="approve-button" type="button" onClick={() => void addNoteSelected()} disabled={!note.trim() || submitting}>{submitting ? "正在记录" : "保存内部备注"}</button></div>
        </Modal>
      )}

      {toast && <div className="toast" role="status"><CheckCircle size={20} weight="fill" />{toast}</div>}
    </div>
  );
}

function AnalyticsPanel({ analytics, loading, error }) {
  if (loading) {
    return <section className="analytics-panel analytics-loading" aria-label="申请到首次工具成功分析"><ArrowClockwise className="spin" size={18} />正在计算申请到首次工具成功的漏斗…</section>;
  }
  if (error || !analytics) {
    return <section className="analytics-panel analytics-muted" aria-label="申请到首次工具成功分析"><strong>申请到首次工具成功分析暂不可用</strong><span>{error || "线上控制面尚未返回分析数据。"}</span></section>;
  }
  const coverage = analytics.coverage ?? {};
  const funnel = analytics.funnel ?? [];
  const durations = analytics.durations ?? [];
  const bottlenecks = (analytics.bottlenecks ?? []).filter((item) => item.count > 0);
  const errors = analytics.errors ?? [];
  return (
    <section className="analytics-panel" aria-label="申请到首次工具成功分析">
      <div className="analytics-heading">
        <div><h2>从申请到首次工具成功</h2><p>“首次观测”是支持该分析的客户端版本第一次出现，不等于安装时间；成功只在工具实际返回成功后计入。</p></div>
        <span>{coverage.applications ?? 0} 个申请 · 首次观测覆盖 {coverage.firstSeenRate ?? 0}%</span>
      </div>
      <div className="funnel-grid">
        {funnel.map((step) => <div className="funnel-card" key={step.key}><strong>{step.count}</strong><span>{step.label}</span><em>{step.conversionRate}%</em></div>)}
      </div>
      <div className="analytics-detail-grid">
        <div className="analytics-card">
          <div className="analytics-card-title"><h3>阶段耗时</h3><span>中位数 / P90</span></div>
          {durations.map((item) => <div className="analytics-row" key={item.key}><span>{item.label}</span><strong>{formatAnalyticsDuration(item.medianSeconds)} <small>/ {formatAnalyticsDuration(item.p90Seconds)}</small></strong></div>)}
          {durations.length === 0 && <p className="analytics-empty">完成数据后会显示耗时。</p>}
        </div>
        <div className="analytics-card">
          <div className="analytics-card-title"><h3>当前卡点</h3><span>超过阈值</span></div>
          {bottlenecks.length > 0 ? bottlenecks.map((item) => <div className="analytics-row" key={item.key}><span>{item.label}</span><strong className="analytics-warning">{item.count} 个</strong></div>) : <p className="analytics-empty">暂时没有超过阈值的申请。</p>}
        </div>
        <div className="analytics-card">
          <div className="analytics-card-title"><h3>常见失败</h3><span>客户端上报</span></div>
          {errors.length > 0 ? errors.slice(0, 4).map((item) => <div className="analytics-row" key={`${item.stage}-${item.errorCode}`}><span>{eventLabels[item.stage] ?? item.stage}{item.errorCode ? ` · ${item.errorCode}` : ""}</span><strong>{item.count} 次</strong></div>) : <p className="analytics-empty">暂无失败事件。</p>}
        </div>
      </div>
    </section>
  );
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { error: "控制面返回了无法识别的响应" };
  }
  if (!response.ok) throw new Error(payload.error || `线上控制面返回 HTTP ${response.status}`);
  return payload;
}

function buildTimeline(application, events, auditEvents = []) {
  if (!application) return [];
  const items = [{ at: application.createdAt, title: "控制面收到申请", detail: "申请已进入线上审核队列。" }];
  for (const event of events) {
    const eventAt = Number.isSafeInteger(event.unixSeconds) ? new Date(event.unixSeconds * 1000).toISOString() : event.receivedAt;
    const failed = event.outcome === "error";
    items.push({
      at: eventAt,
      title: eventLabels[event.stage] ?? event.stage,
      detail: failed
        ? `客户端报告失败${event.errorCode ? `：${event.errorCode}` : ""}${event.appVersion ? ` · v${event.appVersion}` : ""}`
        : `客户端信号${event.appVersion ? ` · v${event.appVersion}` : ""}`,
      error: failed,
    });
  }
  const milestones = [
    [application.provisioningStartedAt, "管理员开始准备连接", "线上控制面正在创建专属连接。"],
    [application.approvedAt, "申请已批准", `授权期限：${formatPeriod(application.period) || "已设置"}`],
    [application.activationStartedAt, "设备已领取配置", "设备已开始领取安全配置。"],
    [application.activatedAt, "开通完成", "设备已完成开通。"],
    [application.rejectedAt, "申请未通过", application.reason || "管理员未通过该申请。"],
    [application.revokedAt, "使用权限已撤销", "管理员已撤销设备权限。"],
  ];
  for (const [at, title, detail] of milestones) if (at) items.push({ at, title, detail, error: title.includes("未通过") || title.includes("撤销") });
  for (const event of auditEvents) {
    const from = statusMeta[event.fromStatus]?.label || event.fromStatus;
    const to = statusMeta[event.toStatus]?.label || event.toStatus;
    const transition = from && to ? `${from} → ${to}` : event.toPeriod ? `调整为${formatPeriod(event.toPeriod)}` : "已记录";
    items.push({
      at: event.createdAt,
      title: auditLabels[event.action] ?? event.action,
      detail: [transition, event.reason, event.note].filter(Boolean).join(" · "),
      error: event.action === "rejected" || event.action === "revoked",
    });
  }
  return items.filter((item) => item.at).sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

function applicationTitle(application) {
  return application.nickname || application.contact || application.deviceName || application.applicationId;
}

function toDateTimeLocal(value) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function resultSummary(application) {
  if (application.status === "activated") return `设备已开通${application.expiresAt ? `，授权至 ${formatDate(application.expiresAt)}` : ""}`;
  if (application.status === "approved") return "申请已批准，等待设备领取配置";
  if (application.status === "provisioning") return "线上控制面正在准备连接";
  if (application.status === "rejected") return application.reason || "申请未通过";
  if (application.status === "expired") return "授权已到期";
  if (application.status === "revoked") return "设备权限已撤销";
  return statusMeta[application.status]?.label || application.status;
}

function formatPeriod(period) {
  return ({ week: "1 周", month: "1 个月", quarter: "1 个季度", year: "1 年" })[period] || "";
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date) : value;
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date) : value;
}

function formatEventTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date) : value;
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value);
}

function relativeTime(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function formatAnalyticsDuration(seconds) {
  if (!Number.isFinite(seconds)) return "暂无数据";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} 小时 ${remainder} 分钟` : `${hours} 小时`;
}
