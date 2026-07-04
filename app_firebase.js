/* ============================================================
   SOCIAL BOARD v3 — Firebase Realtime Database Edition
   ============================================================
   변경사항:
   - 홈 화면 (강의노트 탭 / 게시판 탭 선택)
   - 강의노트 기능 (리치텍스트, 유튜브, 파일첨부, 반별 게시)
   - 학생: 자기 반 게시판만 표시 (학번 파싱)
   - 반 이름 수정 기능
   - 반 게시물 일괄 삭제 기능
   - 모바일 대응
   ============================================================ */

const FB_URL     = 'https://yulha-2026-1-default-rtdb.asia-southeast1.firebasedatabase.app/';
const FB_STORAGE = 'yulha-2026-1.appspot.com'; // ⚠ 더 이상 사용하지 않지만 삭제하지 않고 보존

// 강의노트 첨부파일 업로드용 Google Apps Script 웹앱 주소
// (Apps Script 배포 후 발급되는 /exec 로 끝나는 URL을 여기에 붙여넣으세요)
const GAS_UPLOAD_URL = 'https://script.google.com/macros/s/AKfycbzRydoKELBIKmT4Dtf8BqXv2ZRzVZ_vwp1rMsAgMHAobiNOFnpY56PHw5Oe0HSGivg/exec';
// Code.gs의 UPLOAD_KEY 값과 반드시 동일하게 맞춰주세요
const GAS_UPLOAD_KEY = 'yulha-note-upload-2026';

// 버전이 바뀌면 구버전 세션 자동 삭제
const APP_VERSION = 'v6';
if (sessionStorage.getItem('sb.version') !== APP_VERSION) {
  sessionStorage.clear();
  sessionStorage.setItem('sb.version', APP_VERSION);
}

/*
  ── Firebase 데이터 구조 ─────────────────────────────────────
  /meta/activeSemester
  /admins/{adminId}/password
  /codes/{codeId}/{ value, label, expiresAt }
  /pending/{sid}/{ name, passwordHash, requestedAt }
  /students/{sid}/{ name, klass, passwordHash, approved, approvedAt }
  /{semester}/notes/{noteId}/{ title, body, url, fileUrl, fileName,
      targetClasses:["all"|classId...], createdAt }
  /{semester}/classes/{classId}/{ className, createdAt }
  /{semester}/activities/{id}/{ classId, title, type, ... }
  /{semester}/groups/{id}/{ activityId, title, order }
  /{semester}/posts/{id}/{ activityId, groupId, sid, name, ... }

  ── 학번 규칙 ───────────────────────────────────────────────
  5자리: 학년(1) + 학반(2) + 번호(2)
  예) 10315 → 1학년 03반 15번 → "1학년 3반"
  ──────────────────────────────────────────────────────────── */

// ── 전역 상태 ──────────────────────────────────────────────
const state = {
  user: null,
  adminToken: null,
  semester: '2026-1',
  cur: {
    classId: null, className: '',
    activityId: null, activityTitle: '', activityType: 'mixed',
    columnsCreated: false, groups: [],
    noteId: null
  }
};

// ── 유틸 ───────────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.hidden = true, 2800);
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

// 학번 → 반 이름 변환 (10315 → "1학년 3반")
function sidToKlass(sid) {
  if (!sid || sid.length !== 5) return '';
  const grade = sid[0];
  const klass = parseInt(sid.slice(1,3), 10);
  return `${grade}학년 ${klass}반`;
}

function show(screenId) {
  const screens = ['screen-login','screen-register','screen-home',
    'screen-notes','screen-note-detail','screen-classes',
    'screen-activities','screen-board','screen-members'];
  screens.forEach(id => {
    const el = $('#'+id);
    if (el) el.hidden = (id !== screenId);
  });
  const noTopbar = ['screen-login','screen-register'];
  $('#topbar').hidden = noTopbar.includes(screenId);
}

function isAdmin() { return !!(state.user && state.user.admin); }

// SHA-256
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

// ── 세션 ───────────────────────────────────────────────────
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

// ── Firebase Helpers ────────────────────────────────────────
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
const fbGet    = path      => fbReq(path);
const fbSet    = (path, d) => fbReq(path, 'PUT', d);
const fbPatch  = (path, d) => fbReq(path, 'PATCH', d);
const fbDelete = path      => fbReq(path, 'DELETE');
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
// Google Drive(Apps Script 웹앱)로 파일 업로드
async function fbUploadFile(base64, fileName, mime) {
  if (!GAS_UPLOAD_URL || GAS_UPLOAD_URL.includes('PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE')) {
    throw new Error('업로드 서버 주소가 설정되어 있지 않습니다. app_firebase.js의 GAS_UPLOAD_URL 값을 Apps Script 배포 URL로 교체하세요.');
  }
  let r;
  try {
    r = await fetch(GAS_UPLOAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // GAS doPost 단순 파싱을 위해 text/plain 사용
      body: JSON.stringify({ key: GAS_UPLOAD_KEY, fileBase64: base64, fileName, mime })
    });
  } catch (networkErr) {
    throw new Error('업로드 서버(Google Apps Script)에 연결할 수 없습니다. 배포 URL이 올바른지, 배포가 "웹 앱"으로 되어 있는지 확인하세요.');
  }
  if (!r.ok) {
    throw new Error('파일 업로드 실패 (HTTP ' + r.status + ')');
  }
  const d = await r.json();
  if (d.error) throw new Error('업로드 실패: ' + d.error);
  if (!d.fileUrl) throw new Error('업로드 응답에 fileUrl이 없습니다.');
  return d.fileUrl;
}

// ── api 디스패처 ───────────────────────────────────────────
async function api(action, payload = {}) {
  switch (action) {
    case 'auth.studentLogin':    return fbStudentLogin(payload);
    case 'auth.studentRegister': return fbStudentRegister(payload);
    case 'auth.adminLogin':      return fbAdminLogin(payload);
    case 'meta.activeSemester':  return fbGetMeta();
    case 'meta.setSemester':     return fbSetSemester(payload);
    case 'note.list':            return fbNoteList(payload);
    case 'note.get':             return fbNoteGet(payload);
    case 'note.create':          return fbNoteCreate(payload);
    case 'note.update':          return fbNoteUpdate(payload);
    case 'note.delete':          return fbNoteDelete(payload);
    case 'class.list':           return fbClassList(payload);
    case 'class.create':         return fbClassCreate(payload);
    case 'class.rename':         return fbClassRename(payload);
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
    case 'post.clearByClass':    return fbClearPostsByClass(payload);
    case 'export.csv':           return fbExportCsv(payload);
    case 'member.pendingList':   return fbPendingList(payload);
    case 'member.approve':       return fbApprove(payload);
    case 'member.reject':        return fbReject(payload);
    case 'member.withdraw':      return fbWithdraw(payload);
    case 'member.resetPassword': return fbResetPassword(payload);
    case 'member.activeList':    return fbActiveList(payload);
    case 'code.list':            return fbCodeList(payload);
    case 'code.create':          return fbCodeCreate(payload);
    case 'code.delete':          return fbCodeDelete(payload);
    default: throw new Error('Unknown action: ' + action);
  }
}

// ── 인증 ───────────────────────────────────────────────────
async function fbStudentLogin({ sid, password }) {
  const student = await fbGet('/students/' + sid);
  if (!student) throw new Error('등록되지 않은 학번입니다. 회원가입을 먼저 진행해 주세요.');
  if (!student.approved) throw new Error('관리자 승인 대기 중입니다. 잠시 후 다시 시도해 주세요.');
  const hash = await sha256(password);
  if (student.passwordHash !== hash) throw new Error('비밀번호가 올바르지 않습니다.');
  const klass = sidToKlass(sid);
  return { sid, name: student.name, klass };
}

async function fbStudentRegister({ sid, name, password, code }) {
  if (!sid || sid.length !== 5 || !/^\d{5}$/.test(sid))
    throw new Error('학번은 숫자 5자리여야 합니다.');
  const existing = await fbGet('/students/' + sid);
  if (existing && existing.approved) throw new Error('이미 가입된 학번입니다.');
  const pending = await fbGet('/pending/' + sid);
  if (pending) throw new Error('이미 승인 대기 중입니다. 관리자 승인을 기다려 주세요.');
  const codes = await fbGet('/codes');
  const codeArr = objToArr(codes);
  const matched = codeArr.find(c => c.value === code);
  if (!matched) throw new Error('교사 코드가 올바르지 않습니다.');
  if (matched.expiresAt && new Date(matched.expiresAt) < new Date())
    throw new Error('만료된 교사 코드입니다. 담당 선생님께 문의하세요.');
  const passwordHash = await sha256(password);
  await fbSet('/pending/' + sid, { name, passwordHash, requestedAt: new Date().toISOString() });
  return { ok: true };
}

async function fbAdminLogin({ id, password }) {
  const admin = await fbGet('/admins/' + id);
  if (!admin || admin.password !== password)
    throw new Error('관리자 정보가 올바르지 않습니다.');
  return { token: password };
}

// ── 메타 ───────────────────────────────────────────────────
async function fbGetMeta() {
  const meta = await fbGet('/meta');
  return { semester: (meta && meta.activeSemester) || '2026-1' };
}
async function fbSetSemester({ semester, token }) {
  verifyAdmin(token);
  if (!semester || !semester.trim()) throw new Error('학기명을 입력하세요.');
  await fbPatch('/meta', { activeSemester: semester.trim() });
  return { ok: true, semester: semester.trim() };
}

// ── 강의노트 ────────────────────────────────────────────────
async function fbNoteList({ semester, klass }) {
  const raw = await fbGet('/' + semester + '/notes');
  return objToArr(raw)
    .filter(n => {
      if (!n.targetClasses) return true;
      if (n.targetClasses.includes('all')) return true;
      if (!klass) return true; // 관리자는 전체 노출
      return n.targetClasses.includes(klass);
    })
    .map(n => ({ noteId: n._id, title: n.title, url: n.url || '',
      fileUrl: n.fileUrl || '', fileName: n.fileName || '',
      targetClasses: n.targetClasses || ['all'], createdAt: n.createdAt }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function fbNoteGet({ semester, noteId }) {
  const n = await fbGet('/' + semester + '/notes/' + noteId);
  if (!n) throw new Error('강의노트를 찾을 수 없습니다.');
  return { noteId, ...n };
}

async function fbNoteCreate({ semester, title, body, url, fileBase64, fileName, fileMime, targetClasses, token }) {
  verifyAdmin(token);
  let fileUrl = '', fileNameSaved = '';
  if (fileBase64 && fileName) {
    fileUrl = await fbUploadFile(fileBase64, fileName, fileMime || 'application/octet-stream');
    fileNameSaved = fileName;
  }
  const id = await fbPush('/' + semester + '/notes', {
    title, body: body || '', url: url || '',
    fileUrl, fileName: fileNameSaved,
    targetClasses: targetClasses || ['all'],
    createdAt: new Date().toISOString()
  });
  return { noteId: id };
}

async function fbNoteUpdate({ semester, noteId, title, body, url, targetClasses, token }) {
  verifyAdmin(token);
  await fbPatch('/' + semester + '/notes/' + noteId, {
    title, body: body || '', url: url || '',
    targetClasses: targetClasses || ['all'],
    updatedAt: new Date().toISOString()
  });
  return { ok: true };
}

async function fbNoteDelete({ semester, noteId, token }) {
  verifyAdmin(token);
  await fbDelete('/' + semester + '/notes/' + noteId);
  return { ok: true };
}

// ── 반 ─────────────────────────────────────────────────────
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
async function fbClassRename({ semester, classId, name, token }) {
  verifyAdmin(token);
  await fbPatch('/' + semester + '/classes/' + classId, { className: name });
  return { ok: true };
}
async function fbClassDelete({ semester, classId, token }) {
  verifyAdmin(token);
  const acts = objToArr(await fbGet('/' + semester + '/activities'))
    .filter(a => a.classId === classId);
  for (const a of acts) await _deleteActivity(semester, a._id);
  await fbDelete('/' + semester + '/classes/' + classId);
  return { ok: true };
}

// ── 활동 ───────────────────────────────────────────────────
async function fbActivityList({ semester, classId }) {
  const raw = await fbGet('/' + semester + '/activities');
  return objToArr(raw)
    .filter(a => a.classId === classId)
    .map(a => ({ activityId: a._id, classId: a.classId,
      title: a.title, type: a.type || 'basic',
      description: a.description || '', url: a.url || '',
      columnsCreated: a.columnsCreated || false, createdAt: a.createdAt }))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}
async function fbActivityCreate({ semester, classId, title, type, description, url = '', token }) {
  verifyAdmin(token);
  const id = await fbPush('/' + semester + '/activities', {
    classId, title, type: type || 'basic',
    description: description || '', url: url || '',
    columnsCreated: false, createdAt: new Date().toISOString()
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

// 반 게시물 일괄 삭제
async function fbClearPostsByClass({ semester, classId, token }) {
  verifyAdmin(token);
  const actIds = objToArr(await fbGet('/' + semester + '/activities'))
    .filter(a => a.classId === classId).map(a => a._id);
  const posts = objToArr(await fbGet('/' + semester + '/posts'))
    .filter(p => actIds.includes(p.activityId));
  for (const p of posts) await fbDelete('/' + semester + '/posts/' + p._id);
  return { count: posts.length };
}

// ── 조 ─────────────────────────────────────────────────────
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
      activityId, title: i + '조', order: i, createdAt: new Date().toISOString()
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

// ── 게시물 ─────────────────────────────────────────────────
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
    status: 'visible', createdAt: new Date().toISOString()
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
    .filter(p => p.status !== 'deleted').map(p => ({ postId: p._id, ...p }));
  if (scope === 'activity') posts = posts.filter(p => p.activityId === id);
  else if (scope === 'class') {
    const actIds = objToArr(await fbGet('/' + semester + '/activities'))
      .filter(a => a.classId === id).map(a => a._id);
    posts = posts.filter(p => actIds.includes(p.activityId));
  }
  const fields = ['postId','activityId','groupId','sid','name','type',
    'title','content','step1','step2','step3','step4','step5','fileUrl','status','createdAt'];
  const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const csv = [fields.join(','), ...posts.map(p => fields.map(f => esc(p[f])).join(','))].join('\n');
  return { csv, count: posts.length };
}

// ── 회원 관리 ───────────────────────────────────────────────
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
    name: pending.name, klass: sidToKlass(sid),
    passwordHash: pending.passwordHash,
    approved: true, approvedAt: new Date().toISOString()
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
  await fbPatch('/students/' + sid, { passwordHash: await sha256(sid) });
  return { ok: true };
}
async function fbActiveList({ token }) {
  verifyAdmin(token);
  const raw = await fbGet('/students');
  return objToArr(raw).filter(s => s.approved)
    .map(s => ({ sid: s._id, name: s.name, klass: sidToKlass(s._id), approvedAt: s.approvedAt }))
    .sort((a, b) => a.sid.localeCompare(b.sid));
}

// ── 교사 코드 ───────────────────────────────────────────────
async function fbCodeList({ token }) {
  verifyAdmin(token);
  const raw = await fbGet('/codes');
  return objToArr(raw).map(c => ({ codeId: c._id, value: c.value, label: c.label || '', expiresAt: c.expiresAt || '' }));
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

// ============================================================
//  UI
// ============================================================

// ── 로그인 / 회원가입 ────────────────────────────────────────
async function studentLogin() {
  const sid      = $('#login-sid').value.trim();
  const password = $('#login-password').value;
  if (!sid || !password) return toast('학번과 비밀번호를 입력해 주세요.', 'error');
  try {
    const u = await api('auth.studentLogin', { sid, password });
    state.user = u;
    saveSession();
    await enterApp();
    toast(`환영합니다, ${u.name} 님`, 'success');
  } catch (e) { toast(e.message, 'error'); }
}

async function studentRegister() {
  const sid  = $('#reg-sid').value.trim();
  const name = $('#reg-name').value.trim();
  const code = $('#reg-code').value.trim();
  const pw1  = $('#reg-pw').value;
  const pw2  = $('#reg-pw2').value;
  if (!sid || !name || !code || !pw1 || !pw2) return toast('모든 항목을 입력해 주세요.', 'error');
  if (pw1 !== pw2) return toast('비밀번호가 일치하지 않습니다.', 'error');
  if (pw1.length < 4) return toast('비밀번호는 4자 이상이어야 합니다.', 'error');
  try {
    await api('auth.studentRegister', { sid, name, password: pw1, code });
    toast('신청 완료! 관리자 승인 후 로그인할 수 있습니다.', 'success');
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
    await enterApp();
    toast('관리자로 로그인했습니다.', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

function logout() { clearSession(); show('screen-login'); }

// 학생 로그인 시 관리자 전용 요소를 DOM에서 완전히 제거
function stripAdminOnlyElements() {
  if (isAdmin()) return;
  ['#btn-members', '#btn-new-activity', '#btn-clear-posts',
   '#btn-new-class', '#btn-new-note'].forEach(sel => {
    const el = $(sel);
    if (el) el.remove();
  });
}

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
  stripAdminOnlyElements();
  showHome();
}

// ── 홈 화면 ─────────────────────────────────────────────────
function showHome() {
  const u = state.user;
  if (isAdmin()) {
    $('#home-greeting').textContent = '관리자 메뉴';
    $('#home-sub').textContent = '강의노트 작성, 반 게시판 관리, 회원 관리를 할 수 있습니다.';
    $('#home-board-label').textContent = '반 게시판 관리';
    $('#home-board-desc').textContent = '반을 만들고 활동을 관리하세요.';
  } else {
    const klass = sidToKlass(u.sid);
    $('#home-greeting').textContent = `${escapeHtml(u.name)} 님, 안녕하세요!`;
    $('#home-sub').textContent = `${klass} · ${state.semester}학기`;
    $('#home-board-label').textContent = `${klass} 게시판`;
    $('#home-board-desc').textContent = '우리 반 활동 게시판에 참여하세요.';
  }
  show('screen-home');
}

// ── 강의노트 목록 ────────────────────────────────────────────
async function openNotes() {
  show('screen-notes');
  if (isAdmin()) {
    $('#btn-new-note').hidden = false;
  } else if ($('#btn-new-note')) {
    $('#btn-new-note').remove();
  }
  const root = $('#notes-list');
  root.innerHTML = '<p class="muted">불러오는 중…</p>';
  try {
    const klass = isAdmin() ? null : sidToKlass(state.user.sid);
    const list = await api('note.list', { semester: state.semester, klass });
    if (!list.length) {
      root.innerHTML = '<div class="empty"><strong>등록된 강의노트가 없습니다.</strong></div>';
      return;
    }
    root.innerHTML = list.map(n => `
      <div class="note-card" data-id="${n.noteId}">
        <div class="note-card-body">
          <div class="note-card-title">${escapeHtml(n.title)}</div>
          <div class="note-card-meta">${fmtDate(n.createdAt)}
            ${n.targetClasses && !n.targetClasses.includes('all')
              ? `<span class="pill pill-soft" style="font-size:11px;padding:2px 8px;">${n.targetClasses.join(', ')}</span>` : ''}
          </div>
        </div>
        <div class="note-card-actions">
          ${isAdmin() ? `
            <button class="mini-btn" data-action="edit-note" data-id="${n.noteId}">수정</button>
            <button class="mini-btn danger" data-action="del-note" data-id="${n.noteId}">삭제</button>
          ` : ''}
          <button class="btn-primary" style="font-size:13px;padding:8px 16px;" data-action="view-note" data-id="${n.noteId}">보기 →</button>
        </div>
      </div>`).join('');

    root.querySelectorAll('[data-action="view-note"]').forEach(b => {
      b.addEventListener('click', () => openNoteDetail(b.dataset.id));
    });
    root.querySelectorAll('[data-action="edit-note"]').forEach(b => {
      b.addEventListener('click', () => openNoteModal(b.dataset.id));
    });
    root.querySelectorAll('[data-action="del-note"]').forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirm('이 강의노트를 삭제할까요?')) return;
        try {
          await api('note.delete', { semester: state.semester, noteId: b.dataset.id, token: state.adminToken });
          toast('삭제했습니다.', 'success'); openNotes();
        } catch(e) { toast(e.message, 'error'); }
      });
    });
  } catch(e) { root.innerHTML = `<p class="muted">오류: ${escapeHtml(e.message)}</p>`; }
}

// ── 강의노트 상세 ────────────────────────────────────────────
async function openNoteDetail(noteId) {
  show('screen-note-detail');
  $('#note-detail-title').textContent = '불러오는 중…';
  $('#note-detail-body').innerHTML = '';
  try {
    const n = await api('note.get', { semester: state.semester, noteId });
    state.cur.noteId = noteId;
    $('#note-detail-title').textContent = n.title;
    $('#note-detail-meta').textContent = fmtDate(n.createdAt);
    $('#note-detail-actions').innerHTML = isAdmin()
      ? `<button class="btn-ghost" onclick="openNoteModal('${noteId}')">수정</button>` : '';

    let html = '';
    // 본문 (리치텍스트 HTML)
    if (n.body) html += `<div class="note-body-content">${n.body}</div>`;
    // 유튜브 임베드
    if (n.url) {
      const ytId = extractYoutubeId(n.url);
      if (ytId) {
        html += `<div class="note-video-wrap"><iframe src="https://www.youtube.com/embed/${ytId}"
          frameborder="0" allowfullscreen></iframe></div>`;
      } else {
        html += `<a class="note-link" href="${escapeHtml(n.url)}" target="_blank" rel="noopener">🔗 ${escapeHtml(n.url)}</a>`;
      }
    }
    // 파일 첨부
    if (n.fileUrl) {
      // Drive 다운로드 URL에는 확장자가 없으므로 fileUrl 대신 fileName으로 이미지 여부 판별
      const isImg = /\.(jpg|jpeg|png|gif|webp)$/i.test(n.fileName || '');
      if (isImg) {
        html += `<div class="note-img-wrap"><img src="${escapeHtml(n.fileUrl)}" alt="${escapeHtml(n.fileName||'이미지')}" /></div>
          <a class="n-file" href="${escapeHtml(n.fileUrl)}" download="${escapeHtml(n.fileName||'image')}" target="_blank" rel="noopener">⬇ ${escapeHtml(n.fileName||'이미지')} 다운로드</a>`;
      } else {
        html += `<a class="n-file" href="${escapeHtml(n.fileUrl)}" download="${escapeHtml(n.fileName||'file')}" target="_blank" rel="noopener">⬇ ${escapeHtml(n.fileName||'첨부파일')} 다운로드</a>`;
      }
    }
    $('#note-detail-body').innerHTML = html || '<p class="muted">내용이 없습니다.</p>';
  } catch(e) { $('#note-detail-title').textContent = '오류: ' + e.message; }
}

function extractYoutubeId(url) {
  const m = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
  return m ? m[1] : null;
}

// ── 강의노트 작성/수정 모달 ──────────────────────────────────
let noteEditId = null;
let noteFileData = null;

async function openNoteModal(editNoteId = null) {
  noteEditId = editNoteId || null;
  noteFileData = null;
  $('#modal-note-title').textContent = editNoteId ? '강의노트 수정' : '강의노트 작성';
  $('#note-title').value = '';
  $('#rte-editor').innerHTML = '';
  $('#note-url').value = '';
  $('#note-file-preview').innerHTML = '';
  $('#drop-zone-text').textContent = '파일을 여기에 드래그하거나 클릭하여 선택';

  // 반 목록 불러오기
  const classList = await api('class.list', { semester: state.semester });
  const listEl = $('#note-class-list');
  listEl.innerHTML = classList.map(c => `
    <label class="class-check-item">
      <input type="checkbox" name="note-class" value="${c.classId}" data-name="${escapeHtml(c.className)}" />
      <span>${escapeHtml(c.className)}</span>
    </label>`).join('');
  $('#note-class-all').checked = false;

  if (editNoteId) {
    try {
      const n = await api('note.get', { semester: state.semester, noteId: editNoteId });
      $('#note-title').value = n.title || '';
      $('#rte-editor').innerHTML = n.body || '';
      $('#note-url').value = n.url || '';
      if (n.targetClasses && n.targetClasses.includes('all')) {
        $('#note-class-all').checked = true;
      } else if (n.targetClasses) {
        listEl.querySelectorAll('input[name="note-class"]').forEach(cb => {
          if (n.targetClasses.includes(cb.dataset.name)) cb.checked = true;
        });
      }
    } catch(e) { toast(e.message, 'error'); return; }
  }

  $('#modal-note').hidden = false;
}

async function submitNote() {
  const title = $('#note-title').value.trim();
  const body  = $('#rte-editor').innerHTML.trim();
  const url   = $('#note-url').value.trim();
  if (!title) return toast('제목을 입력하세요.', 'error');

  // 게시 대상 수집
  let targetClasses = [];
  if ($('#note-class-all').checked) {
    targetClasses = ['all'];
  } else {
    $$('input[name="note-class"]:checked').forEach(cb => {
      targetClasses.push(cb.dataset.name);
    });
    if (!targetClasses.length) return toast('게시할 반을 하나 이상 선택하세요.', 'error');
  }

  const payload = { semester: state.semester, title, body, url, targetClasses, token: state.adminToken };
  if (noteFileData) {
    payload.fileBase64 = noteFileData.base64;
    payload.fileName   = noteFileData.name;
    payload.fileMime   = noteFileData.mime;
  }

  try {
    if (noteEditId) {
      await api('note.update', { ...payload, noteId: noteEditId });
      toast('강의노트를 수정했습니다.', 'success');
    } else {
      await api('note.create', payload);
      toast('강의노트를 등록했습니다.', 'success');
    }
    $('#modal-note').hidden = true;
    openNotes();
  } catch(e) { toast(e.message, 'error'); }
}

// ── 반 게시판 (학생: 자기 반만 / 관리자: 전체) ──────────────
async function openBoard() {
  if (isAdmin()) {
    await renderClasses();
    show('screen-classes');
  } else {
    // 학생: 학번으로 자기 반 직접 찾아 입장
    const klass = sidToKlass(state.user.sid);
    const classes = await api('class.list', { semester: state.semester });
    const myClass = classes.find(c => c.className === klass);
    if (!myClass) {
      toast(`${klass} 게시판이 아직 생성되지 않았습니다. 선생님께 문의하세요.`, 'error');
      return;
    }
    await openClass(myClass.classId, myClass.className);
  }
}

async function renderClasses() {
  const grid = $('#class-grid');
  grid.innerHTML = '<p class="muted">불러오는 중…</p>';
  try {
    const list = await api('class.list', { semester: state.semester });
    if (!list.length) {
      grid.innerHTML = `<div class="empty"><strong>아직 등록된 반이 없습니다.</strong>${
        isAdmin() ? '<br/>오른쪽 위 "+ 반 만들기"로 시작하세요.' : ''}</div>`;
      return;
    }
    grid.innerHTML = list.map(c => `
      <div class="class-card-wrap">
        <button class="class-card" data-class-id="${c.classId}">
          <div class="cc-name">${escapeHtml(c.className)}</div>
        </button>
        ${isAdmin() ? `<div class="cc-actions">
          <button class="mini-btn" data-action="rename-class" data-id="${c.classId}" data-name="${escapeHtml(c.className)}">이름 수정</button>
          <button class="mini-btn danger" data-action="del-class" data-id="${c.classId}">삭제</button>
        </div>` : ''}
      </div>`).join('');

    grid.querySelectorAll('.class-card').forEach(btn => {
      btn.addEventListener('click', () => openClass(btn.dataset.classId, btn.querySelector('.cc-name').textContent));
    });
    grid.querySelectorAll('[data-action="rename-class"]').forEach(b => {
      b.addEventListener('click', async () => {
        const newName = await prompt2('반 이름 수정', '새로운 반 이름을 입력하세요.', b.dataset.name);
        if (!newName || newName === b.dataset.name) return;
        try {
          await api('class.rename', { semester: state.semester, classId: b.dataset.id, name: newName, token: state.adminToken });
          toast('반 이름을 수정했습니다.', 'success'); renderClasses();
        } catch(e) { toast(e.message, 'error'); }
      });
    });
    grid.querySelectorAll('[data-action="del-class"]').forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirm('반과 그 안의 모든 활동·게시물이 삭제됩니다. 계속할까요?')) return;
        try {
          await api('class.delete', { semester: state.semester, classId: b.dataset.id, token: state.adminToken });
          toast('반을 삭제했습니다.', 'success'); renderClasses();
        } catch(e) { toast(e.message, 'error'); }
      });
    });
  } catch(e) { grid.innerHTML = `<p class="muted">오류: ${escapeHtml(e.message)}</p>`; }
}

async function newClass() {
  const name = await prompt2('반 만들기', '반 이름을 입력하세요. 예) 1학년 1반');
  if (!name) return;
  try {
    await api('class.create', { semester: state.semester, name, token: state.adminToken });
    toast('반을 생성했습니다.', 'success'); renderClasses();
  } catch(e) { toast(e.message, 'error'); }
}

async function openClass(classId, className) {
  state.cur.classId = classId; state.cur.className = className;
  $('#cur-class-title').textContent = className + ' / 활동 목록';
  $('#cur-class-sub').textContent = state.semester + '학기';
  const backBtn = $('[data-back="classes"]');
  if (backBtn) backBtn.textContent = isAdmin() ? '← 반 목록' : '← 홈';
  if (isAdmin()) {
    $('#btn-new-activity').hidden = false;
    $('#btn-clear-posts').hidden  = false;
  } else {
    if ($('#btn-new-activity')) $('#btn-new-activity').remove();
    if ($('#btn-clear-posts'))  $('#btn-clear-posts').remove();
  }
  show('screen-activities');
  await renderActivities();
}

async function renderActivities() {
  const root = $('#activity-list');
  root.innerHTML = '<p class="muted">불러오는 중…</p>';
  try {
    const list = await api('activity.list', { semester: state.semester, classId: state.cur.classId });
    if (!list.length) {
      root.innerHTML = `<div class="empty"><strong>등록된 활동이 없습니다.</strong>${
        isAdmin() ? '<br/>오른쪽 위 "+ 활동 만들기"로 시작하세요.' : ''}</div>`;
      return;
    }
    root.innerHTML = list.map(a => {
      const isLink = a.type === 'link', isInq = a.type === 'inquiry';
      const icon = isLink ? '🔗' : isInq ? '🔎' : '📋';
      return `<div class="activity-card" data-id="${a.activityId}" data-title="${escapeHtml(a.title)}"
               data-type="${escapeHtml(a.type||'mixed')}"
               data-cols="${a.columnsCreated?'1':'0'}" data-url="${escapeHtml(a.url||'')}">
        <div class="activity-icon ${isLink?'link':isInq?'inquiry':''}">${icon}</div>
        <div><div class="a-title">${escapeHtml(a.title)}</div>
          <div class="a-desc">${isLink?'외부 링크 활동':escapeHtml(a.description||(isInq?'탐구 5단계':'일반 활동'))}</div>
        </div>
        <div class="a-actions">
          ${isAdmin()?`<button class="btn-ghost" data-action="del-activity" data-id="${a.activityId}">삭제</button>`:''}
          <button class="btn-primary" data-action="open">${isLink?'열기 →':'입장 →'}</button>
        </div>
      </div>`;
    }).join('');
    root.querySelectorAll('.activity-card').forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.closest('[data-action="del-activity"]')) return;
        openActivity({ activityId: card.dataset.id, title: card.dataset.title,
          type: card.dataset.type, columnsCreated: card.dataset.cols === '1', url: card.dataset.url || '' });
      });
    });
    root.querySelectorAll('[data-action="del-activity"]').forEach(b => {
      b.addEventListener('click', async e => {
        e.stopPropagation();
        if (!confirm('이 활동과 모든 게시물이 삭제됩니다.')) return;
        try {
          await api('activity.delete', { semester: state.semester, activityId: b.dataset.id, token: state.adminToken });
          toast('삭제했습니다.', 'success'); renderActivities();
        } catch(e) { toast(e.message, 'error'); }
      });
    });
  } catch(e) { root.innerHTML = `<p class="muted">오류: ${escapeHtml(e.message)}</p>`; }
}

async function newActivity() {
  const name = await prompt2('활동 만들기', '활동명을 입력하세요.');
  if (!name) return;
  const isLink = confirm('외부 링크 활동인가요?\n[확인] 링크 / [취소] 일반·탐구');
  let type = 'basic', url = '';
  if (isLink) {
    type = 'link';
    url = await prompt2('활동 URL', '학생에게 열어줄 주소를 입력하세요.');
    if (!url) return;
  } else {
    const isInq = confirm('탐구 질문 5단계 활동인가요?\n[확인] 탐구 / [취소] 일반');
    type = isInq ? 'inquiry' : 'basic';
  }
  try {
    await api('activity.create', { semester: state.semester, classId: state.cur.classId,
      title: name, type, url, description: '', token: state.adminToken });
    toast('활동을 생성했습니다.', 'success'); renderActivities();
  } catch(e) { toast(e.message, 'error'); }
}

async function clearPostsByClass() {
  if (!confirm(`"${state.cur.className}"의 모든 게시물을 삭제할까요?\n활동·조는 유지되며 게시물만 삭제됩니다.`)) return;
  try {
    const r = await api('post.clearByClass', { semester: state.semester, classId: state.cur.classId, token: state.adminToken });
    toast(`${r.count}건의 게시물을 삭제했습니다.`, 'success');
  } catch(e) { toast(e.message, 'error'); }
}

async function openActivity(act) {
  if (act.type === 'link') {
    if (!act.url) return toast('링크 URL이 설정되지 않았습니다.', 'error');
    window.open(act.url, '_blank', 'noopener'); return;
  }
  state.cur.activityId = act.activityId;
  state.cur.activityTitle = act.title;
  state.cur.activityType = act.type || 'mixed';
  state.cur.columnsCreated = !!act.columnsCreated;
  $('#cur-activity-title').textContent = state.cur.className + ' / ' + act.title;
  $('#cur-activity-sub').textContent = state.semester + '학기' + (act.type === 'inquiry' ? ' · 탐구 5단계' : '');
  show('screen-board'); await refreshBoard();
}

async function refreshBoard() {
  try {
    const a = await api('activity.get', { semester: state.semester, activityId: state.cur.activityId });
    state.cur.columnsCreated = !!(a.columnsCreated === true || a.columnsCreated === 'true' || a.columnsCreated === 'TRUE');
  } catch {}
  $('#btn-make-columns').hidden = !(isAdmin() && !state.cur.columnsCreated);
  $('#btn-export').hidden = !isAdmin();
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
  root.innerHTML = posts.length
    ? posts.map(renderPost).join('')
    : `<div class="free-empty"><strong>아직 게시물이 없습니다.</strong>${isAdmin()?'<br/>조별 컬럼: "+ 8개 조 컬럼 만들기"':''}</div>`;
  bindPostActions(root);
}

function renderColumns(groups, posts) {
  const root = $('#columns-area');
  root.innerHTML = groups.map(g => {
    const gPosts = posts.filter(p => p.groupId === g.groupId);
    return `<article class="col" data-group-id="${g.groupId}">
      <header class="col-head">
        <span class="${isAdmin()?'c-title editable':'c-title'}" ${isAdmin()?`data-action="rename" data-id="${g.groupId}"`:''}>${escapeHtml(g.title)}</span>
        <span class="c-count">${gPosts.length}</span>
      </header>
      <div class="col-body">${gPosts.length?gPosts.map(renderPost).join(''):'<div class="col-empty">게시물 없음</div>'}</div>
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
        toast('조 이름 변경 완료.', 'success'); refreshBoard();
      } catch(e) { toast(e.message, 'error'); }
    });
  });
  root.querySelectorAll('[data-action="post-to-group"]').forEach(b => {
    b.addEventListener('click', () => openPostModal(b.dataset.group, b.dataset.groupTitle));
  });
}

function renderPost(p) {
  const isInq = p.type === 'inquiry';
  const hidden = p.status === 'hidden' ? ' hidden-post' : '';
  const adminCls = p.name === '관리자' ? ' admin-post' : '';
  const stepsHtml = isInq ? `<div class="n-steps">
    ${p.step1?`<div class="n-step"><b>① 관찰 중 궁금했던 점</b>${escapeHtml(p.step1)}</div>`:''}
    ${p.step2?`<div class="n-step"><b>② 탐구 질문</b>${escapeHtml(p.step2)}</div>`:''}
    ${p.step3?`<div class="n-step"><b>③ 예상 답변</b>${escapeHtml(p.step3)}</div>`:''}
    ${p.step4?`<div class="n-step"><b>④ AI 답변</b>${escapeHtml(p.step4)}</div>`:''}
    ${p.step5?`<div class="n-step"><b>⑤ 비판적 검토</b>${escapeHtml(p.step5)}</div>`:''}
  </div>` : '';
  return `<article class="note${hidden}${adminCls}" data-post-id="${p.postId}">
    <div class="n-head">
      <span class="pill ${isInq?'pill-lime':'pill-mint'}">${isInq?'탐구':'일반'}</span>
      <span>${p.name==='관리자'?'<span class="pill pill-admin">관리자</span>':escapeHtml(p.sid)+' '+escapeHtml(p.name)}</span>
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
      } catch(e) { toast(e.message, 'error'); }
    });
  });
}

async function makeColumns() {
  if (!confirm('1조부터 8조까지 컬럼을 만듭니다. 계속할까요?')) return;
  try {
    await api('group.makeColumns', { semester: state.semester, activityId: state.cur.activityId, token: state.adminToken });
    toast('컬럼 생성 완료.', 'success'); refreshBoard();
  } catch(e) { toast(e.message, 'error'); }
}

let curGroupId = null, curGroupTitle = '', curPostType = 'basic';

function openPostModal(groupId, groupTitle) {
  curGroupId = groupId || null; curGroupTitle = groupTitle || '';
  $('#post-author').textContent = isAdmin() ? '관리자' : `${state.user.sid} ${state.user.name}`;
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
    $('#post-target').textContent = curGroupTitle || (state.cur.groups.find(g=>g.groupId===curGroupId)?.title||'조 선택');
  } else { wrap.hidden = true; $('#post-target').textContent = '자유 게시'; }
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
  if (state.cur.columnsCreated && state.cur.groups.length > 0) groupId = $('#post-group-select').value;
  const payload = { semester: state.semester, activityId: state.cur.activityId,
    groupId, sid: state.user.sid, name: state.user.name, type: curPostType };
  if (curPostType === 'basic') {
    const title = $('#post-title').value.trim();
    if (!title) return toast('제목을 입력하세요.', 'error');
    payload.title = title; payload.content = $('#post-content').value.trim();
  } else {
    payload.title = ''; payload.content = '';
    ['step1','step2','step3','step4','step5'].forEach(s => payload[s] = $('#'+s).value.trim());
  }
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
  } catch(e) { toast(e.message, 'error'); }
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
  const scope = state.cur.activityId ? 'activity' : 'class';
  const id = state.cur.activityId || state.cur.classId || '';
  try {
    const r = await api('export.csv', { semester: state.semester, scope, id, token: state.adminToken });
    const blob = new Blob([r.csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `SOCIAL_BOARD_${state.semester}_${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
    toast(`${r.count}건 내보냈습니다.`, 'success');
  } catch(e) { toast(e.message, 'error'); }
}

// ── 회원 관리 ───────────────────────────────────────────────
let memberTab = 'pending';
function openMembers() { show('screen-members'); switchMemberTab('pending'); }
function switchMemberTab(tab) {
  memberTab = tab;
  $$('.member-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#member-pending').hidden  = tab !== 'pending';
  $('#member-active').hidden   = tab !== 'active';
  $('#member-codes').hidden    = tab !== 'codes';
  $('#member-semester').hidden = tab !== 'semester';
  if (tab === 'pending')  renderPending();
  if (tab === 'active')   renderActive();
  if (tab === 'codes')    renderCodes();
  if (tab === 'semester') renderSemesterSettings();
}

async function renderPending() {
  const root = $('#member-pending');
  root.innerHTML = '<p class="muted">불러오는 중…</p>';
  try {
    const list = await api('member.pendingList', { token: state.adminToken });
    if (!list.length) { root.innerHTML = '<div class="empty"><strong>승인 대기 중인 학생이 없습니다.</strong></div>'; return; }
    root.innerHTML = `<div class="table-wrap"><table class="member-table">
      <thead><tr><th>학번</th><th>이름</th><th>반(자동)</th><th>신청일시</th><th>처리</th></tr></thead>
      <tbody>${list.map(s => `<tr>
        <td>${escapeHtml(s.sid)}</td><td>${escapeHtml(s.name)}</td>
        <td>${escapeHtml(sidToKlass(s.sid))}</td><td>${fmtDate(s.requestedAt)}</td>
        <td class="action-cell">
          <button class="mini-btn success" data-action="approve" data-sid="${s.sid}">승인</button>
          <button class="mini-btn danger"  data-action="reject"  data-sid="${s.sid}">거절</button>
        </td></tr>`).join('')}
      </tbody></table></div>`;
    root.querySelectorAll('[data-action="approve"]').forEach(b => {
      b.addEventListener('click', async () => {
        try { await api('member.approve', { sid: b.dataset.sid, token: state.adminToken }); toast('승인했습니다.', 'success'); renderPending(); }
        catch(e) { toast(e.message, 'error'); }
      });
    });
    root.querySelectorAll('[data-action="reject"]').forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirm(`${b.dataset.sid} 학생 신청을 거절할까요?`)) return;
        try { await api('member.reject', { sid: b.dataset.sid, token: state.adminToken }); toast('거절했습니다.', 'success'); renderPending(); }
        catch(e) { toast(e.message, 'error'); }
      });
    });
  } catch(e) { root.innerHTML = `<p class="muted">오류: ${escapeHtml(e.message)}</p>`; }
}

async function renderActive() {
  const root = $('#member-active');
  root.innerHTML = '<p class="muted">불러오는 중…</p>';
  try {
    const list = await api('member.activeList', { token: state.adminToken });
    if (!list.length) { root.innerHTML = '<div class="empty"><strong>승인된 학생이 없습니다.</strong></div>'; return; }
    root.innerHTML = `<div class="table-wrap"><table class="member-table">
      <thead><tr><th>학번</th><th>이름</th><th>반</th><th>승인일시</th><th>처리</th></tr></thead>
      <tbody>${list.map(s => `<tr>
        <td>${escapeHtml(s.sid)}</td><td>${escapeHtml(s.name)}</td>
        <td>${escapeHtml(s.klass)}</td><td>${fmtDate(s.approvedAt)}</td>
        <td class="action-cell">
          <button class="mini-btn" data-action="reset-pw" data-sid="${s.sid}">비번 초기화</button>
          <button class="mini-btn danger" data-action="withdraw" data-sid="${s.sid}">탈퇴</button>
        </td></tr>`).join('')}
      </tbody></table></div>`;
    root.querySelectorAll('[data-action="reset-pw"]').forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirm(`${b.dataset.sid} 학생 비밀번호를 학번으로 초기화할까요?`)) return;
        try { await api('member.resetPassword', { sid: b.dataset.sid, token: state.adminToken }); toast(`비밀번호를 학번(${b.dataset.sid})으로 초기화했습니다.`, 'success'); }
        catch(e) { toast(e.message, 'error'); }
      });
    });
    root.querySelectorAll('[data-action="withdraw"]').forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirm(`${b.dataset.sid} 학생을 탈퇴 처리할까요?`)) return;
        try { await api('member.withdraw', { sid: b.dataset.sid, token: state.adminToken }); toast('탈퇴 처리했습니다.', 'success'); renderActive(); }
        catch(e) { toast(e.message, 'error'); }
      });
    });
  } catch(e) { root.innerHTML = `<p class="muted">오류: ${escapeHtml(e.message)}</p>`; }
}

async function renderCodes() {
  const root = $('#member-codes');
  root.innerHTML = '<p class="muted">불러오는 중…</p>';
  try {
    const list = await api('code.list', { token: state.adminToken });
    const tableHtml = list.length ? `<div class="table-wrap"><table class="member-table">
      <thead><tr><th>코드값</th><th>설명</th><th>만료일</th><th>상태</th><th>삭제</th></tr></thead>
      <tbody>${list.map(c => {
        const expired = c.expiresAt && new Date(c.expiresAt) < new Date();
        return `<tr class="${expired?'expired-row':''}">
          <td><code class="code-val">${escapeHtml(c.value)}</code></td>
          <td>${escapeHtml(c.label)}</td><td>${escapeHtml(c.expiresAt)||'—'}</td>
          <td><span class="pill ${expired?'pill-soft':'pill-mint'}">${expired?'만료':'유효'}</span></td>
          <td><button class="mini-btn danger" data-action="del-code" data-id="${c.codeId}">삭제</button></td>
        </tr>`;
      }).join('')}</tbody></table></div>` : '<div class="empty"><strong>등록된 교사 코드가 없습니다.</strong></div>';
    root.innerHTML = `
      <div class="code-form card" style="margin-bottom:20px">
        <h3 style="margin:0 0 12px;font-size:16px;">새 교사 코드 추가</h3>
        <div class="code-form-grid">
          <label class="field" style="margin:0"><span>코드값</span><input id="new-code-value" type="text" placeholder="예: yulha2026"/></label>
          <label class="field" style="margin:0"><span>설명</span><input id="new-code-label" type="text" placeholder="예: 1학기 가입용"/></label>
          <label class="field" style="margin:0"><span>만료일</span><input id="new-code-expires" type="date"/></label>
          <button class="btn-primary" id="btn-add-code">추가</button>
        </div>
      </div>${tableHtml}`;
    root.querySelector('#btn-add-code').addEventListener('click', async () => {
      const value = root.querySelector('#new-code-value').value.trim();
      const label = root.querySelector('#new-code-label').value.trim();
      const expiresAt = root.querySelector('#new-code-expires').value;
      if (!value) return toast('코드값을 입력해 주세요.', 'error');
      if (!expiresAt) return toast('만료일을 선택해 주세요.', 'error');
      try { await api('code.create', { value, label, expiresAt, token: state.adminToken }); toast('추가했습니다.', 'success'); renderCodes(); }
      catch(e) { toast(e.message, 'error'); }
    });
    root.querySelectorAll('[data-action="del-code"]').forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirm('이 코드를 삭제할까요?')) return;
        try { await api('code.delete', { codeId: b.dataset.id, token: state.adminToken }); toast('삭제했습니다.', 'success'); renderCodes(); }
        catch(e) { toast(e.message, 'error'); }
      });
    });
  } catch(e) { root.innerHTML = `<p class="muted">오류: ${escapeHtml(e.message)}</p>`; }
}

async function renderSemesterSettings() {
  const root = $('#member-semester');
  try {
    const m = await api('meta.activeSemester');
    const current = m.semester;
    root.innerHTML = `
      <div class="card" style="max-width:480px">
        <h3 style="margin:0 0 6px;font-size:18px;font-weight:700;">현재 학기</h3>
        <p class="muted">모든 학생이 로그인할 때 이 학기의 게시판을 보게 됩니다.</p>
        <div style="margin-bottom:20px;padding:16px;background:var(--c-surface-low);border-radius:var(--r-md);font-size:22px;font-weight:800;">
          ${escapeHtml(current)}
        </div>
        <label class="field"><span>새로운 학기명 입력</span>
          <input type="text" id="new-semester-val" placeholder="예: 2026-2" value="${escapeHtml(current)}" />
        </label>
        <p class="muted" style="font-size:12px;">예시: 2026-1, 2026-2, 2025-1 등</p>
        <button class="btn-primary" id="btn-set-semester" style="width:100%;margin-top:8px;">변경하기</button>
      </div>`;
    root.querySelector('#btn-set-semester').addEventListener('click', async () => {
      const newSemester = root.querySelector('#new-semester-val').value.trim();
      if (!newSemester) return toast('학기명을 입력해 주세요.', 'error');
      if (newSemester === current) return toast('이미 설정된 학기입니다.', 'error');
      if (!confirm(`학기를 "${newSemester}"로 변경할까요?\n학생들이 재로그인하면 새 학기가 적용됩니다.`)) return;
      try {
        await api('meta.setSemester', { semester: newSemester, token: state.adminToken });
        state.semester = newSemester;
        saveSession();
        $('#semester-pill').textContent = newSemester + '학기';
        toast(`학기를 "${newSemester}"로 변경했습니다.`, 'success');
        renderSemesterSettings();
      } catch(e) { toast(e.message, 'error'); }
    });
  } catch(e) { root.innerHTML = `<p class="muted">오류: ${escapeHtml(e.message)}</p>`; }
}

// ── 공용 유틸 ──────────────────────────────────────────────
function prompt2(title, desc, defaultValue) {
  return new Promise(resolve => {
    $('#prompt-title').textContent = title;
    $('#prompt-desc').textContent = desc;
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

// ── RTE (리치텍스트 에디터) ─────────────────────────────────
function initRTE() {
  const editor = $('#rte-editor');
  // 툴바 버튼
  $$('.rte-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      editor.focus();
      document.execCommand(btn.dataset.cmd, false, null);
    });
  });
  // 글자 크기
  $('#rte-font-size').addEventListener('change', e => {
    editor.focus();
    document.execCommand('fontSize', false, e.target.value);
  });
  // 글자 색상
  $('#rte-color').addEventListener('input', e => {
    editor.focus();
    document.execCommand('foreColor', false, e.target.value);
  });
  // 드래그앤드롭 파일 업로드
  const dropZone = $('#note-drop-zone');
  const fileInput = $('#note-file');
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) handleNoteFile(f);
  });
  fileInput.addEventListener('change', e => {
    if (e.target.files[0]) handleNoteFile(e.target.files[0]);
  });
  // 전체 반 체크박스
  $('#note-class-all').addEventListener('change', e => {
    $$('input[name="note-class"]').forEach(cb => cb.disabled = e.target.checked);
  });
}

async function handleNoteFile(file) {
  if (file.size > 10*1024*1024) return toast('파일은 10MB 이하만 가능합니다.', 'error');
  const base64 = await fileToBase64(file);
  noteFileData = { base64, name: file.name, mime: file.type };
  $('#drop-zone-text').textContent = `선택됨: ${file.name}`;
  const preview = $('#note-file-preview');
  if (file.type.startsWith('image/')) {
    preview.innerHTML = `<img src="data:${file.type};base64,${base64}" alt="미리보기" style="max-width:100%;max-height:200px;border-radius:8px;margin-top:8px;" />`;
  } else {
    preview.innerHTML = `<div style="padding:8px;background:var(--c-surface-low);border-radius:8px;margin-top:8px;font-size:13px;">📎 ${escapeHtml(file.name)}</div>`;
  }
}

// ── 이벤트 바인딩 ───────────────────────────────────────────
function bindOnce() {
  // 로그인
  $('#btn-student-login').addEventListener('click', studentLogin);
  $('#btn-admin-login').addEventListener('click', adminLogin);
  $('#btn-go-register').addEventListener('click', () => show('screen-register'));
  $('#btn-go-login').addEventListener('click', () => show('screen-login'));
  $('#btn-register-submit').addEventListener('click', studentRegister);
  $('#btn-logout').addEventListener('click', logout);

  // 브랜드 로고 클릭 → 홈
  $('#brand-home').addEventListener('click', () => { if (state.user) showHome(); });

  // 홈 버튼
  $('#btn-go-notes').addEventListener('click', openNotes);
  $('#btn-go-board').addEventListener('click', openBoard);

  // 강의노트
  $('#btn-new-note').addEventListener('click', () => openNoteModal());
  $('#btn-submit-note').addEventListener('click', submitNote);
  $('#btn-back-from-notes').addEventListener('click', showHome);
  $('#btn-back-from-note-detail').addEventListener('click', openNotes);

  // 반 목록
  $('#btn-back-from-classes').addEventListener('click', showHome);
  $('#btn-new-class').addEventListener('click', newClass);
  $('#btn-new-activity').addEventListener('click', newActivity);
  $('#btn-clear-posts').addEventListener('click', clearPostsByClass);
  $('#btn-make-columns').addEventListener('click', makeColumns);
  $('#btn-export').addEventListener('click', exportCsv);

  // 회원 관리
  $('#btn-members').addEventListener('click', openMembers);
  $('#btn-back-from-members').addEventListener('click', showHome);
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
  $('#btn-submit-post').addEventListener('click', submitPost);

  // 뒤로가기
  $$('[data-back]').forEach(b => {
    b.addEventListener('click', () => {
      const t = b.dataset.back;
      if (t === 'classes') {
        if (isAdmin()) { renderClasses(); show('screen-classes'); }
        else { showHome(); }
      }
      if (t === 'activities') show('screen-activities');
    });
  });

  // 모달 닫기
  $$('[data-close]').forEach(b => {
    b.addEventListener('click', () => { $('#'+b.dataset.close).hidden = true; });
  });
  $$('.seg').forEach(s => s.addEventListener('click', () => setPostType(s.dataset.type)));

  // 엔터키
  ['login-sid','login-password'].forEach(id => {
    const el = $('#'+id); if(el) el.addEventListener('keydown', e => { if(e.key==='Enter') studentLogin(); });
  });
  ['admin-id','admin-pw'].forEach(id => {
    const el = $('#'+id); if(el) el.addEventListener('keydown', e => { if(e.key==='Enter') adminLogin(); });
  });

  // RTE 초기화
  initRTE();
}

(async function init() {
  bindOnce();
  if (loadSession()) {
    try { await enterApp(); return; } catch {}
  }
  show('screen-login');
})();
