/* ============================================================
   SOCIAL BOARD v2 — Firebase Realtime Database Edition
   GAS(app.js) → Firebase 마이그레이션 버전
   ============================================================
   변경된 부분: GAS_URL → Firebase 설정, api() 함수 전체 교체
   유지된 부분: state, 유틸, UI 렌더링, 이벤트 바인딩 모두 동일
   ============================================================ */

// ★ 배포 전 반드시 교체하세요
const FB_URL     = 'https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com';
const FB_STORAGE = 'YOUR_PROJECT_ID.appspot.com'; // 파일 첨부 사용 시

/*
  ── Firebase 데이터 구조 ─────────────────────────────────────
  /meta/activeSemester              ← 현재 학기 ("2026-1")
  /admins/{adminId}/password        ← 관리자 비밀번호
  /students/{sid}/name              ← 학생 이름
  /students/{sid}/klass             ← 반 (선택)
  /{semester}/classes/{classId}/    ← 반
  /{semester}/activities/{id}/      ← 활동
  /{semester}/groups/{id}/          ← 조
  /{semester}/posts/{id}/           ← 게시물

  ── 학생 명단 등록 방법 ──────────────────────────────────────
  Firebase Console → Realtime Database → 직접 입력:
  students/
    10101/
      name: "홍길동"
      klass: "1반"
    10102/
      name: "김철수"
      klass: "1반"

  또는 아래 setup() 함수로 일괄 등록 가능.

  ── Firebase Security Rules (테스트용) ──────────────────────
  {
    "rules": {
      ".read": true,
      ".write": true
    }
  }
  ★ 실제 운영 시 rules를 강화하세요.
  ─────────────────────────────────────────────────────────── */

// ----------- 전역 상태 ----------- (원본과 동일)
const state = {
  user: null,
  adminToken: null,
  semester: '2026-1',
  cur: {
    classId: null, className: '',
    activityId: null, activityTitle: '', activityType: 'mixed',
    columnsCreated: false,
    groups: []
  }
};

// ----------- 유틸 ----------- (원본과 동일)
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.hidden = true, 2400);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString('ko-KR', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' });
}

function show(screenId) {
  ['screen-login','screen-classes','screen-activities','screen-board'].forEach(id => {
    $('#'+id).hidden = (id !== screenId);
  });
  $('#topbar').hidden = (screenId === 'screen-login');
}

function isAdmin() { return !!(state.user && state.user.admin); }

// ----------- 세션 ----------- (원본과 동일)
function saveSession() {
  sessionStorage.setItem('sb.session', JSON.stringify({
    user: state.user, adminToken: state.adminToken, semester: state.semester
  }));
}
function loadSession() {
  try {
    const raw = sessionStorage.getItem('sb.session');
    if (!raw) return false;
    const s = JSON.parse(raw);
    if (s.user) {
      state.user = s.user;
      state.adminToken = s.adminToken;
      state.semester = s.semester || '2026-1';
      return true;
    }
  } catch {}
  return false;
}
function clearSession() {
  sessionStorage.removeItem('sb.session');
  state.user = null; state.adminToken = null;
}

// ============================================================
//  ★ Firebase Helpers (GAS api() 대체)
// ============================================================

/** Firebase REST API 공통 요청 */
async function fbReq(path, method = 'GET', data = null) {
  const url = FB_URL + path + '.json';
  const opts = { method };
  if (data !== null) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(data);
  }
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error('Firebase 오류: HTTP ' + r.status);
  return r.json();
}

const fbGet    = path       => fbReq(path);
const fbSet    = (path, d)  => fbReq(path, 'PUT', d);
const fbPatch  = (path, d)  => fbReq(path, 'PATCH', d);
const fbDelete = path       => fbReq(path, 'DELETE');
async function fbPush(path, data) {
  const r = await fbReq(path, 'POST', data);
  return r.name; // Firebase 자동생성 키
}

/** Firebase 객체 → 배열 변환 */
function objToArr(obj) {
  if (!obj) return [];
  return Object.entries(obj).map(([k, v]) => ({ _id: k, ...v }));
}

/** 관리자 권한 확인 (클라이언트 사이드) */
function verifyAdmin(token) {
  if (!state.adminToken || state.adminToken !== token)
    throw new Error('관리자 권한이 없습니다.');
}

/** Firebase Storage 파일 업로드 */
async function fbUploadFile(base64, fileName, mime) {
  const ext  = fileName.split('.').pop();
  const path = 'posts/' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.' + ext;
  const url  = 'https://firebasestorage.googleapis.com/v0/b/' + FB_STORAGE
             + '/o?uploadType=media&name=' + encodeURIComponent(path);
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': mime }, body: bytes });
  if (!r.ok) throw new Error('파일 업로드 실패 (' + r.status + ')');
  const d = await r.json();
  return 'https://firebasestorage.googleapis.com/v0/b/' + FB_STORAGE
       + '/o/' + encodeURIComponent(path) + '?alt=media&token=' + d.downloadTokens;
}

// ============================================================
//  ★ api() 디스패처 — 기존 GAS api() 와 완전히 같은 인터페이스
// ============================================================
async function api(action, payload = {}) {
  switch (action) {
    case 'auth.studentLogin':   return fbStudentLogin(payload);
    case 'auth.adminLogin':     return fbAdminLogin(payload);
    case 'meta.activeSemester': return fbGetMeta();
    case 'class.list':          return fbClassList(payload);
    case 'class.create':        return fbClassCreate(payload);
    case 'class.delete':        return fbClassDelete(payload);
    case 'activity.list':       return fbActivityList(payload);
    case 'activity.create':     return fbActivityCreate(payload);
    case 'activity.delete':     return fbActivityDelete(payload);
    case 'activity.get':        return fbActivityGet(payload);
    case 'group.list':          return fbGroupList(payload);
    case 'group.makeColumns':   return fbMakeColumns(payload);
    case 'group.rename':        return fbGroupRename(payload);
    case 'post.list':           return fbPostList(payload);
    case 'post.create':         return fbPostCreate(payload);
    case 'post.moderate':       return fbPostModerate(payload);
    case 'export.csv':          return fbExportCsv(payload);
    default: throw new Error('Unknown action: ' + action);
  }
}

// ── 인증 ─────────────────────────────────────────────────────
async function fbStudentLogin({ sid, name }) {
  const student = await fbGet('/students/' + sid);
  if (!student || student.name !== name)
    throw new Error('학번 또는 이름이 명단과 일치하지 않습니다.');
  return { sid, name: student.name, klass: student.klass || '' };
}

async function fbAdminLogin({ id, password }) {
  const admin = await fbGet('/admins/' + id);
  if (!admin || admin.password !== password)
    throw new Error('관리자 정보가 올바르지 않습니다.');
  return { token: password }; // 비밀번호를 토큰으로 사용 (교실용)
}

// ── 메타 ──────────────────────────────────────────────────────
async function fbGetMeta() {
  const meta = await fbGet('/meta');
  return { semester: (meta && meta.activeSemester) || '2026-1' };
}

// ── 반 ────────────────────────────────────────────────────────
async function fbClassList({ semester }) {
  const raw = await fbGet('/' + semester + '/classes');
  return objToArr(raw)
    .map(c => ({ classId: c._id, className: c.className, createdAt: c.createdAt }))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

async function fbClassCreate({ semester, name, token }) {
  verifyAdmin(token);
  const id = await fbPush('/' + semester + '/classes', {
    className: name, createdAt: new Date().toISOString()
  });
  return { classId: id };
}

async function fbClassDelete({ semester, classId, token }) {
  verifyAdmin(token);
  // 반 안의 활동 연쇄 삭제
  const acts = objToArr(await fbGet('/' + semester + '/activities'))
    .filter(a => a.classId === classId);
  for (const a of acts) {
    await _deleteActivity(semester, a._id);
  }
  await fbDelete('/' + semester + '/classes/' + classId);
  return { ok: true };
}

// ── 활동 ──────────────────────────────────────────────────────
async function fbActivityList({ semester, classId }) {
  const raw = await fbGet('/' + semester + '/activities');
  return objToArr(raw)
    .filter(a => a.classId === classId)
    .map(a => ({
      activityId: a._id, classId: a.classId,
      title: a.title, type: a.type || 'basic',
      description: a.description || '',
      url: a.url || '',
      columnsCreated: a.columnsCreated || false,
      createdAt: a.createdAt
    }))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

async function fbActivityCreate({ semester, classId, title, type, description, url = '', token }) {
  verifyAdmin(token);
  const id = await fbPush('/' + semester + '/activities', {
    classId, title, type: type || 'basic',
    description: description || '',
    url: url || '',
    columnsCreated: false,
    createdAt: new Date().toISOString()
  });
  return { activityId: id };
}

async function fbActivityGet({ semester, activityId }) {
  const a = await fbGet('/' + semester + '/activities/' + activityId);
  if (!a) throw new Error('활동을 찾을 수 없습니다.');
  return { activityId, ...a };
}

async function fbActivityDelete({ semester, activityId, token }) {
  verifyAdmin(token);
  await _deleteActivity(semester, activityId);
  return { ok: true };
}

/** 내부 연쇄 삭제 (조 + 게시물 + 활동) */
async function _deleteActivity(semester, activityId) {
  const groups = objToArr(await fbGet('/' + semester + '/groups'))
    .filter(g => g.activityId === activityId);
  for (const g of groups) await fbDelete('/' + semester + '/groups/' + g._id);

  const posts = objToArr(await fbGet('/' + semester + '/posts'))
    .filter(p => p.activityId === activityId);
  for (const p of posts) await fbDelete('/' + semester + '/posts/' + p._id);

  await fbDelete('/' + semester + '/activities/' + activityId);
}

// ── 조 ────────────────────────────────────────────────────────
async function fbGroupList({ semester, activityId }) {
  const raw = await fbGet('/' + semester + '/groups');
  return objToArr(raw)
    .filter(g => g.activityId === activityId)
    .map(g => ({ groupId: g._id, activityId: g.activityId, title: g.title, order: g.order || 0 }))
    .sort((a, b) => a.order - b.order);
}

async function fbMakeColumns({ semester, activityId, token }) {
  verifyAdmin(token);
  for (let i = 1; i <= 8; i++) {
    await fbPush('/' + semester + '/groups', {
      activityId, title: i + '조', order: i,
      createdAt: new Date().toISOString()
    });
  }
  await fbPatch('/' + semester + '/activities/' + activityId, { columnsCreated: true });
  return { ok: true };
}

async function fbGroupRename({ semester, groupId, title, token }) {
  verifyAdmin(token);
  await fbPatch('/' + semester + '/groups/' + groupId, { title });
  return { ok: true };
}

// ── 게시물 ────────────────────────────────────────────────────
async function fbPostList({ semester, activityId, includeHidden }) {
  const raw = await fbGet('/' + semester + '/posts');
  return objToArr(raw)
    .filter(p => {
      if (p.activityId !== activityId) return false;
      if (p.status === 'deleted') return false;
      if (!includeHidden && p.status === 'hidden') return false;
      return true;
    })
    .map(p => ({ postId: p._id, ...p }))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

async function fbPostCreate(payload) {
  const {
    semester, activityId, groupId = '',
    sid, name, type = 'basic',
    title = '', content = '',
    step1 = '', step2 = '', step3 = '', step4 = '', step5 = '',
    fileBase64, fileName, fileMime
  } = payload;

  let fileUrl = '', fileNameSaved = '';
  if (fileBase64 && fileName) {
    fileUrl = await fbUploadFile(fileBase64, fileName, fileMime || 'application/octet-stream');
    fileNameSaved = fileName;
  }

  const id = await fbPush('/' + semester + '/posts', {
    activityId, groupId, sid, name, type,
    title, content, step1, step2, step3, step4, step5,
    fileUrl, fileName: fileNameSaved,
    status: 'visible',
    createdAt: new Date().toISOString()
  });
  return { postId: id };
}

async function fbPostModerate({ semester, postId, status, token }) {
  verifyAdmin(token);
  await fbPatch('/' + semester + '/posts/' + postId, { status });
  return { ok: true };
}

// ── CSV 내보내기 (클라이언트 생성) ────────────────────────────
async function fbExportCsv({ semester, scope, id }) {
  let posts = objToArr(await fbGet('/' + semester + '/posts'))
    .filter(p => p.status !== 'deleted')
    .map(p => ({ postId: p._id, ...p }));

  if (scope === 'activity') {
    posts = posts.filter(p => p.activityId === id);
  } else if (scope === 'class') {
    const actIds = objToArr(await fbGet('/' + semester + '/activities'))
      .filter(a => a.classId === id)
      .map(a => a._id);
    posts = posts.filter(p => actIds.includes(p.activityId));
  }

  const fields = ['postId','activityId','groupId','sid','name','type',
                  'title','content','step1','step2','step3','step4','step5',
                  'fileUrl','status','createdAt'];
  const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const csv  = [fields.join(','), ...posts.map(p => fields.map(f => esc(p[f])).join(','))].join('\n');
  return { csv, count: posts.length };
}

// ============================================================
//  아래부터는 원본 app.js 와 완전히 동일
// ============================================================

async function studentLogin() {
  const sid  = $('#login-sid').value.trim();
  const name = $('#login-name').value.trim();
  if (!sid || !name) return toast('학번과 이름을 모두 입력해 주세요.', 'error');
  try {
    const u = await api('auth.studentLogin', { sid, name, semester: state.semester });
    state.user = u;
    saveSession();
    enterApp();
    toast(`환영합니다, ${u.name} 님`, 'success');
  } catch (e) { toast(e.message, 'error'); }
}

async function adminLogin() {
  const id = $('#admin-id').value.trim();
  const pw = $('#admin-pw').value;
  if (!id || !pw) return toast('관리자 정보를 입력해 주세요.', 'error');
  try {
    const r = await api('auth.adminLogin', { id, password: pw });
    state.user = { admin: true, name: '관리자', sid: id };
    state.adminToken = r.token;
    saveSession();
    enterApp();
    toast('관리자로 로그인했습니다.', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

function logout() { clearSession(); show('screen-login'); }

async function enterApp() {
  try {
    const m = await api('meta.activeSemester', {});
    state.semester = m.semester;
    saveSession();
  } catch {}
  $('#semester-pill').textContent = state.semester + '학기';
  const u = state.user;
  $('#user-chip').innerHTML = u.admin
    ? `<strong>관리자</strong>`
    : `<span>${escapeHtml(u.sid)}</span>&nbsp;${escapeHtml(u.name)}`;
  $('#btn-new-class').hidden    = !isAdmin();
  $('#btn-new-activity').hidden = !isAdmin();
  $('#btn-export').hidden       = !isAdmin();
  await renderClasses();
  show('screen-classes');
}

async function renderClasses() {
  const grid = $('#class-grid');
  grid.innerHTML = '<p class="muted">불러오는 중…</p>';
  try {
    const list = await api('class.list', { semester: state.semester });
    if (!list.length) {
      grid.innerHTML = `<div class="empty"><strong>아직 등록된 반이 없습니다.</strong>${
        isAdmin() ? '오른쪽 위의 "반 만들기"로 시작하세요.' : '담당 교사가 반을 생성하면 표시됩니다.'
      }</div>`;
      return;
    }
    grid.innerHTML = list.map(c => `
      <button class="class-card" data-class-id="${c.classId}">
        <div class="cc-name">${escapeHtml(c.className)}</div>
        ${isAdmin() ? `<div class="cc-actions">
          <span class="mini-btn danger" data-action="del-class" data-id="${c.classId}">삭제</span>
        </div>` : ''}
      </button>`).join('');
    grid.querySelectorAll('.class-card').forEach(btn => {
      btn.addEventListener('click', e => {
        if (e.target.dataset.action === 'del-class') return;
        openClass(btn.dataset.classId, btn.querySelector('.cc-name').textContent);
      });
    });
    grid.querySelectorAll('[data-action="del-class"]').forEach(b => {
      b.addEventListener('click', async e => {
        e.stopPropagation();
        if (!confirm('반과 그 안의 모든 활동·게시물이 삭제됩니다. 계속할까요?')) return;
        try {
          await api('class.delete', { semester: state.semester, classId: b.dataset.id, token: state.adminToken });
          toast('반을 삭제했습니다.', 'success'); renderClasses();
        } catch (err) { toast(err.message, 'error'); }
      });
    });
  } catch (e) { grid.innerHTML = `<p class="muted">오류: ${escapeHtml(e.message)}</p>`; }
}

async function newClass() {
  const name = await prompt2('반 만들기', '반 이름을 입력하세요. 예) 1학년 3반');
  if (!name) return;
  try {
    await api('class.create', { semester: state.semester, name, token: state.adminToken });
    toast('반을 생성했습니다.', 'success'); renderClasses();
  } catch (e) { toast(e.message, 'error'); }
}

async function openClass(classId, className) {
  state.cur.classId = classId; state.cur.className = className;
  $('#cur-class-title').textContent = className + ' / 활동 목록';
  $('#cur-class-sub').textContent = state.semester + '학기 · 활동을 선택하세요';
  show('screen-activities'); await renderActivities();
}

async function renderActivities() {
  const root = $('#activity-list');
  root.innerHTML = '<p class="muted">불러오는 중…</p>';
  try {
    const list = await api('activity.list', { semester: state.semester, classId: state.cur.classId });
    if (!list.length) {
      root.innerHTML = `<div class="empty"><strong>등록된 활동이 없습니다.</strong>${
        isAdmin() ? '오른쪽 위 "활동 만들기"로 시작하세요.' : '담당 교사가 활동을 생성하면 표시됩니다.'
      }</div>`;
      return;
    }
    root.innerHTML = list.map(a => {
      const isLink = a.type === 'link';
      const isInq  = a.type === 'inquiry';
      const icon   = isLink ? '🔗' : isInq ? '🔎' : '📋';
      const iconCls= isLink ? 'link' : isInq ? 'inquiry' : '';
      const desc   = isLink ? '외부 링크 활동' : escapeHtml(a.description||(isInq?'탐구 질문 5단계 활동':'일반 모둠 활동'));
      return `<div class="activity-card" data-id="${a.activityId}" data-title="${escapeHtml(a.title)}"
               data-type="${escapeHtml(a.type||'mixed')}"
               data-cols="${a.columnsCreated===true||a.columnsCreated==='TRUE'||a.columnsCreated==='true'?'1':'0'}"
               data-url="${escapeHtml(a.url||'')}">
        <div class="activity-icon ${iconCls}">${icon}</div>
        <div>
          <div class="a-title">${escapeHtml(a.title)}</div>
          <div class="a-desc">${desc}</div>
        </div>
        <div class="a-actions">
          ${isAdmin()?`<button class="btn-ghost" data-action="del-activity" data-id="${a.activityId}">삭제</button>`:''}
          <button class="btn-primary" data-action="open">${isLink?'활동 열기 →':'입장 →'}</button>
        </div>
      </div>`;
    }).join('');
    root.querySelectorAll('.activity-card').forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.closest('[data-action="del-activity"]')) return;
        openActivity({ activityId: card.dataset.id, title: card.dataset.title,
                       type: card.dataset.type, columnsCreated: card.dataset.cols === '1',
                       url: card.dataset.url || '' });
      });
    });
    root.querySelectorAll('[data-action="del-activity"]').forEach(b => {
      b.addEventListener('click', async e => {
        e.stopPropagation();
        if (!confirm('이 활동과 그 안의 모든 조·게시물이 삭제됩니다.')) return;
        try {
          await api('activity.delete', { semester: state.semester, activityId: b.dataset.id, token: state.adminToken });
          toast('활동을 삭제했습니다.', 'success'); renderActivities();
        } catch (err) { toast(err.message, 'error'); }
      });
    });
  } catch (e) { root.innerHTML = `<p class="muted">오류: ${escapeHtml(e.message)}</p>`; }
}

async function newActivity() {
  const name = await prompt2('활동 만들기', '활동명을 입력하세요. 예) 김해 공간 변화 탐구');
  if (!name) return;
  const isLink = confirm('외부 링크 활동인가요?\n[확인] 링크 활동 (김해 수업통합 등)\n[취소] 일반·탐구 활동');
  let type = 'basic', url = '';
  if (isLink) {
    type = 'link';
    url = await prompt2('활동 URL', '학생에게 열어줄 페이지 주소를 입력하세요.');
    if (!url) return;
  } else {
    const isInq = confirm('탐구 질문 5단계 활동인가요?\n[확인] 탐구 / [취소] 일반');
    type = isInq ? 'inquiry' : 'basic';
  }
  try {
    await api('activity.create', { semester: state.semester, classId: state.cur.classId,
      title: name, type, url, description: '', token: state.adminToken });
    toast('활동을 생성했습니다.', 'success'); renderActivities();
  } catch (e) { toast(e.message, 'error'); }
}

async function openActivity(act) {
  if (act.type === 'link') {
    if (!act.url) return toast('링크 URL이 설정되지 않았습니다.', 'error');
    window.open(act.url, '_blank', 'noopener');
    return;
  }
  state.cur.activityId    = act.activityId;
  state.cur.activityTitle = act.title;
  state.cur.activityType  = act.type || 'mixed';
  state.cur.columnsCreated = !!act.columnsCreated;
  $('#cur-activity-title').textContent = state.cur.className + ' / ' + act.title;
  $('#cur-activity-sub').textContent = state.semester + '학기' + (act.type === 'inquiry' ? ' · 탐구 5단계' : '');
  show('screen-board'); await refreshBoard();
}

async function refreshBoard() {
  try {
    const a = await api('activity.get', { semester: state.semester, activityId: state.cur.activityId });
    state.cur.columnsCreated = (a.columnsCreated === true || a.columnsCreated === 'TRUE' || a.columnsCreated === 'true');
  } catch {}
  $('#btn-make-columns').hidden = !(isAdmin() && !state.cur.columnsCreated);
  const [groups, posts] = await Promise.all([
    api('group.list', { semester: state.semester, activityId: state.cur.activityId }),
    api('post.list',  { semester: state.semester, activityId: state.cur.activityId, includeHidden: isAdmin() })
  ]);
  state.cur.groups = groups;
  if (state.cur.columnsCreated && groups.length > 0) {
    renderColumns(groups, posts);
    $('#columns-area').hidden = false; $('#free-area').hidden = true;
  } else {
    renderFreePosts(posts);
    $('#columns-area').hidden = true; $('#free-area').hidden = false;
  }
}

function renderFreePosts(posts) {
  const root = $('#free-area');
  if (!posts.length) {
    root.innerHTML = `<div class="free-empty"><strong>아직 게시물이 없습니다.</strong>"+ 게시물 작성"으로 시작하세요.${
      isAdmin() ? '<br/><br/>조별 컬럼으로 진행하시려면 "+ 8개 조 컬럼 만들기"를 누르세요.' : ''
    }</div>`;
    return;
  }
  root.innerHTML = posts.map(renderPost).join('');
  bindPostActions(root);
}

function renderColumns(groups, posts) {
  const root = $('#columns-area');
  root.innerHTML = groups.map(g => {
    const groupPosts = posts.filter(p => p.groupId === g.groupId);
    const titleClass = isAdmin() ? 'c-title editable' : 'c-title';
    const titleAttr  = isAdmin() ? `data-action="rename" data-id="${g.groupId}" title="클릭하여 이름 수정"` : '';
    return `<article class="col" data-group-id="${g.groupId}">
      <header class="col-head">
        <span class="${titleClass}" ${titleAttr}>${escapeHtml(g.title)}</span>
        <span class="c-count">${groupPosts.length}</span>
      </header>
      <div class="col-body">
        ${groupPosts.length === 0 ? '<div class="col-empty">게시물 없음</div>' : groupPosts.map(renderPost).join('')}
      </div>
      <footer class="col-foot">
        <button class="col-post-btn" data-action="post-to-group" data-group="${g.groupId}" data-group-title="${escapeHtml(g.title)}">+ ${escapeHtml(g.title)}에 게시</button>
      </footer>
    </article>`;
  }).join('');
  bindPostActions(root);
  root.querySelectorAll('[data-action="rename"]').forEach(el => {
    el.addEventListener('click', async () => {
      const newName = await prompt2('조 이름 수정', '새 조 이름을 입력하세요.', el.textContent.trim());
      if (!newName || newName === el.textContent.trim()) return;
      try {
        await api('group.rename', { semester: state.semester, groupId: el.dataset.id, title: newName, token: state.adminToken });
        toast('조 이름을 변경했습니다.', 'success'); refreshBoard();
      } catch (e) { toast(e.message, 'error'); }
    });
  });
  root.querySelectorAll('[data-action="post-to-group"]').forEach(b => {
    b.addEventListener('click', () => openPostModal(b.dataset.group, b.dataset.groupTitle));
  });
}

function renderPost(p) {
  const isInq = p.type === 'inquiry';
  const hidden = p.status === 'hidden' ? ' hidden-post' : '';
  const adminCls = (p.name === '관리자') ? ' admin-post' : '';
  const stepsHtml = isInq ? `<div class="n-steps">
    ${p.step1?`<div class="n-step"><b>① 관찰 중 궁금했던 점</b>${escapeHtml(p.step1)}</div>`:''}
    ${p.step2?`<div class="n-step"><b>② 탐구 질문</b>${escapeHtml(p.step2)}</div>`:''}
    ${p.step3?`<div class="n-step"><b>③ 예상 답변</b>${escapeHtml(p.step3)}</div>`:''}
    ${p.step4?`<div class="n-step"><b>④ AI 답변</b>${escapeHtml(p.step4)}</div>`:''}
    ${p.step5?`<div class="n-step"><b>⑤ 비판적 검토</b>${escapeHtml(p.step5)}</div>`:''}
  </div>` : '';
  const authorPill = (p.name === '관리자')
    ? `<span class="pill pill-admin">관리자</span>`
    : `<span>${escapeHtml(p.sid)} ${escapeHtml(p.name)}</span>`;
  return `<article class="note${hidden}${adminCls}" data-post-id="${p.postId}">
    <div class="n-head">
      <span class="pill ${isInq?'pill-lime':'pill-mint'}">${isInq?'탐구':'일반'}</span>
      ${authorPill}
      ${p.status==='hidden'?'<span class="pill pill-soft">숨김</span>':''}
    </div>
    ${!isInq&&p.title?`<div class="n-title">${escapeHtml(p.title)}</div>`:''}
    ${!isInq&&p.content?`<div class="n-content">${escapeHtml(p.content)}</div>`:''}
    ${stepsHtml}
    ${p.fileUrl?`<a class="n-file" href="${escapeHtml(p.fileUrl)}" target="_blank" rel="noopener">📎 ${escapeHtml(p.fileName||'첨부파일')}</a>`:''}
    <div class="n-foot">
      <span>${fmtDate(p.createdAt)}</span>
      ${isAdmin()?`<span class="n-actions">
        <button class="mini-btn" data-mod="${p.status==='hidden'?'visible':'hidden'}" data-id="${p.postId}">${p.status==='hidden'?'공개':'숨김'}</button>
        <button class="mini-btn danger" data-mod="deleted" data-id="${p.postId}">삭제</button>
      </span>`:''}
    </div>
  </article>`;
}

function bindPostActions(root) {
  root.querySelectorAll('[data-mod]').forEach(b => {
    b.addEventListener('click', async () => {
      const status = b.dataset.mod;
      if (status === 'deleted' && !confirm('이 게시물을 삭제할까요?')) return;
      try {
        await api('post.moderate', { semester: state.semester, postId: b.dataset.id, status, token: state.adminToken });
        toast('처리되었습니다.', 'success'); refreshBoard();
      } catch (e) { toast(e.message, 'error'); }
    });
  });
}

async function makeColumns() {
  if (!confirm('1조부터 8조까지 컬럼을 한 번에 만듭니다. 계속할까요?')) return;
  try {
    await api('group.makeColumns', { semester: state.semester, activityId: state.cur.activityId, token: state.adminToken });
    toast('1조~8조 컬럼이 생성되었습니다.', 'success'); refreshBoard();
  } catch (e) { toast(e.message, 'error'); }
}

let curGroupId = null, curGroupTitle = '', curPostType = 'basic';

function openPostModal(groupId, groupTitle) {
  curGroupId = groupId || null; curGroupTitle = groupTitle || '';
  if (isAdmin()) {
    $('#post-author').innerHTML = `<span style="color:var(--c-primary-accent)">관리자</span>`;
  } else {
    $('#post-author').textContent = `${state.user.sid} ${state.user.name}`;
  }
  if (state.cur.activityType === 'inquiry') setPostType('inquiry');
  else setPostType('basic');
  const wrap = $('#post-group-select-wrap');
  if (state.cur.columnsCreated && state.cur.groups.length > 0) {
    wrap.hidden = false;
    const sel = $('#post-group-select');
    sel.innerHTML = state.cur.groups.map(g =>
      `<option value="${g.groupId}" ${g.groupId===curGroupId?'selected':''}>${escapeHtml(g.title)}</option>`
    ).join('');
    if (!curGroupId) curGroupId = state.cur.groups[0].groupId;
    sel.value = curGroupId;
    $('#post-target').textContent = curGroupTitle || (state.cur.groups.find(g => g.groupId===curGroupId)?.title||'조 선택');
  } else {
    wrap.hidden = true; $('#post-target').textContent = '자유 게시';
  }
  $('#post-title').value=''; $('#post-content').value='';
  ['step1','step2','step3','step4','step5'].forEach(id => $('#'+id).value='');
  $('#post-file').value='';
  $('#modal-post').hidden = false;
}

function setPostType(t) {
  curPostType = t;
  $$('.seg').forEach(s => s.classList.toggle('active', s.dataset.type===t));
  $$('[data-show]').forEach(el => el.hidden = (el.dataset.show!==t));
}

async function submitPost() {
  let groupId = '';
  if (state.cur.columnsCreated && state.cur.groups.length > 0) {
    groupId = $('#post-group-select').value;
  }
  const payload = {
    semester: state.semester, activityId: state.cur.activityId,
    groupId, sid: state.user.sid, name: state.user.name, type: curPostType,
  };
  if (curPostType === 'basic') {
    const title = $('#post-title').value.trim();
    if (!title) return toast('제목을 입력하세요.', 'error');
    payload.title = title; payload.content = $('#post-content').value.trim();
  } else {
    payload.title = ''; payload.content = '';
    ['step1','step2','step3','step4','step5'].forEach(s => payload[s] = $('#'+s).value.trim());
    if (!Object.values(payload).some((v,i) => i>4 && v))
      return toast('탐구 5단계 중 적어도 1개 항목을 입력하세요.', 'error');
  }
  if (isAdmin()) { payload.isAdmin = true; payload.adminToken = state.adminToken; }
  const fileEl = $('#post-file');
  if (fileEl.files && fileEl.files[0]) {
    const f = fileEl.files[0];
    if (f.size > 10*1024*1024) return toast('파일은 10MB 이하만 가능합니다.', 'error');
    if (/^video\//.test(f.type)) return toast('동영상은 첨부할 수 없습니다.', 'error');
    payload.fileBase64 = await fileToBase64(f);
    payload.fileName = f.name; payload.fileMime = f.type;
  }
  try {
    await api('post.create', payload);
    $('#modal-post').hidden = true;
    toast('게시 완료!', 'success'); refreshBoard();
  } catch (e) { toast(e.message, 'error'); }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject; r.readAsDataURL(file);
  });
}

async function exportCsv() {
  if (!isAdmin()) return;
  const scope = state.cur.activityId ? 'activity' : state.cur.classId ? 'class' : 'semester';
  const id    = state.cur.activityId || state.cur.classId || '';
  try {
    const r = await api('export.csv', { semester: state.semester, scope, id, token: state.adminToken });
    const blob = new Blob([r.csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `SOCIAL_BOARD_${state.semester}_${scope}_${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
    toast(`${r.count}건 내보냈습니다.`, 'success');
  } catch (e) { toast(e.message, 'error'); }
}

function prompt2(title, desc, defaultValue) {
  return new Promise(resolve => {
    $('#prompt-title').textContent = title; $('#prompt-desc').textContent = desc;
    const inp = $('#prompt-input'); inp.value = defaultValue || '';
    $('#modal-prompt').hidden = false;
    setTimeout(() => { inp.focus(); inp.select(); }, 50);
    const ok = () => close(inp.value.trim() || null);
    const cancel = () => close(null);
    function close(val) {
      $('#modal-prompt').hidden = true;
      $('#prompt-ok').removeEventListener('click', ok);
      inp.removeEventListener('keydown', enter);
      resolve(val);
    }
    function enter(e) { if (e.key==='Enter') ok(); else if (e.key==='Escape') cancel(); }
    $('#prompt-ok').addEventListener('click', ok);
    inp.addEventListener('keydown', enter);
    $$('[data-close="modal-prompt"]').forEach(b => b.addEventListener('click', cancel, { once: true }));
  });
}

function bindOnce() {
  $('#btn-student-login').addEventListener('click', studentLogin);
  $('#btn-admin-login').addEventListener('click', adminLogin);
  $('#btn-logout').addEventListener('click', logout);
  $('#btn-new-class').addEventListener('click', newClass);
  $('#btn-new-activity').addEventListener('click', newActivity);
  $('#btn-make-columns').addEventListener('click', makeColumns);
  $('#btn-export').addEventListener('click', exportCsv);
  $('#btn-new-post').addEventListener('click', () => {
    if (state.cur.columnsCreated && state.cur.groups.length > 0)
      openPostModal(state.cur.groups[0].groupId, state.cur.groups[0].title);
    else openPostModal(null, '');
  });
  $('#post-group-select').addEventListener('change', e => {
    curGroupId = e.target.value;
    const g = state.cur.groups.find(x => x.groupId === curGroupId);
    $('#post-target').textContent = g ? g.title : '조 선택';
  });
  $$('[data-back]').forEach(b => {
    b.addEventListener('click', () => {
      const t = b.dataset.back;
      if (t==='classes')    show('screen-classes');
      if (t==='activities') show('screen-activities');
    });
  });
  $$('[data-close]').forEach(b => {
    b.addEventListener('click', () => { $('#'+b.dataset.close).hidden = true; });
  });
  $$('.seg').forEach(s => s.addEventListener('click', () => setPostType(s.dataset.type)));
  $('#btn-submit-post').addEventListener('click', submitPost);
  ['login-sid','login-name'].forEach(id => {
    $('#'+id).addEventListener('keydown', e => { if (e.key==='Enter') studentLogin(); });
  });
  ['admin-id','admin-pw'].forEach(id => {
    $('#'+id).addEventListener('keydown', e => { if (e.key==='Enter') adminLogin(); });
  });
}

(async function init() {
  bindOnce();
  if (loadSession()) {
    try { await enterApp(); return; } catch {}
  }
  show('screen-login');
})();
