/* ============================================================
   SOCIAL BOARD v2 — Firebase Realtime Database Edition
   GAS(app.js) → Firebase 마이그레이션 버전
   ============================================================
   v2.1 변경사항:
   - 학생 회원가입 신청 (학번, 이름, 교사코드, 비밀번호)
   - 기간별 교사코드 (expiresAt 포함)
   - 관리자 승인/탈퇴/비밀번호 초기화 (회원 관리 탭)
   - 학생 로그인: 학번 + 비밀번호
   ============================================================ */

// ★ 배포 전 반드시 교체하세요
const FB_URL     = 'https://yulha-2026-1-default-rtdb.asia-southeast1.firebasedatabase.app/';
const FB_STORAGE = 'yulha-2026-1.appspot.com'; // 파일 첨부 사용 시

/*
  ── Firebase 데이터 구조 (v2.1) ──────────────────────────────
  /meta/activeSemester              ← 현재 학기 ("2026-1")
  /admins/{adminId}/password        ← 관리자 비밀번호

  /codes/{codeId}/                  ← 교사 코드
    value: "yulha2026"              ← 학생이 입력하는 코드값
    label: "1학기 가입용"
    expiresAt: "2026-09-01"         ← 만료일 (YYYY-MM-DD)

  /pending/{sid}/                   ← 승인 대기 학생
    name, passwordHash, requestedAt

  /students/{sid}/                  ← 승인된 학생
    name, klass, passwordHash, approved: true, approvedAt

  /{semester}/classes/{classId}/    ← 반
  /{semester}/activities/{id}/      ← 활동
  /{semester}/groups/{id}/          ← 조
  /{semester}/posts/{id}/           ← 게시물

  ── Firebase 초기 데이터 예시 ────────────────────────────────
  {
    "meta": { "activeSemester": "2026-1" },
    "admins": { "teacher": { "password": "teacher1234" } },
    "codes": {
      "code1": {
        "value": "yulha2026",
        "label": "1학기 가입용",
        "expiresAt": "2026-09-01"
      }
    }
  }
  ──────────────────────────────────────────────────────────── */

// ----------- 전역 상태 -----------
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

// ----------- 유틸 -----------
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
  ['screen-login','screen-register','screen-classes','screen-activities','screen-board','screen-members'].forEach(id => {
    const el = $('#'+id);
    if (el) el.hidden = (id !== screenId);
  });
  $('#topbar').hidden = (screenId === 'screen-login' || screenId === 'screen-register');
}

function isAdmin() { return !!(state.user && state.user.admin); }

// ----------- SHA-256 해시 -----------
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

// ----------- 세션 -----------
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
//  Firebase Helpers
// ============================================================
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
  return r.name;
}

function objToArr(obj) {
  if (!obj) return [];
  return Object.entries(obj).map(([k, v]) => ({ _id: k, ...v }));
}

function verifyAdmin(token) {
  if (!state.adminToken || state.adminToken !== token)
    throw new Error('관리자 권한이 없습니다.');
}

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
//  api() 디스패처
// ============================================================
async function api(action, payload = {}) {
  switch (action) {
    case 'auth.studentLogin':    return fbStudentLogin(payload);
    case 'auth.studentRegister': return fbStudentRegister(payload);
    case 'auth.adminLogin':      return fbAdminLogin(payload);
    case 'meta.activeSemester':  return fbGetMeta();
    case 'class.list':           return fbClassList(payload);
    case 'class.create':         return fbClassCreate(payload);
    case 'class.delete':         return fbClassDelete(payload);
    case 'activity.list':        return fbActivityList(payload);
    case 'activity.create':      return fbActivityCreate(payload);
    case 'activity.delete':      return fbActivityDelete(payload);
    case 'activity.get':         return fbActivityGet(payload);
    case 'group.list':           return fbGroupList(payload);
    case 'group.makeColumns':    return fbMakeColumns(payload);
    case 'group.rename':         return fbGroupRename(payload);
    case 'post.list':            return fbPostList(payload);
    case 'post.create':          return fbPostCreate(payload);
    case 'post.moderate':        return fbPostModerate(payload);
    case 'export.csv':           return fbExportCsv(payload);
    // 회원 관리
    case 'member.pendingList':   return fbPendingList(payload);
    case 'member.approve':       return fbApprove(payload);
    case 'member.reject':        return fbReject(payload);
    case 'member.withdraw':      return fbWithdraw(payload);
    case 'member.resetPassword': return fbResetPassword(payload);
    case 'member.activeList':    return fbActiveList(payload);
    case 'code.list':            return fbCodeList(payload);
    case 'code.create':          return fbCodeCreate(payload);
    case 'code.delete':          return fbCodeDelete(payload);
    case 'meta.getSemester':     return fbGetSemesterForUI(payload);
    case 'meta.setSemester':     return fbSetSemester(payload);
    default: throw new Error('Unknown action: ' + action);
  }
}

// ── 인증 ─────────────────────────────────────────────────────

async function fbStudentLogin({ sid, password }) {
  const student = await fbGet('/students/' + sid);
  if (!student) throw new Error('등록되지 않은 학번입니다. 회원가입을 먼저 진행해 주세요.');
  if (!student.approved) throw new Error('관리자 승인 대기 중입니다. 잠시 후 다시 시도해 주세요.');
  const hash = await sha256(password);
  if (student.passwordHash !== hash) throw new Error('비밀번호가 올바르지 않습니다.');
  return { sid, name: student.name, klass: student.klass || '' };
}

async function fbStudentRegister({ sid, name, password, code }) {
  // 1. 이미 승인된 학생인지 확인
  const existing = await fbGet('/students/' + sid);
  if (existing && existing.approved) throw new Error('이미 가입된 학번입니다.');

  // 2. 대기 중인지 확인
  const pending = await fbGet('/pending/' + sid);
  if (pending) throw new Error('이미 승인 대기 중입니다. 관리자 승인을 기다려 주세요.');

  // 3. 교사 코드 유효성 검사
  const codes = await fbGet('/codes');
  const codeArr = objToArr(codes);
  const matched = codeArr.find(c => c.value === code);
  if (!matched) throw new Error('교사 코드가 올바르지 않습니다.');
  if (matched.expiresAt && new Date(matched.expiresAt) < new Date())
    throw new Error('만료된 교사 코드입니다. 담당 선생님께 문의하세요.');

  // 4. 대기 목록에 등록
  const passwordHash = await sha256(password);
  await fbSet('/pending/' + sid, {
    name, passwordHash,
    requestedAt: new Date().toISOString()
  });
  return { ok: true };
}

async function fbAdminLogin({ id, password }) {
  const admin = await fbGet('/admins/' + id);
  if (!admin || admin.password !== password)
    throw new Error('관리자 정보가 올바르지 않습니다.');
  return { token: password };
}

// ── 메타 ──────────────────────────────────────────────────────
async function fbGetMeta() {
  const meta = await fbGet('/meta');
  return { semester: (meta && meta.activeSemester) || '2026-1' };
}

async function fbGetSemesterForUI({ token }) {
  verifyAdmin(token);
  const meta = await fbGet('/meta');
  return { currentSemester: (meta && meta.activeSemester) || '2026-1' };
}

async function fbSetSemester({ semester, token }) {
  verifyAdmin(token);
  if (!semester || semester.trim() === '') throw new Error('학기명을 입력하세요.');
  await fbPatch('/meta', { activeSemester: semester.trim() });
  return { ok: true, semester: semester.trim() };
}

// ── 회원 관리 ─────────────────────────────────────────────────

async function fbPendingList({ token }) {
  verifyAdmin(token);
  const raw = await fbGet('/pending');
  return objToArr(raw).map(p => ({ sid: p._id, name: p.name, requestedAt: p.requestedAt }))
    .sort((a, b) => (a.requestedAt||'').localeCompare(b.requestedAt||''));
}

async function fbApprove({ sid, token }) {
  verifyAdmin(token);
  const pending = await fbGet('/pending/' + sid);
  if (!pending) throw new Error('대기 중인 학생을 찾을 수 없습니다.');
  await fbSet('/students/' + sid, {
    name: pending.name,
    klass: pending.klass || '',
    passwordHash: pending.passwordHash,
    approved: true,
    approvedAt: new Date().toISOString()
  });
  await fbDelete('/pending/' + sid);
  return { ok: true };
}

async function fbReject({ sid, token }) {
  verifyAdmin(token);
  await fbDelete('/pending/' + sid);
  return { ok: true };
}

async function fbWithdraw({ sid, token }) {
  verifyAdmin(token);
  await fbDelete('/students/' + sid);
  return { ok: true };
}

async function fbResetPassword({ sid, token }) {
  verifyAdmin(token);
  const student = await fbGet('/students/' + sid);
  if (!student) throw new Error('학생을 찾을 수 없습니다.');
  const newHash = await sha256(sid); // 학번으로 초기화
  await fbPatch('/students/' + sid, { passwordHash: newHash });
  return { ok: true };
}

async function fbActiveList({ token }) {
  verifyAdmin(token);
  const raw = await fbGet('/students');
  return objToArr(raw)
    .filter(s => s.approved)
    .map(s => ({ sid: s._id, name: s.name, klass: s.klass || '', approvedAt: s.approvedAt }))
    .sort((a, b) => a.sid.localeCompare(b.sid));
}

// ── 교사 코드 관리 ────────────────────────────────────────────

async function fbCodeList({ token }) {
  verifyAdmin(token);
  const raw = await fbGet('/codes');
  return objToArr(raw).map(c => ({
    codeId: c._id, value: c.value, label: c.label || '', expiresAt: c.expiresAt || ''
  }));
}

async function fbCodeCreate({ value, label, expiresAt, token }) {
  verifyAdmin(token);
  const id = await fbPush('/codes', { value, label: label || '', expiresAt: expiresAt || '' });
  return { codeId: id };
}

async function fbCodeDelete({ codeId, token }) {
  verifyAdmin(token);
  await fbDelete('/codes/' + codeId);
  return { ok: true };
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
  const acts = objToArr(await fbGet('/' + semester + '/activities'))
    .filter(a => a.classId === classId);
  for (const a of acts) await _deleteActivity(semester, a._id);
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

// ── CSV 내보내기 ────────────────────────────────────────────
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
//  UI — 로그인 / 회원가입
// ============================================================

async function studentLogin() {
  const sid      = $('#login-sid').value.trim();
  const password = $('#login-password').value;
  if (!sid || !password) return toast('학번과 비밀번호를 입력해 주세요.', 'error');
  try {
    const u = await api('auth.studentLogin', { sid, password });
    state.user = u;
    saveSession();
    enterApp();
    toast(`환영합니다, ${u.name} 님`, 'success');
  } catch (e) { toast(e.message, 'error'); }
}

async function studentRegister() {
  const sid  = $('#reg-sid').value.trim();
  const name = $('#reg-name').value.trim();
  const code = $('#reg-code').value.trim();
  const pw1  = $('#reg-pw').value;
  const pw2  = $('#reg-pw2').value;
  if (!sid || !name || !code || !pw1 || !pw2)
    return toast('모든 항목을 입력해 주세요.', 'error');
  if (pw1 !== pw2)
    return toast('비밀번호가 일치하지 않습니다.', 'error');
  if (pw1.length < 4)
    return toast('비밀번호는 4자 이상이어야 합니다.', 'error');
  try {
    await api('auth.studentRegister', { sid, name, password: pw1, code });
    toast('신청이 완료됐습니다. 관리자 승인 후 로그인할 수 있습니다.', 'success');
    show('screen-login');
    ['reg-sid','reg-name','reg-code','reg-pw','reg-pw2'].forEach(id => { const el = $('#'+id); if(el) el.value=''; });
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
  $('#btn-members').hidden      = !isAdmin();
  await renderClasses();
  show('screen-classes');
}

// ============================================================
//  UI — 반 / 활동 / 게시물 (기존과 동일)
// ============================================================

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

// ============================================================
//  UI — 회원 관리 화면
// ============================================================

let memberTab = 'pending'; // 'pending' | 'active' | 'codes' | 'semester'

async function openMembers() {
  show('screen-members');
  switchMemberTab(memberTab);
}

function switchMemberTab(tab) {
  memberTab = tab;
  $$('.member-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#member-pending').hidden = (tab !== 'pending');
  $('#member-active').hidden  = (tab !== 'active');
  $('#member-codes').hidden   = (tab !== 'codes');
  $('#member-semester').hidden = (tab !== 'semester');
  if (tab === 'pending') renderPending();
  if (tab === 'active')  renderActive();
  if (tab === 'codes')   renderCodes();
  if (tab === 'semester') renderSemesterSettings();
}

async function renderPending() {
  const root = $('#member-pending');
  root.innerHTML = '<p class="muted">불러오는 중…</p>';
  try {
    const list = await api('member.pendingList', { token: state.adminToken });
    if (!list.length) {
      root.innerHTML = '<div class="empty"><strong>승인 대기 중인 학생이 없습니다.</strong></div>';
      return;
    }
    root.innerHTML = `<table class="member-table">
      <thead><tr><th>학번</th><th>이름</th><th>신청일시</th><th>처리</th></tr></thead>
      <tbody>${list.map(s => `
        <tr>
          <td>${escapeHtml(s.sid)}</td>
          <td>${escapeHtml(s.name)}</td>
          <td>${fmtDate(s.requestedAt)}</td>
          <td class="action-cell">
            <button class="mini-btn success" data-action="approve" data-sid="${s.sid}">승인</button>
            <button class="mini-btn danger"  data-action="reject"  data-sid="${s.sid}">거절</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>`;
    root.querySelectorAll('[data-action="approve"]').forEach(b => {
      b.addEventListener('click', async () => {
        try {
          await api('member.approve', { sid: b.dataset.sid, token: state.adminToken });
          toast('승인했습니다.', 'success'); renderPending();
        } catch(e) { toast(e.message, 'error'); }
      });
    });
    root.querySelectorAll('[data-action="reject"]').forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirm(`${b.dataset.sid} 학생의 신청을 거절할까요?`)) return;
        try {
          await api('member.reject', { sid: b.dataset.sid, token: state.adminToken });
          toast('거절했습니다.', 'success'); renderPending();
        } catch(e) { toast(e.message, 'error'); }
      });
    });
  } catch(e) { root.innerHTML = `<p class="muted">오류: ${escapeHtml(e.message)}</p>`; }
}

async function renderActive() {
  const root = $('#member-active');
  root.innerHTML = '<p class="muted">불러오는 중…</p>';
  try {
    const list = await api('member.activeList', { token: state.adminToken });
    if (!list.length) {
      root.innerHTML = '<div class="empty"><strong>승인된 학생이 없습니다.</strong></div>';
      return;
    }
    root.innerHTML = `<table class="member-table">
      <thead><tr><th>학번</th><th>이름</th><th>반</th><th>승인일시</th><th>처리</th></tr></thead>
      <tbody>${list.map(s => `
        <tr>
          <td>${escapeHtml(s.sid)}</td>
          <td>${escapeHtml(s.name)}</td>
          <td>${escapeHtml(s.klass)}</td>
          <td>${fmtDate(s.approvedAt)}</td>
          <td class="action-cell">
            <button class="mini-btn" data-action="reset-pw" data-sid="${s.sid}">비밀번호 초기화</button>
            <button class="mini-btn danger" data-action="withdraw" data-sid="${s.sid}">탈퇴</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>`;
    root.querySelectorAll('[data-action="reset-pw"]').forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirm(`${b.dataset.sid} 학생의 비밀번호를 학번으로 초기화할까요?`)) return;
        try {
          await api('member.resetPassword', { sid: b.dataset.sid, token: state.adminToken });
          toast(`비밀번호를 학번(${b.dataset.sid})으로 초기화했습니다.`, 'success');
        } catch(e) { toast(e.message, 'error'); }
      });
    });
    root.querySelectorAll('[data-action="withdraw"]').forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirm(`${b.dataset.sid} 학생을 탈퇴 처리할까요? 복구할 수 없습니다.`)) return;
        try {
          await api('member.withdraw', { sid: b.dataset.sid, token: state.adminToken });
          toast('탈퇴 처리했습니다.', 'success'); renderActive();
        } catch(e) { toast(e.message, 'error'); }
      });
    });
  } catch(e) { root.innerHTML = `<p class="muted">오류: ${escapeHtml(e.message)}</p>`; }
}

async function renderCodes() {
  const root = $('#member-codes');
  root.innerHTML = '<p class="muted">불러오는 중…</p>';
  try {
    const list = await api('code.list', { token: state.adminToken });
    const tableHtml = list.length ? `<table class="member-table">
      <thead><tr><th>코드값</th><th>설명</th><th>만료일</th><th>상태</th><th>삭제</th></tr></thead>
      <tbody>${list.map(c => {
        const expired = c.expiresAt && new Date(c.expiresAt) < new Date();
        return `<tr class="${expired?'expired-row':''}">
          <td><code class="code-val">${escapeHtml(c.value)}</code></td>
          <td>${escapeHtml(c.label)}</td>
          <td>${escapeHtml(c.expiresAt) || '—'}</td>
          <td><span class="pill ${expired?'pill-soft':'pill-mint'}">${expired?'만료':'유효'}</span></td>
          <td><button class="mini-btn danger" data-action="del-code" data-id="${c.codeId}">삭제</button></td>
        </tr>`;
      }).join('')}
      </tbody>
    </table>` : '<div class="empty"><strong>등록된 교사 코드가 없습니다.</strong></div>';

    root.innerHTML = `
      <div class="code-form card" style="margin-bottom:20px">
        <h3 style="margin:0 0 12px;font-size:16px;">새 교사 코드 추가</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:10px;align-items:end;">
          <label class="field" style="margin:0"><span>코드값</span><input id="new-code-value" type="text" placeholder="예: yulha2026"/></label>
          <label class="field" style="margin:0"><span>설명</span><input id="new-code-label" type="text" placeholder="예: 1학기 가입용"/></label>
          <label class="field" style="margin:0"><span>만료일</span><input id="new-code-expires" type="date"/></label>
          <button class="btn-primary" id="btn-add-code" style="height:50px;">추가</button>
        </div>
      </div>
      ${tableHtml}`;

    root.querySelector('#btn-add-code').addEventListener('click', async () => {
      const value     = root.querySelector('#new-code-value').value.trim();
      const label     = root.querySelector('#new-code-label').value.trim();
      const expiresAt = root.querySelector('#new-code-expires').value;
      if (!value) return toast('코드값을 입력해 주세요.', 'error');
      if (!expiresAt) return toast('만료일을 선택해 주세요.', 'error');
      try {
        await api('code.create', { value, label, expiresAt, token: state.adminToken });
        toast('교사 코드를 추가했습니다.', 'success'); renderCodes();
      } catch(e) { toast(e.message, 'error'); }
    });

    root.querySelectorAll('[data-action="del-code"]').forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirm('이 코드를 삭제할까요?')) return;
        try {
          await api('code.delete', { codeId: b.dataset.id, token: state.adminToken });
          toast('삭제했습니다.', 'success'); renderCodes();
        } catch(e) { toast(e.message, 'error'); }
      });
    });
  } catch(e) { root.innerHTML = `<p class="muted">오류: ${escapeHtml(e.message)}</p>`; }
}

async function renderSemesterSettings() {
  const root = $('#member-semester');
  root.innerHTML = '<p class="muted">불러오는 중…</p>';
  try {
    const meta = await api('meta.getSemester', { token: state.adminToken });
    const current = meta.currentSemester;
    root.innerHTML = `
      <div class="semester-form card" style="max-width:500px;padding:32px;">
        <h3 style="margin:0 0 6px;font-size:18px;font-weight:700;">현재 학기</h3>
        <p class="muted" style="margin-bottom:24px;font-size:14px;">모든 학생들이 로그인할 때 이 학기를 보게 됩니다.</p>
        
        <div style="background:var(--c-surface-low);padding:16px;border-radius:var(--r-md);margin-bottom:20px;">
          <p style="margin:0 0 8px;font-size:13px;color:var(--c-on-surface-variant);font-weight:600;">현재 설정된 학기</p>
          <p style="margin:0;font-size:24px;font-weight:700;color:var(--c-primary);">${escapeHtml(current)}</p>
        </div>

        <label class="field">
          <span>새로운 학기명 입력</span>
          <input id="semester-input" type="text" placeholder="예: 2026-2" value="${escapeHtml(current)}" />
        </label>
        <p class="muted" style="margin-top:8px;font-size:12px;">예시: 2026-1, 2026-2, 2025-1학기 등</p>

        <button class="btn-primary" id="btn-save-semester" style="width:100%;padding:14px;font-size:16px;">저장하기</button>
      </div>`;

    root.querySelector('#btn-save-semester').addEventListener('click', async () => {
      const newSemester = root.querySelector('#semester-input').value.trim();
      if (!newSemester) return toast('학기명을 입력해 주세요.', 'error');
      if (newSemester === current) return toast('이미 설정되어 있는 학기입니다.', 'error');
      try {
        await api('meta.setSemester', { semester: newSemester, token: state.adminToken });
        toast(`학기를 "${newSemester}"로 변경했습니다. 학생들이 재로그인하면 적용됩니다.`, 'success');
        renderSemesterSettings();
      } catch(e) { toast(e.message, 'error'); }
    });
  } catch(e) { root.innerHTML = `<p class="muted">오류: ${escapeHtml(e.message)}</p>`; }
}

// ============================================================
//  공용 유틸
// ============================================================

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
  // 로그인
  $('#btn-student-login').addEventListener('click', studentLogin);
  $('#btn-admin-login').addEventListener('click', adminLogin);
  $('#btn-go-register').addEventListener('click', () => show('screen-register'));
  $('#btn-go-login').addEventListener('click', () => show('screen-login'));
  $('#btn-register-submit').addEventListener('click', studentRegister);
  $('#btn-logout').addEventListener('click', logout);

  // 관리자
  $('#btn-new-class').addEventListener('click', newClass);
  $('#btn-new-activity').addEventListener('click', newActivity);
  $('#btn-make-columns').addEventListener('click', makeColumns);
  $('#btn-export').addEventListener('click', exportCsv);
  $('#btn-members').addEventListener('click', openMembers);
  $('#btn-back-from-members').addEventListener('click', () => show('screen-classes'));

  // 회원 관리 탭
  $$('.member-tab').forEach(b => b.addEventListener('click', () => switchMemberTab(b.dataset.tab)));

  // 게시물
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

  // 뒤로가기
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

  // 엔터키
  ['login-sid','login-password'].forEach(id => {
    $('#'+id).addEventListener('keydown', e => { if (e.key==='Enter') studentLogin(); });
  });
  ['admin-id','admin-pw'].forEach(id => {
    $('#'+id).addEventListener('keydown', e => { if (e.key==='Enter') adminLogin(); });
  });
  ['reg-sid','reg-name','reg-code','reg-pw','reg-pw2'].forEach(id => {
    const el = $('#'+id); if(el) el.addEventListener('keydown', e => { if(e.key==='Enter') studentRegister(); });
  });
}

(async function init() {
  bindOnce();
  if (loadSession()) {
    try { await enterApp(); return; } catch {}
  }
  show('screen-login');
})();
