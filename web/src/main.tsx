import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, all, ApiError, pointer, pretty, saveJSON } from './api';
import './style.css';

type Tab = '실험' | '큐·실행기' | '결과' | '설정';
const sampleJob = {
  name: '첫 실험',
  queue: 'research',
  runner: 'generic/1',
  schema_id: 'generic_v1',
  spec: { target_steps: 1000, seed: 42 },
  requirements: { gpu_count: 1, labels: [] },
  policy: { checkpointable: true, eta_seconds: null },
  labels: { campaign: 'baseline' },
  extensions: {},
};
const sampleSchema = {
  id: 'generic_v1',
  runner: 'generic/1',
  name: '일반 실험 v1',
  json_schema: {
    type: 'object',
    required: ['target_steps', 'seed'],
    properties: {
      target_steps: { type: 'integer', minimum: 1, description: '학습 목표 step' },
      seed: { type: 'integer', default: 42 },
    },
    additionalProperties: false,
  },
  report_schema: {
    type: 'object',
    required: ['spec_sha256', 'config_sha256', 'completed_steps'],
    properties: {
      spec_sha256: { type: 'string' },
      config_sha256: { type: 'string' },
      completed_steps: { type: 'integer', minimum: 0 },
      posthoc_completed: { type: 'boolean' },
      summary: { type: 'object' },
    },
    additionalProperties: true,
  },
};
function date(v: string | null) {
  return v
    ? `${new Date(v).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false })} KST`
    : '—';
}
function Badge({ value }: { value: string }) {
  return <span className={`badge ${value}`}>{value}</span>;
}
function Json({ value }: { value: unknown }) {
  return <pre className="json">{pretty(value)}</pre>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="empty">{children}</p>;
}
function ErrorBox({ error }: { error: unknown }) {
  return error ? (
    <div role="alert" className="error">
      {error instanceof Error ? error.message : String(error)}
      {error instanceof ApiError && error.fields.length > 0 && <Json value={error.fields} />}
    </div>
  ) : null;
}
function Login({ onLogin }: { onLogin: (me: any) => void }) {
  const [mode, setMode] = useState('password');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const data = new FormData(e.currentTarget);
    try {
      await api(
        '/sessions',
        'POST',
        mode === 'password'
          ? { username: data.get('username'), password: data.get('password') }
          : { token: data.get('token') },
      );
      onLogin(await api('/me'));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <div className="brand">
        GRT <span>RESEARCH CONTROL</span>
      </div>
      <h1>연구 서버에 로그인</h1>
      <p className="muted">실험, 실행기와 결과를 한곳에서 관리합니다.</p>
      <div className="tabs">
        <button onClick={() => setMode('password')} aria-pressed={mode === 'password'}>
          계정 / 비밀번호
        </button>
        <button onClick={() => setMode('token')} aria-pressed={mode === 'token'}>
          API 토큰
        </button>
      </div>
      <form onSubmit={submit}>
        {mode === 'password' ? (
          <>
            <label>
              계정
              <input name="username" autoComplete="username" required defaultValue="owner" />
            </label>
            <label>
              비밀번호
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
          </>
        ) : (
          <label>
            API 토큰
            <input name="token" type="password" autoComplete="off" required />
          </label>
        )}
        <ErrorBox error={error} />
        <button className="primary" disabled={busy}>
          {busy ? '확인 중…' : '로그인'}
        </button>
      </form>
    </main>
  );
}
function App() {
  const [me, setMe] = useState<any>();
  const [boot, setBoot] = useState(true);
  const [tab, setTab] = useState<Tab>('실험');
  const [jobs, setJobs] = useState<any[]>([]);
  const [queues, setQueues] = useState<any[]>([]);
  const [workers, setWorkers] = useState<any[]>([]);
  const [schemas, setSchemas] = useState<any[]>([]);
  const [tokens, setTokens] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>();
  const [caps, setCaps] = useState<any>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const [updated, setUpdated] = useState<string>();
  const [draft, setDraft] = useState(pretty(sampleJob));
  const [composer, setComposer] = useState(false);
  const [validated, setValidated] = useState<any>();
  const [detail, setDetail] = useState<any>();
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [campaign, setCampaign] = useState('');
  const [partial, setPartial] = useState(false);
  const [oneTime, setOneTime] = useState<string>();
  const [exportId, setExportId] = useState<string>();
  const [exportState, setExportState] = useState<any>();
  const [offers, setOffers] = useState<any>();
  const [columns, setColumns] = useState<string[]>(['/best_loss', '/final_loss']);
  const [newColumn, setNewColumn] = useState('');
  const canWrite = me?.kind === 'write';
  useEffect(() => {
    api('/me')
      .then(setMe)
      .catch(() => {})
      .finally(() => setBoot(false));
    const expired = () => setMe(undefined);
    window.addEventListener('grt:expired', expired);
    return () => window.removeEventListener('grt:expired', expired);
  }, []);
  const refresh = useCallback(async () => {
    if (!me) return;
    try {
      const [j, q, w, s, t, conf, capabilities] = await Promise.all([
        all('/jobs'),
        all('/queues'),
        all('/workers'),
        all('/schemas'),
        all('/tokens'),
        api('/settings'),
        api('/capabilities'),
      ]);
      setJobs(j);
      setQueues(q);
      setWorkers(w);
      setSchemas(s);
      setTokens(t);
      setSettings(conf);
      setCaps(capabilities);
      setOffline(false);
      setUpdated(new Date().toISOString());
    } catch (e) {
      setOffline(true);
      setError(e);
    }
  }, [me]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 7000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!detail || !me) return;
    const timer = setInterval(
      () => api(`/jobs/${detail.id}`).then(setDetail).catch(setError),
      7000,
    );
    return () => clearInterval(timer);
  }, [detail?.id, me]);
  useEffect(() => {
    if (!exportId || !me) return;
    let active = true;
    const poll = () =>
      api(`/exports/${exportId}`)
        .then((e) => {
          if (active) setExportState(e);
        })
        .catch(setError);
    void poll();
    const timer = setInterval(poll, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [exportId, me]);
  async function act(fn: () => Promise<any>) {
    setError(null);
    setBusy(true);
    try {
      const value = await fn();
      await refresh();
      return value;
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function jobAction(job: any, action: string) {
    let termination_evidence: string | undefined;
    if (action === 'retry' && job.status === 'running') {
      termination_evidence =
        prompt('이전 프로세스가 종료되었다는 근거를 입력하세요 (10자 이상).') || undefined;
      if (!termination_evidence) return;
    }
    if (
      action === 'cancel' &&
      !confirm(`${job.name} 실험을 취소할까요? 실행 중이면 안전 종료 명령을 전달합니다.`)
    )
      return;
    await act(() =>
      api(`/jobs/${job.id}/actions`, 'POST', {
        action,
        ...(termination_evidence ? { termination_evidence } : {}),
      }),
    );
    if (detail) setDetail(await api(`/jobs/${job.id}`));
  }
  async function validate() {
    await act(async () => {
      const raw = JSON.parse(draft);
      const values = Array.isArray(raw) ? raw : [raw];
      const results = [];
      for (const j of values) results.push(await api('/jobs/validate', 'POST', j));
      setValidated(results);
      return results;
    });
  }
  async function submit() {
    await act(async () => {
      const raw = JSON.parse(draft);
      const result = await api(
        Array.isArray(raw) ? '/jobs/batch' : '/jobs',
        'POST',
        Array.isArray(raw) ? { jobs: raw } : raw,
      );
      setComposer(false);
      setValidated(undefined);
      return result;
    });
  }
  async function exportSelected() {
    const e = await act(() => api('/exports', 'POST', { job_ids: selected }));
    if (e) {
      setExportId(e.id);
      setExportState(e);
    }
  }
  async function download(id: string) {
    const d = await act(() => api(`/artifacts/${id}/download`));
    if (d) location.assign(d.url);
  }
  const visibleJobs = jobs.filter(
    (j) =>
      (!filter ||
        `${j.name} ${j.queue} ${j.status}`.toLowerCase().includes(filter.toLowerCase())) &&
      (!campaign || j.labels.campaign === campaign) &&
      (tab !== '결과' || partial || j.status === 'succeeded'),
  );
  if (boot) return <Empty>서버 연결 확인 중…</Empty>;
  if (!me) return <Login onLogin={setMe} />;
  return (
    <>
      <header>
        <div className="brand">
          GRT <span>연구 서버</span>
        </div>
        <nav>
          {(['실험', '큐·실행기', '결과', '설정'] as Tab[]).map((t) => (
            <button key={t} aria-current={tab === t ? 'page' : undefined} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
        <div className="session">
          <Badge value={me.kind} />
          <button
            onClick={() =>
              act(async () => {
                await api('/sessions/current', 'DELETE');
                setMe(undefined);
              })
            }
          >
            로그아웃
          </button>
        </div>
      </header>
      {!canWrite && (
        <div className="notice">읽기 전용 접속 · 조회와 다운로드를 사용할 수 있습니다.</div>
      )}
      <main>
        <div className="page-heading">
          <div>
            <p className="eyebrow">RESEARCH WORKSPACE</p>
            <h1>{tab}</h1>
          </div>
          <div className={`sync ${offline ? 'offline' : ''}`} role="status">
            {offline ? '오프라인 · 마지막 조회 데이터를 표시합니다' : '● 연결됨'}
            <small>마지막 갱신 {updated ? date(updated) : '—'}</small>
          </div>
        </div>
        <ErrorBox error={error} />
        {(tab === '실험' || tab === '결과') && (
          <>
            <div className="toolbar">
              <input
                aria-label="실험 검색"
                placeholder="이름, 큐, 상태 검색"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <select
                aria-label="campaign"
                value={campaign}
                onChange={(e) => setCampaign(e.target.value)}
              >
                <option value="">모든 campaign</option>
                {[...new Set(jobs.map((j) => j.labels.campaign).filter(Boolean))].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
              {tab === '실험' && (
                <button
                  className="primary"
                  disabled={!canWrite || busy}
                  onClick={() => {
                    setComposer(!composer);
                    setValidated(undefined);
                  }}
                >
                  + 신규 실험
                </button>
              )}
              {tab === '결과' && (
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={partial}
                    onChange={(e) => setPartial(e.target.checked)}
                  />
                  실패·부분 결과 포함
                </label>
              )}
              <button disabled={!selected.length || busy} onClick={exportSelected}>
                선택 결과 ZIP ({selected.length})
              </button>
            </div>
            {composer && tab === '실험' && (
              <section>
                <h2>실험 등록</h2>
                <p className="muted">
                  JSON 객체 또는 최대 50개 객체의 배열을 입력합니다. 배열은 전체 검증 후 한 번에
                  등록합니다.
                </p>
                <label>
                  불변 실행 설정
                  <textarea
                    spellCheck={false}
                    rows={18}
                    value={draft}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      setValidated(undefined);
                    }}
                  />
                </label>
                <div className="toolbar">
                  <button disabled={busy} onClick={validate}>
                    서버 검증
                  </button>
                  <button
                    className="primary"
                    disabled={!canWrite || !validated || busy}
                    onClick={submit}
                  >
                    검증한 실험 등록
                  </button>
                  <button
                    onClick={() => {
                      try {
                        saveJSON(JSON.parse(draft), 'experiment-draft.json');
                      } catch (e) {
                        setError(e);
                      }
                    }}
                  >
                    Draft 내보내기
                  </button>
                  <label className="file-button">
                    JSON 불러오기
                    <input
                      type="file"
                      accept="application/json,.json"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          setDraft(await file.text());
                          setValidated(undefined);
                        }
                      }}
                    />
                  </label>
                </div>
                {validated && (
                  <details open>
                    <summary>검증 결과와 해소된 설정</summary>
                    <Json value={validated} />
                  </details>
                )}
              </section>
            )}
            {tab === '결과' && (
              <div className="toolbar">
                <input
                  placeholder="summary JSON Pointer (예: /memory/peak)"
                  aria-label="비교 열"
                  value={newColumn}
                  onChange={(e) => setNewColumn(e.target.value)}
                />
                <button
                  disabled={!newColumn.startsWith('/')}
                  onClick={() => {
                    setColumns([...new Set([...columns, newColumn])]);
                    setNewColumn('');
                  }}
                >
                  비교 열 추가
                </button>
                <span className="muted">
                  같은 단위의 scalar를 비교하세요. 없는 값은 null입니다.
                </span>
              </div>
            )}
            <section className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th aria-label="선택" />
                    <th>이름 / campaign</th>
                    <th>큐 / 우선순위</th>
                    <th>상태</th>
                    {tab === '결과' ? columns.map((c) => <th key={c}>{c}</th>) : <th>등록 시각</th>}
                    <th>작업</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleJobs.map((j) => (
                    <tr key={j.id}>
                      <td>
                        <input
                          aria-label={`${j.name} 선택`}
                          type="checkbox"
                          checked={selected.includes(j.id)}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? [...selected, j.id]
                                : selected.filter((id) => id !== j.id),
                            )
                          }
                        />
                      </td>
                      <td>
                        <button
                          className="link"
                          onClick={() => api(`/jobs/${j.id}`).then(setDetail).catch(setError)}
                        >
                          {j.name}
                        </button>
                        <small>{j.labels.campaign || '—'}</small>
                      </td>
                      <td>
                        {j.queue}
                        <small>우선순위 {j.priority}</small>
                      </td>
                      <td>
                        <Badge value={j.status} />
                        {j.cancel_requested && j.status === 'running' && <small>취소 대기</small>}
                      </td>
                      {tab === '결과' ? (
                        columns.map((c) => (
                          <td key={c}>
                            <code>{pretty(pointer(j.summary, c))}</code>
                          </td>
                        ))
                      ) : (
                        <td>{date(j.created_at)}</td>
                      )}
                      <td>
                        <div className="actions">
                          <button
                            disabled={!canWrite || busy}
                            onClick={() => {
                              const body = Object.fromEntries(
                                Object.keys(sampleJob).map((k) => [k, j[k]]),
                              );
                              setDraft(pretty({ ...body, name: `${j.name} (copy)` }));
                              setComposer(true);
                              setTab('실험');
                              setValidated(undefined);
                            }}
                          >
                            복제
                          </button>
                          {['queued', 'running'].includes(j.status) && (
                            <button
                              disabled={!canWrite || busy}
                              onClick={() => jobAction(j, 'cancel')}
                            >
                              취소
                            </button>
                          )}
                          {['failed', 'interrupted', 'cancelled'].includes(j.status) && (
                            <button
                              disabled={!canWrite || busy}
                              onClick={() => jobAction(j, 'retry')}
                            >
                              재시도
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!visibleJobs.length && (
                <Empty>표시할 실험이 없습니다. 큐와 schema를 설정한 뒤 실험을 등록하세요.</Empty>
              )}
            </section>
            {exportState && (
              <section>
                <h2>선택 결과 묶음</h2>
                <Badge value={exportState.status} />
                {exportState.error && <Json value={exportState.error} />}{' '}
                {exportState.download && (
                  <a className="button" href={exportState.download.url}>
                    ZIP 다운로드
                  </a>
                )}
              </section>
            )}
          </>
        )}
        {tab === '큐·실행기' && (
          <>
            <section>
              <div className="section-heading">
                <h2>대기열</h2>
                <button
                  disabled={!canWrite || busy}
                  onClick={() => {
                    const name = prompt('새 큐 이름');
                    if (name) void act(() => api('/queues', 'POST', { name }));
                  }}
                >
                  + 큐 만들기
                </button>
              </div>
              <div className="cards">
                {queues.map((q) => (
                  <article key={q.id}>
                    <h3>
                      {q.name} <Badge value={q.paused ? 'paused' : 'active'} />
                    </h3>
                    <p>
                      대기 {q.counts.queued} · 실행 {q.counts.running} · 검증 {q.counts.finalizing}
                    </p>
                    <button
                      disabled={!canWrite || busy}
                      onClick={() =>
                        act(() =>
                          api(`/queues/${q.id}/actions`, 'POST', {
                            action: q.paused ? 'resume' : 'pause',
                          }),
                        )
                      }
                    >
                      {q.paused ? '재개' : '일시 정지'}
                    </button>
                  </article>
                ))}
              </div>
              {!queues.length && <Empty>첫 번째 큐를 만들어 주세요. 예: research</Empty>}
            </section>
            <section>
              <h2>대기 중인 실험 순서</h2>
              {jobs
                .filter((j) => j.status === 'queued')
                .sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at))
                .map((j) => (
                  <div className="queue-row" key={j.id}>
                    <span>{j.name}</span>
                    <select
                      aria-label={`${j.name} 큐`}
                      disabled={!canWrite || busy}
                      value={j.queue}
                      onChange={(e) =>
                        act(() => api(`/jobs/${j.id}`, 'PATCH', { queue: e.target.value }))
                      }
                    >
                      {queues.map((q) => (
                        <option key={q.id}>{q.name}</option>
                      ))}
                    </select>
                    <button
                      disabled={!canWrite || busy}
                      onClick={() => {
                        const value = prompt('우선순위 (-10000~10000)', String(j.priority));
                        if (value !== null)
                          void act(() =>
                            api(`/jobs/${j.id}`, 'PATCH', { priority: Number(value) }),
                          );
                      }}
                    >
                      우선순위 {j.priority} 변경
                    </button>
                  </div>
                ))}
            </section>
            <section className="table-wrap">
              <h2>실행기</h2>
              <table>
                <thead>
                  <tr>
                    <th>이름 / 환경</th>
                    <th>GPU / world size</th>
                    <th>Runner / schema</th>
                    <th>실행 / 마지막 접속</th>
                    <th>관리</th>
                  </tr>
                </thead>
                <tbody>
                  {workers.map((w) => (
                    <tr key={w.id}>
                      <td>
                        {w.name}
                        <small>{w.environment}</small>
                      </td>
                      <td>
                        {w.gpu_count} / {w.world_size}
                      </td>
                      <td>
                        {w.runners.join(', ')}
                        <small>{w.schema_ids.join(', ')}</small>
                      </td>
                      <td>
                        {w.active_attempt_id || '유휴'}
                        <small>{date(w.last_seen_at)}</small>
                      </td>
                      <td>
                        <button
                          disabled={!canWrite || busy}
                          onClick={() =>
                            act(() =>
                              api(`/workers/${w.id}/actions`, 'POST', {
                                action: w.draining ? 'resume' : 'drain',
                              }),
                            )
                          }
                        >
                          {w.draining ? '재개' : 'Drain'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!workers.length && (
                <Empty>연결된 실행기가 없습니다. 실행기에서 API로 등록하면 표시됩니다.</Empty>
              )}
            </section>
            <section>
              <h2>Vast.ai</h2>
              <p className="muted">
                유료 임대는 독립 deadline 감시와 bootstrap 연동 후 활성화해야 합니다. 현재 버전은
                서버에 키를 설정한 경우 offer 검색만 지원합니다.
              </p>
              <button
                disabled={!caps?.features.vast_offer_search || busy}
                onClick={() =>
                  act(async () => {
                    const result = await api('/providers/vast/offers/search', 'POST', {
                      query: { rentable: { eq: true }, num_gpus: { eq: 1 } },
                    });
                    setOffers(result);
                  })
                }
              >
                Offer 검색
              </button>
              {offers && <Json value={offers} />}
            </section>
          </>
        )}
        {tab === '설정' && (
          <>
            <section>
              <h2>연결 정보</h2>
              <p>
                <code>{location.origin}</code> · {me.kind} · 만료 {date(me.expires_at)}
              </p>
              <p>
                Colab / Kaggle secret 이름: <code>GRT_SERVER_TOKEN</code>
                <br />
                공개 연결 주소: <code>GRT_SERVER_URL</code>
              </p>
              <p className="muted">
                write 토큰은 전체 변경 권한을 가집니다. 신뢰하는 개인 실행 환경에서만 사용하세요.
                기존 GRT notebook helper 연결은 별도 작업입니다.
              </p>
              <details>
                <summary>환경별 secret 읽기</summary>
                <pre>{`# Colab\nfrom google.colab import userdata\ntoken = userdata.get('GRT_SERVER_TOKEN')\n\n# Kaggle\nfrom kaggle_secrets import UserSecretsClient\ntoken = UserSecretsClient().get_secret('GRT_SERVER_TOKEN')\n\n# 원격 환경\nimport os\ntoken = os.environ['GRT_SERVER_TOKEN']`}</pre>
              </details>
            </section>
            <section>
              <h2>API 토큰</h2>
              <form
                className="toolbar"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = e.currentTarget;
                  const data = new FormData(f);
                  void act(async () => {
                    const t = await api('/tokens', 'POST', {
                      name: data.get('name'),
                      kind: data.get('kind'),
                      expires_at: new Date(String(data.get('expires'))).toISOString(),
                    });
                    setOneTime(t.token);
                    f.reset();
                  });
                }}
              >
                <input
                  name="name"
                  aria-label="토큰 이름"
                  placeholder="토큰 이름"
                  required
                  disabled={!canWrite}
                />
                <select name="kind" aria-label="토큰 권한" disabled={!canWrite}>
                  <option>read-only</option>
                  <option>write</option>
                </select>
                <input
                  name="expires"
                  aria-label="토큰 만료"
                  type="datetime-local"
                  required
                  defaultValue={new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16)}
                  disabled={!canWrite}
                />
                <button disabled={!canWrite || busy}>토큰 발급</button>
              </form>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>이름 / 종류</th>
                      <th>만료 / 마지막 사용</th>
                      <th>상태</th>
                      <th>관리</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tokens.map((t) => {
                      const active = !t.revoked_at && Date.parse(t.expires_at) > Date.now();
                      return (
                        <tr key={t.id}>
                          <td>
                            {t.name}
                            <small>
                              {t.kind} · {t.prefix}
                            </small>
                          </td>
                          <td>
                            {date(t.expires_at)}
                            <small>{date(t.last_used_at)}</small>
                          </td>
                          <td>
                            <Badge
                              value={t.revoked_at ? 'revoked' : active ? 'active' : 'expired'}
                            />
                          </td>
                          <td>
                            <button
                              disabled={!canWrite || !active || busy}
                              onClick={() => {
                                const expiry = prompt('새 만료 시각 (ISO8601)', t.expires_at);
                                if (expiry)
                                  void act(() =>
                                    api(`/tokens/${t.id}`, 'PATCH', { expires_at: expiry }),
                                  );
                              }}
                            >
                              만료 변경
                            </button>{' '}
                            <button
                              disabled={!canWrite || !active || busy}
                              onClick={() => {
                                if (confirm(`${t.name} 토큰을 폐기할까요?`))
                                  void act(() => api(`/tokens/${t.id}`, 'DELETE'));
                              }}
                            >
                              폐기
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
            <section>
              <h2>Schema 등록</h2>
              <p className="muted">
                Schema는 불변입니다. 변경 시 새 ID를 사용합니다. 먼저 research 큐를 만든 후 아래
                예제를 등록하면 기본 실험을 제출할 수 있습니다.
              </p>
              <SchemaForm
                disabled={!canWrite || busy}
                onSubmit={(body) => act(() => api('/schemas', 'POST', body))}
              />
              <details>
                <summary>등록된 schema ({schemas.length})</summary>
                <Json value={schemas} />
              </details>
            </section>
            <section>
              <h2>운영 정책</h2>
              <p className="muted">
                최대 실행 시간과 전송 여유를 설정합니다. 변경은 새 작업에 적용됩니다.
              </p>
              {settings && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const data = new FormData(e.currentTarget);
                    void act(() =>
                      api('/settings', 'PATCH', {
                        max_attempt_seconds: Number(data.get('max_attempt_seconds')),
                        upload_margin_seconds: Number(data.get('upload_margin_seconds')),
                      }),
                    );
                  }}
                >
                  <div className="form-grid">
                    <label>
                      최대 실행 시간 (초)
                      <input
                        name="max_attempt_seconds"
                        type="number"
                        min={1}
                        max={604800}
                        required
                        defaultValue={settings.max_attempt_seconds}
                        disabled={!canWrite || busy}
                      />
                    </label>
                    <label>
                      전송 여유 (초)
                      <input
                        name="upload_margin_seconds"
                        type="number"
                        min={30}
                        max={3600}
                        required
                        defaultValue={settings.upload_margin_seconds}
                        disabled={!canWrite || busy}
                      />
                    </label>
                  </div>
                  <button disabled={!canWrite || busy}>정책 저장</button>
                </form>
              )}
            </section>
            <section>
              <h2>계정 보안</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  void act(async () => {
                    await api('/account/actions', 'POST', {
                      action: 'change_password',
                      ...(me.token_id
                        ? { token: data.get('current') }
                        : { password: data.get('current') }),
                      new_password: data.get('new'),
                    });
                    setMe(undefined);
                  });
                }}
              >
                <label>
                  {me.token_id ? '현재 API 토큰' : '현재 비밀번호'}
                  <input
                    name="current"
                    type="password"
                    autoComplete="current-password"
                    required
                    disabled={!canWrite}
                  />
                </label>
                <label>
                  새 계정 비밀번호 (12자 이상)
                  <input
                    name="new"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    required
                    disabled={!canWrite}
                  />
                </label>
                <button disabled={!canWrite || busy}>비밀번호 변경 · 세션 종료</button>
                <button
                  type="button"
                  disabled={!canWrite || busy}
                  onClick={(e) => {
                    const form = e.currentTarget.form;
                    if (!form) return;
                    const credential = new FormData(form).get('current');
                    if (credential)
                      void act(async () => {
                        await api('/account/actions', 'POST', {
                          action: 'revoke_sessions',
                          ...(me.token_id ? { token: credential } : { password: credential }),
                        });
                        setMe(undefined);
                      });
                  }}
                >
                  전체 브라우저 세션 종료
                </button>
              </form>
            </section>
            <details>
              <summary>서버 기능과 한도</summary>
              <Json value={caps} />
            </details>
          </>
        )}
        <footer>GRT 연구 제어 · API v1 · 표시 시간 Asia/Seoul</footer>
      </main>
      {detail && (
        <div className="overlay">
          <section role="dialog" aria-modal="true" aria-label="실험 상세" className="dialog">
            <div className="section-heading">
              <h2>
                {detail.name} <Badge value={detail.status} />
              </h2>
              <button onClick={() => setDetail(undefined)}>닫기</button>
            </div>
            {detail.validation_error && <Json value={detail.validation_error} />}
            <h3>불변 설정</h3>
            <Json value={detail.spec} />
            <h3>실행 이력</h3>
            {detail.attempts?.map((a: any) => (
              <details key={a.id} open>
                <summary>
                  {a.id} · {a.stage} · {a.stale ? 'stale (종료 확인 필요)' : a.status}
                </summary>
                <p>
                  진행{' '}
                  {a.progress
                    ? `${a.progress.current} / ${a.progress.total ?? '?'} ${a.progress.unit}`
                    : '미측정'}{' '}
                  · ETA {a.eta_seconds ?? '미측정'} · 마지막 서버 checkpoint{' '}
                  {a.last_verified_checkpoint_id || '없음'}
                </p>
                <Json value={a} />
              </details>
            ))}
            {detail.status === 'running' && (
              <button disabled={!canWrite || busy} onClick={() => jobAction(detail, 'retry')}>
                Stale 복구 · 종료 근거 기록
              </button>
            )}
            <h3>결과·로그 파일</h3>
            {detail.artifacts?.map((a: any) => (
              <div className="artifact" key={a.id}>
                <div>
                  {a.name} <Badge value={a.status} />
                  <small>
                    {a.kind} · {a.size_bytes.toLocaleString()} bytes
                  </small>
                  <code>{a.sha256}</code>
                </div>
                <button disabled={a.status !== 'verified' || busy} onClick={() => download(a.id)}>
                  다운로드
                </button>
              </div>
            ))}
            <h3>요약</h3>
            <Json value={detail.summary} />
          </section>
        </div>
      )}
      {oneTime && (
        <div className="overlay">
          <section role="dialog" aria-modal="true" aria-label="발급된 토큰" className="dialog">
            <h2>토큰을 안전하게 보관하세요</h2>
            <p>이 창을 닫으면 원문을 다시 조회할 수 없습니다.</p>
            <textarea readOnly value={oneTime} autoComplete="off" />
            <div className="toolbar">
              <button onClick={() => navigator.clipboard.writeText(oneTime).catch(setError)}>
                복사
              </button>
              <button className="primary" onClick={() => setOneTime(undefined)}>
                보관 완료 · 닫기
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
function SchemaForm({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (body: any) => Promise<any>;
}) {
  const [value, setValue] = useState(pretty(sampleSchema));
  const [error, setError] = useState<unknown>();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        try {
          void onSubmit(JSON.parse(value));
          setError(null);
        } catch (e) {
          setError(e);
        }
      }}
    >
      <label>
        Schema JSON
        <textarea
          rows={12}
          value={value}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <ErrorBox error={error} />
      <button disabled={disabled}>새 불변 schema 등록</button>
    </form>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
